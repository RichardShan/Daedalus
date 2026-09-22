import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactOutputRoot, loadConfig, loadState, progressFor, saveState, scanKnowledge, scanLibrary, transitionWorkflowRun, writeAgentArtifact, type Gate, type RuntimeState, type WorkflowRun } from "./shared.js";

function workspace(): string { return process.env.DAEDALUS_WORKSPACE || process.env.ORIGINAL_WORKSPACE_CWD || process.cwd(); }
function globalHome(): string | undefined { return process.env.DAEDALUS_GLOBAL_HOME || undefined; }
function language(): "zh-CN" | "en" { return process.env.DAEDALUS_LANGUAGE === "zh-CN" ? "zh-CN" : "en"; }
function text(value: unknown) { return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }; }
async function initialized() {
  const root = workspace();
  const config = await loadConfig(root);
  if (!config) throw new Error("Daedalus is not initialized in this Workspace. Do not start a spec workflow — ask the user to run the initialization command first.");
  return { root, config };
}

const server = new McpServer({ name: "daedalus-workspace-governance", version: "0.21.12" });

function boundRun(state: RuntimeState, runId: string): WorkflowRun | undefined {
  return (state.runs || []).find((run) => run.id === runId);
}

function touchRun(run: WorkflowRun, status: WorkflowRun["status"], message?: string): void {
  transitionWorkflowRun(run, status, message);
}

async function feedbackCallerMatchesWorkspace(root: string): Promise<boolean> {
  const configured = process.env.DAEDALUS_WORKSPACE;
  if (!configured || path.resolve(configured) !== path.resolve(root)) return false;
  try {
    const result = await server.server.listRoots(undefined, { timeout: 3000 });
    return result.roots.some((item) => {
      if (!item.uri.startsWith("file:")) return false;
      try { return path.resolve(fileURLToPath(item.uri)) === path.resolve(root); } catch { return false; }
    });
  } catch {
    return path.resolve(process.cwd()) === path.resolve(root);
  }
}

server.tool("workspace_status", "Read the current Workspace development workflow, progress, standards library, and pending collaboration requests. Stops explicitly when not initialized.", {}, async () => {
  const { root, config } = await initialized();
  const [state, library, knowledge] = await Promise.all([loadState(root), scanLibrary(root, config, globalHome()), scanKnowledge(root, config, globalHome())]);
  const workflow = config.workflows.find((item) => item.id === config.activeWorkflowId) || config.workflows[0];
  return text({ workspace: config.workspaceName, activeWorkflow: workflow, progress: workflow ? progressFor(state, workflow) : null, agentOutput: { settings: config.settings?.artifactOutput || { mode: "workspace", directory: ".daedalus/artifacts" }, resolvedPath: artifactOutputRoot(root, config) }, library: library.map(({ content, absolutePath, ...item }) => item), knowledge: knowledge.map(({ content, absolutePath, ...item }) => item), pendingRequests: config.settings?.feedbackEnabled ? state.gates.filter((gate) => gate.status === "pending") : [] });
});

server.tool("knowledge_search", "Search the project and global knowledge base, returning the most relevant Markdown content.", {
  query: z.string().min(1).max(300),
  scope: z.enum(["all", "project", "global"]).default("all"),
  limit: z.number().int().min(1).max(10).default(5),
}, async ({ query, scope, limit }) => {
  const { root, config } = await initialized();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = (await scanKnowledge(root, config, globalHome())).filter((item) => scope === "all" || item.scope === scope);
  const ranked = items.map((item) => {
    const title = `${item.name} ${item.description}`.toLowerCase();
    const body = item.content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return text({ query, results: ranked.map(({ item, score }) => ({ score, id: item.id, name: item.name, description: item.description, scope: item.scope, source: item.source, content: item.content })) });
});

server.tool("workflow_context", "Get the execution context for the current or specified workflow step. Returns references to Skills, Rules, and Agents installed in Cursor, plus knowledge items bound to the step. Does not inline spec content into the prompt.", {
  runId: z.string().optional(),
  workflowId: z.string().optional(),
  stepId: z.string().optional(),
}, async ({ runId, workflowId, stepId }) => {
  const { root, config } = await initialized();
  const state = await loadState(root);
  const run = runId ? boundRun(state, runId) : undefined;
  if (runId && !run) return text({ found: false, error: "run_not_found" });
  if (run && ((workflowId && workflowId !== run.workflowId) || (stepId && stepId !== run.stepId))) return text({ found: false, error: "run_binding_mismatch" });
  const workflow = config.workflows.find((item) => item.id === (run?.workflowId || workflowId || config.activeWorkflowId));
  if (!workflow) return text("Workflow not found.");
  const progress = progressFor(state, workflow);
  const step = workflow.steps.find((item) => item.id === (run?.stepId || stepId || progress.currentStepId));
  if (!step) return text({ workflow: { id: workflow.id, name: workflow.name }, completed: true, message: "Workflow completed or no executable step remaining." });
  const [library, knowledge] = await Promise.all([scanLibrary(root, config, globalHome()), scanKnowledge(root, config, globalHome())]);
  const selected = library.filter((item) => [...step.skillIds, ...step.ruleIds].includes(item.id));
  const selectedKnowledge = knowledge.filter((item) => (step.knowledgeIds || []).includes(item.id));
  const currentAgent = library.find((item) => item.kind === "agent" && item.id === workflow.agentId);
  const missingInputs = (workflow.inputs || []).filter((input) => input.required && !progress.inputs?.[input.id]?.trim());
  return text({
    workspace: config.workspaceName,
    language: language(),
    run: run ? { id: run.id, status: run.status, channel: run.channel, cursorSessionId: run.cursorSessionId, feedbackThreadId: run.feedbackThreadId } : undefined,
    parentAgent: { id: "daedalus", name: "Daedalus", role: "Workspace-level development governance and orchestration Agent" },
    currentAgent: currentAgent ? { id: currentAgent.id, name: currentAgent.name, description: currentAgent.description, scope: currentAgent.scope, cursorPath: currentAgent.installedPath } : { id: workflow.id, name: workflow.name, description: workflow.description },
    workflow: { id: workflow.id, name: workflow.name },
    step,
    workflowInputs: workflow.inputs || [],
    providedInputs: progress.inputs || {},
    ready: missingInputs.length === 0,
    missingInputs,
    skills: selected.filter((item) => item.kind === "skill").map((item) => ({ id: item.id, name: item.name, description: item.description, scope: item.scope, cursorPath: item.installedPath })),
    rules: selected.filter((item) => item.kind === "rule").map((item) => ({ id: item.id, name: item.name, description: item.description, scope: item.scope, cursorPath: item.installedPath })),
    knowledge: selectedKnowledge.map((item) => ({ id: item.id, name: item.name, description: item.description, scope: item.scope, source: item.source })),
    interaction: { feedbackChannel: config.settings?.feedbackEnabled === true ? "daedalus" : "cursor-native", continuousFeedback: config.settings?.continuousFeedback === true },
    agentOutput: { settings: config.settings?.artifactOutput || { mode: "workspace", directory: ".daedalus/artifacts" }, resolvedPath: artifactOutputRoot(root, config) },
    instruction: language() === "zh-CN"
      ? `你正在 Daedalus 工作台中执行“${workflow.name}”流程的“${step.name}”阶段。以上 Agent、Skills、Rules 已安装到 Cursor 原生目录；请按 cursorPath 直接引用并遵循，不要要求 Daedalus 返回正文，也不要把它们重新拼接成 Prompt。knowledge 中列出本阶段绑定的知识条目，开展工作前应按条目名称调用 knowledge_search 获取内容；需要其他项目背景时也可继续检索。Plan、总结、设计说明等非代码交付物应调用 agent_output 保存。结束前必须调用 workflow_report 回写 ready、continue 或 blocked 状态；不要自行推进阶段，由用户在工作台确认。请使用中文与用户交互（包括 AskQuestion 的提问和选项）。`
      : `You are executing the "${step.name}" stage of the "${workflow.name}" workflow in the Daedalus Workbench. The Agent, Skills, and Rules above are installed in Cursor-native directories; reference and follow them via cursorPath directly — do not ask Daedalus for their content or inline them into the prompt. The knowledge section lists items bound to this stage; retrieve each by name via knowledge_search before starting work, and search for more project context as needed. Save plans, summaries, design docs, and other non-code deliverables via agent_output. Before finishing, call workflow_report with status ready, continue, or blocked; do not advance the stage yourself — the user confirms advancement in the Workbench. Use English for all user interactions (including AskQuestion prompts and options).`,
  });
});

server.tool("workflow_report", "Report the current stage execution result to the Daedalus Workbench. ready shows an advancement suggestion; continue/blocked updates the description without advancing.", {
  runId: z.string().min(1),
  status: z.enum(["ready", "continue", "blocked"]),
  summary: z.string().min(1).max(3000),
  evidence: z.array(z.string().min(1).max(500)).max(20).default([]),
}, async ({ runId, status, summary, evidence }) => {
  const { root, config } = await initialized();
  const state = await loadState(root);
  const run = boundRun(state, runId);
  if (!run) return text({ reported: false, error: "run_not_found" });
  const workflow = config.workflows.find((item) => item.id === run.workflowId);
  if (!workflow) return text({ reported: false, error: "workflow_not_found" });
  const currentIndex = workflow.steps.findIndex((item) => item.id === run.stepId);
  const current = workflow.steps[currentIndex];
  if (!current) return text({ reported: false, error: "step_not_found" });
  const next = workflow.steps[currentIndex + 1];
  const signal = {
    version: 1,
    runId: run.id,
    workflowId: workflow.id,
    currentStepId: current.id,
    suggestedStepId: status === "ready" ? next?.id || current.id : current.id,
    suggestedStepName: status === "ready" ? next?.name || "Workflow complete" : current.name,
    status,
    excerpt: summary,
    evidence,
    detectedAt: new Date().toISOString(),
  };
  const destination = path.join(root, ".daedalus", "conversation-signal.json");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(signal, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  run.summary = summary;
  touchRun(run, status === "ready" ? "ready_suggested" : status === "blocked" ? "blocked" : "continuing", summary);
  await saveState(root, state);
  return text({ reported: true, status, currentStep: current.name, suggestedStep: status === "ready" ? next?.name || null : null });
});

server.tool("agent_output", "Save agent-generated summaries, plans, design docs, or other non-code Markdown deliverables to the configured Workspace or Git repository directory.", {
  runId: z.string().optional(),
  kind: z.enum(["summary", "plan", "design", "other"]),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(500_000),
  filename: z.string().max(300).optional(),
}, async ({ runId, kind, title, content, filename }) => {
  const { root, config } = await initialized();
  const state = await loadState(root);
  const run = runId ? boundRun(state, runId) : undefined;
  if (runId && !run) return text({ saved: false, error: "run_not_found" });
  const workflow = config.workflows.find((item) => item.id === (run?.workflowId || config.activeWorkflowId));
  const progress = workflow ? progressFor(state, workflow) : null;
  const saved = await writeAgentArtifact(root, config, kind, title, content, filename, { workflowId: workflow?.id, stepId: run?.stepId || progress?.currentStepId || undefined });
  return text({ saved: true, kind, title, ...saved });
});

server.tool("request_feedback", "Request user feedback or approval in the Daedalus panel of the current Workspace and wait for a response.", {
  runId: z.string().min(1),
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(10_000),
  type: z.enum(["feedback", "approval"]).default("feedback"),
  threadId: z.string().uuid().optional(),
  wait: z.boolean().default(true),
}, async ({ runId, title, message, type, threadId, wait }) => {
  const { root, config } = await initialized();
  if (!await feedbackCallerMatchesWorkspace(root)) return text({ created: false, error: "workspace_scope_mismatch", message: "This conversation does not belong to this Daedalus Workspace. Feedback request denied." });
  if (!config.settings?.feedbackEnabled) return text({ created: false, error: "feedback_disabled", message: "Feedback is not enabled. Ask the user to enable it in Daedalus settings." });
  const state = await loadState(root);
  const run = boundRun(state, runId);
  if (!run) return text({ created: false, error: "run_not_found" });
  const workflow = config.workflows.find((item) => item.id === run.workflowId);
  if (!workflow || !workflow.steps.some((step) => step.id === run.stepId)) return text({ created: false, error: "run_binding_invalid" });
  const now = new Date().toISOString();
  let gate = threadId ? state.gates.find((item) => item.id === threadId) : undefined;
  if (gate?.status === "pending" && gate.origin !== "hook") return text({ created: false, error: "thread_already_waiting", threadId: gate.id });
  if (gate?.status === "pending" && gate.origin === "hook") {
    gate.origin = "mcp";
    gate.runId = run.id;
    gate.cursorSessionId = run.cursorSessionId;
    gate.updatedAt = now;
    await saveState(root, state);
  } else if (gate) {
    gate.type = type;
    gate.title = title;
    gate.message = message;
    gate.status = "pending";
    gate.updatedAt = now;
    gate.messages = [...(gate.messages || []), { role: "agent", content: message, createdAt: now }];
    gate.origin = "mcp";
    gate.runId = run.id;
    gate.workflowId = run.workflowId;
    gate.stepId = run.stepId;
    gate.cursorSessionId = run.cursorSessionId;
    delete gate.decision;
    delete gate.response;
    delete gate.resolvedAt;
  } else if (!gate) {
    gate = { id: randomUUID(), type, title, message, workflowId: run.workflowId, stepId: run.stepId, runId: run.id, cursorSessionId: run.cursorSessionId, createdAt: now, updatedAt: now, status: "pending", origin: "mcp", messages: [{ role: "agent", content: message, createdAt: now }] };
    state.gates.unshift(gate);
  }
  run.feedbackThreadId = gate.id;
  touchRun(run, "waiting_feedback", message);
  await saveState(root, state);
  if (!wait) return text({ gateId: gate.id, threadId: gate.id, status: "pending" });
  const deadline = Date.now() + Math.max(1, Number(process.env.DAEDALUS_COLLABORATION_TIMEOUT_MINUTES || process.env.DAEDALUS_GATE_TIMEOUT_MINUTES || 60)) * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const resolved = (await loadState(root)).gates.find((item) => item.id === gate.id);
    if (resolved?.status === "resolved") {
      const latest = await loadState(root);
      const latestRun = boundRun(latest, run.id);
      if (latestRun) { touchRun(latestRun, "continuing", resolved.response || "Feedback resolved"); await saveState(root, latest); }
      return text({ threadId: gate.id, decision: resolved.decision, response: resolved.response || "" });
    }
  }
  return text({ gateId: gate.id, threadId: gate.id, status: "timeout" });
});

async function main(): Promise<void> { await server.connect(new StdioServerTransport()); }
main().catch((error) => { console.error("Daedalus MCP server failed:", error); process.exitCode = 1; });
