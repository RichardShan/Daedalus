import * as vscode from "vscode";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import {
  advanceWorkflow,
  artifactOutputRoot,
  cursorLibraryPath,
  daedalusDir,
  feedbackTitleFromContent,
  initializeWorkspace,
  loadGlobalConfig,
  loadConfig,
  loadState,
  newId,
  progressFor,
  reusableNativeCursorSessionId,
  parseStandaloneAgentResponse,
  saveConfig,
  saveGlobalConfig,
  saveState,
  scanAgentArtifacts,
  scanKnowledge,
  scanLibrary,
  setActiveWorkflow,
  setCurrentWorkflowStep,
  writeAgentArtifact,
  type LocalChange,
  type Gate,
  type RuntimeState,
  type LibraryItem,
  type WorkflowProgress,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkspaceConfig,
} from "./shared.js";

const execFileAsync = promisify(execFile);
let panel: vscode.WebviewPanel | undefined;
let panelMessageQueue: Promise<void> = Promise.resolve();
let statusBarItem: vscode.StatusBarItem | undefined;
const DAEDALUS_STATUS_ICON = "$(hubot)";
let globalHome = "";
let extensionRoot = "";
let extensionVersion = "0.0.0";
let extensionIdentifier = "local.daedalus-pipeline";

interface AgentExecution {
  status: "idle" | WorkflowRunStatus;
  runId?: string;
  workflowId?: string;
  stepId?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}
const agentExecutions = new Map<string, AgentExecution>();
const agentProcesses = new Map<string, ChildProcess>();
const feedbackProcesses = new Map<string, ChildProcess>();
const localChangeQueues = new Map<string, Promise<void>>();
const runtimeStateQueues = new Map<string, Promise<void>>();
const gitBackedWorkspaces = new Set<string>();

type UiLanguage = "zh-CN" | "en";
type UiTheme = "auto" | "light" | "dark";

/** 纯编辑器语言检测：中文语言包 active → zh-CN，其余 → en */
function detectEditorLanguage(): UiLanguage {
  const envLang = vscode.env.language.toLowerCase();
  if (!envLang.startsWith("zh")) return "en";
  const chinesePack = vscode.extensions.getExtension("MS-CEINTL.vscode-language-pack-zh-hans") || vscode.extensions.getExtension("MS-CEINTL.vscode-language-pack-zh-hant");
  return chinesePack?.isActive ? "zh-CN" : "en";
}

function languageSetting(fallback: "auto" | UiLanguage = "auto"): "auto" | UiLanguage {
  const inspected = vscode.workspace.getConfiguration("daedalus").inspect<"auto" | UiLanguage>("language");
  return inspected?.globalValue ?? fallback;
}
function effectiveLanguage(selected: "auto" | UiLanguage = languageSetting()): UiLanguage {
  if (selected !== "auto") return selected;
  return detectEditorLanguage();
}
function localize(zh: string, en: string): string { return effectiveLanguage() === "zh-CN" ? zh : en; }
function themeSetting(): UiTheme { return vscode.workspace.getConfiguration("daedalus").inspect<UiTheme>("theme")?.globalValue ?? "auto"; }
function feedbackSetting(fallback = false): boolean { return vscode.workspace.getConfiguration("daedalus").inspect<boolean>("feedbackEnabled")?.globalValue ?? fallback; }
function continuousFeedbackSetting(fallback = false): boolean { return vscode.workspace.getConfiguration("daedalus").inspect<boolean>("continuousFeedback")?.globalValue ?? fallback; }
function editorTheme(): "light" | "dark" { return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark"; }

function workspacePath(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
function nonce(): string { return Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join(""); }
function slug(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || newId("item"); }
function normalizeImportSubpath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").slice(0, 500);
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("-") || /^[A-Za-z]:/.test(normalized) || segments.some((part) => !part || part === "." || part === "..")) throw new Error(localize("仓库内路径必须是安全的相对路径，不能包含 .. 或绝对路径", "Repository path must be a safe relative path without .. or an absolute path."));
  return normalized;
}
function normalizeOutputDirectory(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").slice(0, 500) || ".";
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || segments.some((part) => !part || part === "..")) throw new Error(localize("输出目录必须是安全的相对路径，不能包含 .. 或绝对路径", "Output directory must be a safe relative path without .. or an absolute path."));
  return normalized;
}

async function copyMissingTree(source: string, destination: string): Promise<void> {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); } catch { return; }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyMissingTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
}

async function installBundledDefaults(root: string, extensionUri: vscode.Uri): Promise<void> {
  const source = path.join(extensionUri.fsPath, "assets", "bundled");
  await Promise.all(["skills", "rules", "agents"].map((kind) => copyMissingTree(path.join(source, kind), path.join(daedalusDir(root), kind))));
}

function installedStandardContent(item: LibraryItem): string {
  if (item.kind === "agent") return item.content;
  const description = item.description.replace(/\r?\n/g, " ").trim() || item.name;
  const body = item.content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
  if (item.kind === "skill") {
    const name = path.basename(path.dirname(cursorLibraryPath("/", item))).replace(/^daedalus-/, "");
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  }
  return `---\ndescription: ${description}\nglobs: []\nalwaysApply: false\n---\n\n${body}\n`;
}

async function syncCursorStandards(root: string): Promise<void> {
  const config = await loadConfig(root);
  if (!config) return;
  const library = await scanLibrary(root, config, globalHome, effectiveLanguage());
  const manifestPath = path.join(daedalusDir(root), "cursor-installations.json");
  const previous = await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as Array<{ path: string; kind: LibraryItem["kind"] }>).catch(() => []);
  const desired: Array<{ path: string; kind: LibraryItem["kind"] }> = [];
  for (const item of library.filter((entry) => entry.source !== "native")) {
    const destination = cursorLibraryPath(root, item);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, installedStandardContent(item), "utf8");
    desired.push({ path: destination, kind: item.kind });
  }
  const desiredPaths = new Set(desired.map((item) => path.resolve(item.path)));
  const allowedRoots = [path.resolve(root, ".cursor"), path.resolve(homedir(), ".cursor")];
  for (const item of previous) {
    const installed = path.resolve(item.path);
    if (desiredPaths.has(installed) || !allowedRoots.some((allowed) => installed.startsWith(`${allowed}${path.sep}`))) continue;
    if (item.kind === "skill") await rm(path.dirname(installed), { recursive: true, force: true });
    else await rm(installed, { force: true });
  }
  await writeJsonFile(manifestPath, desired);
}

async function uninstallImportedStandards(root: string, importId: string, scope: "project" | "global"): Promise<void> {
  const config = await loadConfig(root);
  if (!config) return;
  const library = await scanLibrary(root, config, globalHome, effectiveLanguage());
  for (const item of library.filter((entry) => entry.importId === importId && entry.scope === scope)) {
    const installed = cursorLibraryPath(root, item);
    if (item.kind === "skill") await rm(path.dirname(installed), { recursive: true, force: true });
    else await rm(installed, { force: true });
  }
}

type JsonObject = Record<string, unknown>;
interface ConversationSignal { version: 1; runId?: string; workflowId: string; currentStepId: string; suggestedStepId: string; suggestedStepName: string; status?: "ready" | "continue" | "blocked"; excerpt: string; detectedAt: string; acknowledgedAt?: string; }

async function readJsonFile(file: string): Promise<JsonObject> {
  try { const value = JSON.parse(await readFile(file, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(localize(`无法解析 ${file}，请先修复 JSON 格式`, `Could not parse ${file}. Fix its JSON syntax first.`)); }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function globalFeedbackPath(): string { return path.join(globalHome, "feedback-conversations.json"); }
async function loadGlobalFeedback(): Promise<Gate[]> {
  try {
    const value = JSON.parse(await readFile(globalFeedbackPath(), "utf8")) as { version?: number; conversations?: Gate[] };
    return value.version === 1 && Array.isArray(value.conversations)
      ? value.conversations.filter((item) => item?.origin === "user" && typeof item.id === "string" && Array.isArray(item.messages))
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function saveGlobalFeedback(conversations: Gate[]): Promise<void> {
  await writeJsonFile(globalFeedbackPath(), { version: 1, conversations });
}

function mcpDefinition(root: string): JsonObject {
  const timeout = vscode.workspace.getConfiguration("daedalus").get<number>("collaborationTimeoutMinutes", 60);
  return { type: "stdio", command: "node", args: [path.join(__dirname, "mcp-server.cjs")], env: { DAEDALUS_WORKSPACE: root, DAEDALUS_GLOBAL_HOME: globalHome, DAEDALUS_COLLABORATION_TIMEOUT_MINUTES: String(timeout), DAEDALUS_LANGUAGE: effectiveLanguage() } };
}

async function configureWorkspaceMcp(root: string, enabled: boolean): Promise<void> {
  const file = path.join(root, ".cursor", "mcp.json");
  if (!enabled) {
    try { await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  const value = await readJsonFile(file);
  const current = value.mcpServers && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers) ? value.mcpServers as JsonObject : {};
  if (enabled) current.daedalus = mcpDefinition(root); else delete current.daedalus;
  value.mcpServers = current;
  if (!enabled && Object.keys(current).length === 0 && Object.keys(value).every((key) => key === "mcpServers")) { await rm(file, { force: true }); return; }
  await writeJsonFile(file, value);
}

async function removeDaedalusCursorStandards(cursorRoot: string): Promise<void> {
  for (const kind of ["skills", "rules", "agents"] as const) {
    const directory = path.join(cursorRoot, kind);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.name.startsWith("daedalus-")) continue;
      if (kind === "skills" && entry.isDirectory()) await rm(path.join(directory, entry.name), { recursive: true, force: true });
      if (kind !== "skills" && entry.isFile()) await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

async function removeDaedalusHooks(root: string): Promise<void> {
  const file = path.join(root, ".cursor", "hooks.json");
  let value: JsonObject;
  try { value = await readJsonFile(file); } catch { return; }
  const hooks = value.hooks && typeof value.hooks === "object" && !Array.isArray(value.hooks) ? value.hooks as JsonObject : {};
  for (const name of ["afterAgentResponse", "stop", "beforeSubmitPrompt", "preToolUse"]) {
    const entries = Array.isArray(hooks[name]) ? hooks[name] as unknown[] : [];
    const filtered = entries.filter((item) => !(item && typeof item === "object" && "command" in item && String((item as JsonObject).command).includes(".daedalus/scripts/")));
    if (filtered.length) hooks[name] = filtered; else delete hooks[name];
  }
  if (Object.keys(hooks).length) value.hooks = hooks; else delete value.hooks;
  const remaining = Object.keys(value).filter((key) => key !== "version");
  if (!remaining.length) await rm(file, { force: true }); else await writeJsonFile(file, value);
}

async function clearDaedalusSettings(includeGlobal: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("daedalus");
  for (const key of ["collaborationTimeoutMinutes", "cursorAgentPath", "language", "theme", "feedbackEnabled", "continuousFeedback"]) {
    await configuration.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    if (includeGlobal) await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

async function cleanupDaedalus(root: string, includeGlobal: boolean): Promise<void> {
  agentProcesses.get(root)?.kill("SIGTERM");
  agentProcesses.delete(root);
  agentExecutions.delete(root);
  if (includeGlobal) {
    for (const process of feedbackProcesses.values()) process.kill("SIGTERM");
    feedbackProcesses.clear();
  }
  await configureWorkspaceMcp(root, false);
  await removeDaedalusHooks(root);
  await removeDaedalusCursorStandards(path.join(root, ".cursor"));
  await clearDaedalusSettings(includeGlobal);
  await rm(daedalusDir(root), { recursive: true, force: true });
  if (includeGlobal) {
    await removeDaedalusCursorStandards(path.join(homedir(), ".cursor"));
    await rm(globalHome, { recursive: true, force: true });
  }
  gitBackedWorkspaces.delete(root);
}

async function cursorAgentCommand(): Promise<string> {
  const configured = vscode.workspace.getConfiguration("daedalus").get<string>("cursorAgentPath", "").trim();
  const candidates = [configured, path.join(homedir(), ".local", "bin", "cursor-agent"), "cursor-agent"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "cursor-agent") return candidate;
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return "cursor-agent";
}

async function requireCursorAgent(root: string): Promise<string> {
  const command = await cursorAgentCommand();
  try {
    const status = await execFileAsync(command, ["status"], { cwd: root, timeout: 10_000 });
    if (/not logged in/i.test(`${status.stdout}\n${status.stderr}`)) throw new Error("not_logged_in");
  } catch (error) {
    if (error instanceof Error && error.message === "not_logged_in") throw new Error(localize("Cursor Agent CLI 尚未登录，请先在终端运行 cursor-agent login", "Cursor Agent CLI is not signed in. Run cursor-agent login in a terminal first."));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(localize("未找到 Cursor Agent CLI。请先安装 Cursor CLI，或配置 daedalus.cursorAgentPath", "Cursor Agent CLI was not found. Install Cursor CLI or configure daedalus.cursorAgentPath."));
    throw error;
  }
  return command;
}

async function sendStandaloneFeedback(root: string, threadId: string, content: string): Promise<void> {
  if (feedbackProcesses.has(threadId)) throw new Error(localize("此会话正在等待 Agent 回复", "This conversation is waiting for the Agent."));
  const message = content.trim().slice(0, 20_000);
  if (!message) throw new Error(localize("消息不能为空", "Message cannot be empty."));
  const conversations = await loadGlobalFeedback();
  const conversation = conversations.find((item) => item.id === threadId && item.origin === "user");
  if (!conversation) throw new Error(localize("找不到此 Feedback 会话", "Feedback conversation not found."));
  const requestTitle = !(conversation.messages || []).some((item) => item.role === "agent");
  const now = new Date().toISOString();
  conversation.messages = [...(conversation.messages || []), { role: "user", content: message, createdAt: now }];
  conversation.message = message;
  conversation.updatedAt = now;
  await saveGlobalFeedback(conversations);

  const command = await requireCursorAgent(root);
  if (!conversation.cursorSessionId) {
    const created = await execFileAsync(command, ["create-chat"], { cwd: root, timeout: 15_000, maxBuffer: 100_000 });
    const output = `${created.stdout}\n${created.stderr}`.trim();
    const sessionId = output.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || output.split(/\s+/).at(-1);
    if (!sessionId) throw new Error(localize("Cursor Agent 未返回会话 ID", "Cursor Agent did not return a session ID."));
    conversation.cursorSessionId = sessionId;
    await saveGlobalFeedback(conversations);
  }

  const prompt = [
    "You are replying inside a standalone Daedalus Feedback conversation.",
    "This conversation is independent and may be unrelated to the current Workspace. Answer the user's latest message directly and concisely.",
    "Run in read-only Q&A mode. Do not edit files, execute implementation work, or assume a Daedalus workflow exists.",
    requestTitle ? "On the first line, output exactly DAEDALUS_TITLE: <a concise title in the user's language, at most 12 words>. Start the conversational reply on the next line. Do not mention this title instruction in the reply." : "Do not output a DAEDALUS_TITLE line because this conversation already has a title.",
    continuousFeedbackSetting() ? "End with one short, useful question that lets the user continue or adjust the discussion." : "Ask a follow-up only when it materially helps the discussion.",
    `Latest user message:\n${message}`,
  ].join("\n\n");
  const child = spawn(command, ["--trust", "--resume", conversation.cursorSessionId, "--mode", "ask", "-p", "--output-format", "text", prompt], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  feedbackProcesses.set(threadId, child);
  await publishPanelState(root);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-100_000); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000); });
  let settled = false;
  const finish = async (response: string): Promise<void> => {
    if (settled) return;
    settled = true;
    feedbackProcesses.delete(threadId);
    const latest = await loadGlobalFeedback();
    const current = latest.find((item) => item.id === threadId);
    if (current) {
      const parsed = requestTitle ? parseStandaloneAgentResponse(response) : { content: response.trim() };
      if (parsed.title) current.title = parsed.title;
      const agentContent = parsed.content || localize("Agent 未返回回复正文", "The Agent did not return a reply body.");
      current.messages = [...(current.messages || []), { role: "agent", content: agentContent, createdAt: new Date().toISOString() }];
      current.updatedAt = new Date().toISOString();
      await saveGlobalFeedback(latest);
    }
    await publishPanelState(root);
  };
  child.on("error", (error) => { void finish(localize(`无法启动 Agent：${error.message}`, `Could not start the Agent: ${error.message}`)); });
  child.on("close", (code, signal) => {
    const response = stdout.trim() || localize(`Agent 未能完成回复（${signal || code}）${stderr.trim() ? `：${stderr.trim().slice(-500)}` : ""}`, `The Agent could not complete its reply (${signal || code})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
    void finish(response);
  });
}

function nativeExecutionPrompt(runId: string, workflowId: string, stepId: string, continuousFeedback: boolean, resume: boolean): string {
  return [
    resume ? "Resume the existing Daedalus Workbench stage in this Cursor conversation. Preserve the prior context and continue the multi-turn work." : "Start the current Daedalus Workbench stage directly in this Cursor conversation.",
    `Daedalus runId: ${runId}`,
    `Target workflowId: ${workflowId}`,
    `Target stepId: ${stepId}`,
    "First call the Daedalus MCP tool workflow_context with this exact runId and these exact workflow/step IDs. Follow the returned references to Skills and Rules already installed in Cursor. Retrieve each bound knowledge item with knowledge_search instead of expanding those resources into prompt text.",
    "Work directly in the current workspace. This stage is expected to take multiple conversational turns: complete one coherent work cycle at a time, preserve the session, and do not silently advance the workflow.",
    continuousFeedback
      ? "Continuous feedback is enabled for this Workspace. At every material decision or completed work cycle, use Cursor's native AskQuestion interaction with at least one continue/next option and one adjust-current-work option. Wait for the user's answer before continuing."
      : "Continuous feedback is disabled. Use Cursor's native questions only when the active Cursor Rules or an unresolved decision require them; do not invent a mandatory question loop.",
    "Use agent_output for substantial non-code Markdown deliverables. Before ending a work cycle, call workflow_report with this runId and status ready, continue, or blocked, including a concise summary and concrete evidence. Ready is only a suggestion; the user alone confirms advancement in the Workbench.",
  ].join("\n\n");
}

function executionPrompt(runId: string, workflowId: string, stepId: string, continuousFeedback: boolean, resume = false, latestFeedback?: string): string {
  return [
    resume ? "Resume the existing Daedalus Workbench stage. Preserve its prior context and continue the multi-turn work." : "You are executing a Daedalus Workbench stage inside Cursor Agent.",
    `Daedalus runId: ${runId}`,
    `Target workflowId: ${workflowId}`,
    `Target stepId: ${stepId}`,
    "First call the Daedalus MCP tool workflow_context with this exact runId and these exact workflow/step IDs. It returns references to Skills and Rules already installed in Cursor plus knowledge bound to this stage; follow the installed resources directly and do not ask Daedalus to expand them into prompt text.",
    "Work directly in the current workspace. Do not ask the user to copy a prompt. Retrieve every knowledge item bound to the stage through knowledge_search before using it, and use agent_output for substantial non-code Markdown deliverables.",
    "Pass this runId to workflow_context, workflow_report, request_feedback, and agent_output. All user interaction for this run must use request_feedback. Keep the returned threadId and reuse it so the entire stage remains one multi-round Feedback conversation.",
    ...(latestFeedback ? [`Latest persisted user feedback: ${latestFeedback}`] : []),
    continuousFeedback
      ? "Continuous feedback is enabled for this Workspace. After every substantive work cycle, you MUST call request_feedback before continuing or concluding. Offer at least one concrete continue/next option and one adjust-current-work option."
      : "Continuous feedback is disabled. Ask through request_feedback only when the installed Cursor Rules or an unresolved product decision require it; do not invent a mandatory feedback loop.",
    "Before finishing, always call workflow_report with this runId, status ready, continue, or blocked, a concise summary, and concrete evidence. Use ready only when the current stage standards are satisfied. A ready report is only a suggestion: never advance the workflow; only the user can confirm advancement in the Workbench.",
  ].join("\n");
}

const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>(["completed", "stopped", "failed"]);
function activeStepRun(state: RuntimeState, workflowId: string, stepId: string): WorkflowRun | undefined {
  const preferred = state.activeRunId ? (state.runs || []).find((run) => run.id === state.activeRunId) : undefined;
  if (preferred?.workflowId === workflowId && preferred.stepId === stepId && !TERMINAL_RUN_STATUSES.has(preferred.status)) return preferred;
  return [...(state.runs || [])].reverse().find((run) => run.workflowId === workflowId && run.stepId === stepId && !TERMINAL_RUN_STATUSES.has(run.status));
}

function executionFromRun(run?: WorkflowRun): AgentExecution {
  if (!run) return { status: "idle" };
  return { status: run.status, runId: run.id, workflowId: run.workflowId, stepId: run.stepId, startedAt: run.startedAt, finishedAt: run.finishedAt, message: run.message };
}

async function mutateRuntimeState<T>(root: string, mutate: (state: RuntimeState) => T | Promise<T>): Promise<T> {
  let result: T | undefined;
  const previous = runtimeStateQueues.get(root) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const state = await loadState(root);
    result = await mutate(state);
    await saveState(root, state);
  });
  runtimeStateQueues.set(root, operation.then(() => undefined, () => undefined));
  await operation;
  return result as T;
}

async function terminateAgentProcess(root: string): Promise<void> {
  const child = agentProcesses.get(root);
  if (!child) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    child.once("close", finish);
    child.once("error", finish);
    child.kill("SIGTERM");
    setTimeout(finish, 2_000);
  });
  agentProcesses.delete(root);
  await runtimeStateQueues.get(root)?.catch(() => undefined);
}

async function persistRun(root: string, runId: string, update: (run: WorkflowRun) => void): Promise<WorkflowRun | undefined> {
  return mutateRuntimeState(root, (state) => {
    const run = (state.runs || []).find((item) => item.id === runId);
    if (!run) return undefined;
    update(run);
    run.updatedAt = new Date().toISOString();
    return run;
  });
}

async function startAgentExecution(root: string): Promise<void> {
  if (agentProcesses.has(root)) throw new Error(localize("当前阶段已在执行", "The current stage is already running."));
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const state = await loadState(root);
  const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId) || config.workflows[0];
  if (!workflow) throw new Error(localize("没有可执行的流程", "There is no workflow to execute."));
  const progress = progressFor(state, workflow);
  const step = workflow.steps.find((item) => item.id === progress.currentStepId);
  if (!step) throw new Error(localize("当前流程已经完成", "The current workflow is complete."));
  const missing = (workflow.inputs || []).filter((input) => input.required && !progress.inputs?.[input.id]?.trim());
  if (missing.length) throw new Error(localize(`请先提供必填流程输入：${missing.map((item) => item.name).join("、")}`, `Provide required workflow input first: ${missing.map((item) => item.name).join(", ")}`));

  await configureWorkspaceMcp(root, true);
  const command = await requireCursorAgent(root);
  const now = new Date().toISOString();
  let run = activeStepRun(state, workflow.id, step.id);
  if (run && run.channel !== "feedback") {
    run.status = "stopped";
    run.finishedAt = now;
    run.updatedAt = now;
    run = undefined;
  }
  const recovering = Boolean(run?.cursorSessionId);
  if (!run) {
    run = { id: randomUUID(), workflowId: workflow.id, stepId: step.id, channel: "feedback", status: "starting", startedAt: now, updatedAt: now, message: localize(`正在启动 Cursor Agent · ${step.name}`, `Starting Cursor Agent · ${step.name}`) };
    state.runs = [...(state.runs || []), run];
  } else {
    run.status = "starting";
    run.updatedAt = now;
    run.message = localize(`正在恢复 Cursor Agent · ${step.name}`, `Resuming Cursor Agent · ${step.name}`);
    delete run.finishedAt;
  }
  if (!run.cursorSessionId) {
    const created = await execFileAsync(command, ["create-chat"], { cwd: root, timeout: 15_000, maxBuffer: 100_000 });
    const output = `${created.stdout}\n${created.stderr}`.trim();
    const sessionId = output.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || output.split(/\s+/).at(-1);
    if (!sessionId) throw new Error(localize("Cursor Agent 未返回可恢复的会话 ID", "Cursor Agent did not return a resumable session ID."));
    run.cursorSessionId = sessionId;
    run.cursorSessionKind = "cli";
  }
  state.activeRunId = run.id;
  await saveState(root, state);
  const execution: AgentExecution = executionFromRun(run);
  agentExecutions.set(root, execution);
  await publish(root);

  const latestFeedback = run.feedbackThreadId ? state.gates.find((gate) => gate.id === run?.feedbackThreadId)?.response : undefined;
  const args = ["--trust", "--approve-mcps", "--auto-review"];
  if (run.cursorSessionId) args.push("--resume", run.cursorSessionId);
  args.push("-p", "--output-format", "stream-json", executionPrompt(run.id, workflow.id, step.id, continuousFeedbackSetting(config.settings?.continuousFeedback === true), recovering, latestFeedback));
  const child = spawn(command, args, { cwd: root, env: { ...process.env, DAEDALUS_WORKSPACE: root, DAEDALUS_RUN_ID: run.id }, stdio: ["ignore", "pipe", "pipe"] });
  agentProcesses.set(root, child);
  run.status = "running";
  run.updatedAt = new Date().toISOString();
  run.message = recovering ? localize(`正在恢复 Cursor Agent · ${step.name}`, `Resuming Cursor Agent · ${step.name}`) : localize(`Cursor Agent 正在执行 · ${step.name}`, `Cursor Agent is running · ${step.name}`);
  await saveState(root, state);
  agentExecutions.set(root, executionFromRun(run));
  let buffered = "";
  const runId = run.id;
  const updateOutput = (chunk: Buffer) => {
    buffered = `${buffered}${chunk.toString("utf8")}`.slice(-12_000);
    const lines = buffered.trim().split("\n");
    const last = lines.at(-1) || "";
    try {
      const event = JSON.parse(last) as Record<string, unknown>;
      const sessionId = event.session_id || event.sessionId || event.chat_id || event.chatId;
      if (typeof sessionId === "string" && sessionId.trim()) void persistRun(root, runId, (current) => {
        if (TERMINAL_RUN_STATUSES.has(current.status)) return;
        current.cursorSessionId = sessionId.trim(); current.cursorSessionKind = "cli"; current.status = "running";
      });
      const candidate = event.text || event.message || event.type;
      if (typeof candidate === "string" && candidate.trim()) execution.message = candidate.trim().slice(-500);
    } catch { if (last.trim()) execution.message = last.trim().slice(-500); }
    void publish(root);
  };
  child.stdout.on("data", updateOutput);
  child.stderr.on("data", updateOutput);
  child.on("error", (error) => {
    execution.status = "failed"; execution.finishedAt = new Date().toISOString(); execution.message = error.message;
    agentProcesses.delete(root); void persistRun(root, runId, (current) => { current.status = "failed"; current.finishedAt = execution.finishedAt; current.message = error.message; }).then(() => publish(root));
  });
  child.on("close", async (code, signal) => {
    agentProcesses.delete(root);
    const persisted = await persistRun(root, runId, (current) => {
      if (current.status === "stopped") current.message = localize("已停止当前阶段执行", "Stage execution stopped.");
      else if (code !== 0) { current.status = "failed"; current.finishedAt = new Date().toISOString(); current.message = localize(`Cursor Agent 退出（${signal || code}）`, `Cursor Agent exited (${signal || code}).`); }
      else if (["starting", "running", "continuing"].includes(current.status)) { current.status = "paused"; current.message = localize("执行会话已暂停，可继续当前阶段恢复", "The execution is paused and can be resumed from this stage."); }
    });
    if (persisted) agentExecutions.set(root, executionFromRun(persisted));
    await publish(root);
  });
}

async function openNativeAgentChat(root: string): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const state = await loadState(root);
  const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId) || config.workflows[0];
  if (!workflow) throw new Error(localize("没有可执行的流程", "There is no workflow to execute."));
  const progress = progressFor(state, workflow);
  const step = workflow.steps.find((item) => item.id === progress.currentStepId);
  if (!step) throw new Error(localize("当前流程已经完成", "The current workflow is complete."));
  const missing = (workflow.inputs || []).filter((input) => input.required && !progress.inputs?.[input.id]?.trim());
  if (missing.length) throw new Error(localize(`请先提供必填流程输入：${missing.map((item) => item.name).join("、")}`, `Provide required workflow input first: ${missing.map((item) => item.name).join(", ")}`));
  await configureWorkspaceMcp(root, true);
  await ensureConversationMonitor(root);
  const now = new Date().toISOString();
  let run = activeStepRun(state, workflow.id, step.id);
  if (run && run.channel !== "cursor-native") {
    run.status = "stopped";
    run.finishedAt = now;
    run.updatedAt = now;
    run = undefined;
  }
  const existingNativeSessionId = reusableNativeCursorSessionId(run);
  if (run && !existingNativeSessionId && run.cursorSessionId) {
    run.status = "stopped";
    run.finishedAt = now;
    run.updatedAt = now;
    run.message = localize("旧版 CLI 会话绑定已停用", "The legacy CLI session binding was retired.");
    run = undefined;
  }
  if (!run) {
    run = { id: randomUUID(), workflowId: workflow.id, stepId: step.id, channel: "cursor-native", status: "starting", startedAt: now, updatedAt: now, message: localize("正在绑定 Cursor 原生对话", "Binding the native Cursor conversation") };
    state.runs = [...(state.runs || []), run];
  } else {
    run.status = "starting";
    run.updatedAt = now;
    delete run.finishedAt;
  }
  const askQuestions = continuousFeedbackSetting(config.settings?.continuousFeedback === true);
  const commands = new Set(await vscode.commands.getCommands(true));
  const openCommand = commands.has("glass.openAgentById") ? "glass.openAgentById" : commands.has("composer.openComposer") ? "composer.openComposer" : undefined;
  const createCommand = commands.has("composer.createNew") ? "composer.createNew" : "glass.newAgentWithQuery";
  const recovering = Boolean(existingNativeSessionId);
  if (recovering && !openCommand) throw new Error(localize("当前 Cursor 版本无法打开已绑定的 Agent 会话", "This Cursor version cannot open the bound Agent conversation."));
  state.activeRunId = run.id;
  run.status = "running";
  run.updatedAt = new Date().toISOString();
  run.message = recovering
    ? localize("已打开 Daedalus 绑定的 Cursor 对话，可继续多轮沟通", "Opened the Cursor conversation bound to Daedalus for continued discussion")
    : localize("正在创建独立的 Cursor 对话", "Creating an independent Cursor conversation");
  await saveState(root, state);
  agentExecutions.set(root, executionFromRun(run));
  await publish(root);
  try {
    if (existingNativeSessionId) {
      await vscode.commands.executeCommand(openCommand!, existingNativeSessionId);
      return;
    }
    const prompt = nativeExecutionPrompt(run.id, workflow.id, step.id, askQuestions, false);
    const created = createCommand === "composer.createNew"
      ? await vscode.commands.executeCommand<{ composerId?: string }>(createCommand, {
          unifiedMode: "agent",
          openInNewTab: true,
          view: "pane",
          partialState: { unifiedMode: "agent", text: prompt, richText: prompt },
          autoSubmit: true,
        })
      : await vscode.commands.executeCommand(createCommand, prompt);
    const createdSessionId = created && typeof created === "object" && "composerId" in created && typeof created.composerId === "string" ? created.composerId.trim() : "";
    const bound = await persistRun(root, run.id, (current) => {
      if (createdSessionId && !current.cursorSessionId) {
        current.cursorSessionId = createdSessionId;
        current.cursorSessionKind = "native-ui";
      }
      current.message = current.cursorSessionKind === "native-ui"
        ? localize("已在独立 Cursor 对话中开始当前阶段", "Started the stage in an independent Cursor conversation")
        : localize("Cursor 对话已创建，等待首次消息绑定", "Cursor conversation created; waiting for the first message binding");
    });
    if (bound) agentExecutions.set(root, executionFromRun(bound));
    await publish(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed = await persistRun(root, run.id, (current) => { current.status = "failed"; current.finishedAt = new Date().toISOString(); current.message = detail; });
    if (failed) agentExecutions.set(root, executionFromRun(failed));
    await publish(root);
    throw error;
  }
}

async function executeCurrentStep(root: string): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  if (feedbackSetting(config.settings?.feedbackEnabled === true)) await startAgentExecution(root);
  else await openNativeAgentChat(root);
}

/** 推进工作流后自动启动新步骤的执行（如果设置允许且有下一步） */
async function autoExecuteIfEnabled(root: string): Promise<void> {
  try {
    const config = await loadConfig(root);
    if (!config || config.settings?.autoExecuteOnAdvance === false) return;
    const state = await loadState(root);
    const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId);
    if (!workflow) return;
    const progress = progressFor(state, workflow);
    if (!progress.currentStepId) return;
    if (agentProcesses.has(root)) return;
    await executeCurrentStep(root);
  } catch (error) {
    void vscode.window.showWarningMessage(localize(
      `自动执行下一步失败：${error instanceof Error ? error.message : String(error)}`,
      `Auto-execute failed: ${error instanceof Error ? error.message : String(error)}`
    ));
  }
}

async function stopAgentExecution(root: string): Promise<void> {
  const process = agentProcesses.get(root);
  const run = await mutateRuntimeState(root, (state) => {
    const current = state.activeRunId ? (state.runs || []).find((item) => item.id === state.activeRunId) : undefined;
    if (!current) return undefined;
    current.status = "stopped";
    current.finishedAt = new Date().toISOString();
    current.updatedAt = current.finishedAt;
    current.message = localize("已停止当前阶段执行", "Stage execution stopped.");
    return current;
  });
  if (!run) return;
  agentExecutions.set(root, executionFromRun(run));
  if (run.channel === "feedback") process?.kill("SIGTERM");
  await publish(root);
}

async function ensureConversationMonitor(root: string): Promise<void> {
  const scriptDestination = path.join(daedalusDir(root), "scripts", "conversation-monitor.cjs");
  const resumeDestination = path.join(daedalusDir(root), "scripts", "feedback-resume.cjs");
  const bindDestination = path.join(daedalusDir(root), "scripts", "session-bind.cjs");
  const injectDestination = path.join(daedalusDir(root), "scripts", "inject-subagent-context.cjs");
  await mkdir(path.dirname(scriptDestination), { recursive: true });
  await writeFile(scriptDestination, await readFile(path.join(extensionRoot, "assets", "conversation-monitor.cjs")));
  await writeFile(resumeDestination, await readFile(path.join(extensionRoot, "assets", "feedback-resume.cjs")));
  await writeFile(bindDestination, await readFile(path.join(extensionRoot, "assets", "session-bind.cjs")));
  await writeFile(injectDestination, await readFile(path.join(extensionRoot, "assets", "inject-subagent-context.cjs")));
  const hooksFile = path.join(root, ".cursor", "hooks.json");
  const value = await readJsonFile(hooksFile);
  const hooks = value.hooks && typeof value.hooks === "object" && !Array.isArray(value.hooks) ? value.hooks as JsonObject : {};
  const entries = Array.isArray(hooks.afterAgentResponse) ? hooks.afterAgentResponse.filter((item) => !(item && typeof item === "object" && "command" in item && String((item as JsonObject).command).includes(".daedalus/scripts/conversation-monitor.cjs"))) : [];
  entries.push({ command: "node .daedalus/scripts/conversation-monitor.cjs", timeout: 10 });
  hooks.afterAgentResponse = entries;
  const stopEntries = Array.isArray(hooks.stop) ? hooks.stop.filter((item) => !(item && typeof item === "object" && "command" in item && String((item as JsonObject).command).includes(".daedalus/scripts/feedback-resume.cjs"))) : [];
  stopEntries.push({ command: "node .daedalus/scripts/feedback-resume.cjs", timeout: 10 });
  hooks.stop = stopEntries;
  const submitEntries = Array.isArray(hooks.beforeSubmitPrompt) ? hooks.beforeSubmitPrompt.filter((item) => !(item && typeof item === "object" && "command" in item && String((item as JsonObject).command).includes(".daedalus/scripts/session-bind.cjs"))) : [];
  submitEntries.push({ command: "node .daedalus/scripts/session-bind.cjs", timeout: 10 });
  hooks.beforeSubmitPrompt = submitEntries;
  const preToolEntries = Array.isArray(hooks.preToolUse) ? hooks.preToolUse.filter((item) => !(item && typeof item === "object" && "command" in item && String((item as JsonObject).command).includes(".daedalus/scripts/inject-subagent-context.cjs"))) : [];
  preToolEntries.push({ command: "node .daedalus/scripts/inject-subagent-context.cjs", matcher: "Task|Subagent", timeout: 15 });
  hooks.preToolUse = preToolEntries;
  value.version = typeof value.version === "number" ? value.version : 1;
  value.hooks = hooks;
  await writeJsonFile(hooksFile, value);
}

async function ensureAgentOutputRule(root: string): Promise<void> {
  const destination = path.join(root, ".cursor", "rules", "daedalus-agent-output.mdc");
  const content = [
    "---",
    "description: Save Daedalus Agent non-code deliverables to the configured output directory",
    "globs: []",
    "alwaysApply: true",
    "---",
    "",
    "# Daedalus Agent document output",
    "",
    "When this Workspace contains `.daedalus/config.json`, treat Daedalus as the Workspace-level development Agent.",
    "",
    "When the user executes or discusses the active Daedalus workflow stage and the Daedalus MCP is available:",
    "",
    "1. Call `workflow_context` before substantial stage work. It returns references to Skills and Rules already installed in Cursor-native directories plus knowledge bound to the stage; use installed resources directly, then retrieve each bound knowledge item through `knowledge_search`, and never ask Daedalus to inline standards as prompt text.",
    "2. Before ending the stage response, call `workflow_report` with the bound `runId`, `ready`, `continue`, or `blocked`, plus a concise summary and evidence.",
    "3. `ready` is only a completion suggestion. Only the user can advance the workflow from the Workbench; no MCP tool may advance it.",
    "",
    "# Interaction language",
    "",
    "The `workflow_context` response includes a `language` field (`\"zh-CN\"` or `\"en\"`) reflecting the user's Daedalus language setting. Use this language for all user-facing text — including AskQuestion prompts, option labels, summaries, and explanations. When `workflow_context` has not been called (e.g. outside a workflow stage), follow the language the user is writing in.",
    "",
    "# Workspace-scoped feedback routing",
    "",
    "Before asking the user a question, requesting approval, or waiting for a decision, read `settings.feedbackEnabled` and `settings.continuousFeedback` from this Workspace's `.daedalus/config.json`.",
    "",
    "- If `feedbackEnabled` is `true`, you MUST call the Daedalus MCP `request_feedback` tool for every question. Keep and reuse its `threadId` for later turns in the same stage. Do not leave the question only in native chat.",
    "- If `feedbackEnabled` is `false`, you MUST NOT call `request_feedback`; continue the conversation in Cursor's native chat.",
    "- Ask only when installed Cursor Rules or an unresolved decision require it. The optional Daedalus Continuous Feedback rule separately controls mandatory end-of-cycle questions.",
    "- Never use Daedalus feedback for a different Workspace. The MCP client roots must contain this rule's Workspace.",
    "",
    "For substantial non-code deliverables such as plans, requirement summaries, architecture/design documents, review reports, and acceptance summaries:",
    "",
    "1. Read `settings.artifactOutput` from `.daedalus/config.json`.",
    "2. In `workspace` mode, save Markdown below the configured Workspace-relative `directory`.",
    "3. In `git` mode, save Markdown below `.daedalus/<repositoryRelativePath>/<directory>`.",
    "4. Add `daedalusWorkflowId` and `daedalusStepId` to YAML frontmatter so the document appears under its workflow stage.",
    "5. Keep development source code in its normal project location; do not copy code files into the document output directory.",
    "6. If the Daedalus MCP `agent_output` tool is available, prefer it because it validates the destination, filename, and stage metadata.",
    "",
  ].join("\n");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

async function findExistingContinuousFeedbackRule(root: string, managedPath: string): Promise<string | undefined> {
  const ruleRoots = [path.join(root, ".cursor", "rules"), path.join(homedir(), ".cursor", "rules")];
  const pattern = /(ask[\s_-]*questions?|askquestion|continuous[\s_-]*feedback|持续反馈|每轮[^\n]{0,24}(提问|确认))/i;
  for (const ruleRoot of ruleRoots) {
    let entries;
    try { entries = await readdir(ruleRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|mdc)$/i.test(entry.name)) continue;
      const file = path.join(ruleRoot, entry.name);
      if (path.resolve(file) === path.resolve(managedPath)) continue;
      if (entry.name === "daedalus-agent-output.mdc") continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (pattern.test(`${entry.name}\n${content}`)) return file;
    }
  }
  return undefined;
}

async function configureContinuousFeedbackRule(root: string, enabled: boolean): Promise<{ installed: boolean; existing?: string }> {
  const destination = path.join(root, ".cursor", "rules", "daedalus-continuous-feedback.mdc");
  if (!enabled) {
    await rm(destination, { force: true });
    return { installed: false };
  }
  const existing = await findExistingContinuousFeedbackRule(root, destination);
  if (existing) {
    await rm(destination, { force: true });
    return { installed: false, existing };
  }
  const content = [
    "---",
    "description: Require a confirmation question after every substantive Daedalus work cycle",
    "globs: []",
    "alwaysApply: true",
    "---",
    "",
    "# Daedalus Continuous Feedback",
    "",
    "This managed rule is present only while Daedalus Continuous Feedback is enabled. Every substantive work cycle must end with a concrete confirmation question before continuing or concluding.",
    "",
    "- For an initialized Daedalus workflow routed to Feedback, ask through the Daedalus MCP `request_feedback` tool and reuse its `threadId`.",
    "- Otherwise, use Cursor's native `AskQuestion` interaction.",
    "- Offer at least one continue/next option and one adjust-current-work option.",
    "- Do not apply this behavior outside the Workspace containing this rule.",
    "",
  ].join("\n");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return { installed: true };
}

async function loadConversationSignal(root: string): Promise<ConversationSignal | null> {
  try { return JSON.parse(await readFile(path.join(daedalusDir(root), "conversation-signal.json"), "utf8")) as ConversationSignal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return null; }
}

interface GitChangedFile { path: string; originalPath?: string; status: string; indexStatus: string; worktreeStatus: string; untracked: boolean; local?: boolean; }
interface GitRepositoryView { root: string; name: string; relativeRoot: string; branch: string; lastCommit: string; files: GitChangedFile[]; kind: "git" | "local"; }

async function scanRepositoryRoots(directory: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const roots: string[] = [];
  if (entries.some((entry) => entry.name === ".git")) roots.push(directory);
  const skipped = new Set([".git", ".daedalus", "node_modules", "dist", "build", ".next", "target", "vendor", "coverage"]);
  for (const entry of entries) {
    if (!entry.isDirectory() || skipped.has(entry.name) || entry.name.startsWith(".")) continue;
    roots.push(...await scanRepositoryRoots(path.join(directory, entry.name), depth + 1));
  }
  return roots;
}

async function discoverRepositoryRoots(workspaceRoot?: string): Promise<string[]> {
  const roots = new Set<string>();
  const folders = vscode.workspace.workspaceFolders || [];
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: Array<{ rootUri: vscode.Uri }> } }>("vscode.git");
  try {
    const exports = gitExtension ? await gitExtension.activate() : undefined;
    for (const repository of exports?.getAPI(1).repositories || []) roots.add(path.resolve(repository.rootUri.fsPath));
  } catch { /* fall back to filesystem discovery */ }
  for (const folder of folders) {
    for (const candidate of await scanRepositoryRoots(folder.uri.fsPath)) roots.add(path.resolve(candidate));
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: folder.uri.fsPath, timeout: 5000 });
      if (stdout.trim()) roots.add(path.resolve(stdout.trim()));
    } catch { /* workspace root is not a repository */ }
  }
  if (workspaceRoot) {
    const config = await loadConfig(workspaceRoot);
    const output = config?.settings?.artifactOutput;
    if (output?.mode === "git" && output.repositoryRelativePath) {
      const checkout = path.resolve(daedalusDir(workspaceRoot), output.repositoryRelativePath);
      if (await stat(path.join(checkout, ".git")).then(() => true).catch(() => false)) roots.add(checkout);
    }
  }
  return [...roots].sort();
}

function parseGitStatus(output: string): GitChangedFile[] {
  const entries = output.split("\0").filter(Boolean);
  const files: GitChangedFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file: GitChangedFile = { path: entry.slice(3), status, indexStatus: status[0], worktreeStatus: status[1], untracked: status === "??" };
    if (status.includes("R") || status.includes("C")) file.originalPath = entries[++index];
    files.push(file);
  }
  return files;
}

function isExcludedChange(workspaceRoot: string, repositoryRoot: string, relativePath: string, artifactRoot?: string): boolean {
  const absolute = path.resolve(repositoryRoot, relativePath);
  const internal = path.resolve(daedalusDir(workspaceRoot));
  const ignored = new Set([".git", ".daedalus", "node_modules", ".next", "target", "vendor", "coverage"]);
  const workspaceRelative = path.relative(workspaceRoot, absolute).split(path.sep);
  return workspaceRelative.some((part) => ignored.has(part)) || absolute === internal || absolute.startsWith(`${internal}${path.sep}`) || Boolean(artifactRoot && (absolute === artifactRoot || absolute.startsWith(`${artifactRoot}${path.sep}`)));
}

function localChangedFiles(changes: LocalChange[]): GitChangedFile[] {
  return changes.map((change) => {
    const code = change.status === "created" ? "A" : change.status === "deleted" ? "D" : "M";
    return { path: change.path, status: `${code} `, indexStatus: code, worktreeStatus: " ", untracked: change.status === "created", local: true };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

async function gitRepositories(workspaceRoot: string, localChanges: LocalChange[] = [], artifactRoot?: string): Promise<GitRepositoryView[]> {
  const roots = await discoverRepositoryRoots(workspaceRoot);
  if (!roots.length) {
    gitBackedWorkspaces.delete(workspaceRoot);
    return [{ root: workspaceRoot, name: path.basename(workspaceRoot), relativeRoot: ".", branch: localize("本地记录", "Local history"), lastCommit: "", files: localChangedFiles(localChanges), kind: "local" }];
  }
  gitBackedWorkspaces.add(workspaceRoot);
  const repositories = await Promise.all(roots.map(async (root): Promise<GitRepositoryView | null> => {
    try {
      const [{ stdout: branch }, { stdout: status }, { stdout: lastCommit }] = await Promise.all([
        execFileAsync("git", ["branch", "--show-current"], { cwd: root, timeout: 5000 }),
        execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, timeout: 10_000, maxBuffer: 10_000_000 }),
        execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: root, timeout: 5000 }).catch(() => ({ stdout: "" } as { stdout: string })),
      ]);
      const current = parseGitStatus(status).filter((file) => !isExcludedChange(workspaceRoot, root, file.path, artifactRoot));
      current.sort((a, b) => a.path.localeCompare(b.path));
      return { root, name: path.basename(root), relativeRoot: path.relative(workspaceRoot, root) || ".", branch: branch.trim() || "detached", lastCommit: lastCommit.trim(), files: current, kind: "git" };
    } catch { return null; }
  }));
  return repositories.filter((item): item is GitRepositoryView => item !== null);
}

async function recordLocalChange(workspaceRoot: string, uri: vscode.Uri, status: LocalChange["status"]): Promise<void> {
  if (gitBackedWorkspaces.has(workspaceRoot) || uri.scheme !== "file" || !await loadConfig(workspaceRoot)) return;
  const absolute = path.resolve(uri.fsPath);
  const root = path.resolve(workspaceRoot);
  if (!absolute.startsWith(`${root}${path.sep}`)) return;
  const relativePath = path.relative(root, absolute).split(path.sep).join("/");
  const config = await loadConfig(workspaceRoot);
  const outputRoot = config ? await Promise.resolve().then(() => artifactOutputRoot(workspaceRoot, config)).catch(() => undefined) : undefined;
  if (!relativePath || isExcludedChange(workspaceRoot, root, relativePath, outputRoot)) return;
  if (status !== "deleted" && await stat(absolute).then((value) => value.isDirectory()).catch(() => false)) return;
  const state = await loadState(workspaceRoot);
  const changes = [...(state.localChanges || [])];
  const index = changes.findIndex((item) => item.path === relativePath);
  const previous = index >= 0 ? changes[index] : undefined;
  if (status === "deleted" && previous?.status === "created") changes.splice(index, 1);
  else {
    const nextStatus: LocalChange["status"] = previous?.status === "created" ? "created" : status === "created" && previous?.status === "deleted" ? "modified" : status;
    const next = { path: relativePath, status: nextStatus, recordedAt: new Date().toISOString() };
    if (index >= 0) changes[index] = next; else changes.push(next);
  }
  state.localChanges = changes.slice(-2000);
  await saveState(workspaceRoot, state);
}

function queueLocalChange(workspaceRoot: string, uri: vscode.Uri, status: LocalChange["status"]): void {
  const previous = localChangeQueues.get(workspaceRoot) || Promise.resolve();
  const next = previous.then(() => recordLocalChange(workspaceRoot, uri, status)).catch(() => undefined);
  localChangeQueues.set(workspaceRoot, next);
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "media", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "media", "webview.css"));
  const token = nonce();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${token}';"><link rel="stylesheet" href="${style}"><title>Daedalus</title></head><body><div id="root"></div><script nonce="${token}" src="${script}"></script></body></html>`;
}

async function snapshot(root: string) {
  const config = await loadConfig(root);
  if (!config) return null;
  const state = await loadState(root);
  const outputRoot = await Promise.resolve().then(() => artifactOutputRoot(root, config)).catch(() => undefined);
  const [library, knowledge, artifacts, globalConfig, git, conversationSignal, globalFeedback] = await Promise.all([scanLibrary(root, config, globalHome, effectiveLanguage()), scanKnowledge(root, config, globalHome), scanAgentArtifacts(root, config), loadGlobalConfig(globalHome), gitRepositories(root, state.localChanges, outputRoot), loadConversationSignal(root), loadGlobalFeedback()]);
  const language = languageSetting(config.settings?.language || "auto");
  config.settings = { ...(config.settings || {}), language, feedbackEnabled: feedbackSetting(config.settings?.feedbackEnabled === true), continuousFeedback: continuousFeedbackSetting(config.settings?.continuousFeedback === true) };
  state.gates = [...globalFeedback.map((item) => ({ ...item, busy: feedbackProcesses.has(item.id) })), ...state.gates];
  const persistedRun = state.activeRunId ? (state.runs || []).find((run) => run.id === state.activeRunId) : undefined;
  const liveExecution = agentExecutions.get(root);
  let agentExecution = persistedRun ? executionFromRun(persistedRun) : liveExecution || { status: "idle" as const };
  if (!liveExecution && persistedRun && ["starting", "running", "continuing"].includes(persistedRun.status)) agentExecution = { ...agentExecution, status: "paused", message: persistedRun.channel === "feedback" ? localize("Cursor Agent 会话可从上次状态继续", "The Cursor Agent session can resume from its last state.") : localize("Cursor 原生对话可从上次会话恢复", "The native Cursor conversation can be restored.") };
  return { config, state, library: library.map(({ absolutePath, content, ...item }) => item), knowledge, artifacts: artifacts.map(({ absolutePath, ...item }) => item), globalImports: globalConfig.imports, globalLocalImports: globalConfig.localImports || [], git, conversationSignal, agentExecution, workspace: path.basename(root), version: extensionVersion, preferences: { languageSetting: language, language: effectiveLanguage(language), editorLanguage: vscode.env.language, themeSetting: themeSetting(), editorTheme: editorTheme() } };
}

async function updateStatusBar(root: string): Promise<void> {
  if (!statusBarItem) return;
  if (!root) { statusBarItem.hide(); return; }
  const config = await loadConfig(root).catch(() => null);
  if (!config) {
    statusBarItem.text = `${DAEDALUS_STATUS_ICON} Daedalus`;
    statusBarItem.tooltip = localize("初始化 Daedalus 工作台", "Initialize Daedalus Workbench");
    statusBarItem.show();
    return;
  }
  let state: RuntimeState;
  try {
    state = await loadState(root);
  } catch {
    statusBarItem.text = "$(warning) Daedalus";
    statusBarItem.tooltip = localize("工作区状态文件异常；点击打开 Daedalus 进行恢复", "Workspace state is invalid; open Daedalus to recover it");
    statusBarItem.show();
    return;
  }
  const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId) || config.workflows[0];
  const progress = workflow ? progressFor(state, workflow) : null;
  const step = progress?.currentStepId ? workflow?.steps.find((item) => item.id === progress.currentStepId) : null;
  const pending = state.gates.filter((gate) => gate.status === "pending").length;
  const persistedRun = state.activeRunId ? (state.runs || []).find((run) => run.id === state.activeRunId) : undefined;
  const execution = persistedRun ? executionFromRun(persistedRun) : agentExecutions.get(root);
  const waiting = execution?.status === "waiting_feedback";
  const running = execution && ["starting", "running", "continuing"].includes(execution.status) && (agentProcesses.has(root) || persistedRun?.channel === "cursor-native");
  const paused = execution?.status === "paused" || (persistedRun?.channel === "feedback" && !agentProcesses.has(root) && ["starting", "running", "continuing"].includes(persistedRun.status));
  const icon = waiting || pending ? "$(bell-dot)" : running ? "$(sync~spin)" : paused ? "$(debug-pause)" : DAEDALUS_STATUS_ICON;
  const suffix = step ? ` · ${step.name}` : "";
  statusBarItem.text = `${icon} Daedalus${suffix}`;
  statusBarItem.tooltip = waiting || pending ? localize(`${pending || 1} 个待处理反馈`, `${pending || 1} pending feedback`) : running ? localize("Agent 正在执行", "Agent is running") : paused ? localize("执行会话已暂停，可在工作台恢复", "The execution is paused and can be resumed from the Workbench") : localize("打开 Daedalus 工作台", "Open Daedalus Workbench");
  statusBarItem.show();
}

async function publish(root: string): Promise<void> {
  const value = await snapshot(root);
  if (panel && value) await panel.webview.postMessage({ type: "state", ...value });
  void updateStatusBar(root);
}

async function publishPanelState(root: string): Promise<void> {
  if (await loadConfig(root)) {
    await publish(root);
    return;
  }
  const globalFeedback = await loadGlobalFeedback();
  await panel?.webview.postMessage({
    type: "not_initialized",
    workspace: path.basename(root),
    version: extensionVersion,
    config: { workflows: [], imports: [], localImports: [], settings: { language: languageSetting(), feedbackEnabled: feedbackSetting(), continuousFeedback: continuousFeedbackSetting(), autoExecuteOnAdvance: true } },
    state: { version: 2, progress: [], runs: [], localChanges: [], gates: globalFeedback.map((item) => ({ ...item, busy: feedbackProcesses.has(item.id) })) },
    preferences: {
      languageSetting: languageSetting(),
      language: effectiveLanguage(),
      editorLanguage: vscode.env.language,
      themeSetting: themeSetting(),
      editorTheme: editorTheme(),
    },
  });
  void updateStatusBar(root);
}

async function updateConfig(root: string, update: (config: WorkspaceConfig) => void): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error("当前 Workspace 尚未初始化");
  update(config);
  await saveConfig(root, config);
  await publish(root);
}

async function updateState(root: string, update: (state: RuntimeState, config: WorkspaceConfig) => void): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error("当前 Workspace 尚未初始化");
  await mutateRuntimeState(root, (state) => update(state, config));
  await publish(root);
}

async function createLibraryItem(root: string, message: Record<string, unknown>): Promise<void> {
  const kind = message.kind === "rule" ? "rule" : "skill";
  const scope = message.scope === "global" ? "global" : "project";
  const name = typeof message.name === "string" ? message.name.trim().slice(0, 100) : "";
  const description = typeof message.description === "string" ? message.description.trim().slice(0, 300) : "";
  const body = typeof message.content === "string" ? message.content.trim().slice(0, 50_000) : "";
  if (!name || !body) throw new Error("名称和内容不能为空");
  const id = slug(name);
  const content = `---\nname: ${name.replace(/\n/g, " ")}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${name}\n\n${body}\n`;
  const libraryRoot = scope === "global" ? globalHome : daedalusDir(root);
  const destination = kind === "skill"
    ? path.join(libraryRoot, "skills", id, "SKILL.md")
    : path.join(libraryRoot, "rules", `${id}.md`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error(`已存在同名 ${kind === "skill" ? "Skill" : "Rule"}`);
    throw error;
  });
  await syncCursorStandards(root);
  await publish(root);
}

async function saveKnowledgeItem(root: string, message: Record<string, unknown>): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error("当前 Workspace 尚未初始化");
  const scope = message.scope === "global" ? "global" : "project";
  const name = typeof message.name === "string" ? message.name.trim().slice(0, 120) : "";
  const description = typeof message.description === "string" ? message.description.trim().slice(0, 500) : "";
  const body = typeof message.content === "string" ? message.content.trim().slice(0, 200_000) : "";
  if (!name || !body) throw new Error("知识名称和内容不能为空");
  let destination: string | undefined;
  if (typeof message.id === "string" && message.id) {
    const existing = (await scanKnowledge(root, config, globalHome)).find((item) => item.id === message.id);
    if (!existing || existing.source !== "direct") throw new Error("Git 导入的知识条目为只读，请在来源仓库中修改");
    destination = existing.absolutePath;
    const renamedDestination = path.join(path.dirname(existing.absolutePath), `${slug(name)}.md`);
    if (renamedDestination !== existing.absolutePath) {
      const occupied = await access(renamedDestination).then(() => true).catch(() => false);
      if (occupied) throw new Error(localize("已存在同名知识文件", "A knowledge file with this name already exists."));
      await rename(existing.absolutePath, renamedDestination);
      destination = renamedDestination;
    }
  } else {
    const base = scope === "global" ? path.join(globalHome, "knowledge") : path.join(daedalusDir(root), "knowledge");
    destination = path.join(base, `${slug(name)}.md`);
    await mkdir(base, { recursive: true });
  }
  const content = `---\nname: ${name.replace(/\n/g, " ")}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${name}\n\n${body}\n`;
  await writeFile(destination, content, "utf8");
  await publish(root);
}

async function linkKnowledgeDirectory(root: string, message: Record<string, unknown>): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const scope = message.scope === "global" ? "global" : "project";
  const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, title: localize("选择要关联的知识目录", "Choose a knowledge directory to link") });
  if (!selected?.[0]) return;
  const dirPath = selected[0].fsPath;
  const name = path.basename(dirPath);
  const id = `linked-${slug(name)}-${Date.now().toString(36)}`;
  const entry = { id, name, path: dirPath, scope, linkedAt: new Date().toISOString() } as const;
  config.linkedKnowledgeDirs = [...(config.linkedKnowledgeDirs || []), entry];
  await saveConfig(root, config);
  await publish(root);
  void vscode.window.showInformationMessage(localize(`已关联知识目录：${name}`, `Linked knowledge directory: ${name}`));
}

async function unlinkKnowledgeDirectory(root: string, message: Record<string, unknown>): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const id = String(message.id || "");
  config.linkedKnowledgeDirs = (config.linkedKnowledgeDirs || []).filter((item) => item.id !== id);
  await saveConfig(root, config);
  await publish(root);
  void vscode.window.showInformationMessage(localize("已取消关联知识目录", "Knowledge directory unlinked."));
}

async function importRepository(root: string, message: Record<string, unknown>): Promise<void> {
  const url = typeof message.url === "string" ? message.url.trim().slice(0, 1000) : "";
  const ref = typeof message.ref === "string" ? message.ref.trim().slice(0, 200) : "";
  const subpath = normalizeImportSubpath(message.subpath);
  if (!url || url.startsWith("-")) throw new Error("请输入有效的 Git 仓库地址");
  const target = message.target === "knowledge" ? "knowledge" : "standards";
  const scope = message.scope === "global" ? "global" : "project";
  const config = await loadConfig(root);
  if (!config) throw new Error("当前 Workspace 尚未初始化");
  const rawName = url.replace(/[?#].*$/, "").replace(/\/$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") || "repository";
  const id = `${slug(rawName)}-${Date.now().toString(36)}`;
  const relativePath = path.join(target === "knowledge" ? "knowledge-imports" : "imports", id);
  const baseRoot = scope === "global" ? globalHome : daedalusDir(root);
  const destination = path.join(baseRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (subpath) args.push("--filter=blob:none", "--sparse");
  if (ref) args.push("--branch", ref);
  args.push("--", url, destination);
  try {
    await execFileAsync("git", args, { cwd: root, timeout: 120_000, maxBuffer: 2_000_000 });
    if (subpath) {
      await execFileAsync("git", ["sparse-checkout", "set", "--no-cone", subpath], { cwd: destination, timeout: 60_000, maxBuffer: 2_000_000 });
      const selected = path.resolve(destination, ...subpath.split("/"));
      await stat(selected).catch(() => { throw new Error(localize(`仓库中找不到指定路径：${subpath}`, `The selected repository path was not found: ${subpath}`)); });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  const imported = { id, name: rawName, url, ref: ref || undefined, subpath, importedAt: new Date().toISOString(), relativePath, target, scope } as const;
  if (scope === "global") {
    const globalConfig = await loadGlobalConfig(globalHome);
    globalConfig.imports.push(imported);
    await saveGlobalConfig(globalHome, globalConfig);
  } else {
    config.imports.push(imported);
    await saveConfig(root, config);
  }
  await syncCursorStandards(root);
  await publish(root);
}

async function importLocalMarkdown(root: string, message: Record<string, unknown>): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const target = message.target === "knowledge" ? "knowledge" : "standards";
  const kind = message.kind === "agent" ? "agent" : message.kind === "rule" ? "rule" : "skill";
  const scope = message.scope === "global" ? "global" : "project";
  const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { Markdown: ["md", "mdc"] }, title: localize("选择要导入的 Markdown 文档", "Choose a Markdown document to import") });
  if (!selected?.[0]) return;
  const sourcePath = selected[0].fsPath;
  const content = await readFile(sourcePath, "utf8");
  const title = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(sourcePath, path.extname(sourcePath));
  const id = `${slug(title)}-${Date.now().toString(36)}`;
  const baseRoot = scope === "global" ? globalHome : daedalusDir(root);
  const destination = target === "knowledge"
    ? path.join(baseRoot, "knowledge", `${id}.md`)
    : kind === "skill"
      ? path.join(baseRoot, "skills", id, "SKILL.md")
      : path.join(baseRoot, kind === "agent" ? "agents" : "rules", `${id}.md`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
  const relativePath = target === "standards" && scope === "project" ? path.relative(root, destination) : path.relative(baseRoot, destination);
  const imported = { id, name: title, sourcePath, importedAt: new Date().toISOString(), relativePath, target, kind: target === "standards" ? kind : undefined, scope } as const;
  if (scope === "global") {
    const globalConfig = await loadGlobalConfig(globalHome);
    globalConfig.localImports = [...(globalConfig.localImports || []), imported];
    await saveGlobalConfig(globalHome, globalConfig);
  } else {
    config.localImports = [...(config.localImports || []), imported];
    await saveConfig(root, config);
  }
  await syncCursorStandards(root);
  await publish(root);
  void vscode.window.showInformationMessage(localize(`已导入 ${title}`, `Imported ${title}`));
}

async function openImportSource(root: string, message: Record<string, unknown>): Promise<void> {
  const id = String(message.id || "");
  const scope = message.scope === "global" ? "global" : "project";
  const config = await loadConfig(root);
  if (!config) return;
  const globalConfig = await loadGlobalConfig(globalHome);
  const local = (scope === "global" ? globalConfig.localImports || [] : config.localImports || []).find((item) => item.id === id);
  let source: string | undefined;
  if (local) source = await stat(local.sourcePath).then(() => local.sourcePath).catch(() => local.target === "standards" ? path.join(root, local.relativePath) : path.join(scope === "global" ? globalHome : daedalusDir(root), local.relativePath));
  const gitImport = (scope === "global" ? globalConfig.imports : config.imports).find((item) => item.id === id);
  if (gitImport) source = path.join(scope === "global" ? globalHome : daedalusDir(root), gitImport.relativePath, ...(gitImport.subpath ? gitImport.subpath.split("/") : []));
  if (!source) throw new Error(localize("找不到导入来源", "Import source not found."));
  const info = await stat(source);
  await vscode.commands.executeCommand(info.isFile() ? "vscode.open" : "revealFileInOS", vscode.Uri.file(source));
}

async function configureArtifactOutput(root: string, message: Record<string, unknown>): Promise<void> {
  const config = await loadConfig(root);
  if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
  const mode = message.mode === "git" ? "git" : "workspace";
  if (mode === "workspace") {
    const directory = normalizeOutputDirectory(message.directory, ".daedalus/artifacts");
    const destination = path.resolve(root, ...directory.split("/"));
    const resolvedRoot = path.resolve(root);
    if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(localize("输出目录必须位于当前 Workspace 内", "Output directory must be inside the current Workspace."));
    await mkdir(destination, { recursive: true });
    config.settings = { ...(config.settings || {}), artifactOutput: { mode, directory } };
  } else {
    const repositoryUrl = typeof message.repositoryUrl === "string" ? message.repositoryUrl.trim().slice(0, 1000) : "";
    const ref = typeof message.ref === "string" ? message.ref.trim().slice(0, 200) : "";
    const directory = normalizeOutputDirectory(message.directory, "daedalus");
    if (!repositoryUrl || repositoryUrl.startsWith("-")) throw new Error(localize("请输入有效的输出 Git 仓库地址", "Enter a valid output Git repository URL."));
    if (ref.startsWith("-")) throw new Error(localize("分支或 Tag 无效", "Invalid branch or tag."));
    const current = config.settings?.artifactOutput;
    let repositoryRelativePath = current?.mode === "git" && current.repositoryUrl === repositoryUrl && current.ref === (ref || undefined) ? current.repositoryRelativePath : undefined;
    let checkout = repositoryRelativePath ? path.join(daedalusDir(root), repositoryRelativePath) : "";
    const available = checkout ? await stat(path.join(checkout, ".git")).then(() => true).catch(() => false) : false;
    if (!available) {
      const repositoryName = repositoryUrl.replace(/[?#].*$/, "").replace(/\/$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") || "output";
      repositoryRelativePath = path.join("artifact-repositories", `${slug(repositoryName)}-${Date.now().toString(36)}`);
      checkout = path.join(daedalusDir(root), repositoryRelativePath);
      await mkdir(path.dirname(checkout), { recursive: true });
      const args = ["clone"];
      if (ref) args.push("--branch", ref);
      args.push("--", repositoryUrl, checkout);
      try { await execFileAsync("git", args, { cwd: root, timeout: 120_000, maxBuffer: 2_000_000 }); }
      catch (error) { await rm(checkout, { recursive: true, force: true }); throw error; }
    }
    await mkdir(path.resolve(checkout, ...directory.split("/")), { recursive: true });
    config.settings = { ...(config.settings || {}), artifactOutput: { mode, directory, repositoryUrl, ref: ref || undefined, repositoryRelativePath } };
  }
  await saveConfig(root, config);
  await publish(root);
  void vscode.window.showInformationMessage(localize("Agent 文档输出位置已更新", "Agent document output location updated."));
}

async function resolveGitSelection(repoRootValue: unknown, pathsValue?: unknown): Promise<{ repository: GitRepositoryView; files: GitChangedFile[] }> {
  const repoRoot = typeof repoRootValue === "string" ? path.resolve(repoRootValue) : "";
  const currentWorkspace = workspacePath() || repoRoot;
  const config = await loadConfig(currentWorkspace);
  const state = config ? await loadState(currentWorkspace) : undefined;
  const outputRoot = config ? await Promise.resolve().then(() => artifactOutputRoot(currentWorkspace, config)).catch(() => undefined) : undefined;
  const repositories = await gitRepositories(currentWorkspace, state?.localChanges, outputRoot);
  const repository = repositories.find((item) => item.root === repoRoot);
  if (!repository) throw new Error("找不到指定的 Git 仓库");
  const requested = Array.isArray(pathsValue) ? new Set(pathsValue.filter((item): item is string => typeof item === "string")) : null;
  const files = requested ? repository.files.filter((file) => requested.has(file.path)) : repository.files;
  return { repository, files };
}

async function openGitDiff(message: Record<string, unknown>): Promise<void> {
  const { repository, files } = await resolveGitSelection(message.repoRoot, [message.path]);
  const file = files[0];
  if (!file) throw new Error("该文件已不在变更列表中");
  const workingUri = vscode.Uri.file(path.join(repository.root, file.path));
  if (repository.kind === "local") {
    if (file.worktreeStatus === "D" || file.indexStatus === "D") void vscode.window.showInformationMessage(localize(`本地文件已删除：${file.path}`, `Local file deleted: ${file.path}`));
    else await vscode.commands.executeCommand("vscode.open", workingUri);
    return;
  }
  if (file.untracked) {
    await vscode.commands.executeCommand("vscode.open", workingUri);
    return;
  }
  try {
    await vscode.commands.executeCommand("git.openChange", workingUri);
  } catch {
    const originalPath = file.originalPath || file.path;
    const originalFile = vscode.Uri.file(path.join(repository.root, originalPath));
    const originalUri = originalFile.with({ scheme: "git", query: JSON.stringify({ path: originalFile.fsPath, ref: "HEAD" }) });
    await vscode.commands.executeCommand("vscode.diff", originalUri, workingUri, `${file.path} (HEAD ↔ Working Tree)`);
  }
}

async function commitGitChanges(root: string, message: Record<string, unknown>): Promise<void> {
  const commitMessage = typeof message.message === "string" ? message.message.trim().slice(0, 10_000) : "";
  if (!commitMessage) throw new Error(localize("请填写提交信息", "Enter a commit message."));
  const { repository, files } = await resolveGitSelection(message.repoRoot, message.paths);
  if (repository.kind !== "git") throw new Error(localize("本地变更记录不能提交，请先初始化 Git 仓库", "Local change history cannot be committed. Initialize a Git repository first."));
  const committable = files;
  if (!committable.length) throw new Error(localize("请选择尚未提交的变更文件", "Select at least one uncommitted file."));
  const pathspecs = [...new Set(committable.flatMap((file) => file.originalPath ? [file.path, file.originalPath] : [file.path]))];
  const untracked = committable.filter((file) => file.untracked).map((file) => file.path);
  if (untracked.length) await execFileAsync("git", ["add", "-N", "--", ...untracked], { cwd: repository.root, timeout: 30_000, maxBuffer: 2_000_000 });
  const args = ["commit"];
  if (message.amend === true) args.push("--amend");
  args.push("-m", commitMessage, "--only", "--", ...pathspecs);
  const { stdout } = await execFileAsync("git", args, { cwd: repository.root, timeout: 120_000, maxBuffer: 10_000_000 });
  if (message.push === true) await execFileAsync("git", ["push"], { cwd: repository.root, timeout: 120_000, maxBuffer: 10_000_000 });
  void vscode.window.showInformationMessage(message.push === true ? localize(`已提交并推送 ${repository.name}`, `Committed and pushed ${repository.name}`) : localize(`已提交 ${repository.name}: ${stdout.trim().split("\n")[0] || commitMessage}`, `Committed ${repository.name}: ${stdout.trim().split("\n")[0] || commitMessage}`));
  await publish(root);
}

async function handleMessage(root: string, message: Record<string, unknown>): Promise<void> {
  switch (message.type) {
    case "ready": case "refresh": await publishPanelState(root); return;
    case "execute_current_step": await executeCurrentStep(root); return;
    case "stop_current_step": await stopAgentExecution(root); return;
    case "select_workflow":
      await updateConfig(root, (config) => { setActiveWorkflow(config, String(message.id || "")); });
      return;
    case "save_workflow_inputs": {
      const workflowId = String(message.workflowId || "");
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const progress = progressFor(state, workflow);
        progress.inputs = typeof message.inputs === "object" && message.inputs ? Object.fromEntries(Object.entries(message.inputs).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, String(value).slice(0, 100_000)])) : {};
        const index = state.progress.findIndex((item) => item.workflowId === workflow.id);
        if (index >= 0) state.progress[index] = progress; else state.progress.push(progress);
      }); return;
    }
    case "pick_workflow_input_file": {
      const workflowId = String(message.workflowId || ""); const inputId = String(message.inputId || "");
      const config = await loadConfig(root); const input = config?.workflows.find((item) => item.id === workflowId)?.inputs?.find((item) => item.id === inputId);
      if (!input?.accepts.includes("image")) return;
      const selection = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: localize("选择测试用例截图", "Choose test-case screenshot"), filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] } });
      if (!selection?.[0]) return;
      await updateState(root, (state, currentConfig) => {
        const workflow = currentConfig.workflows.find((item) => item.id === workflowId); if (!workflow) return;
        const progress = progressFor(state, workflow); progress.inputs = { ...(progress.inputs || {}), [inputId]: selection[0].fsPath };
        const index = state.progress.findIndex((item) => item.workflowId === workflowId); if (index >= 0) state.progress[index] = progress; else state.progress.push(progress);
      });
      return;
    }
    case "advance_workflow":
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId);
        if (!workflow) return;
        const progress = progressFor(state, workflow);
        const missing = (workflow.inputs || []).filter((input) => input.required && !progress.inputs?.[input.id]?.trim());
        if (missing.length) throw new Error(localize(`请先提供必填流程输入：${missing.map((item) => item.name).join("、")}`, `Provide required workflow input first: ${missing.map((item) => item.name).join(", ")}`));
        const completedStepId = progress.currentStepId;
        advanceWorkflow(state, workflow, typeof message.summary === "string" ? message.summary.slice(0, 3000) : undefined);
        const now = new Date().toISOString();
        for (const run of state.runs || []) if (run.workflowId === workflow.id && run.stepId === completedStepId && !TERMINAL_RUN_STATUSES.has(run.status)) { run.status = "completed"; run.finishedAt = now; run.updatedAt = now; run.message = localize("用户已确认完成并推进", "The user confirmed completion and advanced the workflow."); }
      });
      await rm(path.join(daedalusDir(root), "conversation-signal.json"), { force: true });
      await publish(root);
      await autoExecuteIfEnabled(root);
      return;
    case "save_step": {
      const workflowId = String(message.workflowId || ""); const stepId = String(message.stepId || "");
      await updateConfig(root, (config) => {
        const step = config.workflows.find((item) => item.id === workflowId)?.steps.find((item) => item.id === stepId);
        if (!step) return;
        if (typeof message.name === "string" && message.name.trim()) step.name = message.name.trim().slice(0, 100);
        if (typeof message.description === "string") step.description = message.description.trim().slice(0, 500);
        step.skillIds = Array.isArray(message.skillIds) ? message.skillIds.filter((item): item is string => typeof item === "string").slice(0, 30) : [];
        step.ruleIds = Array.isArray(message.ruleIds) ? message.ruleIds.filter((item): item is string => typeof item === "string").slice(0, 30) : [];
        step.knowledgeIds = Array.isArray(message.knowledgeIds) ? message.knowledgeIds.filter((item): item is string => typeof item === "string").slice(0, 30) : [];
        step.standards = Array.isArray(message.standards) ? message.standards.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 30) : [];
      }); return;
    }
    case "add_workflow":
      await updateConfig(root, (config) => { const name = typeof message.name === "string" ? message.name.trim().slice(0, 100) : ""; if (!name) return; const id = newId("workflow"); config.workflows.push({ id, name, description: typeof message.description === "string" && message.description.trim() ? message.description.trim().slice(0, 500) : localize("自定义研发流程", "Custom development workflow"), agentId: typeof message.agentId === "string" ? message.agentId : undefined, steps: [] }); config.activeWorkflowId = id; }); return;
    case "update_workflow":
      await updateConfig(root, (config) => { const workflow = config.workflows.find((item) => item.id === message.id); if (!workflow) return; if (typeof message.name === "string" && message.name.trim()) workflow.name = message.name.trim().slice(0, 100); if (typeof message.description === "string") workflow.description = message.description.trim().slice(0, 500); workflow.agentId = typeof message.agentId === "string" && message.agentId ? message.agentId : undefined; delete workflow.agent; }); return;
    case "delete_workflow": {
      const id = String(message.id || "");
      await updateConfig(root, (config) => { config.workflows = config.workflows.filter((item) => item.id !== id); if (config.activeWorkflowId === id) config.activeWorkflowId = config.workflows[0]?.id || ""; });
      await updateState(root, (state) => { state.progress = state.progress.filter((item) => item.workflowId !== id); });
      return;
    }
    case "move_step": {
      const workflowId = String(message.workflowId || ""); const stepId = String(message.stepId || ""); const direction = message.direction === "up" ? -1 : 1;
      await updateConfig(root, (config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const index = workflow.steps.findIndex((item) => item.id === stepId);
        const targetIndex = index + direction;
        if (index < 0 || targetIndex < 0 || targetIndex >= workflow.steps.length) return;
        [workflow.steps[index], workflow.steps[targetIndex]] = [workflow.steps[targetIndex], workflow.steps[index]];
      }); return;
    }
    case "add_step":
      await updateConfig(root, (config) => { const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId); const name = typeof message.name === "string" ? message.name.trim().slice(0, 100) : ""; if (workflow && name) workflow.steps.push({ id: newId("step"), name, description: "", skillIds: [], ruleIds: [], knowledgeIds: [], standards: [] }); }); return;
    case "delete_step": {
      const workflowId = String(message.workflowId || ""); const stepId = String(message.stepId || "");
      await updateConfig(root, (config) => { const workflow = config.workflows.find((item) => item.id === workflowId); if (workflow) workflow.steps = workflow.steps.filter((item) => item.id !== stepId); });
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId); const progress = state.progress.find((item) => item.workflowId === workflowId);
        if (!workflow || !progress) return;
        progress.completed = progress.completed.filter((item) => item.stepId !== stepId);
        if (progress.currentStepId === stepId || !workflow.steps.some((item) => item.id === progress.currentStepId)) progress.currentStepId = workflow.steps.find((item) => !progress.completed.some((done) => done.stepId === item.id))?.id || null;
      });
      return;
    }
    case "reset_workflow": {
      const workflowId = String(message.workflowId || "");
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const index = state.progress.findIndex((item) => item.workflowId === workflowId);
        const reset: WorkflowProgress = { workflowId, currentStepId: workflow.steps[0]?.id || null, completed: [], updatedAt: new Date().toISOString() };
        if (index >= 0) state.progress[index] = reset; else state.progress.push(reset);
      });
      return;
    }
    case "revert_step": {
      const workflowId = String(message.workflowId || "");
      const stepId = String(message.stepId || "");
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const stepIndex = workflow.steps.findIndex((item) => item.id === stepId);
        if (stepIndex < 0) return;
        const progress = state.progress.find((item) => item.workflowId === workflowId);
        if (!progress) return;
        progress.currentStepId = stepId;
        progress.completed = progress.completed.filter((item) => {
          const completedIndex = workflow.steps.findIndex((step) => step.id === item.stepId);
          return completedIndex >= 0 && completedIndex < stepIndex;
        });
        progress.updatedAt = new Date().toISOString();
      });
      return;
    }
    case "set_current_step": {
      const workflowId = String(message.workflowId || "");
      const stepId = String(message.stepId || "");
      await terminateAgentProcess(root);
      agentExecutions.set(root, { status: "idle" });
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const updated = setCurrentWorkflowStep(state, workflow, stepId, localize("用户选择从此阶段开始，已跳过", "Skipped because the user chose a later starting stage"));
        if (!updated) return;
        const now = new Date().toISOString();
        for (const run of state.runs || []) {
          if (run.workflowId !== workflow.id || TERMINAL_RUN_STATUSES.has(run.status)) continue;
          run.status = "stopped";
          run.finishedAt = now;
          run.updatedAt = now;
          run.message = localize("用户重新选择了当前阶段", "The user selected a different current stage.");
        }
        state.activeRunId = undefined;
      });
      return;
    }
    case "execute_step": {
      const workflowId = String(message.workflowId || "");
      const stepId = String(message.stepId || "");
      await terminateAgentProcess(root);
      agentExecutions.set(root, { status: "idle" });
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === workflowId);
        if (!workflow) return;
        const updated = setCurrentWorkflowStep(state, workflow, stepId, localize("用户选择直接执行此阶段，已跳过", "Skipped because the user chose to execute a later stage"));
        if (!updated) return;
        const now = new Date().toISOString();
        for (const run of state.runs || []) {
          if (run.workflowId !== workflow.id || TERMINAL_RUN_STATUSES.has(run.status)) continue;
          run.status = "stopped";
          run.finishedAt = now;
          run.updatedAt = now;
          run.message = localize("用户选择执行其他阶段", "The user chose to execute a different stage.");
        }
        state.activeRunId = undefined;
      });
      await executeCurrentStep(root);
      return;
    }
    case "create_library_item": await createLibraryItem(root, message); return;
    case "save_knowledge": await saveKnowledgeItem(root, message); return;
    case "link_knowledge_directory": await linkKnowledgeDirectory(root, message); return;
    case "unlink_knowledge_directory": await unlinkKnowledgeDirectory(root, message); return;
    case "import_git": await importRepository(root, message); return;
    case "import_local_markdown": await importLocalMarkdown(root, message); return;
    case "open_import_source": await openImportSource(root, message); return;
    case "open_artifact_preview": {
      const config = await loadConfig(root);
      if (!config) throw new Error(localize("当前 Workspace 尚未初始化", "This Workspace is not initialized."));
      const artifact = (await scanAgentArtifacts(root, config)).find((item) => item.id === String(message.id || ""));
      if (!artifact) throw new Error(localize("找不到输出文档", "Output document not found."));
      await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(artifact.absolutePath));
      return;
    }
    case "update_artifact_output": await configureArtifactOutput(root, message); return;
    case "update_import": {
      const id = String(message.id || "");
      const scope = message.scope === "global" ? "global" : "project";
      const config = await loadConfig(root);
      if (!config) throw new Error("当前 Workspace 尚未初始化");
      const globalCfg = await loadGlobalConfig(globalHome);
      const imported = scope === "global"
        ? globalCfg.imports.find((item) => item.id === id)
        : config.imports.find((item) => item.id === id);
      if (!imported) throw new Error(localize("找不到此导入仓库", "Import not found"));
      const baseRoot = scope === "global" ? globalHome : daedalusDir(root);
      const importPath = path.join(baseRoot, imported.relativePath);
      await execFileAsync("git", ["pull", "--ff-only"], { cwd: importPath, timeout: 120_000, maxBuffer: 2_000_000 });
      await syncCursorStandards(root);
      void vscode.window.showInformationMessage(localize(`已更新导入仓库 ${imported.name}`, `Updated import ${imported.name}`));
      await publish(root);
      return;
    }
    case "delete_import": {
      const id = String(message.id || "");
      const scope = message.scope === "global" ? "global" : "project";
      const config = await loadConfig(root);
      if (!config) throw new Error("当前 Workspace 尚未初始化");
      await uninstallImportedStandards(root, id, scope);
      if (scope === "global") {
        const globalCfg = await loadGlobalConfig(globalHome);
        const imported = globalCfg.imports.find((item) => item.id === id);
        if (!imported) throw new Error(localize("找不到此导入仓库", "Import not found"));
        await rm(path.join(globalHome, imported.relativePath), { recursive: true, force: true });
        globalCfg.imports = globalCfg.imports.filter((item) => item.id !== id);
        await saveGlobalConfig(globalHome, globalCfg);
      } else {
        const imported = config.imports.find((item) => item.id === id);
        if (!imported) throw new Error(localize("找不到此导入仓库", "Import not found"));
        await rm(path.join(daedalusDir(root), imported.relativePath), { recursive: true, force: true });
        config.imports = config.imports.filter((item) => item.id !== id);
        await saveConfig(root, config);
      }
      await syncCursorStandards(root);
      void vscode.window.showInformationMessage(localize("已删除导入仓库", "Import removed"));
      await publish(root);
      return;
    }
    case "git_refresh": await publish(root); return;
    case "git_open_diff": await openGitDiff(message); return;
    case "git_commit":
      await commitGitChanges(root, message);
      await panel?.webview.postMessage({ type: "git_commit_success", repoRoot: message.repoRoot });
      return;
    case "open_item": {
      const config = await loadConfig(root); if (!config) return;
      const item = (await scanLibrary(root, config, globalHome, effectiveLanguage())).find((entry) => entry.id === message.id);
      if (item) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(item.absolutePath));
      return;
    }
    case "create_feedback_conversation": {
      if (!feedbackSetting()) throw new Error(localize("请先在设置中启用 Feedback", "Enable Feedback in Settings first."));
      const content = typeof message.content === "string" ? message.content.trim().slice(0, 20_000) : "";
      if (!content) throw new Error(localize("消息不能为空", "Message is required."));
      const now = new Date().toISOString();
      const conversation: Gate = { id: randomUUID(), type: "feedback", title: feedbackTitleFromContent(content), message: content, createdAt: now, updatedAt: now, status: "pending", origin: "user", messages: [] };
      const conversations = await loadGlobalFeedback();
      conversations.unshift(conversation);
      await saveGlobalFeedback(conversations);
      await sendStandaloneFeedback(root, conversation.id, content);
      return;
    }
    case "send_feedback_message": {
      await sendStandaloneFeedback(root, String(message.id || ""), typeof message.content === "string" ? message.content : "");
      return;
    }
    case "resolve_gate": {
      const id = String(message.id || "");
      await updateState(root, (state) => { const gate = state.gates.find((item) => item.id === id && item.status === "pending"); if (!gate) return; const now = new Date().toISOString(); gate.status = "resolved"; gate.decision = message.decision === "approve" || message.decision === "reject" ? message.decision : "respond"; gate.response = typeof message.response === "string" ? message.response.trim().slice(0, 10_000) : ""; gate.resolvedAt = now; gate.updatedAt = now; const decisionText = gate.decision === "approve" ? localize("确认", "Approved") : gate.decision === "reject" ? localize("不同意", "Rejected") : ""; const content = gate.response || decisionText; if (content) gate.messages = [...(gate.messages || [{ role: "agent", content: gate.message, createdAt: gate.createdAt }]), { role: "user", content, createdAt: now }]; const run = gate.runId ? (state.runs || []).find((item) => item.id === gate.runId) : undefined; if (run && !TERMINAL_RUN_STATUSES.has(run.status)) { run.status = "continuing"; run.updatedAt = now; run.message = content || localize("Feedback 已回复，等待继续执行", "Feedback resolved; waiting to continue."); } }); return;
    }
    case "update_feedback": {
      const enabled = message.enabled === true;
      await vscode.workspace.getConfiguration("daedalus").update("feedbackEnabled", enabled, vscode.ConfigurationTarget.Global);
      const config = await loadConfig(root);
      if (config) {
        config.settings = { ...(config.settings || {}), feedbackEnabled: enabled };
        await saveConfig(root, config);
        await configureWorkspaceMcp(root, true);
      }
      void vscode.window.showInformationMessage(enabled ? localize("Feedback 已启用，可创建独立会话", "Feedback is enabled; you can start independent conversations.") : localize("Feedback 已关闭", "Feedback is disabled."));
      await publishPanelState(root);
      return;
    }
    case "update_continuous_feedback": {
      const enabled = message.enabled === true;
      await vscode.workspace.getConfiguration("daedalus").update("continuousFeedback", enabled, vscode.ConfigurationTarget.Global);
      const config = await loadConfig(root);
      let result: { installed: boolean; existing?: string } = { installed: false };
      if (config) {
        config.settings = { ...(config.settings || {}), continuousFeedback: enabled };
        await saveConfig(root, config);
        result = await configureContinuousFeedbackRule(root, enabled);
      }
      void vscode.window.showInformationMessage(enabled ? result.existing ? localize("持续反馈已启用；检测到现有 Cursor Rule，已跳过重复安装", "Continuous feedback is enabled; an existing Cursor Rule was detected, so duplicate installation was skipped.") : localize("持续反馈已启用", "Continuous feedback is enabled.") : localize("持续反馈已关闭", "Continuous feedback is disabled."));
      await publishPanelState(root);
      return;
    }
    case "update_auto_execute": {
      const enabled = message.enabled !== false;
      await updateConfig(root, (config) => { config.settings = { ...(config.settings || {}), autoExecuteOnAdvance: enabled }; });
      void vscode.window.showInformationMessage(enabled ? localize("推进后将自动执行下一阶段", "Next stage will auto-execute after advancement.") : localize("推进后需手动执行下一阶段", "Next stage requires manual execution after advancement."));
      await publish(root);
      return;
    }
    case "advance_from_signal": {
      const signal = await loadConversationSignal(root);
      if (!signal || (signal.status && signal.status !== "ready")) return;
      await updateState(root, (state, config) => {
        const workflow = config.workflows.find((item) => item.id === signal.workflowId);
        if (!workflow) return;
        const progress = progressFor(state, workflow);
        if (progress.currentStepId !== signal.currentStepId) return;
        advanceWorkflow(state, workflow, signal.excerpt || localize("Agent 报告当前阶段已就绪", "Agent reported the current stage ready."));
        const now = new Date().toISOString();
        const run = signal.runId ? (state.runs || []).find((item) => item.id === signal.runId) : undefined;
        if (run) { run.status = "completed"; run.finishedAt = now; run.updatedAt = now; run.message = localize("用户已确认建议并推进", "The user confirmed the suggestion and advanced."); }
      });
      await rm(path.join(daedalusDir(root), "conversation-signal.json"), { force: true });
      await publish(root);
      await autoExecuteIfEnabled(root);
      return;
    }
    case "acknowledge_conversation_signal": {
      const signal = await loadConversationSignal(root);
      if (signal && !signal.acknowledgedAt) { signal.acknowledgedAt = new Date().toISOString(); await writeJsonFile(path.join(daedalusDir(root), "conversation-signal.json"), signal); }
      await publish(root);
      return;
    }
    case "open_config": await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.join(daedalusDir(root), "config.json"))); return;
    case "cleanup_workspace": {
      await cleanupDaedalus(root, false);
      void vscode.window.showInformationMessage(localize("当前 Workspace 的 Daedalus 配置与项目级安装已清理", "Daedalus configuration and project-level installations were removed from this Workspace."));
      await publishPanelState(root);
      return;
    }
    case "uninstall_daedalus": {
      await cleanupDaedalus(root, true);
      await panel?.webview.postMessage({ type: "not_initialized", workspace: path.basename(root), preferences: { languageSetting: "auto", language: effectiveLanguage(), editorLanguage: vscode.env.language, themeSetting: "auto", editorTheme: editorTheme() } });
      await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", extensionIdentifier);
      return;
    }
    case "open_file": if (typeof message.path === "string") await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(message.path)); return;
    case "update_language":
      if (message.language === "auto" || message.language === "zh-CN" || message.language === "en") {
        await vscode.workspace.getConfiguration("daedalus").update("language", message.language, vscode.ConfigurationTarget.Global);
        const config = await loadConfig(root);
        if (config) { config.settings = { ...(config.settings || {}), language: message.language as "auto" | "zh-CN" | "en" }; await saveConfig(root, config); }
        await publishPanelState(root);
      }
      return;
    case "update_theme":
      if (message.theme === "auto" || message.theme === "light" || message.theme === "dark") {
        await vscode.workspace.getConfiguration("daedalus").update("theme", message.theme, vscode.ConfigurationTarget.Global);
        await publishPanelState(root);
      }
      return;
  }
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  const root = workspacePath();
  if (!root) { void vscode.window.showWarningMessage(localize("请先打开一个 Workspace", "Open a Workspace first.")); return; }
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    await publishPanelState(root);
    return;
  }
  panel = vscode.window.createWebviewPanel("daedalus.pipeline", "Daedalus", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")] });
  panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, "assets", "icon-light.svg"), dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icon-dark.svg") };
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.webview.onDidReceiveMessage((message) => {
    panelMessageQueue = panelMessageQueue.then(() => message.type === "initialize_workspace" ? initialize(context) : handleMessage(root, message)).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Daedalus: ${text}`);
      void panel?.webview.postMessage({ type: "operation_error", message: text });
    });
  });
  panel.onDidDispose(() => { panel = undefined; });
  await publishPanelState(root);
}

async function initialize(context: vscode.ExtensionContext): Promise<void> {
  const root = workspacePath();
  if (!root) { void vscode.window.showWarningMessage(localize("请先打开一个 Workspace", "Open a Workspace first.")); return; }
  const existing = await loadConfig(root);
  if (existing) { await installBundledDefaults(root, context.extensionUri); await syncCursorStandards(root); await ensureConversationMonitor(root); await ensureAgentOutputRule(root); await configureContinuousFeedbackRule(root, continuousFeedbackSetting(existing.settings?.continuousFeedback === true)); await configureWorkspaceMcp(root, true); void vscode.window.showInformationMessage(localize("当前 Workspace 已初始化 Daedalus", "Daedalus is already initialized in this Workspace.")); await openPanel(context); return; }
  await initializeWorkspace(root, path.basename(root), effectiveLanguage() === "zh-CN" ? "zh" : "en");
  await installBundledDefaults(root, context.extensionUri);
  await syncCursorStandards(root);
  await ensureConversationMonitor(root);
  await ensureAgentOutputRule(root);
  await configureContinuousFeedbackRule(root, continuousFeedbackSetting());
  await configureWorkspaceMcp(root, true);
  void vscode.window.showInformationMessage(localize("Daedalus 已为当前 Workspace 写入默认 Skills、Rules 和研发流程", "Daedalus initialized the default Skills, Rules, and development workflows for this Workspace."));
  await openPanel(context);
}

export function activate(context: vscode.ExtensionContext): void {
  globalHome = context.globalStorageUri.fsPath;
  extensionRoot = context.extensionUri.fsPath;
  extensionVersion = String(context.extension.packageJSON.version || "0.0.0");
  extensionIdentifier = context.extension.id;
  const root = workspacePath();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  statusBarItem.command = "daedalus.openPanel";
  statusBarItem.text = `${DAEDALUS_STATUS_ICON} Daedalus`;
  statusBarItem.tooltip = localize("打开 Daedalus 工作台", "Open Daedalus Workbench");
  statusBarItem.show();
  context.subscriptions.push(
    vscode.commands.registerCommand("daedalus.initializeWorkspace", () => initialize(context).catch((error) => void vscode.window.showErrorMessage(`Daedalus: ${error instanceof Error ? error.message : String(error)}`))),
    vscode.commands.registerCommand("daedalus.openPanel", () => openPanel(context).catch((error) => void vscode.window.showErrorMessage(`Daedalus: ${error instanceof Error ? error.message : String(error)}`))),
    statusBarItem,
  );
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".daedalus/{config,state,conversation-signal}.json"));
    let refreshTimer: NodeJS.Timeout | undefined;
    const refresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void publish(root); }, 180);
    };
    watcher.onDidCreate(refresh); watcher.onDidChange(refresh); watcher.onDidDelete(refresh);
    const gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/.git/{HEAD,index}"));
    gitWatcher.onDidCreate(refresh); gitWatcher.onDidChange(refresh); gitWatcher.onDidDelete(refresh);
    const refsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/.git/refs/**"));
    refsWatcher.onDidCreate(refresh); refsWatcher.onDidChange(refresh); refsWatcher.onDidDelete(refresh);
    const artifactWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.md"));
    const refreshArtifact = (uri: vscode.Uri) => {
      void loadConfig(root).then((config) => {
        if (!config) return;
        const outputRoot = path.resolve(artifactOutputRoot(root, config));
        const file = path.resolve(uri.fsPath);
        if (file.startsWith(`${outputRoot}${path.sep}`)) refresh();
      }).catch(() => undefined);
    };
    artifactWatcher.onDidCreate(refreshArtifact); artifactWatcher.onDidChange(refreshArtifact); artifactWatcher.onDidDelete(refreshArtifact);
    context.subscriptions.push(
      watcher,
      gitWatcher,
      refsWatcher,
      artifactWatcher,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (["language", "theme", "feedbackEnabled", "continuousFeedback"].some((key) => event.affectsConfiguration(`daedalus.${key}`))) void publishPanelState(root);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const file = path.resolve(document.uri.fsPath);
        const projectStandards = path.resolve(daedalusDir(root));
        const globalStandards = path.resolve(globalHome);
        queueLocalChange(root, document.uri, "modified");
        if (file.startsWith(`${projectStandards}${path.sep}`) || file.startsWith(`${globalStandards}${path.sep}`)) void syncCursorStandards(root).then(refresh);
        else refresh();
      }),
      vscode.workspace.onDidCreateFiles((event) => { event.files.forEach((uri) => queueLocalChange(root, uri, "created")); refresh(); }),
      vscode.workspace.onDidDeleteFiles((event) => { event.files.forEach((uri) => queueLocalChange(root, uri, "deleted")); refresh(); }),
      vscode.workspace.onDidRenameFiles((event) => { event.files.forEach(({ oldUri, newUri }) => { queueLocalChange(root, oldUri, "deleted"); queueLocalChange(root, newUri, "created"); }); refresh(); }),
      vscode.window.onDidChangeActiveColorTheme(refresh),
      { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
    );
    void updateStatusBar(root);
    void loadConfig(root).then(async (config) => {
      if (!config) return;
      await installBundledDefaults(root, context.extensionUri);
      await syncCursorStandards(root);
      await ensureConversationMonitor(root);
      await ensureAgentOutputRule(root);
      await configureContinuousFeedbackRule(root, continuousFeedbackSetting(config.settings?.continuousFeedback === true));
      await configureWorkspaceMcp(root, true);
      await publish(root);
    }).catch((error) => void vscode.window.showWarningMessage(`Daedalus: ${error instanceof Error ? error.message : String(error)}`));
  } else {
    void updateStatusBar("");
  }
}

export function deactivate(): void { for (const process of agentProcesses.values()) process.kill("SIGTERM"); panel?.dispose(); statusBarItem?.dispose(); }
