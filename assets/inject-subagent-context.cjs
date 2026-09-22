#!/usr/bin/env node
/**
 * preToolUse hook — 在 Daedalus 子 Agent（Task 调用）启动前自动注入工作流上下文。
 *
 * push 模式：拦截 Task 工具调用，读取当前 workflow step 绑定的 skills/rules/knowledge，
 * 将内容注入到子 Agent 的 prompt 前面，使其启动即拥有完整上下文，无需手动调用 MCP。
 *
 * 输入：Cursor preToolUse hook stdin JSON（tool_name, tool_input, cwd 等）
 * 输出：{ "permission": "allow", "updated_input": { ...tool_input, "prompt": "注入后的 prompt" } }
 */
const fs = require("node:fs");
const path = require("node:path");

const DAEDALUS_AGENTS = new Set([
  "daedalus-implementation",
  "daedalus-quality-review",
  "daedalus-research",
]);

const MAX_FILE_BYTES = 32768;
const MAX_TOTAL_BYTES = 131072;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readText(file, maxBytes) {
  try {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(file, "r");
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    const content = buf.slice(0, bytesRead).toString("utf8");
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return content + `\n[truncated at ${maxBytes} bytes — read ${file} for full content]`;
    return content;
  } catch { return null; }
}

/** 解析 subagent_type，兼容 Cursor 的多种编码 */
function extractSubagentType(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of ["subagent_type", "subagentType", "subagent_type_name", "subagentTypeName", "name"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "object" && value) {
      if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
      const custom = value.custom;
      if (typeof custom === "object" && custom && typeof custom.name === "string") return custom.name.trim();
      const oneof = value.type;
      if (typeof oneof === "object" && oneof && oneof.case === "custom" && typeof oneof.value?.name === "string") return oneof.value.name.trim();
      if (typeof oneof === "object" && oneof && typeof oneof.case === "string") return oneof.case;
    }
  }
  return "";
}

/** 从 .daedalus/config.json 和 state.json 解析当前 workflow step */
function resolveCurrentStep(daedalusDir, sessionId) {
  const config = readJson(path.join(daedalusDir, "config.json"), null);
  if (!config) return null;
  const state = readJson(path.join(daedalusDir, "state.json"), { progress: [] });

  const run = sessionId
    ? (state.runs || []).find((r) => r.cursorSessionId === sessionId && r.status !== "completed")
    : undefined;

  const workflow = config.workflows?.find((w) => w.id === (run?.workflowId || config.activeWorkflowId))
    || config.workflows?.[0];
  if (!workflow) return null;

  const progress = (state.progress || []).find((p) => p.workflowId === workflow.id) || {};
  const stepId = run?.stepId || progress.currentStepId || workflow.steps?.[0]?.id;
  const step = workflow.steps?.find((s) => s.id === stepId);
  if (!step) return null;

  return { config, workflow, step, run, language: process.env.DAEDALUS_LANGUAGE || "en" };
}

/** 收集 installed skills/rules 的内容 */
function collectInstalledContent(workspace, step, budget) {
  const blocks = [];
  const cursorDir = path.join(workspace, ".cursor");
  const ids = [...(step.skillIds || []), ...(step.ruleIds || [])];

  for (const id of ids) {
    if (budget.used >= budget.max) break;
    const [kind, ...slugParts] = id.split(":");
    const slug = slugParts.join(":");
    const cursorSlug = slug.startsWith("daedalus-") ? slug : `daedalus-${slug}`;

    let filePath;
    if (kind === "skill") {
      filePath = path.join(cursorDir, "skills", cursorSlug, "SKILL.md");
    } else if (kind === "rule") {
      filePath = path.join(cursorDir, "rules", `${cursorSlug}.mdc`);
      if (!fs.existsSync(filePath)) filePath = path.join(cursorDir, "rules", `${cursorSlug}.md`);
    } else if (kind === "agent") {
      filePath = path.join(cursorDir, "agents", `${cursorSlug}.md`);
    }
    if (!filePath || !fs.existsSync(filePath)) continue;

    const remaining = budget.max - budget.used;
    const cap = Math.min(MAX_FILE_BYTES, remaining);
    const content = readText(filePath, cap);
    if (!content) continue;

    const block = `=== ${kind}: ${slug} ===\n${content}`;
    budget.used += Buffer.byteLength(block, "utf8");
    blocks.push(block);
  }
  return blocks;
}

/** 收集 knowledge 内容 */
function collectKnowledge(daedalusDir, step, budget) {
  const blocks = [];
  const knowledgeIds = step.knowledgeIds || [];
  if (!knowledgeIds.length) return blocks;

  const knowledgeDir = path.join(daedalusDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return blocks;

  for (const id of knowledgeIds) {
    if (budget.used >= budget.max) break;
    const candidates = [
      path.join(knowledgeDir, `${id}.md`),
      path.join(knowledgeDir, id, "index.md"),
      path.join(knowledgeDir, id, "README.md"),
    ];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) continue;

    const remaining = budget.max - budget.used;
    const cap = Math.min(MAX_FILE_BYTES, remaining);
    const content = readText(found, cap);
    if (!content) continue;

    const block = `=== knowledge: ${id} ===\n${content}`;
    budget.used += Buffer.byteLength(block, "utf8");
    blocks.push(block);
  }
  return blocks;
}

function buildInjectedPrompt(agentType, context, originalPrompt, language) {
  const { workflow, step, run } = context;
  const zh = language === "zh-CN";

  const header = zh
    ? `<!-- daedalus-context-injected -->
# Daedalus 工作流上下文

你是 Daedalus 工作台中"${workflow.name}"流程的"${step.name}"阶段的执行 Agent（${agentType}）。
以下是本阶段绑定的 Skills、Rules 和 Knowledge，已由 preToolUse hook 自动注入。
请按这些规范执行任务，不需要再调用 workflow_context。
结束前仍需调用 workflow_report 报告状态（ready/continue/blocked）。`
    : `<!-- daedalus-context-injected -->
# Daedalus Workflow Context

You are executing the "${step.name}" stage of the "${workflow.name}" workflow as ${agentType}.
The Skills, Rules, and Knowledge bound to this stage are injected below by the preToolUse hook.
Follow these standards directly — no need to call workflow_context.
Before finishing, call workflow_report with status ready, continue, or blocked.`;

  const runInfo = run ? (zh ? `\nRun ID: ${run.id}` : `\nRun ID: ${run.id}`) : "";

  return `${header}${runInfo}`;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  if (!payload || typeof payload !== "object") return;

  const toolName = (payload.tool_name || payload.toolName || "").toLowerCase();
  if (toolName !== "task" && toolName !== "subagent") return;

  const toolInput = payload.tool_input || payload.toolInput || {};
  const agentType = extractSubagentType(toolInput);
  if (!DAEDALUS_AGENTS.has(agentType)) return;

  const cwd = payload.cwd || process.env.CURSOR_PROJECT_DIR || process.cwd();
  const daedalusDir = path.join(cwd, ".daedalus");
  if (!fs.existsSync(path.join(daedalusDir, "config.json"))) return;

  const sessionId = payload.conversation_id || payload.conversationId
    || payload.session_id || payload.sessionId;

  const context = resolveCurrentStep(daedalusDir, sessionId);
  if (!context) return;

  const budget = { used: 0, max: MAX_TOTAL_BYTES };

  const specBlocks = collectInstalledContent(cwd, context.step, budget);
  const knowledgeBlocks = collectKnowledge(daedalusDir, context.step, budget);

  if (!specBlocks.length && !knowledgeBlocks.length) return;

  const header = buildInjectedPrompt(agentType, context, toolInput.prompt || "", context.language);
  const allBlocks = [header, ...specBlocks, ...knowledgeBlocks];
  const injectedContext = allBlocks.join("\n\n");

  const originalPrompt = toolInput.prompt || "";
  const newPrompt = `${injectedContext}\n\n---\n\n${originalPrompt}`;

  const updatedInput = { ...toolInput, prompt: newPrompt };
  const output = {
    permission: "allow",
    updated_input: updatedInput,
  };

  process.stdout.write(JSON.stringify(output, null, 0) + "\n");
}

main().catch(() => {}).finally(() => {
  // 确保即使出错也不阻塞 Cursor
  if (!process.stdout.writableEnded) {
    try { process.stdout.write(""); } catch { /* ignore */ }
  }
});
