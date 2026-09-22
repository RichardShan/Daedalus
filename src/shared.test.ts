import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { advanceWorkflow, artifactOutputRoot, canTransitionWorkflowRun, cursorLibraryPath, defaultConfig, emptyState, feedbackTitleFromContent, initializeWorkspace, loadConfig, loadState, parseStandaloneAgentResponse, progressFor, reusableNativeCursorSessionId, saveConfig, saveState, scanAgentArtifacts, scanKnowledge, scanLibrary, setActiveWorkflow, setCurrentWorkflowStep, transitionWorkflowRun, writeAgentArtifact, type WorkflowRun } from "./shared.js";

describe("workspace workflow", () => {
  it("creates a fallback Feedback title and extracts the Agent-generated title", () => {
    expect(feedbackTitleFromContent("  # 帮我分析一个新的产品方向，需要考虑目标用户和 MVP  ", 16)).toBe("帮我分析一个新的产品方向，需要考…");
    expect(parseStandaloneAgentResponse("DAEDALUS_TITLE: 产品方向与 MVP\n\n先明确目标用户。"))
      .toEqual({ title: "产品方向与 MVP", content: "先明确目标用户。" });
    expect(parseStandaloneAgentResponse("直接回复正文")).toEqual({ content: "直接回复正文" });
  });
  it("enforces explicit workflow run state transitions", () => {
    const run: WorkflowRun = { id: "run-1", workflowId: "workflow", stepId: "step", channel: "feedback", status: "starting", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    transitionWorkflowRun(run, "running", "started", "2026-01-01T00:00:01.000Z");
    transitionWorkflowRun(run, "waiting_feedback", "question", "2026-01-01T00:00:02.000Z");
    transitionWorkflowRun(run, "continuing", "answered", "2026-01-01T00:00:03.000Z");
    transitionWorkflowRun(run, "ready_suggested", "ready", "2026-01-01T00:00:04.000Z");
    expect(canTransitionWorkflowRun("ready_suggested", "completed")).toBe(true);
    expect(canTransitionWorkflowRun("completed", "running")).toBe(false);
    transitionWorkflowRun(run, "completed", "confirmed", "2026-01-01T00:00:05.000Z");
    expect(run).toMatchObject({ status: "completed", finishedAt: "2026-01-01T00:00:05.000Z", message: "confirmed" });
    expect(() => transitionWorkflowRun(run, "running")).toThrow("Invalid workflow run transition");
  });
  it("reuses only IDs proven to belong to Cursor's native UI", () => {
    const base: WorkflowRun = { id: "run-native", workflowId: "workflow", stepId: "step", channel: "cursor-native", status: "running", cursorSessionId: "conversation-42", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(reusableNativeCursorSessionId(base)).toBeUndefined();
    expect(reusableNativeCursorSessionId({ ...base, cursorSessionKind: "cli" })).toBeUndefined();
    expect(reusableNativeCursorSessionId({ ...base, cursorSessionKind: "native-ui" })).toBe("conversation-42");
    expect(reusableNativeCursorSessionId({ ...base, channel: "feedback", cursorSessionKind: "native-ui" })).toBeUndefined();
  });
  it("retires active legacy native bindings while loading persisted state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-legacy-native-"));
    try {
      await mkdir(path.join(root, ".daedalus"), { recursive: true });
      const legacy: WorkflowRun = { id: "legacy-run", workflowId: "workflow", stepId: "step", channel: "cursor-native", status: "running", cursorSessionId: "cli-session", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      await writeFile(path.join(root, ".daedalus", "state.json"), JSON.stringify({ version: 2, progress: [], gates: [], runs: [legacy], activeRunId: legacy.id }));
      const loaded = await loadState(root);
      expect(loaded.activeRunId).toBeUndefined();
      expect(loaded.runs?.[0]).toMatchObject({ status: "stopped", cursorSessionId: "cli-session" });
      expect(JSON.parse(await readFile(path.join(root, ".daedalus", "state.json"), "utf8"))).toMatchObject({ runs: [{ status: "stopped" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps continuous feedback as a workspace setting instead of a stage rule", () => {
    const config = defaultConfig("demo");
    expect(config.settings?.continuousFeedback).toBe(false);
    expect(config.workflows.flatMap((workflow) => workflow.steps).flatMap((step) => step.ruleIds)).not.toContain("rule:continuous-feedback");
  });

  it("maps standards to Cursor-native project and global locations", () => {
    const project = cursorLibraryPath("/workspace", { id: "skill:review", name: "Review", kind: "skill", scope: "project" }, "/user/.cursor");
    const global = cursorLibraryPath("/workspace", { id: "rule:safe", name: "Safe", kind: "rule", scope: "global" }, "/user/.cursor");
    expect(project).toBe(path.join("/workspace", ".cursor", "skills", "daedalus-review", "SKILL.md"));
    expect(global).toBe(path.join("/user/.cursor", "rules", "daedalus-safe.mdc"));
  });
  it("ships a complete default development workflow", () => {
    const config = defaultConfig("demo");
    expect(config.workspaceName).toBe("demo");
    expect(config.workflows.map((workflow) => workflow.id)).toEqual(["standard-development", "test-case-alignment", "code-review"]);
    expect(config.workflows[0].steps.map((step) => step.name)).toEqual(["需求梳理", "技术设计", "编码实现", "测试验收"]);
    expect(config.workflows.every((workflow) => workflow.agentId?.startsWith("agent:"))).toBe(true);
    expect(config.workflows.flatMap((workflow) => workflow.steps).every((step) => step.skillIds.length > 0 && step.ruleIds.length > 0)).toBe(true);
    expect(config.workflows[1].inputs).toEqual([expect.objectContaining({ id: "test-cases", required: true, accepts: ["url", "image", "text"] })]);
    expect(config.workflows[2].steps).toHaveLength(4);
  });

  it("migrates removed and renamed built-in workflows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-workflow-migration-"));
    try {
      const config = defaultConfig("demo");
      config.workflows[1].name = "测试用例驱动对齐";
      config.workflows.push({ id: "test-case-regression", name: "测试用例回归验证", description: "legacy", agentId: "agent:quality-review", steps: [] });
      config.activeWorkflowId = "test-case-regression";
      await saveConfig(root, config);
      const migrated = await loadConfig(root);
      expect(migrated?.workflows.map((workflow) => workflow.id)).toEqual(["standard-development", "test-case-alignment", "code-review"]);
      expect(migrated?.workflows[1].name).toBe("用例驱动对齐");
      expect(migrated?.activeWorkflowId).toBe("standard-development");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("localizes newly initialized workflow templates", () => {
    const config = defaultConfig("demo", "en");
    expect(config.workflows.map((workflow) => workflow.name)).toEqual(["Standard Development", "Case-driven Alignment", "Code Review"]);
    expect(config.workflows[1].inputs?.[0].name).toBe("Test-case source");
  });

  it("sets the active workflow only when the workflow exists", () => {
    const config = defaultConfig("demo");
    expect(setActiveWorkflow(config, "code-review")).toBe(true);
    expect(config.activeWorkflowId).toBe("code-review");
    expect(setActiveWorkflow(config, "missing-workflow")).toBe(false);
    expect(config.activeWorkflowId).toBe("code-review");
  });

  it("normalizes and persists stage knowledge bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-step-knowledge-test-"));
    try {
      const config = defaultConfig("demo");
      await saveConfig(root, config);
      const loaded = await loadConfig(root);
      expect(loaded?.workflows[0].steps[0].knowledgeIds).toEqual([]);
      loaded!.workflows[0].steps[0].knowledgeIds = ["project:knowledge:architecture"];
      await saveConfig(root, loaded!);
      expect((await loadConfig(root))?.workflows[0].steps[0].knowledgeIds).toEqual(["project:knowledge:architecture"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advances isolated progress without mutating workflow configuration", () => {
    const workflow = defaultConfig("demo").workflows[0];
    const state = emptyState();
    expect(state.localChanges).toEqual([]);
    expect(progressFor(state, workflow).currentStepId).toBe("requirement");
    const next = advanceWorkflow(state, workflow, "需求已确认");
    expect(next.currentStepId).toBe("design");
    expect(next.completed[0]).toMatchObject({ stepId: "requirement", summary: "需求已确认" });
    expect(workflow.steps[0].id).toBe("requirement");
  });

  it("lets the user choose a workflow starting step without leaving earlier steps pending", () => {
    const workflow = defaultConfig("demo").workflows[0];
    const state = emptyState();
    const selected = setCurrentWorkflowStep(state, workflow, "implementation", "Skipped by user");
    expect(selected?.currentStepId).toBe("implementation");
    expect(selected?.completed.map((item) => [item.stepId, item.summary])).toEqual([["requirement", "Skipped by user"], ["design", "Skipped by user"]]);
    expect(setCurrentWorkflowStep(state, workflow, "missing", "Skipped by user")).toBeNull();
    expect(progressFor(state, workflow).currentStepId).toBe("implementation");
  });

  it("recovers the newest runtime state from concatenated JSON writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-state-recovery-"));
    try {
      const older = emptyState();
      older.progress = [{ workflowId: "standard-development", currentStepId: "requirement", completed: [], updatedAt: "2026-01-01T00:00:00.000Z" }];
      const newer = emptyState();
      newer.progress = [{ workflowId: "standard-development", currentStepId: "design", completed: [], updatedAt: "2026-01-01T00:00:01.000Z" }];
      const file = path.join(root, ".daedalus", "state.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(older, null, 2)}\n${JSON.stringify(newer, null, 2)}\n`, "utf8");
      expect((await loadState(root)).progress[0].currentStepId).toBe("design");
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2, progress: [expect.objectContaining({ currentStepId: "design" })] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a complete runtime state followed by an interrupted write fragment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-state-partial-recovery-"));
    try {
      const state = emptyState();
      state.runs = [{ id: "run-1", workflowId: "standard-development", stepId: "requirement", channel: "cursor-native", status: "stopped", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" }];
      const file = path.join(root, ".daedalus", "state.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n8"\n}\n`, "utf8");
      expect((await loadState(root)).runs?.[0]).toMatchObject({ id: "run-1", status: "stopped" });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2, runs: [expect.objectContaining({ id: "run-1" })] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes Agent documents only inside the configured Workspace output directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-artifact-test-"));
    try {
      const config = defaultConfig("demo");
      config.settings = { ...config.settings, artifactOutput: { mode: "workspace", directory: "docs/agent" } };
      expect(artifactOutputRoot(root, config)).toBe(path.join(root, "docs", "agent"));
      const saved = await writeAgentArtifact(root, config, "design", "API 设计", "设计正文", "architecture/api", { workflowId: "standard-development", stepId: "design" });
      expect(saved.relativePath).toBe(path.join("docs", "agent", "architecture", "api.md"));
      expect(await readFile(saved.absolutePath, "utf8")).toContain("# API 设计\n\n设计正文");
      expect(await scanAgentArtifacts(root, config)).toContainEqual(expect.objectContaining({ name: "API 设计", relativePath: path.join("architecture", "api.md"), workflowId: "standard-development", stepId: "design", kind: "design" }));
      await expect(writeAgentArtifact(root, config, "plan", "越界", "内容", "../outside.md")).rejects.toThrow("安全的相对路径");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does nothing until initialized, then installs the default library", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-test-"));
    try {
      expect(await loadConfig(root)).toBeNull();
      const config = await initializeWorkspace(root, "demo");
      const library = await scanLibrary(root, config);
      expect(library.filter((item) => item.kind === "skill")).toHaveLength(4);
      expect(library.filter((item) => item.kind === "rule")).toHaveLength(3);
      expect(library.every((item) => item.source === "default")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers existing Cursor skills and rules without duplicating Daedalus-managed installations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-native-library-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      const managed = (await scanLibrary(root, config)).find((item) => item.kind === "skill");
      expect(managed).toBeDefined();
      const managedPath = cursorLibraryPath(root, managed!);
      const nativeSkill = path.join(root, ".cursor", "skills", "team-review", "SKILL.md");
      const nativeRule = path.join(root, ".cursor", "rules", "team-quality.mdc");
      await mkdir(path.dirname(managedPath), { recursive: true });
      await mkdir(path.dirname(nativeSkill), { recursive: true });
      await mkdir(path.dirname(nativeRule), { recursive: true });
      await writeFile(managedPath, "# Managed copy\n", "utf8");
      await writeFile(nativeSkill, "---\nname: Team Review\ndescription: Review team changes.\n---\n", "utf8");
      await writeFile(nativeRule, "---\ndescription: Enforce team quality.\n---\n# Team Quality\n", "utf8");
      const library = await scanLibrary(root, config);
      expect(library).toContainEqual(expect.objectContaining({ kind: "skill", source: "native", name: "Team Review", installedPath: nativeSkill }));
      expect(library).toContainEqual(expect.objectContaining({ kind: "rule", source: "native", name: "Team Quality", installedPath: nativeRule }));
      expect(library.some((item) => item.source === "native" && path.resolve(item.absolutePath) === path.resolve(managedPath))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers skills, rules, and agents from an imported git working tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-import-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      const imported = path.join(root, ".daedalus", "imports", "team-standards");
      await mkdir(path.join(imported, "skills", "review"), { recursive: true });
      await mkdir(path.join(imported, ".cursor", "rules"), { recursive: true });
      await mkdir(path.join(imported, ".cursor", "agents"), { recursive: true });
      await writeFile(path.join(imported, "skills", "review", "SKILL.md"), "# Review Skill\n", "utf8");
      await writeFile(path.join(imported, ".cursor", "rules", "quality.mdc"), "# Quality Rule\n", "utf8");
      await writeFile(path.join(imported, ".cursor", "agents", "reviewer.md"), "# Review Agent\n", "utf8");
      config.imports.push({ id: "team", name: "team-standards", url: "local-test", importedAt: new Date().toISOString(), relativePath: "imports/team-standards" });
      const library = await scanLibrary(root, config);
      expect(library.some((item) => item.id.startsWith("git:team:skill:") && item.name === "Review Skill")).toBe(true);
      expect(library.some((item) => item.id.startsWith("git:team:rule:") && item.name === "Quality Rule")).toBe(true);
      expect(library.some((item) => item.id.startsWith("git:team:agent:") && item.name === "Review Agent")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits a standards import to a selected repository file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-subpath-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      const imported = path.join(root, ".daedalus", "imports", "selected-rule");
      await mkdir(path.join(imported, ".cursor", "rules"), { recursive: true });
      await mkdir(path.join(imported, "skills", "ignored"), { recursive: true });
      await writeFile(path.join(imported, ".cursor", "rules", "quality.mdc"), "# Selected Quality Rule\n", "utf8");
      await writeFile(path.join(imported, "skills", "ignored", "SKILL.md"), "# Ignored Skill\n", "utf8");
      config.imports.push({ id: "selected", name: "selected-rule", url: "local-test", subpath: ".cursor/rules/quality.mdc", importedAt: new Date().toISOString(), relativePath: "imports/selected-rule" });
      const library = await scanLibrary(root, config);
      expect(library.some((item) => item.id.startsWith("git:selected:rule:") && item.name === "Selected Quality Rule")).toBe(true);
      expect(library.some((item) => item.importId === "selected" && item.kind === "skill")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers bundled-style Cursor agents in the standards library", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-agent-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      await mkdir(path.join(root, ".daedalus", "agents"), { recursive: true });
      await writeFile(path.join(root, ".daedalus", "agents", "quality-review.md"), "---\nname: daedalus-quality-review\ndescription: Review completed work.\n---\n", "utf8");
      const library = await scanLibrary(root, config);
      expect(library).toContainEqual(expect.objectContaining({ id: "agent:quality-review", kind: "agent", name: "daedalus-quality-review" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a likely workflow transition from a Cursor response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-monitor-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      const script = path.resolve("assets/conversation-monitor.cjs");
      const result = spawnSync(process.execPath, [script], { cwd: root, input: JSON.stringify({ text: "需求梳理已完成，需求摘要和验收标准已经确认。下一步进入技术设计。" }), encoding: "utf8" });
      expect(result.status).toBe(0);
      const signal = JSON.parse(await readFile(path.join(root, ".daedalus", "conversation-signal.json"), "utf8"));
      expect(signal).toMatchObject({ workflowId: config.activeWorkflowId, currentStepId: "requirement", suggestedStepId: "design" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens feedback from the project hook only when that Workspace enables it", async () => {
    const enabledRoot = await mkdtemp(path.join(os.tmpdir(), "daedalus-feedback-enabled-"));
    const disabledRoot = await mkdtemp(path.join(os.tmpdir(), "daedalus-feedback-disabled-"));
    try {
      const enabled = await initializeWorkspace(enabledRoot, "enabled");
      enabled.settings = { ...enabled.settings, feedbackEnabled: true };
      await saveConfig(enabledRoot, enabled);
      await initializeWorkspace(disabledRoot, "disabled");
      const script = path.resolve("assets/conversation-monitor.cjs");
      const question = JSON.stringify({ text: "我已检查当前实现。你希望继续下一步还是调整当前方案？" });
      expect(spawnSync(process.execPath, [script], { cwd: enabledRoot, input: question, encoding: "utf8" }).status).toBe(0);
      expect(spawnSync(process.execPath, [script], { cwd: disabledRoot, input: question, encoding: "utf8" }).status).toBe(0);
      const enabledState = await loadState(enabledRoot);
      expect(enabledState.gates).toContainEqual(expect.objectContaining({ status: "pending", origin: "hook", workflowId: enabled.activeWorkflowId, stepId: "requirement" }));
      expect((await loadState(disabledRoot)).gates).toHaveLength(0);
      const resumeScript = path.resolve("assets/feedback-resume.cjs");
      const resume = spawnSync(process.execPath, [resumeScript], { cwd: enabledRoot, input: JSON.stringify({ loop_count: 0 }), encoding: "utf8" });
      const noResume = spawnSync(process.execPath, [resumeScript], { cwd: disabledRoot, input: JSON.stringify({ loop_count: 0 }), encoding: "utf8" });
      expect(JSON.parse(resume.stdout)).toEqual(expect.objectContaining({ followup_message: expect.stringContaining(enabledState.gates[0].id) }));
      expect(JSON.parse(noResume.stdout)).toEqual({});
    } finally {
      await rm(enabledRoot, { recursive: true, force: true });
      await rm(disabledRoot, { recursive: true, force: true });
    }
  });

  it("binds a native Cursor session and Feedback thread to the exact workflow run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-session-binding-"));
    try {
      const config = await initializeWorkspace(root, "binding");
      config.settings = { ...config.settings, feedbackEnabled: true };
      await saveConfig(root, config);
      const state = await loadState(root);
      const run: WorkflowRun = { id: "11111111-1111-4111-8111-111111111111", workflowId: config.activeWorkflowId, stepId: "requirement", channel: "cursor-native", status: "starting", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      state.runs = [run]; state.activeRunId = run.id;
      await saveState(root, state);
      const sessionId = "cursor-session-42";
      const bind = spawnSync(process.execPath, [path.resolve("assets/session-bind.cjs")], { cwd: root, input: JSON.stringify({ prompt: `Daedalus runId: ${run.id}`, conversation_id: sessionId }), encoding: "utf8" });
      expect(bind.status).toBe(0);
      expect((await loadState(root)).runs?.[0]).toMatchObject({ cursorSessionId: sessionId, cursorSessionKind: "native-ui", status: "running" });
      const monitor = spawnSync(process.execPath, [path.resolve("assets/conversation-monitor.cjs")], { cwd: root, input: JSON.stringify({ text: "请选择继续还是调整当前需求？", conversation_id: sessionId }), encoding: "utf8" });
      expect(monitor.status).toBe(0);
      const updated = await loadState(root);
      expect(updated.gates[0]).toMatchObject({ runId: run.id, cursorSessionId: sessionId, workflowId: run.workflowId, stepId: run.stepId });
      expect(updated.runs?.[0]).toMatchObject({ status: "waiting_feedback", feedbackThreadId: updated.gates[0].id });
      const wrongSession = spawnSync(process.execPath, [path.resolve("assets/feedback-resume.cjs")], { cwd: root, input: JSON.stringify({ loop_count: 0, conversation_id: "different-session" }), encoding: "utf8" });
      const correctSession = spawnSync(process.execPath, [path.resolve("assets/feedback-resume.cjs")], { cwd: root, input: JSON.stringify({ loop_count: 0, conversation_id: sessionId }), encoding: "utf8" });
      expect(JSON.parse(wrongSession.stdout)).toEqual({});
      expect(JSON.parse(correctSession.stdout).followup_message).toContain(run.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("combines project and global knowledge without mixing their scopes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-knowledge-test-"));
    const globalHome = await mkdtemp(path.join(os.tmpdir(), "daedalus-global-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      await mkdir(path.join(root, ".daedalus", "knowledge"), { recursive: true });
      await mkdir(path.join(globalHome, "knowledge"), { recursive: true });
      await writeFile(path.join(root, ".daedalus", "knowledge", "domain.md"), "# 项目领域模型\n", "utf8");
      await writeFile(path.join(globalHome, "knowledge", "engineering.md"), "# 全局工程约定\n", "utf8");
      const knowledge = await scanKnowledge(root, config, globalHome);
      expect(knowledge.map((item) => [item.name, item.scope])).toEqual(expect.arrayContaining([["domain", "project"], ["engineering", "global"]]));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(globalHome, { recursive: true, force: true });
    }
  });

  it("discovers markdown from a linked knowledge directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-linked-knowledge-test-"));
    const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "daedalus-linked-source-test-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      await mkdir(path.join(linkedRoot, "guides"), { recursive: true });
      await writeFile(path.join(linkedRoot, "guides", "api.md"), "---\nname: Team API Guide\ndescription: Shared API conventions.\n---\n\n# Team API Guide\n", "utf8");
      config.linkedKnowledgeDirs = [{ id: "team-docs", name: "Team docs", path: linkedRoot, scope: "project", linkedAt: new Date().toISOString() }];
      await saveConfig(root, config);
      const knowledge = await scanKnowledge(root, config);
      expect(knowledge).toContainEqual(expect.objectContaining({ id: "linked:team-docs:guides/api.md", name: "api", source: "linked", linkedDirId: "team-docs", scope: "project" }));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });

  it("limits a knowledge import to the selected repository directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-knowledge-subpath-test-"));
    const globalHome = await mkdtemp(path.join(os.tmpdir(), "daedalus-knowledge-subpath-global-"));
    try {
      const config = await initializeWorkspace(root, "demo");
      const imported = path.join(root, ".daedalus", "knowledge-imports", "handbook");
      await mkdir(path.join(imported, "docs", "selected"), { recursive: true });
      await mkdir(path.join(imported, "docs", "ignored"), { recursive: true });
      await writeFile(path.join(imported, "docs", "selected", "api.md"), "# API Handbook\n", "utf8");
      await writeFile(path.join(imported, "docs", "ignored", "private.md"), "# Ignored Notes\n", "utf8");
      config.imports.push({ id: "handbook", name: "handbook", url: "local-test", target: "knowledge", scope: "project", subpath: "docs/selected", importedAt: new Date().toISOString(), relativePath: "knowledge-imports/handbook" });
      const knowledge = await scanKnowledge(root, config, globalHome);
      expect(knowledge.some((item) => item.name === "api" && item.importId === "handbook")).toBe(true);
      expect(knowledge.some((item) => item.name === "private")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(globalHome, { recursive: true, force: true });
    }
  });
});
