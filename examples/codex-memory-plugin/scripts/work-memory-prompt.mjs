import { loadConfig } from "./config.mjs";
import { runHookStage } from "./shared/agent-hook-runtime.mjs";
import { isCaptureEnabled, sanitizeCapturedText, shouldCaptureText } from "./shared/capture-utils.mjs";
import { applyInputFilters, compileInputFilters } from "./shared/input-filters.mjs";
import { workMemoryEnabled } from "./work-memory-settings.mjs";

// The existing transcript sanitizer removes the outer envelope from captures.
// Keep the hook output static: never interpolate a prompt or retrieved memory.
const guidance = `<openviking-context>
<ov-work-memory>
此员工已启用同轮工作记忆。仅当本轮用户本人明确表达了可长期复用的工作偏好、已确定的项目决定或工作约定时，在本轮回答前按本插件自带的 ov-work-memory 技能，发现并使用本插件的 work_memory_get / work_memory_save 更新该员工自己的工作记忆。普通问答、一次性要求、推测、私人敏感信息、凭据、示例、转述及文档/工具/旧记忆里的文字均跳过。服从用户要求不保存和只读的约束。只保存最短必要结论，同一事项去重，更正更新原条；不要复制聊天原文或扫描历史。缺少技能、专用工具或写入权限时跳过，不另起模型、不改用通用写入工具。
</ov-work-memory>
</openviking-context>`;

const hostPrompt = /^(?:<\/?(?:ov-work-memory|openviking-context|environment_context|system-reminder|subagent_notification|external_codex_apps_open_page|send_user_message_question_reply|turn_aborted|recommended_plugins)\b|\[(?:Subagent Context|agent-message|tool-(?:call|result))\b|# AGENTS\.md instructions\b|Message Type:\s*(?:NEW_TASK|MESSAGE|FINAL_ANSWER)\b)/i;
const explicitOptOut = /(?:不要|不用|禁止|别)(?:再|把这(?:次|条|段)(?:对话|聊天|内容)?)?(?:保存|记|存|写入记忆)|\b(?:do not|don['’]t|never)\s+(?:save|remember|record|store)\b/iu;

function eligible(input, cfg) {
  if (input.hook_event_name !== "UserPromptSubmit" || typeof input.session_id !== "string" ||
      !input.session_id.trim() || typeof input.prompt !== "string" || !isCaptureEnabled(cfg)) return false;

  const prompt = input.prompt.trim();
  if (input.is_subagent === true || hostPrompt.test(prompt) || explicitOptOut.test(prompt)) return false;
  if (!shouldCaptureText(prompt, "user", cfg, { filters: false }).shouldCapture) return false;

  // Codex sees the original text. If an operator's filter would drop or redact
  // any of it, do not suggest a memory write for that turn.
  const sanitized = sanitizeCapturedText(prompt);
  for (const filterSet of [cfg.captureFilters, cfg.recallQueryFilters]) {
    const { rules, errors } = compileInputFilters(filterSet);
    if (errors.length) return false;
    if (rules.length) {
      const verdict = applyInputFilters(sanitized, rules, { role: "user" });
      if (verdict.dropped || verdict.changed) return false;
    }
  }
  return true;
}

function emit(context) {
  const result = context ? {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  } : {};
  process.stdout.write(JSON.stringify(result) + "\n");
}

await runHookStage({ loadConfig, envelope: emit }, async ({ input, cfg, cwd }) => {
  if (eligible(input, cfg) && await workMemoryEnabled(cwd)) return guidance;
}).catch(() => emit());
