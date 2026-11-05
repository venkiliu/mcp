import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeCapturedText } from "./shared/capture-utils.mjs";

test("a real opted-in prompt gets static guidance even without recall; excluded turns emit nothing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ov-work-hook-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, "ovcli.conf");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENVIKING_")));
  Object.assign(env, { CODEX_HOME: dir, OPENVIKING_CLI_CONFIG_FILE: configFile, OPENVIKING_CONFIG_FILE: join(dir, "unused.conf") });
  const key = ["team", "hook-fixture", "synthetic"].map(s => Buffer.from(s).toString("base64url")).join(".");
  await writeFile(configFile, JSON.stringify({ url: "http://127.0.0.1:1933", api_key: key, plugin: { codex: { auth_mode: "api_key", autoRecall: false } } }));
  const input = { hook_event_name: "UserPromptSubmit", session_id: "fixture-session", cwd: dir, prompt: "今后交接清单都请用两列：负责人和截止日期。" };
  function run(filename, args, stdin, extraEnv) {
    const script = fileURLToPath(new URL(filename, import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...env, ...extraEnv }, input: stdin, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const hook = (event = input, extraEnv = {}) => run("./work-memory-prompt.mjs", [], JSON.stringify(event), extraEnv);
  assert.deepEqual(hook(), {});
  assert.equal(run("./work-memory-settings.mjs", ["--enable"], "").enabled, true);
  const output = hook().hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.ok(output.additionalContext.includes("<ov-work-memory>") && output.additionalContext.includes("ov-work-memory 技能"));
  assert.ok(!output.additionalContext.includes(input.prompt));
  assert.equal(sanitizeCapturedText(output.additionalContext), "");
  assert.equal(hook({ ...input, prompt: "以后项目周报使用中文。" }).hookSpecificOutput.additionalContext, output.additionalContext);
  for (const event of [
    { ...input, hook_event_name: "Stop" }, { ...input, session_id: "" }, { ...input, prompt: "/clear" },
    { ...input, prompt: "不要记录这个工作决定" }, { ...input, prompt: "以后周报用中文，这条别记" },
    { ...input, prompt: "今后的工作清单按姓名排列，但别存" }, { ...input, prompt: "不用记，帮我处理当前工作" },
    { ...input, prompt: output.additionalContext },
    { ...input, is_subagent: true },
  ]) assert.deepEqual(hook(event), {});
  for (const extraEnv of [
    { OPENVIKING_BYPASS_SESSION: "true" }, { OPENVIKING_AUTO_CAPTURE: "false" },
    { OPENVIKING_CAPTURE_FILTERS: "d/交接清单/" }, { OPENVIKING_RECALL_QUERY_FILTERS: "s/负责人/匿名/" },
  ]) assert.deepEqual(hook(input, extraEnv), {});
});
