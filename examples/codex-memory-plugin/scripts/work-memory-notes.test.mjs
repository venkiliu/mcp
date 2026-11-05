import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWorkMemoryTools } from "./work-memory-notes.mjs";

const key = { kind: "preference", scope: "general", topic: "handoff-columns" };
const config = { mcpUrl: "http://127.0.0.1:1933/mcp", apiKey: "fixture-only" };
const savedBody = content => "<!-- ov-work-memory:v1 -->\n" + content + '\n\n<!-- MEMORY_FIELDS\n{"version":1}\n-->';
const sha = text => createHash("sha256").update(text).digest("hex");
const res = (status, json) => new Response(JSON.stringify(json), {status});
const ok = result => res(200, {status: "ok", result});
const missing = () => res(404, {status: "error", error: {code: "NOT_FOUND"}});
const conflict = details => res(409, {status: "error", error: {code: "CONFLICT", details}});
const invoke = (tools, name, args) => tools.callTool({name: "work_memory_" + name, arguments: {...key, ...args}}, {config});

test("revoked, invalid, and unowned targets never write", async () => {
  let count = 0;
  const tools = createWorkMemoryTools({isEnabled: () => false, fetchImpl: () => count++});
  assert.ok((await invoke(tools, "get", {})).isError);
  assert.equal(count, 0);
  const enabled = createWorkMemoryTools({isEnabled: () => true, fetchImpl: (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    count++; return ok("existing employee-authored file");
  }});
  assert.ok((await invoke(enabled, "save", {scope: "../someone", content: "x", expected_revision: null})).isError);
  assert.equal(count, 0);
  assert.ok((await invoke(enabled, "save", {content: "x", expected_revision: null})).isError);
  assert.equal(count, 1);
});

test("server metadata remains in the revision; a locked index retries the same conditional write", async () => {
  let raw = null, busy = true;
  const versions = [];
  const tools = createWorkMemoryTools({isEnabled: () => true, delay: async () => {}, fetchImpl: async (url, init) => {
    const {pathname} = new URL(url);
    if (pathname.endsWith("content/read")) return raw === null ? missing() : ok(raw);
    if (pathname.endsWith("fs/stat")) return ok({isDir: true});
    assert.ok(pathname.endsWith("content/batch-write"));
    const {operations: [op]} = JSON.parse(init.body);
    versions.push(op.expected_sha256 ?? null);
    if (busy) {
      busy = false;
      return conflict({conflict_type: "path_busy", retryable: true});
    }
    assert.ok(raw === null ? op.if_absent === true : op.expected_sha256 === sha(raw));
    raw = op.content + '\n\n<!-- MEMORY_FIELDS\n{"version":1}\n-->';
    return ok({});
  }});
  const created = (await invoke(tools, "save", {content: "One", expected_revision: null})).structuredContent;
  assert.equal(created.status, "created");
  assert.equal(created.revision, sha(savedBody("One")));
  const get = (await invoke(tools, "get", {})).structuredContent;
  assert.equal(get.content, "One");
  assert.equal((await invoke(tools, "save", {content: "One", expected_revision: null})).structuredContent.status, "unchanged");
  assert.equal((await invoke(tools, "save", {content: "Two", expected_revision: get.revision})).structuredContent.status, "updated");
  assert.ok((await invoke(tools, "save", {content: "Three", expected_revision: get.revision})).isError);
  assert.deepEqual(versions, [null,null,get.revision]);
});

test("a real concurrent change is never retried as transient or overwritten", async () => {
  let writes = 0;
  const raw = savedBody("First");
  const tools = createWorkMemoryTools({isEnabled: () => true, fetchImpl: async (url, init) => {
    if (init.method === "GET") return ok(raw);
    writes++;
    return conflict({conflict_type: "revision_mismatch"});
  }});
  const result = await invoke(tools, "save", {content: "Different", expected_revision: sha(raw)});
  assert.ok(result.isError);
  assert.equal(writes, 1);
});
