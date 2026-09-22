#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { /* ignore malformed hook input */ }
  const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const daedalus = path.join(root, ".daedalus");
  const config = readJson(path.join(daedalus, "config.json"), null);
  if (config?.settings?.feedbackEnabled !== true) return process.stdout.write("{}\n");
  const state = readJson(path.join(daedalus, "state.json"), { gates: [] });
  const sessionId = payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId;
  const run = typeof sessionId === "string" ? state.runs?.find((item) => item.cursorSessionId === sessionId) : undefined;
  const pending = state.gates?.find((item) => item.status === "pending" && item.origin === "hook" && (run ? item.runId === run.id : item.cursorSessionId === sessionId));
  const loopCount = Number(payload.loop_count || payload.loopCount || 0);
  if (!pending || loopCount >= 3) return process.stdout.write("{}\n");
  const followup = `Daedalus feedback is enabled for this Workspace and the previous response asked the user a question outside the required channel. Call the Daedalus MCP request_feedback tool now with runId \"${pending.runId || run?.id}\", threadId \"${pending.id}\", the same title and question, and wait for the response. Do not continue or finish until that tool returns.`;
  process.stdout.write(`${JSON.stringify({ followup_message: followup })}\n`);
}

main().catch(() => process.stdout.write("{}\n"));
