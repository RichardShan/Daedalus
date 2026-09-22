import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface WorkflowStep { id: string; name: string; description: string; skillIds: string[]; ruleIds: string[]; knowledgeIds?: string[]; standards: string[]; }
export interface WorkflowInput { id: string; name: string; description: string; required: boolean; accepts: Array<"url" | "image" | "text">; }
export interface Workflow { id: string; name: string; description: string; agentId?: string; agent?: { enabled: boolean; role: string; instructions?: string }; inputs?: WorkflowInput[]; steps: WorkflowStep[]; }
export interface GitImport { id: string; name: string; url: string; ref?: string; subpath?: string; importedAt: string; relativePath: string; target?: "standards" | "knowledge"; scope?: "project" | "global"; }
export interface LocalImport { id: string; name: string; sourcePath: string; importedAt: string; relativePath: string; target: "standards" | "knowledge"; kind?: "skill" | "rule" | "agent"; scope?: "project" | "global"; }
export interface ArtifactOutputSettings { mode: "workspace" | "git"; directory: string; repositoryUrl?: string; ref?: string; repositoryRelativePath?: string; }
export interface LinkedKnowledgeDir { id: string; name: string; path: string; scope: "project" | "global"; linkedAt: string; }
export interface WorkspaceConfig { version: 1; workspaceName: string; activeWorkflowId: string; workflows: Workflow[]; imports: GitImport[]; localImports?: LocalImport[]; linkedKnowledgeDirs?: LinkedKnowledgeDir[]; settings?: { language?: "auto" | "zh-CN" | "en"; feedbackEnabled?: boolean; continuousFeedback?: boolean; autoExecuteOnAdvance?: boolean; artifactOutput?: ArtifactOutputSettings }; }

export function setActiveWorkflow(config: WorkspaceConfig, workflowId: string): boolean {
  if (!config.workflows.some((workflow) => workflow.id === workflowId)) return false;
  config.activeWorkflowId = workflowId;
  return true;
}
export interface GlobalConfig { version: 1; imports: GitImport[]; localImports?: LocalImport[]; }
export interface StepCompletion { stepId: string; summary?: string; completedAt: string; }
export interface WorkflowProgress { workflowId: string; currentStepId: string | null; completed: StepCompletion[]; inputs?: Record<string, string>; updatedAt: string; }
export interface GateMessage { role: "agent" | "user"; content: string; createdAt: string; }
export function feedbackTitleFromContent(content: string, maxLength = 32): string {
  const normalized = content.replace(/\s+/g, " ").replace(/^[#>*_`\-\s]+/, "").trim();
  if (!normalized) return "Feedback";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}…` : normalized;
}
export function parseStandaloneAgentResponse(response: string): { title?: string; content: string } {
  const match = response.match(/^\s*`?DAEDALUS_TITLE:\s*([^\r\n`]+)`?\s*(?:\r?\n|$)/i);
  if (!match) return { content: response.trim() };
  const title = match[1].trim().replace(/^["'“‘]+|["'”’]+$/g, "").slice(0, 60).trim();
  return { title: title || undefined, content: response.slice(match[0].length).trim() };
}
export type WorkflowRunStatus = "starting" | "running" | "waiting_feedback" | "continuing" | "ready_suggested" | "blocked" | "paused" | "completed" | "stopped" | "failed";
export interface WorkflowRun {
  id: string;
  workflowId: string;
  stepId: string;
  channel: "feedback" | "cursor-native";
  status: WorkflowRunStatus;
  cursorSessionId?: string;
  cursorSessionKind?: "native-ui" | "cli";
  feedbackThreadId?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  message?: string;
  summary?: string;
}
export function reusableNativeCursorSessionId(run?: WorkflowRun): string | undefined {
  const sessionId = run?.cursorSessionId?.trim();
  return run?.channel === "cursor-native" && run.cursorSessionKind === "native-ui" && sessionId ? sessionId : undefined;
}
const WORKFLOW_RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  starting: ["running", "waiting_feedback", "ready_suggested", "blocked", "paused", "stopped", "failed"],
  running: ["waiting_feedback", "continuing", "ready_suggested", "blocked", "paused", "stopped", "failed"],
  waiting_feedback: ["continuing", "paused", "stopped", "failed"],
  continuing: ["running", "waiting_feedback", "ready_suggested", "blocked", "paused", "stopped", "failed"],
  ready_suggested: ["continuing", "waiting_feedback", "completed", "stopped"],
  blocked: ["continuing", "waiting_feedback", "paused", "stopped", "failed"],
  paused: ["starting", "running", "continuing", "stopped", "failed"],
  completed: [],
  stopped: [],
  failed: ["starting"],
};
export function canTransitionWorkflowRun(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean { return from === to || WORKFLOW_RUN_TRANSITIONS[from].includes(to); }
export function transitionWorkflowRun(run: WorkflowRun, status: WorkflowRunStatus, message?: string, at = new Date().toISOString()): void {
  if (!canTransitionWorkflowRun(run.status, status)) throw new Error(`Invalid workflow run transition: ${run.status} -> ${status}`);
  run.status = status;
  run.updatedAt = at;
  if (message !== undefined) run.message = message;
  if (["completed", "stopped", "failed"].includes(status)) run.finishedAt = at;
  else delete run.finishedAt;
}
export interface Gate { id: string; type: "feedback" | "approval"; title: string; message: string; workflowId?: string; stepId?: string; runId?: string; cursorSessionId?: string; createdAt: string; updatedAt?: string; status: "pending" | "resolved"; origin?: "mcp" | "hook" | "user"; decision?: "approve" | "reject" | "respond"; response?: string; resolvedAt?: string; messages?: GateMessage[]; busy?: boolean; }
export interface LocalChange { path: string; status: "created" | "modified" | "deleted"; recordedAt: string; }
export interface RuntimeState { version: 2; progress: WorkflowProgress[]; gates: Gate[]; runs?: WorkflowRun[]; activeRunId?: string; localChanges?: LocalChange[]; }
export interface LibraryItem { id: string; kind: "skill" | "rule" | "agent"; name: string; description: string; source: "default" | "workspace" | "local" | "git" | "native"; scope: "project" | "global"; absolutePath: string; installedPath?: string; relativePath: string; importId?: string; content: string; }
export interface KnowledgeItem { id: string; name: string; description: string; scope: "project" | "global"; source: "direct" | "local" | "git" | "linked"; absolutePath: string; relativePath: string; importId?: string; linkedDirId?: string; content: string; }
export interface AgentArtifact { id: string; name: string; absolutePath: string; relativePath: string; content: string; updatedAt: string; workflowId?: string; stepId?: string; kind?: "summary" | "plan" | "design" | "other"; }

export function defaultSkills(language: "zh" | "en" = "zh") {
  const zh = language === "zh";
  return [
    { id: "requirement-analysis", name: zh ? "需求澄清" : "Requirement Analysis", description: zh ? "识别目标、边界、用户场景、验收标准与待确认问题。" : "Identify goals, boundaries, user scenarios, acceptance criteria, and open questions.", content: zh ? `---\nname: 需求澄清\ndescription: 识别目标、边界、用户场景、验收标准与待确认问题。\n---\n\n# 需求澄清\n\n1. 明确用户目标、使用场景和非目标。\n2. 把模糊描述转换为可验证的验收标准。\n3. 标记假设、依赖、风险和必须由用户决策的问题。\n4. 在编码前输出简明需求摘要。\n` : `---\nname: Requirement Analysis\ndescription: Identify goals, boundaries, user scenarios, acceptance criteria, and open questions.\n---\n\n# Requirement Analysis\n\n1. Clarify user goals, usage scenarios, and non-goals.\n2. Convert vague descriptions into verifiable acceptance criteria.\n3. Flag assumptions, dependencies, risks, and questions requiring user decisions.\n4. Produce a concise requirement summary before coding.\n` },
    { id: "technical-design", name: zh ? "技术设计" : "Technical Design", description: zh ? "基于现有代码给出最小、可维护且可验证的实现方案。" : "Produce a minimal, maintainable, and verifiable implementation plan based on existing code.", content: zh ? `---\nname: 技术设计\ndescription: 基于现有代码给出最小、可维护且可验证的实现方案。\n---\n\n# 技术设计\n\n1. 先理解现有边界、数据流和约束。\n2. 给出模块职责、接口、状态变化和失败处理。\n3. 优先复用现有抽象，避免无必要的新依赖。\n4. 明确验证方式和回滚策略。\n` : `---\nname: Technical Design\ndescription: Produce a minimal, maintainable, and verifiable implementation plan based on existing code.\n---\n\n# Technical Design\n\n1. Understand existing boundaries, data flows, and constraints first.\n2. Define module responsibilities, interfaces, state changes, and failure handling.\n3. Reuse existing abstractions; avoid unnecessary new dependencies.\n4. Specify verification approach and rollback strategy.\n` },
    { id: "implementation", name: zh ? "增量实现" : "Incremental Implementation", description: zh ? "以小步、可审查的方式完成代码改动。" : "Complete code changes in small, reviewable increments.", content: zh ? `---\nname: 增量实现\ndescription: 以小步、可审查的方式完成代码改动。\n---\n\n# 增量实现\n\n1. 保护用户已有改动，只修改当前目标需要的文件。\n2. 保持接口清晰、命名一致、错误可诊断。\n3. 每完成一个逻辑单元就进行局部验证。\n4. 不把密钥、令牌或机器专属路径写入源码。\n` : `---\nname: Incremental Implementation\ndescription: Complete code changes in small, reviewable increments.\n---\n\n# Incremental Implementation\n\n1. Protect the user's existing changes; only modify files required by the current goal.\n2. Keep interfaces clear, naming consistent, and errors diagnosable.\n3. Perform local verification after each logical unit.\n4. Never commit secrets, tokens, or machine-specific paths into source code.\n` },
    { id: "verification", name: zh ? "测试与验收" : "Testing & Acceptance", description: zh ? "用证据确认功能、回归风险和交付状态。" : "Confirm functionality, regression risk, and delivery status with evidence.", content: zh ? `---\nname: 测试与验收\ndescription: 用证据确认功能、回归风险和交付状态。\n---\n\n# 测试与验收\n\n1. 执行与改动风险匹配的类型检查、自动化测试和构建。\n2. 验证主要路径、边界条件和失败路径。\n3. 区分已验证、未验证和受环境限制的结论。\n4. 交付时说明改动、验证结果和剩余风险。\n` : `---\nname: Testing & Acceptance\ndescription: Confirm functionality, regression risk, and delivery status with evidence.\n---\n\n# Testing & Acceptance\n\n1. Run type checks, automated tests, and builds proportional to change risk.\n2. Verify happy paths, boundary conditions, and failure paths.\n3. Distinguish verified, unverified, and environment-limited conclusions.\n4. On delivery, state the changes, verification results, and residual risks.\n` },
  ];
}
export const DEFAULT_SKILLS = defaultSkills("zh");

export function defaultRules(language: "zh" | "en" = "zh") {
  const zh = language === "zh";
  return [
    { id: "workspace-scope", name: zh ? "Workspace 边界" : "Workspace Scope", description: zh ? "所有状态、规范和导入资源必须隔离在当前 Workspace。" : "All state, specs, and imported resources must be scoped to the current Workspace.", content: zh ? `---\nname: Workspace 边界\ndescription: 所有状态、规范和导入资源必须隔离在当前 Workspace。\n---\n\n# Workspace 边界\n\n- 只读取和修改当前 Workspace 授权范围内的文件。\n- 不把一个 Workspace 的配置、上下文或状态带入另一个 Workspace。\n- 未初始化 Daedalus 的 Workspace 不自动启动规范流程。\n` : `---\nname: Workspace Scope\ndescription: All state, specs, and imported resources must be scoped to the current Workspace.\n---\n\n# Workspace Scope\n\n- Only read and modify files within the current Workspace's authorized scope.\n- Never carry configuration, context, or state from one Workspace into another.\n- Do not auto-start spec workflows in Workspaces where Daedalus is not initialized.\n` },
    { id: "safe-change", name: zh ? "安全变更" : "Safe Changes", description: zh ? "保持改动聚焦、可恢复，并尊重已有工作。" : "Keep changes focused, reversible, and respectful of existing work.", content: zh ? `---\nname: 安全变更\ndescription: 保持改动聚焦、可恢复，并尊重已有工作。\n---\n\n# 安全变更\n\n- 不覆盖无关的用户修改。\n- 破坏性操作必须有明确授权和精确目标。\n- 新增依赖前说明必要性，禁止提交凭据。\n` : `---\nname: Safe Changes\ndescription: Keep changes focused, reversible, and respectful of existing work.\n---\n\n# Safe Changes\n\n- Do not overwrite unrelated user modifications.\n- Destructive operations require explicit authorization and a precise target.\n- Justify new dependencies before adding them; never commit credentials.\n` },
    { id: "evidence-first", name: zh ? "证据优先" : "Evidence First", description: zh ? "重要结论来自代码、测试或明确的运行结果。" : "Important conclusions must come from code, tests, or explicit runtime output.", content: zh ? `---\nname: 证据优先\ndescription: 重要结论来自代码、测试或明确的运行结果。\n---\n\n# 证据优先\n\n- 先检查实际代码和配置，再提出方案。\n- 不把推测描述成已验证事实。\n- 完成声明必须附带相称的验证证据。\n` : `---\nname: Evidence First\ndescription: Important conclusions must come from code, tests, or explicit runtime output.\n---\n\n# Evidence First\n\n- Inspect actual code and configuration before proposing a solution.\n- Do not present speculation as verified fact.\n- Completion claims must be backed by proportional verification evidence.\n` },
  ];
}
export const DEFAULT_RULES = defaultRules("zh");

export function daedalusDir(workspace: string): string { return path.join(workspace, ".daedalus"); }
export function configPath(workspace: string): string { return path.join(daedalusDir(workspace), "config.json"); }
export function statePath(workspace: string): string { return path.join(daedalusDir(workspace), "state.json"); }
export function globalConfigPath(globalHome: string): string { return path.join(globalHome, "config.json"); }

function safeChild(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relative.replaceAll("\\", "/").split("/"));
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

export function artifactOutputRoot(workspace: string, config: WorkspaceConfig): string {
  const output = config.settings?.artifactOutput || { mode: "workspace" as const, directory: ".daedalus/artifacts" };
  if (output.mode === "git") {
    if (!output.repositoryRelativePath) throw new Error("Agent Git 输出仓库尚未配置");
    const repository = safeChild(daedalusDir(workspace), output.repositoryRelativePath);
    const selected = repository && safeChild(repository, output.directory || ".");
    if (!selected) throw new Error("Agent 输出目录不是安全的相对路径");
    return selected;
  }
  const selected = safeChild(workspace, output.directory || ".daedalus/artifacts");
  if (!selected) throw new Error("Agent 输出目录不是安全的 Workspace 相对路径");
  return selected;
}

export async function writeAgentArtifact(workspace: string, config: WorkspaceConfig, kind: "summary" | "plan" | "design" | "other", title: string, content: string, filename?: string, context?: { workflowId?: string; stepId?: string }): Promise<{ absolutePath: string; relativePath: string }> {
  const root = artifactOutputRoot(workspace, config);
  if (config.settings?.artifactOutput?.mode === "git") {
    const repository = safeChild(daedalusDir(workspace), config.settings.artifactOutput.repositoryRelativePath || "");
    if (!repository || !await stat(path.join(repository, ".git")).then(() => true).catch(() => false)) throw new Error("Agent Git 输出仓库不可用，请在 Daedalus 设置中重新配置");
  }
  const generated = `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`;
  const requested = (filename || generated).trim().replaceAll("\\", "/");
  if (!requested || requested.startsWith("/") || /^[A-Za-z]:/.test(requested) || requested.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("输出文件名必须是安全的相对路径");
  const markdownName = /\.md$/i.test(requested) ? requested : `${requested}.md`;
  const destination = safeChild(root, markdownName);
  if (!destination) throw new Error("输出文件超出了配置目录");
  await mkdir(path.dirname(destination), { recursive: true });
  const body = content.trim();
  const frontmatter = ["---", `daedalusKind: ${kind}`, ...(context?.workflowId ? [`daedalusWorkflowId: ${context.workflowId}`] : []), ...(context?.stepId ? [`daedalusStepId: ${context.stepId}`] : []), "---", ""].join("\n");
  const document = `${frontmatter}${/^#\s/m.test(body) ? `${body}\n` : `# ${title.trim()}\n\n${body}\n`}`;
  await writeFile(destination, document, { encoding: "utf8", flag: "wx" });
  return { absolutePath: destination, relativePath: path.relative(workspace, destination) };
}

export async function loadConfig(workspace: string): Promise<WorkspaceConfig | null> {
  try {
    const value = JSON.parse(await readFile(configPath(workspace), "utf8")) as WorkspaceConfig;
    if (value.version !== 1 || !Array.isArray(value.workflows)) throw new Error("不支持的 Daedalus 配置格式");
    value.localImports = Array.isArray(value.localImports) ? value.localImports : [];
    value.settings = { language: "auto", feedbackEnabled: false, continuousFeedback: false, autoExecuteOnAdvance: true, ...(value.settings || {}) };
    value.workflows = value.workflows.filter((workflow) => workflow.id !== "test-case-regression");
    const caseAlignment = value.workflows.find((workflow) => workflow.id === "test-case-alignment");
    if (caseAlignment?.name === "测试用例驱动对齐") caseAlignment.name = "用例驱动对齐";
    if (caseAlignment?.name === "Test Case Alignment") caseAlignment.name = "Case-driven Alignment";
    if (!value.workflows.some((workflow) => workflow.id === value.activeWorkflowId)) value.activeWorkflowId = value.workflows[0]?.id || "";
    for (const workflow of value.workflows) {
      if (!workflow.agentId && workflow.id === "standard-development") workflow.agentId = "agent:implementation";
      if (!workflow.agentId && ["test-case-alignment", "code-review"].includes(workflow.id)) workflow.agentId = "agent:quality-review";
      for (const step of workflow.steps) {
        step.ruleIds = step.ruleIds.filter((id) => id !== "rule:continuous-feedback" && id !== "rule:ask-questions-feedback-loop");
        step.knowledgeIds = Array.isArray(step.knowledgeIds) ? step.knowledgeIds.filter((id): id is string => typeof id === "string") : [];
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJsonWrite(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

export async function saveConfig(workspace: string, config: WorkspaceConfig): Promise<void> { await atomicJsonWrite(configPath(workspace), config); }
export async function loadGlobalConfig(globalHome?: string): Promise<GlobalConfig> {
  if (!globalHome) return { version: 1, imports: [], localImports: [] };
  try {
    const value = JSON.parse(await readFile(globalConfigPath(globalHome), "utf8")) as GlobalConfig;
    return value.version === 1 && Array.isArray(value.imports) ? { ...value, localImports: Array.isArray(value.localImports) ? value.localImports : [] } : { version: 1, imports: [], localImports: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, imports: [], localImports: [] };
    throw error;
  }
}
export async function saveGlobalConfig(globalHome: string, config: GlobalConfig): Promise<void> { await atomicJsonWrite(globalConfigPath(globalHome), config); }
export function emptyState(): RuntimeState { return { version: 2, progress: [], gates: [], runs: [], localChanges: [] }; }

function completeJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeState>;
  return candidate.version === 2 && Array.isArray(candidate.progress) && Array.isArray(candidate.gates);
}

export async function loadState(workspace: string): Promise<RuntimeState> {
  try {
    const file = statePath(workspace);
    const raw = await readFile(file, "utf8");
    let value: RuntimeState;
    try {
      value = JSON.parse(raw) as RuntimeState;
    } catch (originalError) {
      let recovered: RuntimeState | undefined;
      for (const document of completeJsonObjects(raw).reverse()) {
        try {
          const candidate = JSON.parse(document) as unknown;
          if (isRuntimeState(candidate)) { recovered = candidate; break; }
        } catch { /* Try the previous complete top-level JSON object. */ }
      }
      if (!recovered) throw originalError;
      value = recovered;
      await atomicJsonWrite(file, recovered);
    }
    if (value.version !== 2 || !Array.isArray(value.progress) || !Array.isArray(value.gates)) return emptyState();
    const normalized: RuntimeState = { ...value, runs: Array.isArray(value.runs) ? value.runs : [], localChanges: Array.isArray(value.localChanges) ? value.localChanges : [] };
    let migratedLegacyNativeRun = false;
    const migratedAt = new Date().toISOString();
    for (const run of normalized.runs || []) {
      if (run.channel !== "cursor-native" || run.cursorSessionKind || !run.cursorSessionId || ["completed", "stopped", "failed"].includes(run.status)) continue;
      run.status = "stopped";
      run.finishedAt = migratedAt;
      run.updatedAt = migratedAt;
      run.message = "Legacy CLI session binding retired; start the stage again to create a native Cursor conversation.";
      if (normalized.activeRunId === run.id) delete normalized.activeRunId;
      migratedLegacyNativeRun = true;
    }
    if (migratedLegacyNativeRun) await atomicJsonWrite(file, normalized);
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}
export async function saveState(workspace: string, state: RuntimeState): Promise<void> { await atomicJsonWrite(statePath(workspace), state); }

export function defaultConfig(workspaceName: string, language: "zh" | "en" = "zh"): WorkspaceConfig {
  const zh = language === "zh";
  return { version: 1, workspaceName, activeWorkflowId: "standard-development", imports: [], localImports: [], settings: { language: "auto", feedbackEnabled: false, continuousFeedback: false, autoExecuteOnAdvance: true, artifactOutput: { mode: "workspace", directory: ".daedalus/artifacts" } }, workflows: [
    {
      id: "standard-development", name: zh ? "标准研发流程" : "Standard Development", description: zh ? "从需求澄清到测试验收的默认全流程。" : "A complete workflow from requirement clarification to acceptance.", agentId: "agent:implementation", steps: [
        { id: "requirement", name: zh ? "需求梳理" : "Requirement Clarification", description: zh ? "明确目标、边界与验收标准。" : "Clarify goals, scope, and acceptance criteria.", skillIds: ["skill:requirement-analysis"], ruleIds: ["rule:workspace-scope", "rule:evidence-first"], standards: zh ? ["输出需求摘要", "列出验收标准", "记录待确认问题"] : ["Produce a requirement summary", "List acceptance criteria", "Record open questions"] },
        { id: "design", name: zh ? "技术设计" : "Technical Design", description: zh ? "形成与现有代码一致的实现方案。" : "Design an implementation aligned with the existing codebase.", skillIds: ["skill:technical-design"], ruleIds: ["rule:workspace-scope", "rule:safe-change"], standards: zh ? ["说明模块边界", "说明数据流和失败处理", "定义验证方案"] : ["Describe module boundaries", "Describe data flow and failures", "Define verification"] },
        { id: "implementation", name: zh ? "编码实现" : "Implementation", description: zh ? "按设计小步实现并持续验证。" : "Implement incrementally with continuous verification.", skillIds: ["skill:implementation"], ruleIds: ["rule:safe-change", "rule:evidence-first"], standards: zh ? ["保护已有改动", "不得写入凭据", "保持改动聚焦"] : ["Preserve existing changes", "Never commit credentials", "Keep changes focused"] },
        { id: "verification", name: zh ? "测试验收" : "Verification", description: zh ? "验证功能、边界和交付质量。" : "Verify behavior, edge cases, and delivery quality.", skillIds: ["skill:verification"], ruleIds: ["rule:evidence-first"], standards: zh ? ["类型检查通过", "相关测试通过", "记录未验证项和风险"] : ["Type checks pass", "Relevant tests pass", "Record unverified risks"] },
      ],
    },
    {
      id: "test-case-alignment", name: zh ? "用例驱动对齐" : "Case-driven Alignment", description: zh ? "以已有测试用例为准绳完成实现、核对和验收。" : "Implement and verify changes against an existing test-case source.", agentId: "agent:quality-review", inputs: [{ id: "test-cases", name: zh ? "测试用例来源" : "Test-case source", description: zh ? "请提供测试用例 URL、截图路径/地址，或直接粘贴测试用例文字。" : "Provide a test-case URL, screenshot path/URL, or pasted test-case text.", required: true, accepts: ["url", "image", "text"] }], steps: [
        { id: "case-intake", name: zh ? "测试用例解析" : "Test-case Intake", description: zh ? "读取测试用例并提取前置条件、操作和预期结果。" : "Extract preconditions, actions, and expected results.", skillIds: ["skill:requirement-analysis"], ruleIds: ["rule:evidence-first"], standards: zh ? ["每条用例可追踪", "标记缺失信息", "不得臆造预期结果"] : ["Every case is traceable", "Flag missing information", "Do not invent expectations"] },
        { id: "case-mapping", name: zh ? "代码映射与差距分析" : "Code Mapping and Gap Analysis", description: zh ? "把每条用例映射到代码路径并识别差距。" : "Map each case to code paths and identify gaps.", skillIds: ["skill:technical-design"], ruleIds: ["rule:workspace-scope", "rule:evidence-first"], standards: zh ? ["建立用例到代码映射", "列出实现差距", "定义验证方法"] : ["Map cases to code", "List implementation gaps", "Define verification"] },
        { id: "case-implementation", name: zh ? "对齐实现" : "Aligned Implementation", description: zh ? "按用例差距完成最小实现。" : "Implement the smallest changes needed to close the gaps.", skillIds: ["skill:implementation"], ruleIds: ["rule:safe-change"], standards: zh ? ["逐条对应测试用例", "避免超范围改动", "保留可追踪证据"] : ["Address each test case", "Avoid out-of-scope changes", "Keep traceable evidence"] },
        { id: "case-verification", name: zh ? "用例逐项验收" : "Case-by-case Verification", description: zh ? "逐条执行或验证测试用例并形成结果。" : "Execute or verify every test case and report results.", skillIds: ["skill:verification"], ruleIds: ["rule:evidence-first"], standards: zh ? ["记录每条用例结果", "附上失败证据", "汇总剩余风险"] : ["Record every result", "Attach failure evidence", "Summarize remaining risks"] },
      ],
    },
    {
      id: "code-review", name: zh ? "代码 Review" : "Code Review", description: zh ? "面向正确性、安全性、可维护性和测试充分性的系统审查。" : "Review correctness, security, maintainability, and test coverage.", agentId: "agent:quality-review", steps: [
        { id: "review-scope", name: zh ? "确认审查范围" : "Define Review Scope", description: zh ? "确认变更基线、目标和风险区域。" : "Confirm the diff base, goals, and risk areas.", skillIds: ["skill:requirement-analysis"], ruleIds: ["rule:workspace-scope", "rule:evidence-first"], standards: zh ? ["明确 Diff 范围", "理解业务目标", "识别高风险模块"] : ["Define the diff", "Understand the goal", "Identify high-risk modules"] },
        { id: "review-analysis", name: zh ? "代码审查" : "Code Analysis", description: zh ? "检查缺陷、回归、安全、性能和维护成本。" : "Inspect defects, regressions, security, performance, and maintenance cost.", skillIds: ["skill:technical-design", "skill:verification"], ruleIds: ["rule:safe-change", "rule:evidence-first"], standards: zh ? ["问题必须可定位", "区分优先级", "避免纯风格噪音"] : ["Findings are actionable", "Assign priorities", "Avoid style-only noise"] },
        { id: "review-fixes", name: zh ? "修复与复核" : "Fix and Re-review", description: zh ? "修复确认的问题并复核影响范围。" : "Fix confirmed issues and re-check affected paths.", skillIds: ["skill:implementation"], ruleIds: ["rule:safe-change"], standards: zh ? ["只修复确认问题", "增加必要测试", "复核回归风险"] : ["Fix confirmed issues only", "Add necessary tests", "Re-check regression risk"] },
        { id: "review-report", name: zh ? "Review 结论" : "Review Report", description: zh ? "输出问题、证据、修复状态和剩余风险。" : "Report findings, evidence, fix status, and remaining risks.", skillIds: ["skill:verification"], ruleIds: ["rule:evidence-first"], standards: zh ? ["按优先级排序", "引用具体文件位置", "明确通过或阻塞"] : ["Sort by priority", "Reference exact locations", "State pass or block"] },
      ],
    },
  ] };
}

export async function initializeWorkspace(workspace: string, workspaceName: string, language: "zh" | "en" = "zh"): Promise<WorkspaceConfig> {
  const existing = await loadConfig(workspace);
  if (existing) return existing;
  await Promise.all(["skills", "rules", "agents", "scripts", "imports", "knowledge", "knowledge-imports", "artifacts", "artifact-repositories"].map((name) => mkdir(path.join(daedalusDir(workspace), name), { recursive: true })));
  for (const skill of defaultSkills(language)) {
    const directory = path.join(daedalusDir(workspace), "skills", skill.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), skill.content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  for (const rule of defaultRules(language)) {
    await writeFile(path.join(daedalusDir(workspace), "rules", `${rule.id}.md`), rule.content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  }
  const config = defaultConfig(workspaceName, language);
  await saveConfig(workspace, config);
  await saveState(workspace, emptyState());
  return config;
}

async function walk(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function scanAgentArtifacts(workspace: string, config: WorkspaceConfig): Promise<AgentArtifact[]> {
  const root = artifactOutputRoot(workspace, config);
  const files = (await walk(root)).filter((file) => /\.md$/i.test(file)).slice(0, 200);
  const artifacts = await Promise.all(files.map(async (file) => {
    const [content, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const relative = path.relative(root, file);
    const fallback = path.basename(file, path.extname(file)).replace(/[-_]+/g, " ");
    const kind = content.match(/^daedalusKind:\s*(summary|plan|design|other)\s*$/m)?.[1] as AgentArtifact["kind"];
    return { id: `artifact:${relative.replaceAll(path.sep, "/")}`, name: content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback, absolutePath: file, relativePath: relative, content: content.slice(0, 300_000), updatedAt: info.mtime.toISOString(), workflowId: content.match(/^daedalusWorkflowId:\s*(.+)$/m)?.[1]?.trim(), stepId: content.match(/^daedalusStepId:\s*(.+)$/m)?.[1]?.trim(), kind };
  }));
  return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function filesAt(target: string): Promise<string[]> {
  try { return (await stat(target)).isFile() ? [target] : walk(target); } catch { return []; }
}

function selectedImportRoot(importRoot: string, subpath?: string): string | null {
  const resolvedRoot = path.resolve(importRoot);
  const selected = subpath ? path.resolve(importRoot, ...subpath.split("/")) : resolvedRoot;
  return selected === resolvedRoot || selected.startsWith(`${resolvedRoot}${path.sep}`) ? selected : null;
}

function metadata(content: string, fallbackName: string): { name: string; description: string } {
  const block = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || "";
  return {
    name: block.match(/^name:\s*(.+)$/m)?.[1]?.trim() || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackName,
    description: block.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "",
  };
}

const BUNDLED_LIBRARY_NAMES: Record<string, { zh: string; en: string; descZh?: string; descEn?: string }> = {
  "agent:daedalus-implementation": { zh: "实现 Agent", en: "Implementation Agent", descZh: "以小步、可审查的方式完成代码改动，不提交 git。", descEn: "Implement code changes in small, reviewable increments. No git commits." },
  "agent:daedalus-quality-review": { zh: "质量审查 Agent", en: "Quality Review Agent", descZh: "审查代码变更、直接修复问题并运行验证。", descEn: "Review code changes, fix issues directly, and run verification." },
  "agent:daedalus-research": { zh: "调研 Agent", en: "Research Agent", descZh: "探索代码库和技术方案，将发现持久化到文件。", descEn: "Explore codebases and technical solutions, persist findings to files." },
  "skill:daedalus-pre-development": { zh: "编码前准备", en: "Pre-development Check", descZh: "编码前加载项目编码规范。开始新任务、切换模块、或需要刷新规范认知时使用。", descEn: "Load project coding standards before writing code. Use when starting a new task, switching modules, or needing to refresh spec awareness." },
  "skill:daedalus-requirement-analysis": { zh: "需求澄清", en: "Requirement Analysis", descZh: "识别目标、边界、用户场景、验收标准与待确认问题。适用于清晰的直接需求。", descEn: "Identify goals, boundaries, user scenarios, acceptance criteria, and open questions. Use for straightforward requirements." },
  "skill:daedalus-requirement-workshop": { zh: "需求工坊", en: "Requirement Workshop", descZh: "协作式需求发现。逐个提问、代码优先探索、收敛到 MVP 范围。", descEn: "Collaborative requirement discovery through iterative questioning. Explore code-first, converge to MVP scope." },
  "skill:daedalus-technical-design": { zh: "技术设计", en: "Technical Design", descZh: "基于现有代码给出最小、可维护且可验证的实现方案。", descEn: "Produce a minimal, maintainable, and verifiable implementation plan based on existing code." },
  "skill:daedalus-implementation": { zh: "增量实现", en: "Incremental Implementation", descZh: "以小步、可审查的方式完成代码改动。", descEn: "Complete code changes in small, reviewable increments." },
  "skill:daedalus-verification": { zh: "测试与验收", en: "Testing & Acceptance", descZh: "用证据确认功能、回归风险和交付状态。", descEn: "Confirm functionality, regression risk, and delivery status with evidence." },
  "skill:daedalus-quality-verification": { zh: "代码质量检查", en: "Quality Verification", descZh: "多维度代码质量审查：规范合规、lint、类型检查、测试、跨层数据流、代码复用与一致性。", descEn: "Multi-dimension code quality review: spec compliance, lint, type-check, tests, cross-layer data flow, code reuse, and consistency." },
  "skill:daedalus-root-cause-review": { zh: "根因分析", en: "Root-cause Review", descZh: "Bug 根因分析，打断修复-遗忘-重复循环。", descEn: "Bug root-cause analysis. Break the fix-forget-repeat cycle." },
  "skill:daedalus-multi-agent-collaboration": { zh: "多 Agent 协作", en: "Multi-agent Collaboration", descZh: "多 Agent 协作模式指南。用于任务拆分、并行调查、跨 Agent 审查。", descEn: "Multi-agent collaboration patterns. Use for task decomposition, parallel investigation, cross-agent review." },
  "skill:daedalus-agent-configuration": { zh: "Agent 配置", en: "Agent Configuration", descZh: "理解和定制项目中的 Daedalus 本地架构。", descEn: "Understand and customize the local Daedalus architecture inside a user project." },
  "skill:daedalus-session-insights": { zh: "会话洞察", en: "Session Insights", descZh: "从过往对话历史中检索上下文。用于「上次怎么解的」「之前讨论过吗」等场景。", descEn: "Retrieve context from past conversation history. Use for cross-session continuity and pattern recognition." },
  "skill:daedalus-standards-bootstrap": { zh: "规范初始化", en: "Standards Bootstrap", descZh: "从真实代码库初始化项目编码规范。", descEn: "Initialize project coding standards from the real codebase." },
  "skill:daedalus-standards-capture": { zh: "规范沉淀", en: "Standards Capture", descZh: "将调试、实现、讨论中学到的可执行契约和编码惯例沉淀到规范文档。", descEn: "Capture executable contracts and coding conventions discovered during debugging, implementation, or discussion." },
  "skill:daedalus-first-principles": { zh: "第一性原理", en: "First Principles Thinking", descZh: "将问题分解到基本事实再设计方案。需求模糊、方案过度设计时使用。", descEn: "Decompose problems to fundamental truths before designing solutions." },
  "rule:daedalus-safe-change": { zh: "安全变更", en: "Safe Changes", descZh: "保持变更聚焦、可逆，尊重已有代码。", descEn: "Keep changes focused, reversible, and respectful of existing work." },
  "rule:daedalus-evidence-first": { zh: "证据优先", en: "Evidence First", descZh: "重要结论必须来源于代码、测试或明确的运行输出。", descEn: "Important conclusions must come from code, tests, or explicit runtime output." },
  "rule:daedalus-workspace-scope": { zh: "Workspace 边界", en: "Workspace Scope", descZh: "所有状态、规范和导入资源必须限定在当前 Workspace 内。", descEn: "All state, specs, and imported resources must be scoped to the current Workspace." },
  "rule:ask-questions-feedback-loop": { zh: "持续反馈", en: "Continuous Feedback", descZh: "Agent 在每个有意义的响应末尾向用户征求反馈。", descEn: "Agent solicits user feedback at the end of each meaningful response." },
  "rule:daedalus-agent-output": { zh: "文档输出", en: "Agent Output", descZh: "将 Agent 非代码交付物保存到配置的输出目录。", descEn: "Save Agent non-code deliverables to the configured output directory." },
};
const BUNDLED_PUBLIC_SLUGS: Record<string, string> = {
  "rule:ask-questions-feedback-loop": "continuous-feedback",
};
function publicLibraryId(kind: LibraryItem["kind"], slug: string): string { return `${kind}:${BUNDLED_PUBLIC_SLUGS[`${kind}:${slug}`] || slug}`; }
function libraryMetadata(kind: LibraryItem["kind"], slug: string, content: string, fallback: string, language: "zh-CN" | "en" = "en"): { name: string; description: string } {
  const value = metadata(content, fallback);
  const bundled = BUNDLED_LIBRARY_NAMES[`${kind}:${slug}`];
  const name = bundled ? (language === "zh-CN" ? bundled.zh : bundled.en) : value.name;
  const description = bundled && (language === "zh-CN" ? bundled.descZh : bundled.descEn) || value.description;
  return { name, description };
}

function cursorLibrarySlug(item: Pick<LibraryItem, "id" | "name">): string {
  const bundled = item.id.split(":").at(-1) || item.name;
  const value = bundled.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 63) || "standard";
  return value.startsWith("daedalus-") ? value : `daedalus-${value}`;
}

export function cursorLibraryPath(workspace: string, item: Pick<LibraryItem, "id" | "name" | "kind" | "scope">, cursorUserRoot = path.join(homedir(), ".cursor")): string {
  const root = item.scope === "global" ? cursorUserRoot : path.join(workspace, ".cursor");
  const slug = cursorLibrarySlug(item);
  if (item.kind === "skill") return path.join(root, "skills", slug, "SKILL.md");
  return path.join(root, item.kind === "rule" ? "rules" : "agents", `${slug}.${item.kind === "rule" ? "mdc" : "md"}`);
}

export async function scanLibrary(workspace: string, config: WorkspaceConfig, globalHome?: string, language: "zh-CN" | "en" = "en"): Promise<LibraryItem[]> {
  const root = daedalusDir(workspace);
  const items: LibraryItem[] = [];
  for (const file of (await walk(path.join(root, "skills"))).filter((file) => path.basename(file).toLowerCase() === "skill.md")) {
    const content = await readFile(file, "utf8"); const slug = path.basename(path.dirname(file)); const relativePath = path.relative(workspace, file); const local = config.localImports?.find((item) => item.target === "standards" && item.relativePath === relativePath);
    items.push({ id: publicLibraryId("skill", slug), kind: "skill", scope: "project", source: DEFAULT_SKILLS.some((item) => item.id === slug) || BUNDLED_LIBRARY_NAMES[`skill:${slug}`] ? "default" : local ? "local" : "workspace", importId: local?.id, absolutePath: file, relativePath, content, ...libraryMetadata("skill", slug, content, slug, language) });
  }
  for (const file of (await walk(path.join(root, "rules"))).filter((file) => /\.(md|mdc)$/i.test(file))) {
    const content = await readFile(file, "utf8"); const slug = path.basename(file).replace(/\.(md|mdc)$/i, ""); const relativePath = path.relative(workspace, file); const local = config.localImports?.find((item) => item.target === "standards" && item.relativePath === relativePath);
    if (slug === "ask-questions-feedback-loop" || slug === "continuous-feedback") continue;
    items.push({ id: publicLibraryId("rule", slug), kind: "rule", scope: "project", source: DEFAULT_RULES.some((item) => item.id === slug) || BUNDLED_LIBRARY_NAMES[`rule:${slug}`] ? "default" : local ? "local" : "workspace", importId: local?.id, absolutePath: file, relativePath, content, ...libraryMetadata("rule", slug, content, slug, language) });
  }
  for (const file of (await walk(path.join(root, "agents"))).filter((file) => /\.md$/i.test(file))) {
    const content = await readFile(file, "utf8"); const slug = path.basename(file, ".md"); const relativePath = path.relative(workspace, file); const local = config.localImports?.find((item) => item.target === "standards" && item.relativePath === relativePath);
    items.push({ id: publicLibraryId("agent", slug), kind: "agent", scope: "project", source: BUNDLED_LIBRARY_NAMES[`agent:${slug}`] ? "default" : local ? "local" : "workspace", importId: local?.id, absolutePath: file, relativePath, content, ...libraryMetadata("agent", slug, content, slug, language) });
  }
  for (const imported of config.imports.filter((item) => !item.target || item.target === "standards")) {
    const importRoot = path.join(root, imported.relativePath);
    if (!await stat(importRoot).then(() => true).catch(() => false)) continue;
    const selectedRoot = selectedImportRoot(importRoot, imported.subpath);
    if (!selectedRoot) continue;
    const selectedIsFile = await stat(selectedRoot).then((value) => value.isFile()).catch(() => false);
    for (const file of await filesAt(selectedRoot)) {
      const lower = path.basename(file).toLowerCase(); const normalized = file.replaceAll("\\", "/").toLowerCase();
      const kind = lower === "skill.md" ? "skill" : (/\.md$/i.test(file) && normalized.includes("/agents/")) ? "agent" : (/\.(md|mdc)$/i.test(file) && (normalized.includes("/rules/") || selectedIsFile)) ? "rule" : null;
      if (!kind) continue;
      const content = await readFile(file, "utf8"); const relative = path.relative(importRoot, file).replaceAll(path.sep, "/");
      items.push({ id: `git:${imported.id}:${kind}:${relative}`, kind, scope: "project", source: "git", importId: imported.id, absolutePath: file, relativePath: path.relative(workspace, file), content, ...metadata(content, path.basename(file, path.extname(file))) });
    }
  }
  if (globalHome) {
    const globalConfig = await loadGlobalConfig(globalHome);
    for (const kind of ["skill", "rule", "agent"] as const) {
      const directory = path.join(globalHome, kind === "skill" ? "skills" : kind === "rule" ? "rules" : "agents");
      const files = (await walk(directory)).filter((file) => kind === "skill" ? path.basename(file).toLowerCase() === "skill.md" : kind === "rule" ? /\.(md|mdc)$/i.test(file) : /\.md$/i.test(file));
      for (const file of files) {
        const content = await readFile(file, "utf8");
        const slug = kind === "skill" ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.(md|mdc)$/i, "");
        const relativePath = path.relative(globalHome, file);
        const local = globalConfig.localImports?.find((item) => item.target === "standards" && item.relativePath === relativePath);
        const meta = libraryMetadata(kind, slug, content, slug, language);
        const item: LibraryItem = { id: `global:${kind}:${slug}`, kind, scope: "global", source: local ? "local" : "workspace", importId: local?.id, absolutePath: file, relativePath, content, ...meta };
        item.installedPath = cursorLibraryPath(workspace, item);
        items.push(item);
      }
    }
    for (const imported of globalConfig.imports.filter((item) => !item.target || item.target === "standards")) {
      const importRoot = path.join(globalHome, imported.relativePath);
      if (!await stat(importRoot).then(() => true).catch(() => false)) continue;
      const selectedRoot = selectedImportRoot(importRoot, imported.subpath);
      if (!selectedRoot) continue;
      const selectedIsFile = await stat(selectedRoot).then((value) => value.isFile()).catch(() => false);
      for (const file of await filesAt(selectedRoot)) {
        const lower = path.basename(file).toLowerCase(); const normalized = file.replaceAll("\\", "/").toLowerCase();
        const kind = lower === "skill.md" ? "skill" : (/\.md$/i.test(file) && normalized.includes("/agents/")) ? "agent" : (/\.(md|mdc)$/i.test(file) && (normalized.includes("/rules/") || selectedIsFile)) ? "rule" : null;
        if (!kind) continue;
        const content = await readFile(file, "utf8"); const relative = path.relative(importRoot, file).replaceAll(path.sep, "/");
        const item: LibraryItem = { id: `global:git:${imported.id}:${kind}:${relative}`, kind, scope: "global", source: "git", importId: imported.id, absolutePath: file, relativePath: path.relative(globalHome, file), content, ...metadata(content, path.basename(file, path.extname(file))) };
        item.installedPath = cursorLibraryPath(workspace, item);
        items.push(item);
      }
    }
  }
  const managedCursorPaths = new Set(items.map((item) => path.resolve(cursorLibraryPath(workspace, item))));
  const cursorRoot = path.join(workspace, ".cursor");
  for (const kind of ["skill", "rule"] as const) {
    const directory = path.join(cursorRoot, kind === "skill" ? "skills" : "rules");
    const files = (await walk(directory)).filter((file) => kind === "skill" ? path.basename(file).toLowerCase() === "skill.md" : /\.(md|mdc)$/i.test(file));
    for (const file of files) {
      if (managedCursorPaths.has(path.resolve(file))) continue;
      const content = await readFile(file, "utf8");
      const relative = path.relative(cursorRoot, file).replaceAll(path.sep, "/");
      const slug = kind === "skill" ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.(md|mdc)$/i, "");
      items.push({ id: `native:${kind}:${relative}`, kind, scope: "project", source: "native", absolutePath: file, installedPath: file, relativePath: path.relative(workspace, file), content, ...metadata(content, slug) });
    }
  }
  for (const item of items) item.installedPath ||= cursorLibraryPath(workspace, item);
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "zh-CN"));
}

async function knowledgeFiles(root: string, scope: "project" | "global", baseRoot: string, localImports: LocalImport[]): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  for (const file of (await walk(root)).filter((entry) => /\.md$/i.test(entry))) {
    const content = await readFile(file, "utf8");
    const idPart = path.relative(root, file).replaceAll(path.sep, "/").replace(/\.md$/i, "");
    const relativePath = path.relative(baseRoot, file); const local = localImports.find((item) => item.target === "knowledge" && item.relativePath === relativePath);
    items.push({ id: `${scope}:knowledge:${idPart}`, name: path.basename(file, path.extname(file)), description: metadata(content, "").description, scope, source: local ? "local" : "direct", importId: local?.id, absolutePath: file, relativePath, content });
  }
  return items;
}

async function importedKnowledge(baseRoot: string, imports: GitImport[], scope: "project" | "global"): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  for (const imported of imports.filter((item) => item.target === "knowledge")) {
    const importRoot = path.join(baseRoot, imported.relativePath);
    if (!await stat(importRoot).then(() => true).catch(() => false)) continue;
    const selectedRoot = selectedImportRoot(importRoot, imported.subpath);
    if (!selectedRoot) continue;
    for (const file of (await filesAt(selectedRoot)).filter((entry) => /\.md$/i.test(entry))) {
      const content = await readFile(file, "utf8");
      const relative = path.relative(importRoot, file).replaceAll(path.sep, "/");
      const meta = metadata(content, "");
      items.push({ id: `${scope}:git:${imported.id}:${relative}`, name: path.basename(file, path.extname(file)), description: meta.description, scope, source: "git", importId: imported.id, absolutePath: file, relativePath: path.relative(baseRoot, file), content });
    }
  }
  return items;
}

async function linkedKnowledge(dirs: LinkedKnowledgeDir[]): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  for (const dir of dirs) {
    if (!await stat(dir.path).then((s) => s.isDirectory()).catch(() => false)) continue;
    for (const file of (await walk(dir.path)).filter((entry) => /\.md$/i.test(entry))) {
      const content = await readFile(file, "utf8");
      const relative = path.relative(dir.path, file).replaceAll(path.sep, "/");
      const meta = metadata(content, "");
      items.push({ id: `linked:${dir.id}:${relative}`, name: path.basename(file, path.extname(file)), description: meta.description, scope: dir.scope, source: "linked", linkedDirId: dir.id, absolutePath: file, relativePath: relative, content });
    }
  }
  return items;
}

export async function scanKnowledge(workspace: string, config: WorkspaceConfig, globalHome?: string): Promise<KnowledgeItem[]> {
  const projectRoot = daedalusDir(workspace);
  const project = await knowledgeFiles(path.join(projectRoot, "knowledge"), "project", projectRoot, config.localImports || []);
  const projectImported = await importedKnowledge(projectRoot, config.imports.filter((item) => item.scope !== "global"), "project");
  const linked = await linkedKnowledge(config.linkedKnowledgeDirs || []);
  if (!globalHome) return [...project, ...projectImported, ...linked].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const globalConfig = await loadGlobalConfig(globalHome);
  const global = await knowledgeFiles(path.join(globalHome, "knowledge"), "global", globalHome, globalConfig.localImports || []);
  const globalImported = await importedKnowledge(globalHome, globalConfig.imports, "global");
  return [...project, ...projectImported, ...linked, ...global, ...globalImported].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name, "zh-CN"));
}

export function progressFor(state: RuntimeState, workflow: Workflow): WorkflowProgress {
  return state.progress.find((item) => item.workflowId === workflow.id) || { workflowId: workflow.id, currentStepId: workflow.steps[0]?.id || null, completed: [], updatedAt: new Date().toISOString() };
}

export function setCurrentWorkflowStep(state: RuntimeState, workflow: Workflow, stepId: string, skippedSummary: string): WorkflowProgress | null {
  const targetIndex = workflow.steps.findIndex((step) => step.id === stepId);
  if (targetIndex < 0) return null;
  const current = progressFor(state, workflow);
  const completedByStep = new Map(current.completed.map((item) => [item.stepId, item]));
  const now = new Date().toISOString();
  const completed = workflow.steps.slice(0, targetIndex).map((step) => completedByStep.get(step.id) || { stepId: step.id, summary: skippedSummary, completedAt: now });
  const next = { ...current, currentStepId: stepId, completed, updatedAt: now };
  const index = state.progress.findIndex((item) => item.workflowId === workflow.id);
  if (index >= 0) state.progress[index] = next; else state.progress.push(next);
  return next;
}

export function advanceWorkflow(state: RuntimeState, workflow: Workflow, summary?: string): WorkflowProgress {
  const current = progressFor(state, workflow);
  if (!current.currentStepId) return current;
  const index = workflow.steps.findIndex((step) => step.id === current.currentStepId);
  const next: WorkflowProgress = { ...current, currentStepId: workflow.steps[index + 1]?.id || null, completed: [...current.completed.filter((item) => item.stepId !== current.currentStepId), { stepId: current.currentStepId, summary, completedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() };
  const stateIndex = state.progress.findIndex((item) => item.workflowId === workflow.id);
  if (stateIndex >= 0) state.progress[stateIndex] = next; else state.progress.push(next);
  return next;
}

export function newId(prefix: string): string { return `${prefix}-${randomUUID().slice(0, 8)}`; }
