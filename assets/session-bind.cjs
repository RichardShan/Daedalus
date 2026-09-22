#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const match = prompt.match(/Daedalus runId:\s*([0-9a-f-]{16,})/i);
  const sessionId = payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId;
  if (!match || typeof sessionId !== "string" || !sessionId.trim()) return;
  const root = process.env.CURSOR_PROJECT_DIR || process.cwd();
  const stateFile = path.join(root, ".daedalus", "state.json");
  const state = readJson(stateFile, null);
  const run = state?.runs?.find((item) => item.id === match[1]);
  if (!run || run.channel !== "cursor-native") return;
  const now = new Date().toISOString();
  run.cursorSessionId = sessionId.trim();
  run.cursorSessionKind = "native-ui";
  run.status = "running";
  run.updatedAt = now;
  run.message = "Cursor native conversation connected";
  state.activeRunId = run.id;
  for (const gate of state.gates || []) if (gate.runId === run.id) gate.cursorSessionId = run.cursorSessionId;
  writeJson(stateFile, state);
}

main().catch(() => {}).finally(() => process.stdout.write("{}\n"));
