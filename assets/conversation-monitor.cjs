#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function keywords(values) {
  const leading = /^(输出|列出|记录|说明|定义|保护|不得|保持|明确|理解|识别|建立|附上|汇总|逐条|增加|复核|引用|确认|执行|验证|produce|list|record|describe|define|preserve|keep|identify|map|attach|summarize|confirm|execute|verify)\s*/i;
  return values.flatMap((value) => String(value).split(/[，。；、,:;|/\n]/)).map((value) => value.trim().replace(leading, "").trim()).filter((value) => value.length >= 3);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { /* ignore malformed hook input */ }
  const text = typeof payload.text === "string" ? payload.text : "";
  const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const daedalus = path.join(root, ".daedalus");
  const config = readJson(path.join(daedalus, "config.json"), null);
  const state = readJson(path.join(daedalus, "state.json"), { progress: [] });
  const sessionId = payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId;
  const run = typeof sessionId === "string" ? state.runs?.find((item) => item.cursorSessionId === sessionId) : undefined;
  const workflow = config?.workflows?.find((item) => item.id === (run?.workflowId || config.activeWorkflowId)) || config?.workflows?.[0];
  if (!workflow || !text) return;
  const progress = state.progress?.find((item) => item.workflowId === workflow.id) || { currentStepId: workflow.steps?.[0]?.id };
  const currentIndex = workflow.steps?.findIndex((item) => item.id === (run?.stepId || progress.currentStepId)) ?? -1;
  const current = workflow.steps?.[currentIndex];
  const next = workflow.steps?.[currentIndex + 1];
  if (!current) return;
  const asksForUserInput = /[?？]\s*$/.test(text.trim()) || /(请.{0,12}(确认|选择|回复|告诉)|是否.{0,16}(继续|同意|采用|需要)|你希望|您希望|would you|do you want|which (?:option|approach))/i.test(text);
  if (config?.settings?.feedbackEnabled === true && asksForUserInput && !state.gates?.some((item) => item.status === "pending" && (!run || item.runId === run.id))) {
    const now = new Date().toISOString();
    const message = text.trim().slice(0, 10_000);
    const gate = { id: crypto.randomUUID(), type: "feedback", title: `${current.name} · 需要反馈`, message, workflowId: workflow.id, stepId: current.id, runId: run?.id, cursorSessionId: typeof sessionId === "string" ? sessionId : undefined, createdAt: now, updatedAt: now, status: "pending", origin: "hook", messages: [{ role: "agent", content: message, createdAt: now }] };
    state.version = 2;
    state.gates = [gate, ...(state.gates || [])];
    state.progress = state.progress || [];
    if (run) { run.feedbackThreadId = gate.id; run.status = "waiting_feedback"; run.updatedAt = now; run.message = message; }
    writeJson(path.join(daedalus, "state.json"), state);
  }
  if (!next) return;
  const signalFile = path.join(daedalus, "conversation-signal.json");
  const existing = readJson(signalFile, null);
  if (existing?.workflowId === workflow.id && existing?.currentStepId === current.id) return;
  const normalized = text.toLowerCase();
  const explicit = normalized.includes("daedalus-next-step");
  const namesNext = normalized.includes(String(next.name).toLowerCase());
  const complete = /(已完成|完成了|已经完成|实现完成|测试通过|验证通过|可以进入|进入下一|下一步|接下来|completed|implemented|tests? (?:pass|passed)|verification passed|ready (?:for|to)|next step)/i.test(text);
  const evidence = keywords([current.name, ...(current.standards || [])]).some((word) => normalized.includes(word.toLowerCase()));
  if (!explicit && !namesNext && !(complete && evidence)) return;
  const now = new Date().toISOString();
  const signal = { version: 1, runId: run?.id, workflowId: workflow.id, currentStepId: current.id, suggestedStepId: next.id, suggestedStepName: next.name, status: "ready", excerpt: text.trim().slice(0, 500), detectedAt: now };
  if (run) { run.status = "ready_suggested"; run.updatedAt = now; run.summary = signal.excerpt; run.message = signal.excerpt; writeJson(path.join(daedalus, "state.json"), state); }
  writeJson(signalFile, signal);
}

main().catch(() => {}).finally(() => process.stdout.write("{}\n"));
