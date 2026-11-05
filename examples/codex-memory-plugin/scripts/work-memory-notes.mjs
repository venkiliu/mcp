// Local MCP tools for company work notes. The server owns authorization and revision checks.
import { createHash } from "node:crypto";
import { buildOvHeaders } from "./shared/ov-http.mjs";
import { workMemoryEnabled } from "./work-memory-settings.mjs";

const CATEGORIES = { preference: "preferences", decision: "events" };
const MARKER = "<!-- ov-work-memory:v1 -->\n";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{64}$/;
const LIMIT = 800;
const fields = {
  kind: { type: "string", enum: Object.keys(CATEGORIES) },
  scope: { type: "string", description: "Stable short project slug, or general for a cross-project preference." },
  topic: { type: "string", description: "Stable topic slug, for example handoff-columns. Reuse it for corrections." },
};

function definition(name, description, properties, readOnly) {
  return {
    name, description,
    inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
  };
}

const tools = [
  definition("work_memory_get", "Read the caller's opted-in work note. Get its current content and revision (null if absent) before saving.", fields, true),
  definition("work_memory_save", "Save one concise, confirmed work note for the opted-in caller. Supply the revision returned by work_memory_get. A conflicting concurrent update fails safely.", {
    ...fields,
    content: { type: "string", minLength: 1, maxLength: LIMIT, description: "One concise work preference, adopted standard or decision, without transcripts, instructions to the agent, credentials or private data." },
    expected_revision: { type: ["string", "null"], description: "The previous revision returned by work_memory_get, or null for a confirmed new note." },
  }, false),
];

class NoteError extends Error {}
class BusyError extends NoteError {}
const conflict = () => new NoteError("记忆已变化。重新读取并比较；若两项决定矛盾，请让员工确认。");
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function parse(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).length !== tool.inputSchema.required.length
      || !tool.inputSchema.required.every(key => Object.hasOwn(args, key))) {
    throw new NoteError("工作记忆工具参数不完整或包含未知字段。");
  }
  const slug = value => typeof value === "string" && value.length <= 64 && SLUG.test(value);
  if (!Object.hasOwn(CATEGORIES, args.kind) || typeof args.kind !== "string" || !slug(args.scope) || !slug(args.topic)) {
    throw new NoteError("kind 需为 preference 或 decision；scope 与 topic 只接受短小写字母、数字和连字符。");
  }
  if (args.kind === "decision" && args.scope === "general") {
    throw new NoteError("项目决定必须使用已确认的项目范围。");
  }
  const root = "viking://~/memories/" + CATEGORIES[args.kind] + "/codex-work/" + args.scope;
  const uri = root + "/" + args.topic + ".md";
  if (name === "work_memory_get") return { root, uri };
  const revision = args.expected_revision;
  if (revision !== null && !(typeof revision === "string" && SHA.test(revision))) {
    throw new NoteError("expected_revision 须使用刚刚读取的修订值。");
  }
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content || [...content].length > LIMIT || /<!--|[\x00-\x08\x0b-\x1f]/.test(content)
      || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{20,}|dGVhbQ\.[\w-]+\.[\w-]{16,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/i.test(content)) {
    throw new NoteError("请只提供一条简短的工作结论，并去除凭据、隐藏标记和控制字符。");
  }
  return { root, uri, content, revision };
}

async function api(fetchImpl, config, method, route, body) {
  // Enrollment also verifies that mcpUrl is exactly the enrolled personal endpoint.
  // Always use this one origin; never forward credentials via a redirect or URL input.
  const dest = new URL(config.mcpUrl);
  if (dest.pathname !== "/mcp" || !["https:", "http:"].includes(dest.protocol) || dest.username || dest.password || dest.search || dest.hash) {
    throw new NoteError("请检查本机绑定的个人知识库连接。");
  }
  const response = await fetchImpl(dest.origin + "/api/v1/" + route, {
    method, headers: buildOvHeaders(config, { identityHeaders: false }),
    redirect: "error", signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (response.ok && result?.status === "ok") return result.result;
  if (method === "GET" && response.status === 404 && result?.error?.code === "NOT_FOUND") return null;
  if (response.status === 409) {
    const details = result?.error?.details;
    if (details?.conflict_type === "path_busy" && details.retryable === true) {
      throw new BusyError("知识库目录仍忙。稍后重新读取该条目再决定是否重试。");
    }
    throw conflict();
  }
  throw new NoteError("知识库未完成请求（HTTP " + response.status + "），请核对服务或本人权限。");
}

async function getNote(fetchImpl, cfg, uri) {
  const raw = await api(fetchImpl, cfg, "GET", "content/read?" + new URLSearchParams({ uri, raw: "true" }));
  if (raw === null) return { uri, content: null, revision: null };
  if (typeof raw !== "string" || !raw.startsWith(MARKER)) {
    throw new NoteError("该位置已有其他来源的文件，本工具不会修改它。");
  }
  // OpenViking appends versioned MEMORY_FIELDS to memory files. This suffix is
  // server-owned, while CAS always protects the exact raw bytes, including it.
  let content = raw.slice(MARKER.length);
  const suffix = /\n\n<!-- MEMORY_FIELDS\n(\{[\s\S]*\})\n-->\s*$/.exec(content);
  if (suffix) {
    try {
      const metadata = JSON.parse(suffix[1]);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
    } catch {
      throw new NoteError("记忆元数据格式异常，已保留原文件。");
    }
    content = content.slice(0, suffix.index);
  }
  return { uri, content, revision: digest(raw) };
}

async function ensureCategory(fetchImpl, cfg, root) {
  const stat = () => api(fetchImpl, cfg, "GET", "fs/stat?" + new URLSearchParams({ uri: root }));
  let directory = await stat();
  if (directory === null) {
    try {
      await api(fetchImpl, cfg, "POST", "fs/mkdir", { uri: root });
    } catch (error) {
      // A second device may create the category between stat and mkdir.
      if (!(await stat())?.isDir) throw error;
    }
  } else if (!directory.isDir) {
    throw new NoteError("工作记忆类别目录被文件占用。");
  }
}

export function createWorkMemoryTools({ isEnabled = workMemoryEnabled, fetchImpl = globalThis.fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  async function authorize(config) {
    if (!await isEnabled(process.cwd(), config)) {
      throw new NoteError("工作记忆未开启，或当前知识库身份与登记不符。");
    }
  }
  return {
    listTools: () => tools,
    async callTool({ name, arguments: args }, { config }) {
      try {
        await authorize(config);
        const note = parse(name, args);
        if (config.apiKey && note.content?.includes(config.apiKey)) {
          throw new NoteError("请先去除凭据再保存工作结论。");
        }
        const current = await getNote(fetchImpl, config, note.uri);
        let result = current;
        if (name === "work_memory_save") {
          if (current.content === note.content) {
            result = { uri: note.uri, revision: current.revision, status: "unchanged" };
          } else {
            if (current.revision !== note.revision) throw conflict();
            const op = {
              uri: note.uri, mode: "upsert", content: MARKER + note.content,
              ...(note.revision === null ? { if_absent: true } : { expected_sha256: note.revision }),
            };
            // Indexing may briefly hold the same directory lock. Retry only the
            // server's explicit transient lock error, with the SAME CAS revision.
            for (let attempt = 0;; attempt++) {
              await authorize(config);
              try {
                if (note.revision === null) await ensureCategory(fetchImpl, config, note.root);
                await authorize(config);
                await api(fetchImpl, config, "POST", "content/batch-write", {
                  root_uri: note.root, operations: [op], edit_source: "agent", wait: false,
                });
                break;
              } catch (error) {
                if (!(error instanceof BusyError) || attempt >= 7) throw error;
                const backoff = Math.min(150 * 2 ** attempt, 1800);
                await delay(backoff + Math.random() * 100);
              }
            }
            const saved = await getNote(fetchImpl, config, note.uri);
            if (saved.content !== note.content) throw conflict();
            result = { uri: note.uri, revision: saved.revision, status: note.revision === null ? "created" : "updated" };
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        // Do not expose headers, server response bodies or transport diagnostics in chat.
        const text = error instanceof NoteError ? error.message : "无法确认工作记忆操作结果。请检查连接，重新读取该条目后再决定是否重试。";
        return { isError: true, content: [{ type: "text", text }] };
      }
    },
  };
}
