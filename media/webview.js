const vscode = acquireVsCodeApi();
const savedUi = vscode.getState() || {};
const ui = { initialized: false, view: "workflow", config: { workflows: [], imports: [], localImports: [], settings: { feedbackEnabled: false, continuousFeedback: false, autoExecuteOnAdvance: true } }, state: { progress: [], gates: [] }, library: [], knowledge: [], artifacts: [], globalImports: [], globalLocalImports: [], git: [], conversationSignal: null, agentExecution: { status: "idle" }, workspace: "", preferences: { language: "en", languageSetting: "auto", editorLanguage: "", themeSetting: "auto", editorTheme: "dark" }, editingStep: null, editingKnowledge: null, libraryKind: null, libraryTab: "skill", librarySearch: "", knowledgeScope: "all", knowledgeSearch: "", importTarget: null, importMode: "local", selectedGateId: null, newFeedbackConversation: false, activeRepoRoot: null, gitSelection: {}, commitDrafts: {}, amendByRepo: {}, previewLibraryId: null, previewKnowledgeId: null, previewArtifactId: null, previewArtifactStepId: null, previewWorkflowArtifacts: false, previewAllArtifacts: false, previewStageChanges: false, maintenanceAction: null, sidebarCollapsed: savedUi.sidebarCollapsed === true, splitSizes: savedUi.splitSizes || {} };
const icons = {
  workflow: '<svg viewBox="0 0 24 24"><path d="M12 3v3"/><path d="M8 3h8"/><rect x="4" y="6" width="16" height="14" rx="4"/><path d="M8 11h.01M16 11h.01M8.5 16h7"/></svg>',
  standards: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m8 8 4 2.5L16 8m-4 2.5V16"/></svg>',
  knowledge: '<svg viewBox="0 0 24 24"><path d="M4 6.5c2.8-1.5 5.5-1 8 1v11c-2.5-2-5.2-2.5-8-1Z"/><path d="M20 6.5c-2.8-1.5-5.5-1-8 1v11c2.5-2 5.2-2.5 8-1Z"/><path d="M4 21c2.8-1.6 5.5-1.4 8 0 2.5-1.4 5.2-1.6 8 0"/></svg>',
  git: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 7.5v9M8.5 16.5h1A8.5 8.5 0 0 0 18 8"/></svg>',
  feedback: '<svg viewBox="0 0 24 24"><path d="M4 4h13a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4Z"/><path d="M8 9h8m-8 4h5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a2 2 0 0 0 .4 2.2l-2.6 2.6A2 2 0 0 0 15 19.4a2 2 0 0 0-1.2 1.8h-3.6A2 2 0 0 0 9 19.4a2 2 0 0 0-2.2.4l-2.6-2.6A2 2 0 0 0 4.6 15a2 2 0 0 0-1.8-1.2v-3.6A2 2 0 0 0 4.6 9a2 2 0 0 0-.4-2.2l2.6-2.6A2 2 0 0 0 9 4.6a2 2 0 0 0 1.2-1.8h3.6A2 2 0 0 0 15 4.6a2 2 0 0 0 2.2-.4l2.6 2.6A2 2 0 0 0 19.4 9a2 2 0 0 0 1.8 1.2v3.6A2 2 0 0 0 19.4 15Z"/></svg>',
};

function esc(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function miniMarkdown(text) {
  return text
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
    .split("\n\n").map((block) => {
      block = block.trim();
      if (!block) return "";
      if (/^#{1,4}\s/.test(block)) { const level = block.match(/^(#+)/)[1].length; return `<h${level}>${esc(block.replace(/^#+\s*/, ""))}</h${level}>`; }
      if (/^[-*]\s/.test(block)) return `<ul>${block.split(/\n/).map((line) => `<li>${esc(line.replace(/^[-*]\s*/, ""))}</li>`).join("")}</ul>`;
      if (/^\d+\.\s/.test(block)) return `<ol>${block.split(/\n/).map((line) => `<li>${esc(line.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`;
      if (/^```/.test(block)) { const body = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""); return `<pre><code>${esc(body)}</code></pre>`; }
      return `<p>${esc(block).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`;
    }).join("");
}
const i18n = {
  "zh-CN": { "研发流程": "工作台", "Workspace 级规范": "Workspace 级研发 Agent" },
  "en": { "研发流程": "Workbench", "Workspace 级规范": "Workspace Agent" }
};
function L(zh, en) { return ui.preferences.language === "en" ? (i18n.en[zh] || en) : (i18n["zh-CN"][zh] || zh); }
const bundledAgentNames = {
  "agent:implementation": ["开发执行 Agent", "Implementation Agent"],
  "agent:quality-review": ["质量审查 Agent", "Quality Review Agent"],
  "agent:research": ["调研分析 Agent", "Research Agent"],
};
const builtinWorkflowNames = {
  "standard-development": ["标准研发流程", "Standard Development"],
  "test-case-alignment": ["用例驱动对齐", "Case-driven Alignment"],
  "code-review": ["代码 Review", "Code Review"],
};
const builtinStepNames = {
  "requirement": ["需求梳理", "Requirement Clarification"], "design": ["技术设计", "Technical Design"], "implementation": ["编码实现", "Implementation"], "verification": ["测试验收", "Verification"],
  "case-intake": ["测试用例解析", "Test-case Intake"], "case-mapping": ["代码映射与差距分析", "Code Mapping and Gap Analysis"], "case-implementation": ["对齐实现", "Aligned Implementation"], "case-verification": ["用例逐项验收", "Case-by-case Verification"],
  "review-scope": ["确认审查范围", "Define Review Scope"], "review-analysis": ["代码审查", "Code Analysis"], "review-fixes": ["修复与复核", "Fix and Re-review"], "review-report": ["Review 结论", "Review Report"],
};
const builtinWorkflowDescriptions = {
  "standard-development": ["从需求澄清到测试验收的默认全流程。", "A complete workflow from requirement clarification to acceptance."],
  "test-case-alignment": ["以已有测试用例为准绳完成实现、核对和验收。", "Implement and verify changes against an existing test-case source."],
  "code-review": ["面向正确性、安全性、可维护性和测试充分性的系统审查。", "Review correctness, security, maintainability, and test coverage."],
};
const builtinStepCopy = {
  requirement: { description: ["明确目标、边界与验收标准。", "Clarify goals, scope, and acceptance criteria."], standards: [["输出需求摘要", "列出验收标准", "记录待确认问题"], ["Produce a requirement summary", "List acceptance criteria", "Record open questions"]] },
  design: { description: ["形成与现有代码一致的实现方案。", "Design an implementation aligned with the existing codebase."], standards: [["说明模块边界", "说明数据流和失败处理", "定义验证方案"], ["Describe module boundaries", "Describe data flow and failures", "Define verification"]] },
  implementation: { description: ["按设计小步实现并持续验证。", "Implement incrementally with continuous verification."], standards: [["保护已有改动", "不得写入凭据", "保持改动聚焦"], ["Preserve existing changes", "Never commit credentials", "Keep changes focused"]] },
  verification: { description: ["验证功能、边界和交付质量。", "Verify behavior, edge cases, and delivery quality."], standards: [["类型检查通过", "相关测试通过", "记录未验证项和风险"], ["Type checks pass", "Relevant tests pass", "Record unverified risks"]] },
  "case-intake": { description: ["读取测试用例并提取前置条件、操作和预期结果。", "Extract preconditions, actions, and expected results."], standards: [["每条用例可追踪", "标记缺失信息", "不得臆造预期结果"], ["Every case is traceable", "Flag missing information", "Do not invent expectations"]] },
  "case-mapping": { description: ["把每条用例映射到代码路径并识别差距。", "Map each case to code paths and identify gaps."], standards: [["建立用例到代码映射", "列出实现差距", "定义验证方法"], ["Map cases to code", "List implementation gaps", "Define verification"]] },
  "case-implementation": { description: ["按用例差距完成最小实现。", "Implement the smallest changes needed to close the gaps."], standards: [["逐条对应测试用例", "避免超范围改动", "保留可追踪证据"], ["Address each test case", "Avoid out-of-scope changes", "Keep traceable evidence"]] },
  "case-verification": { description: ["逐条执行或验证测试用例并形成结果。", "Execute or verify every test case and report results."], standards: [["记录每条用例结果", "附上失败证据", "汇总剩余风险"], ["Record every result", "Attach failure evidence", "Summarize remaining risks"]] },
  "review-scope": { description: ["确认变更基线、目标和风险区域。", "Confirm the diff base, goals, and risk areas."], standards: [["明确 Diff 范围", "理解业务目标", "识别高风险模块"], ["Define the diff", "Understand the goal", "Identify high-risk modules"]] },
  "review-analysis": { description: ["检查缺陷、回归、安全、性能和维护成本。", "Inspect defects, regressions, security, performance, and maintenance cost."], standards: [["问题必须可定位", "区分优先级", "避免纯风格噪音"], ["Findings are actionable", "Assign priorities", "Avoid style-only noise"]] },
  "review-fixes": { description: ["修复确认的问题并复核影响范围。", "Fix confirmed issues and re-check affected paths."], standards: [["只修复确认问题", "增加必要测试", "复核回归风险"], ["Fix confirmed issues only", "Add necessary tests", "Re-check regression risk"]] },
  "review-report": { description: ["输出问题、证据、修复状态和剩余风险。", "Report findings, evidence, fix status, and remaining risks."], standards: [["按优先级排序", "引用具体文件位置", "明确通过或阻塞"], ["Sort by priority", "Reference exact locations", "State pass or block"]] },
};
const builtinWorkflowInputCopy = {
  "test-case-alignment:test-cases": { name: ["测试用例来源", "Test-case source"], description: ["请提供测试用例 URL、截图路径/地址，或直接粘贴测试用例文字。", "Provide a test-case URL, screenshot path/URL, or pasted test-case text."] },
};
function localizedPair(value, fallback = "") { return value ? (ui.preferences.language === "en" ? value[1] : value[0]) : fallback; }
function displayWorkflowName(workflow) { const name = builtinWorkflowNames[workflow?.id]; return name ? (ui.preferences.language === "en" ? name[1] : name[0]) : workflow?.name || ""; }
function displayStepName(step) { const name = builtinStepNames[step?.id]; return name ? (ui.preferences.language === "en" ? name[1] : name[0]) : step?.name || ""; }
function displayWorkflowDescription(workflow) { return localizedPair(builtinWorkflowDescriptions[workflow?.id], workflow?.description || ""); }
function displayStepDescription(step) { return localizedPair(builtinStepCopy[step?.id]?.description, step?.description || L("尚未填写步骤说明", "No step description")); }
function displayStepStandards(step) { const copy = builtinStepCopy[step?.id]?.standards; return copy ? (ui.preferences.language === "en" ? copy[1] : copy[0]) : (step?.standards || []); }
function displayWorkflowInputName(workflow, input) { return localizedPair(builtinWorkflowInputCopy[`${workflow?.id}:${input?.id}`]?.name, input?.name || ""); }
function displayWorkflowInputDescription(workflow, input) { return localizedPair(builtinWorkflowInputCopy[`${workflow?.id}:${input?.id}`]?.description, input?.description || ""); }
function displayItemName(item) { const name = item?.kind === "agent" ? bundledAgentNames[item?.id] : null; return name ? localizedPair(name) : item?.name || ""; }
function displayItemDescription(item) { return String(item?.description || ""); }
function applyTheme() {
  const selected = ui.preferences.themeSetting || "auto";
  document.body.classList.remove("daedalus-theme-light", "daedalus-theme-dark");
  if (selected === "light" || selected === "dark") document.body.classList.add(`daedalus-theme-${selected}`);
  document.documentElement.style.colorScheme = selected === "auto" ? (ui.preferences.editorTheme || "dark") : selected;
}
function relativeTime(value) { const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return L("刚刚", "just now"); if (seconds < 3600) return L(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)}m ago`); if (seconds < 86400) return L(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)}h ago`); return L(`${Math.floor(seconds / 86400)} 天前`, `${Math.floor(seconds / 86400)}d ago`); }
function activeWorkflow() { return ui.config.workflows.find((item) => item.id === ui.config.activeWorkflowId) || ui.config.workflows[0]; }
function currentProgress(workflow) { return ui.state.progress.find((item) => item.workflowId === workflow?.id) || { currentStepId: workflow?.steps[0]?.id || null, completed: [] }; }
function itemName(id) { const item = ui.library.find((entry) => entry.id === id); return item ? displayItemName(item) : id; }
function navItem(id, label, badge = 0, dot = false) { return `<button class="nav-item ${ui.view === id ? "active" : ""}" data-view="${id}" title="${esc(label)}"><span class="nav-icon">${icons[id]}${dot ? '<i class="nav-alert-dot"></i>' : ""}</span><span class="nav-label">${label}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</button>`; }
function collaborationEntry(pending) { return `<button class="collaboration-entry ${ui.view === "feedback" ? "active" : ""}" data-view="feedback" title="Feedback"><span class="collaboration-icon">${icons.feedback}</span><span class="collaboration-copy"><strong>Feedback</strong><small>${L("与 Agent 协作", "Agent collaboration")}</small></span>${pending ? `<span class="nav-badge">${pending}</span>` : '<span class="collaboration-arrow">›</span>'}</button>`; }
function shell(content) { const feedbackEnabled = ui.config.settings?.feedbackEnabled === true; const pending = ui.state.gates.filter((gate) => gate.status === "pending" && gate.origin !== "user").length; const changes = ui.git.reduce((sum, repo) => sum + repo.files.length, 0); const workflowAlert = Boolean(ui.conversationSignal && !ui.conversationSignal.acknowledgedAt); const sidebarAction = ui.sidebarCollapsed ? L("展开侧栏", "Expand sidebar") : L("收起侧栏", "Collapse sidebar"); return `<div class="app-shell"><aside class="sidebar ${ui.sidebarCollapsed ? "collapsed" : ""}"><button class="brand" data-action="toggle-sidebar" title="${sidebarAction}" aria-label="${sidebarAction}"><span class="brand-mark">D</span><span class="brand-copy"><strong>Daedalus</strong><small>AGENT STUDIO</small></span></button><nav>${navItem("workflow", L("研发流程", "Workflows"), 0, workflowAlert)}${navItem("git", L("变更", "Changes"), 0, changes > 0)}${navItem("knowledge", L("知识库", "Knowledge"))}${navItem("standards", L("规范库", "Standards"))}${navItem("settings", L("设置", "Settings"))}</nav>${feedbackEnabled ? `<nav class="nav-bottom">${collaborationEntry(pending)}</nav>` : ""}</aside><main class="main-content">${content}</main></div>`; }
function pageHeader(title, subtitle, actions = "") { return `<header class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="header-actions">${actions}</div></header>`; }
function chips(ids, kind) {
  if (!ids.length) return `<span class="empty-binding">${L("未绑定", "No")} ${kind === "skill" ? "Skill" : "Rule"}</span>`;
  const visible = ids.slice(0, 3).map((id) => `<span class="binding-chip ${kind}">${esc(itemName(id))}</span>`).join("");
  const remainder = ids.length - 3;
  return `<div class="binding-chips">${visible}${remainder > 0 ? `<span class="binding-overflow" title="${L(`另有 ${remainder} 项`, `${remainder} more items`)}">+${remainder}</span>` : ""}</div>`;
}
function knowledgeChips(ids = []) {
  if (!ids.length) return `<span class="empty-binding">${L("未绑定知识", "No knowledge")}</span>`;
  const visible = ids.slice(0, 3).map((id) => `<span class="binding-chip knowledge">${esc(ui.knowledge.find((item) => item.id === id)?.name || id)}</span>`).join("");
  const remainder = ids.length - 3;
  return `<div class="binding-chips">${visible}${remainder > 0 ? `<span class="binding-overflow" title="${L(`另有 ${remainder} 项`, `${remainder} more items`)}">+${remainder}</span>` : ""}</div>`;
}

function resourceMeta(item) {
  if (item.source === "default") return `<span class="origin-badge builtin">${L("内置", "Built-in")}</span>`;
  const scope = `<span class="scope-badge ${item.scope || "project"}">${item.scope === "global" ? L("全局", "Global") : L("项目", "Project")}</span>`;
  if (item.source === "git") return `<span class="origin-badge git">${L("Git 导入", "Git import")}</span>${scope}`;
  if (item.source === "local") return `<span class="origin-badge local">${L("本地导入", "Local import")}</span>${scope}`;
  if (item.source === "native") return `<span class="origin-badge native">Cursor</span>${scope}`;
  if (item.source === "linked") return `<span class="origin-badge linked">${L("关联目录", "Linked dir")}</span>${scope}`;
  return scope;
}

function workflowView() {
  const workflow = activeWorkflow();
  if (!workflow) return shell(`${pageHeader(L("研发流程", "Workflows"), esc(ui.workspace))}<div class="content-wrapper"><section class="empty-state"><h2>${L("还没有流程", "No workflows yet")}</h2><button class="btn-primary" data-action="show-add-workflow">${L("创建流程", "Create workflow")}</button></section></div>${workflowDialogs()}`);
  const progress = currentProgress(workflow);
  const workflowArtifacts = (ui.artifacts || []).filter((item) => item.workflowId === workflow.id);
  const currentStep = workflow.steps.find((item) => item.id === progress.currentStepId);
  const currentAgent = ui.library.find((item) => item.kind === "agent" && item.id === workflow.agentId);
  const execution = ui.agentExecution || { status: "idle" };
  const executionRunning = ["starting", "running", "waiting_feedback", "continuing"].includes(execution.status) && execution.workflowId === workflow.id;
  const hasCurrentStepRun = Boolean(progress.currentStepId && (ui.state.runs || []).some((run) => run.workflowId === workflow.id && run.stepId === progress.currentStepId));
  const missingRequiredInput = (workflow.inputs || []).some((input) => input.required && !progress.inputs?.[input.id]?.trim());
  const steps = workflow.steps.map((step, index) => {
    const completion = progress.completed.find((item) => item.stepId === step.id);
    const status = completion ? "done" : progress.currentStepId === step.id ? "active" : "pending";
    const standards = displayStepStandards(step);
    const artifactCount = workflowArtifacts.filter((item) => item.stepId === step.id).length;
    return `<article class="workflow-step ${status}"><div class="step-rail"><span>${status === "done" ? "✓" : index + 1}</span></div><div class="step-content"><div class="step-head"><div><h3>${esc(displayStepName(step))}</h3><p>${esc(displayStepDescription(step))}</p></div><div class="step-head-actions"><div class="step-resource-actions">${artifactCount ? `<button class="step-resource-action stage-artifact-button" data-stage-artifacts="${esc(step.id)}">${L("产出", "Outputs")}<b>${artifactCount}</b></button>` : ""}</div><div class="step-control-actions">${status !== "active" ? `<button class="step-current-action" data-execute-step="${step.id}" title="${L("将此阶段设为当前阶段并立即执行", "Set this as the current stage and execute it")}"><span aria-hidden="true"></span>${L("执行", "Run")}</button>` : ""}<button class="btn-secondary btn-small" data-edit-step="${step.id}">${L("配置", "Configure")}</button></div></div></div><div class="step-bindings-compact"><div class="binding-row"><strong>Skills</strong>${chips(step.skillIds, "skill")}</div><div class="binding-row"><strong>Rules</strong>${chips(step.ruleIds, "rule")}</div><div class="binding-row knowledge-binding"><strong>${L("知识", "Knowledge")}</strong>${knowledgeChips(step.knowledgeIds)}</div></div><div class="standards"><strong>${L("标准化要求", "Standards")}</strong><ul>${standards.length ? standards.map((item) => `<li>${esc(item)}</li>`).join("") : `<li>${L("未配置", "Not configured")}</li>`}</ul></div>${completion ? `<div class="completion-note">${L("完成摘要", "Completion summary")}：${esc(completion.summary || L("已完成", "Completed"))}</div>` : ""}</div></article>`;
  }).join("");
  const actions = `<select id="workflow-select" title="${L("切换后自动设为当前流程", "Switching sets the active workflow")}">${ui.config.workflows.map((item) => `<option value="${item.id}" ${item.id === workflow.id ? "selected" : ""}>${item.id === ui.config.activeWorkflowId ? "★ " : ""}${esc(displayWorkflowName(item))}</option>`).join("")}</select><button class="btn-secondary btn-small" data-action="show-add-workflow">＋ ${L("流程", "Workflow")}</button>`;
  const inputPanel = workflow.inputs?.length ? `<form class="workflow-inputs" id="workflow-inputs-form"><div><strong>${L("流程输入", "Workflow input")}</strong><p>${esc(displayWorkflowInputDescription(workflow, workflow.inputs[0]))}</p></div>${workflow.inputs.map((input) => `<label>${esc(displayWorkflowInputName(workflow, input))}${input.required ? " *" : ""}<textarea name="${esc(input.id)}" rows="3" ${input.required ? "required" : ""} placeholder="${L("粘贴 URL、截图路径/地址或文字内容", "Paste a URL, screenshot path/URL, or text")}">${esc(progress.inputs?.[input.id] || "")}</textarea><span class="workflow-input-meta"><small>${L("支持", "Accepts")}: ${esc(input.accepts.join(" / "))}</small>${input.accepts.includes("image") ? `<button type="button" class="btn-secondary btn-small" data-pick-workflow-input="${esc(input.id)}">${L("选择截图", "Choose screenshot")}</button>` : ""}</span></label>`).join("")}<button class="btn-secondary btn-small">${L("保存流程输入", "Save input")}</button></form>` : "";
  const signalStatus = ui.conversationSignal?.status || "ready";
  const signalTitle = signalStatus === "ready" ? L("阶段已就绪", "Stage ready") : signalStatus === "blocked" ? L("阶段受阻", "Stage blocked") : L("需继续", "More work needed");
  const signalExcerpt = ui.conversationSignal?.excerpt || (signalStatus === "ready" ? `${L("可推进到", "Ready to advance to")} ${ui.conversationSignal?.suggestedStepName || ""}` : "");
  const signal = ui.conversationSignal?.workflowId === workflow.id ? `<div class="workflow-compact-signal ${ui.conversationSignal.acknowledgedAt ? "acknowledged" : ""} ${signalStatus}" title="${esc(signalExcerpt)}"><span class="signal-dot"></span><span class="signal-copy"><strong>${signalTitle}</strong><small>${esc(signalExcerpt)}</small></span><div class="signal-actions">${signalStatus === "ready" ? `<button class="btn-primary btn-small" data-action="advance-from-signal">${L("推进", "Advance")}</button>` : ""}<button class="signal-dismiss" data-action="acknowledge-signal" title="${L("收起提示", "Dismiss suggestion")}" aria-label="${L("收起提示", "Dismiss suggestion")}">×</button></div></div>` : "";
  const executionTitle = execution.status === "waiting_feedback" ? L("等待 Feedback", "Waiting Feedback") : execution.status === "continuing" ? L("继续执行中", "Continuing") : execution.status === "ready_suggested" ? L("建议完成", "Ready") : execution.status === "blocked" ? L("受阻", "Blocked") : execution.status === "paused" ? L("已暂停", "Paused") : execution.status === "completed" ? L("已完成", "Complete") : execution.status === "failed" ? L("执行失败", "Failed") : execution.status === "stopped" ? L("已停止", "Stopped") : L("执行中", "Running");
  const executionInline = execution.status !== "idle" && execution.workflowId === workflow.id ? `<span class="execution-inline ${esc(execution.status)}" title="${esc(execution.message || executionTitle)}"><span class="execution-pulse"></span><strong>${executionTitle}</strong>${executionRunning ? `<button class="btn-secondary btn-small" data-action="stop-agent">${L("停止", "Stop")}</button>` : ""}</span>` : "";
  const isActiveWorkflow = workflow.id === ui.config.activeWorkflowId;
  const manageActions = `<details class="workflow-manage"><summary>${L("流程管理", "Manage")} <i>⌄</i></summary><div class="workflow-manage-menu">${!isActiveWorkflow ? `<button data-action="set-active-workflow" data-workflow-id="${esc(workflow.id)}">★ ${L("设为当前流程", "Set as active workflow")}</button>` : ""}<button data-action="edit-workflow">${L("编辑流程", "Edit workflow")}</button><button data-action="show-add-step">${L("添加步骤", "Add step")}</button>${progress.completed.length ? `<button data-action="reset-workflow">${L("重置进度", "Reset progress")}</button>` : ""}<button class="danger" data-action="delete-workflow">${L("删除流程", "Delete workflow")}</button></div></details>`;
  const workflowOutputs = workflowArtifacts.length ? `<button class="btn-secondary" data-workflow-artifacts>${L("流程产出", "Workflow outputs")} <b>${workflowArtifacts.length}</b></button>` : "";
  const primaryActions = `${workflowOutputs}${progress.currentStepId ? `<button class="btn-primary" data-action="execute-agent" ${executionRunning || missingRequiredInput ? `disabled title="${missingRequiredInput ? L("请先保存必填流程输入", "Save the required workflow input first") : L("正在执行", "Running")}"` : ""}>${executionRunning ? L("执行中…", "Running…") : hasCurrentStepRun ? L("继续执行", "Continue") : L("开始执行", "Start")}</button><button class="btn-secondary" data-action="show-advance" ${missingRequiredInput ? `disabled title="${L("请先保存必填流程输入", "Save the required workflow input first")}"` : ""}>${L("手动完成", "Complete manually")}</button>` : `<span class="status-pill completed">${L("流程已完成", "Completed")}</span>`}`;
  const interactionMeta = currentStep || signal || executionInline ? `<div class="summary-meta">${currentStep ? `<span><small>Agent</small><strong>${esc(currentAgent ? displayItemName(currentAgent) : L("未选择", "Not selected"))}</strong></span><span><small>${L("对话", "Conversation")}</small><strong>${ui.config.settings?.feedbackEnabled ? "Feedback" : L("原生对话", "Native chat")}</strong></span>` : ""}${executionInline}${signal}</div>` : "";
  return shell(`${pageHeader(L("研发流程", "Workflows"), `${esc(ui.workspace)} · ${L("Workspace 级规范", "Workspace governance")}`, actions)}<div class="content-wrapper"><section class="workflow-summary"><div class="workflow-summary-main"><div class="workflow-summary-copy"><span class="card-kicker">${isActiveWorkflow ? `★ ${L("当前流程", "ACTIVE WORKFLOW")}` : L("查看流程（非当前）", "VIEWING WORKFLOW (not active)")}</span><h2>${esc(displayWorkflowName(workflow))}</h2><p>${esc(displayWorkflowDescription(workflow))}</p></div><div class="summary-actions">${primaryActions}${manageActions}</div>${interactionMeta}</div></section>${inputPanel}<div class="workflow-list">${steps || `<div class="empty-list">${L("此流程还没有步骤。", "This workflow has no steps.")}</div>`}</div></div>${workflowDialogs()}`);
}

function workflowDialogs() {
  const workflow = activeWorkflow();
  const step = ui.editingStep ? workflow?.steps.find((item) => item.id === ui.editingStep) : null;
  const skillOptions = ui.library.filter((item) => item.kind === "skill").map((item) => `<label class="check-row"><input type="checkbox" name="skills" value="${esc(item.id)}" ${step?.skillIds.includes(item.id) ? "checked" : ""}><span><strong>${esc(displayItemName(item))}</strong><small>${esc(displayItemDescription(item))}</small></span></label>`).join("") || `<p class="muted-block">${L("暂无 Skill", "No Skills")}</p>`;
  const ruleOptions = ui.library.filter((item) => item.kind === "rule").map((item) => `<label class="check-row"><input type="checkbox" name="rules" value="${esc(item.id)}" ${step?.ruleIds.includes(item.id) ? "checked" : ""}><span><strong>${esc(displayItemName(item))}</strong><small>${esc(displayItemDescription(item))}</small></span></label>`).join("") || `<p class="muted-block">${L("暂无 Rule", "No Rules")}</p>`;
  const knowledgeOptions = ui.knowledge.map((item) => `<label class="check-row"><input type="checkbox" name="knowledge" value="${esc(item.id)}" ${step?.knowledgeIds?.includes(item.id) ? "checked" : ""}><span><strong>${esc(item.name)}</strong><small>${item.scope === "global" ? L("全局", "Global") : L("当前项目", "Current project")} · ${esc(item.description || L("暂无说明", "No description"))}</small></span></label>`).join("") || `<p class="muted-block">${L("知识库暂无内容", "No knowledge entries")}</p>`;
  return `<div class="modal-backdrop hidden" id="simple-modal"><form class="modal" id="simple-form"><div class="modal-head"><div><h2 id="simple-title">${L("新增", "Add")}</h2><p id="simple-help"></p></div><button type="button" class="icon-btn" data-action="close-modal">×</button></div><label>${L("名称", "Name")}<input name="name" required maxlength="100"></label><label class="workflow-description-field hidden">${L("说明", "Description")}<textarea name="description" rows="3"></textarea></label><input type="hidden" name="mode"><input type="hidden" name="id"><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-modal">${L("取消", "Cancel")}</button><button class="btn-primary">${L("保存", "Save")}</button></div></form></div>
  <div class="modal-backdrop ${step ? "" : "hidden"}" id="step-modal"><form class="modal modal-wide" id="step-form"><div class="modal-head"><div><h2>${L("配置流程步骤", "Configure workflow step")}</h2><p>${L("绑定 Cursor 原生 Skills、Rules 与当前阶段需要引用的知识。", "Bind Cursor-native Skills and Rules plus knowledge used by this stage.")}</p></div><button type="button" class="icon-btn" data-action="close-step">×</button></div><input type="hidden" name="stepId" value="${esc(step?.id || "")}"><label>${L("步骤名称", "Step name")}<input name="name" required value="${esc(step?.name || "")}"></label><label>${L("步骤说明", "Description")}<textarea name="description" rows="2">${esc(step?.description || "")}</textarea></label><div class="picker-grid"><fieldset><legend>Skills</legend>${skillOptions}</fieldset><fieldset><legend>Rules</legend>${ruleOptions}</fieldset><fieldset class="knowledge-picker"><legend>${L("知识库", "Knowledge")}</legend>${knowledgeOptions}</fieldset></div><label>${L("标准化要求（每行一条）", "Standards (one per line)")}<textarea name="standards" rows="4">${esc(step?.standards.join("\n") || "")}</textarea></label><div class="modal-actions"><button type="button" class="btn-danger" data-action="delete-step">${L("删除步骤", "Delete step")}</button><span class="modal-spacer"></span><button type="button" class="btn-secondary btn-small" data-action="move-step-up" title="${L("上移", "Move up")}">↑ ${L("上移", "Up")}</button><button type="button" class="btn-secondary btn-small" data-action="move-step-down" title="${L("下移", "Move down")}">↓ ${L("下移", "Down")}</button><button type="button" class="btn-secondary" data-action="close-step">${L("取消", "Cancel")}</button><button class="btn-primary">${L("保存配置", "Save")}</button></div></form></div>
  <div class="modal-backdrop hidden" id="advance-modal"><form class="modal" id="advance-form"><div class="modal-head"><div><h2>${L("完成当前步骤", "Complete current step")}</h2><p>${L("Agent 只提供完成建议，流程推进必须由你确认。", "The Agent only suggests completion; you must confirm workflow advancement.")}</p></div><button type="button" class="icon-btn" data-action="close-advance">×</button></div><label>${L("完成摘要", "Completion summary")}<textarea name="summary" rows="5" required placeholder="${L("说明产出、验证结果和剩余风险", "Describe outputs, verification, and remaining risks")}"></textarea></label><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-advance">${L("取消", "Cancel")}</button><button class="btn-primary">${L("完成并推进", "Complete and advance")}</button></div></form></div>`;
}

function libraryView() {
  const kind = ui.libraryTab;
  const title = kind === "skill" ? "Skills" : kind === "rule" ? "Rules" : "Agents";
  const query = ui.librarySearch.trim().toLowerCase();
  const items = ui.library.filter((item) => item.kind === kind && (!query || `${displayItemName(item)} ${displayItemDescription(item)} ${item.source}`.toLowerCase().includes(query)));
  const tabs = `<div class="page-tabs"><button class="page-tab ${kind === "skill" ? "active" : ""}" data-library-tab="skill">Skills</button><button class="page-tab ${kind === "rule" ? "active" : ""}" data-library-tab="rule">Rules</button><button class="page-tab ${kind === "agent" ? "active" : ""}" data-library-tab="agent">Agents</button></div>`;
  const toolbar = `<div class="library-toolbar">${tabs}<label class="library-search"><span>⌕</span><input id="library-search" value="${esc(ui.librarySearch)}" placeholder="${L("搜索名称或说明…", "Search names or descriptions…")}"></label></div>`;
  const add = `<button class="btn-secondary btn-small" data-show-import="standards">${L("导入", "Import")}</button>${kind === "agent" ? "" : `<button class="btn-primary btn-small" data-add-library="${kind}">＋ ${L("新建", "New")}</button>`}`;
  const rows = items.map((item) => { const source = item.source === "git" && item.importId ? `<button class="resource-source-link" data-open-import-source="${esc(item.importId)}" data-import-scope="${esc(item.scope || "project")}">${L("来源", "Source")} ↗</button>` : ""; const action = item.source === "git" ? source : `<button class="resource-row-action" data-open-item="${esc(item.id)}" title="${L("在 Cursor 编辑器中打开", "Open in Cursor editor")}">${L("编辑", "Edit")}</button>`; return `<div class="resource-row-shell"><div class="resource-row"><span class="library-icon ${kind}">${kind === "skill" ? "✦" : kind === "rule" ? "§" : "A"}</span><span class="resource-copy"><strong>${esc(displayItemName(item))}</strong><small>${esc(displayItemDescription(item) || L("暂无说明", "No description"))}</small></span><span class="resource-meta">${resourceMeta(item)}</span>${action}</div></div>`; }).join("");
  return shell(`${pageHeader(L("规范库", "Standards"), L("项目开发使用的 Agents、Skills 与 Rules", "Agents, Skills, and Rules used by project workflows"), add)}<div class="content-wrapper">${toolbar}<div class="section-caption"><strong>${title}</strong><span>${items.length} ${query ? L("项匹配结果", "matching items") : L("项", "items")}</span></div><div class="resource-list">${rows || `<section class="empty-state compact"><h2>${query ? L("没有匹配结果", "No matching results") : L("暂无内容", "No items")}</h2></section>`}</div></div>${libraryDialog()}`);
}

function libraryDialog() { const kind = ui.libraryKind || "skill"; return `<div class="modal-backdrop ${ui.libraryKind ? "" : "hidden"}" id="library-modal"><form class="modal modal-wide" id="library-form"><div class="modal-head"><div><h2>${L("新建", "New")} ${kind === "skill" ? "Skill" : "Rule"}</h2><p>${L("保存后会按作用域安装到 Cursor 原生规范目录。", "The resource is installed into Cursor's native standards directory for the selected scope.")}</p></div><button type="button" class="icon-btn" data-action="close-library">×</button></div><input type="hidden" name="kind" value="${kind}"><label>${L("作用域", "Scope")}<select name="scope"><option value="project">${L("当前项目", "Current project")}</option><option value="global">${L("全局", "Global")}</option></select></label><label>${L("名称", "Name")}<input name="name" required maxlength="100"></label><label>${L("说明", "Description")}<input name="description" maxlength="300"></label><label>${L("规范内容", "Content")}<textarea name="content" rows="12" required placeholder="${L("写下 Agent 应遵循的具体步骤或约束…", "Describe the steps or constraints the Agent must follow…")}"></textarea></label><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-library">${L("取消", "Cancel")}</button><button class="btn-primary">${L("保存并安装", "Save & install")}</button></div></form></div>`; }

function knowledgeBody(content = "") { return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").replace(/^#\s+.*\n+/, "").trim(); }
function knowledgeFileIcon(item) {
  const file = String(item.relativePath || item.absolutePath || "");
  const extension = file.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() || "file";
  const labels = { md: "MD", mdx: "MDX", mdc: "MDC", txt: "TXT", json: "JSON", yaml: "YML", yml: "YML" };
  const label = labels[extension] || extension.slice(0, 4).toUpperCase() || "FILE";
  return `<span class="knowledge-file-icon format-${esc(extension)}" title="${esc(extension === "file" ? L("文档", "Document") : `${extension.toUpperCase()} ${L("文件", "file")}`)}">${esc(label)}</span>`;
}
function linkedDirsSection() {
  const dirs = ui.config.linkedKnowledgeDirs || [];
  if (!dirs.length) return "";
  const rows = dirs.map((dir) => {
    const count = ui.knowledge.filter((item) => item.source === "linked" && item.linkedDirId === dir.id).length;
    return `<div class="linked-dir-row"><span class="linked-dir-mark" aria-hidden="true">DIR</span><div class="linked-dir-info"><strong>${esc(dir.name)}</strong><small>${esc(dir.path)}</small></div><span class="linked-dir-scope">${dir.scope === "global" ? L("全局", "Global") : L("项目", "Project")}</span><span class="linked-dir-count">${count} MD</span><button class="resource-text-action linked-dir-unlink" data-unlink-dir="${esc(dir.id)}">${L("取消关联", "Unlink")}</button></div>`;
  }).join("");
  return `<div class="section-caption"><strong>${L("已关联目录", "Linked directories")}</strong><span>${dirs.length} ${L("个", "")}</span></div><div class="linked-dirs-list">${rows}</div>`;
}

function knowledgeView() {
  const query = ui.knowledgeSearch.trim().toLowerCase();
  const items = ui.knowledge.filter((item) => (ui.knowledgeScope === "all" || item.scope === ui.knowledgeScope) && (!query || `${item.name} ${item.description} ${item.content}`.toLowerCase().includes(query)));
  const editor = ui.editingKnowledge === "new" ? { id: "", name: "", description: "", scope: ui.knowledgeScope === "global" ? "global" : "project", content: "", source: "direct" } : null;
  const tabs = `<div class="page-tabs"><button class="page-tab ${ui.knowledgeScope === "all" ? "active" : ""}" data-knowledge-scope="all">${L("全部", "All")}</button><button class="page-tab ${ui.knowledgeScope === "project" ? "active" : ""}" data-knowledge-scope="project">${L("当前项目", "Current project")}</button><button class="page-tab ${ui.knowledgeScope === "global" ? "active" : ""}" data-knowledge-scope="global">${L("全局", "Global")}</button></div>`;
  const toolbar = `<div class="library-toolbar">${tabs}<label class="library-search"><span>⌕</span><input id="knowledge-search" value="${esc(ui.knowledgeSearch)}" placeholder="${L("搜索知识名称或内容…", "Search knowledge names or content…")}"></label></div>`;
  const rows = items.map((item) => { const editing = ui.editingKnowledge === item.id; const action = item.source === "linked" ? `<button class="resource-row-action" data-open-linked-knowledge="${esc(item.absolutePath)}">${L("打开", "Open")}</button>` : item.source === "git" && item.importId ? `<button class="resource-source-link" data-open-import-source="${esc(item.importId)}" data-import-scope="${esc(item.scope)}">${L("来源", "Source")} ↗</button>` : `<button class="resource-row-action" data-edit-knowledge="${esc(item.id)}">${L("编辑", "Edit")}</button>`; const detail = editing ? `<form class="resource-inline-editor" data-knowledge-inline-form><input type="hidden" name="id" value="${esc(item.id)}"><input type="hidden" name="scope" value="${esc(item.scope)}"><label>${L("名称", "Name")}<input name="name" required maxlength="120" value="${esc(item.name)}"></label><label>${L("说明", "Description")}<input name="description" maxlength="500" value="${esc(item.description || "")}"></label><label>${L("Markdown 内容", "Markdown content")}<textarea name="content" rows="10" required>${esc(knowledgeBody(item.content || ""))}</textarea></label><div class="resource-inline-editor-actions"><button type="button" class="resource-text-action" data-action="cancel-inline-knowledge">${L("取消", "Cancel")}</button><button class="btn-primary btn-small">${L("保存", "Save")}</button></div></form>` : ""; return `<div class="resource-row-shell ${editing ? "expanded" : ""}"><div class="resource-row">${knowledgeFileIcon(item)}<span class="resource-copy"><strong>${esc(item.name)}</strong><small>${esc(item.description || L("暂无说明", "No description"))}</small></span><span class="resource-meta">${resourceMeta(item)}</span>${action}</div>${detail}</div>`; }).join("");
  return shell(`${pageHeader(L("知识库", "Knowledge"), L("Agent 可检索的当前项目与全局知识", "Current-project and global knowledge searchable by the Agent"), `<button class="btn-secondary btn-small" data-show-import="knowledge">${L("导入", "Import")}</button><button class="btn-secondary btn-small" data-action="link-knowledge-dir">${L("关联目录", "Link directory")}</button><button class="btn-primary btn-small" data-add-knowledge>＋ ${L("新建", "New")}</button>`)}<div class="content-wrapper">${toolbar}${linkedDirsSection()}<div class="section-caption"><strong>${L("知识条目", "Knowledge entries")}</strong><span>${items.length} ${query ? L("项匹配结果", "matching items") : L("项", "items")}</span></div><div class="resource-list">${rows || `<section class="empty-state compact"><h2>${query ? L("没有匹配结果", "No matching results") : L("暂无知识条目", "No knowledge entries")}</h2><p>${query ? L("尝试其他关键词或切换范围。", "Try another keyword or scope.") : L("使用上方入口新建或导入 Markdown 知识。", "Use the actions above to create or import Markdown knowledge.")}</p></section>`}</div></div>${knowledgeDialog(editor)}`);
}

function knowledgeDialog(item) {
  return `<div class="modal-backdrop ${item ? "" : "hidden"}" id="knowledge-modal"><form class="modal modal-wide" id="knowledge-form"><div class="modal-head"><div><h2>${item?.id ? L("编辑知识", "Edit knowledge") : L("新建知识", "New knowledge")}</h2><p>${L("直接编辑 Markdown；当前项目仅在此 Workspace 可见，全局内容可供所有已初始化 Workspace 使用。", "Edit Markdown directly. Current-project knowledge is local to this Workspace; global knowledge is shared by initialized Workspaces.")}</p></div><button type="button" class="icon-btn" data-action="close-knowledge">×</button></div><input type="hidden" name="id" value="${esc(item?.id || "")}"><label>${L("作用域", "Scope")}<select name="scope" ${item?.id ? "disabled" : ""}><option value="project" ${item?.scope !== "global" ? "selected" : ""}>${L("当前项目", "Current project")}</option><option value="global" ${item?.scope === "global" ? "selected" : ""}>${L("全局", "Global")}</option></select></label><label>${L("名称", "Name")}<input name="name" required maxlength="120" value="${esc(item?.name || "")}"></label><label>${L("说明", "Description")}<input name="description" maxlength="500" value="${esc(item?.description || "")}"></label><label>${L("Markdown 内容", "Markdown content")}<textarea name="content" rows="15" required>${esc(knowledgeBody(item?.content || ""))}</textarea></label><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-knowledge">${L("取消", "Cancel")}</button><button class="btn-primary">${L("保存知识", "Save knowledge")}</button></div></form></div>`;
}

function gitStatusLabel(file) {
  if (file.untracked) return { code: "U", label: L("未跟踪", "Untracked"), tone: "added" };
  const code = file.worktreeStatus !== " " ? file.worktreeStatus : file.indexStatus;
  const labels = { M: L("修改", "Modified"), A: L("新增", "Added"), D: L("删除", "Deleted"), R: L("重命名", "Renamed"), C: L("复制", "Copied"), U: L("冲突", "Conflict"), T: L("类型变更", "Type changed") };
  return { code, label: labels[code] || L("变更", "Changed"), tone: code === "D" ? "deleted" : code === "A" ? "added" : code === "R" ? "renamed" : "modified" };
}

function gitView() {
  const repositories = ui.git || [];
  const repository = repositories.find((item) => item.root === ui.activeRepoRoot) || repositories[0];
  if (!repository) return shell(`${pageHeader(L("变更", "Changes"), L("查看当前工作区的文件变化", "View file changes in the current workspace"), '<button class="icon-btn" data-action="git-refresh">↻</button>')}<div class="content-wrapper"><section class="empty-state"><h2>${L("暂无变更", "No changes")}</h2></section></div>`);
  const isLocal = repository.kind === "local";
  const selected = ui.gitSelection[repository.root] || new Set();
  const committableFiles = isLocal ? [] : repository.files;
  const allChecked = committableFiles.length > 0 && committableFiles.every((file) => selected.has(file.path));
  const repoList = repositories.map((repo) => `<button class="git-repo-row ${repo.root === repository.root ? "active" : ""}" data-repo-root="${esc(repo.root)}"><span class="repo-icon">${repo.kind === "local" ? "◌" : "⑂"}</span><span><strong>${esc(repo.name)}</strong><small>${esc(repo.relativeRoot)} · ${esc(repo.branch)}</small></span><b>${repo.files.length}</b></button>`).join("");
  const files = repository.files.map((file) => { const status = gitStatusLabel(file); return `<div class="git-change-row">${isLocal ? '<span class="git-local-marker">•</span>' : `<input type="checkbox" data-git-check="${esc(file.path)}" ${selected.has(file.path) ? "checked" : ""}>`}<button class="git-file-button" data-git-file="${esc(file.path)}"><span class="git-file-status ${status.tone}" title="${status.label}">${status.code}</span><span class="git-file-info"><strong>${esc(file.path.split("/").pop())}</strong><small>${esc(file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : repository.name)}${file.originalPath ? ` · ${L("从", "renamed from")} ${esc(file.originalPath)} ${L("重命名", "")}` : ""}</small></span></button><span class="git-stage-state">${isLocal ? L("本地记录", "Local") : file.indexStatus !== " " && file.indexStatus !== "?" ? L("已暂存", "Staged") : ""}</span></div>`; }).join("");
  const draft = ui.commitDrafts[repository.root] || "";
  const header = isLocal
    ? `<strong>${esc(repository.name)}</strong><span>${repository.files.length} ${L("项本地变更", "local changes")}</span>`
    : `<label><input type="checkbox" id="git-check-all" ${allChecked ? "checked" : ""} ${!committableFiles.length ? "disabled" : ""}> <strong>${esc(repository.name)}</strong></label><span>${selected.size}/${committableFiles.length} ${L("个待提交文件已选择", "uncommitted files selected")}</span>`;
  const footer = isLocal
    ? `<div class="git-local-note"><strong>${L("本地变更记录", "Local change history")}</strong><span>${L("当前项目尚未初始化 Git。Daedalus 会记录创建、修改和删除的文件；初始化 Git 后将自动切换为 Git 未提交变更。", "This project has no Git repository. Daedalus records created, modified, and deleted files, then switches to Git changes after Git is initialized.")}</span></div>`
    : `<div class="git-commit-panel"><div class="git-commit-toolbar"><label class="amend-toggle"><input type="checkbox" id="git-amend" ${ui.amendByRepo[repository.root] ? "checked" : ""}> ${L("修订上一次提交", "Amend last commit")}</label><span>${L("上次提交", "Last commit")}</span><strong>${esc(repository.lastCommit || L("暂无提交", "No commits"))}</strong></div><textarea id="git-commit-message" rows="5" placeholder="${L("提交信息…", "Commit message…")}">${esc(draft)}</textarea><div class="git-commit-actions"><span>${selected.size} ${L("个文件将被提交", "files will be committed")}</span><button class="btn-secondary" data-commit-mode="commit" ${!committableFiles.length ? "disabled" : ""}>${L("提交", "Commit")}</button><button class="btn-primary" data-commit-mode="push" ${!committableFiles.length ? "disabled" : ""}>${L("提交并推送", "Commit and Push")}</button></div></div>`;
  const subtitle = isLocal ? L("未检测到 Git 仓库 · 显示 Daedalus 本地记录", "No Git repository · showing Daedalus local history") : L(`${repositories.length} 个仓库 · ${repositories.reduce((sum, repo) => sum + repo.files.length, 0)} 个未提交文件`, `${repositories.length} repositories · ${repositories.reduce((sum, repo) => sum + repo.files.length, 0)} uncommitted files`);
  return shell(`${pageHeader(L("变更", "Changes"), subtitle, `<span class="branch-pill">${isLocal ? "◌" : "⑂"} ${esc(repository.branch)}</span><button class="icon-btn" data-action="git-refresh">↻</button>`)}<div class="git-page"><aside class="git-projects"><div class="git-pane-title">${L("项目目录", "Projects")}</div>${repoList}</aside><section class="git-change-pane ${isLocal ? "local" : ""}"><div class="git-change-header">${header}</div><div class="git-change-list">${files || `<div class="empty-list">${isLocal ? L("尚未记录到本地文件变化。", "No local file changes recorded yet.") : L("工作区干净，没有未提交文件。", "Working tree clean. Nothing to commit.")}</div>`}</div>${footer}</section></div>`);
}

function feedbackView() {
  const conversations = ui.state.gates.filter((gate) => gate.origin === "user");
  const pending = ui.state.gates.filter((gate) => gate.origin !== "user" && gate.status === "pending");
  const resolved = ui.state.gates.filter((gate) => gate.origin !== "user" && gate.status === "resolved");
  const all = [...conversations, ...pending, ...resolved];
  const selected = all.find((gate) => gate.id === ui.selectedGateId) || all[0];
  if (selected && ui.selectedGateId !== selected.id) ui.selectedGateId = selected.id;
  const item = (gate) => `<button class="feedback-thread-item ${gate.id === selected?.id ? "active" : ""}" data-select-gate="${esc(gate.id)}"><span class="decision ${gate.origin === "user" ? "conversation" : gate.status === "pending" ? "respond" : gate.decision}">${gate.origin === "user" ? (gate.busy ? "…" : "↗") : gate.status === "pending" ? "·" : gate.decision === "approve" ? "✓" : gate.decision === "reject" ? "×" : "↩"}</span><span><strong>${esc(gate.title)}</strong><small>${esc(gate.message)}</small></span>${gate.origin === "user" || gate.status === "resolved" ? `<time>${relativeTime(gate.updatedAt || gate.resolvedAt || gate.createdAt)}</time>` : '<i class="thread-unread"></i>'}</button>`;
  const list = `<aside class="feedback-thread-list"><div class="feedback-list-head"><strong>${L("会话", "Conversations")}</strong><span>${all.length}</span></div>${conversations.length ? `<div class="feedback-list-group"><small>${L("我的会话", "MY CONVERSATIONS")}</small>${conversations.map(item).join("")}</div>` : ""}${pending.length ? `<div class="feedback-list-group"><small>${L("待处理", "PENDING")}</small>${pending.map(item).join("")}</div>` : ""}${resolved.length ? `<div class="feedback-list-group"><small>${L("处理记录", "HISTORY")}</small>${resolved.map(item).join("")}</div>` : ""}</aside>`;
  let detail = `<section class="feedback-thread-empty"><div class="pulse-ring">✓</div><h2>${L("暂无会话", "No conversations")}</h2><p>${L("你可以新建独立会话；工作流中的意见征询和确认请求也会出现在这里。", "Start an independent conversation, or review feedback and approval requests from workflows here.")}</p></section>`;
  if (selected) {
    const messages = Array.isArray(selected.messages) && selected.messages.length ? selected.messages : [{ role: "agent", content: selected.message, createdAt: selected.createdAt }, ...(selected.response ? [{ role: "user", content: selected.response, createdAt: selected.resolvedAt }] : [])];
    const thread = messages.map((message) => `<div class="feedback-message ${message.role === "user" ? "user" : "agent"}"><div><strong>${message.role === "user" ? L("你", "You") : "Daedalus Agent"}</strong><time>${relativeTime(message.createdAt || selected.createdAt)}</time></div><p>${esc(message.content || "").replace(/\n/g, "<br>")}</p></div>`).join("");
    const resolvedStatus = selected.status === "resolved" ? `<div class="feedback-resolution ${selected.decision}"><span>${selected.decision === "approve" ? "✓" : selected.decision === "reject" ? "×" : "↩"}</span><strong>${selected.decision === "approve" ? L("已确认", "Approved") : selected.decision === "reject" ? L("已拒绝", "Rejected") : L("已回复", "Responded")}</strong></div>` : "";
    const composer = selected.origin === "user" ? `<div class="feedback-composer"><textarea id="standalone-feedback-message" rows="3" placeholder="${L("继续这段会话…", "Continue this conversation…")}" ${selected.busy ? "disabled" : ""}></textarea><div class="gate-actions"><button class="btn-primary" data-send-feedback="${selected.id}" ${selected.busy ? "disabled" : ""}>${selected.busy ? L("Agent 回复中…", "Agent is replying…") : L("发送", "Send")}</button></div></div>` : selected.status === "pending" ? `<div class="feedback-composer"><textarea id="response-${selected.id}" rows="3" placeholder="${L("补充意见或下一步方向…", "Add feedback or next steps…")}"></textarea><div class="gate-actions">${selected.type === "approval" ? `<button class="btn-danger" data-gate="${selected.id}" data-decision="reject">${L("不同意", "Reject")}</button><button class="btn-primary" data-gate="${selected.id}" data-decision="approve">${L("确认", "Approve")}</button>` : `<button class="btn-primary" data-gate="${selected.id}" data-decision="respond">${L("发送回复", "Send response")}</button>`}</div></div>` : resolvedStatus;
    detail = `<section class="feedback-thread-detail"><header><div><span class="gate-type">${selected.origin === "user" ? L("独立会话", "Independent conversation") : selected.type === "approval" ? L("确认请求", "Approval request") : L("意见征询", "Feedback request")}</span><h2>${esc(selected.title)}</h2></div><time>${relativeTime(selected.createdAt)}</time></header><div class="feedback-messages">${thread}</div>${composer}</section>`;
  }
  const createDialog = ui.newFeedbackConversation ? `<div class="modal-backdrop"><form class="modal" id="new-feedback-form"><div class="modal-head"><div><h2>${L("开始新对话", "Start a new conversation")}</h2><p>${L("直接输入你想讨论的内容，标题将由 Agent 自动总结。", "Enter what you want to discuss. The Agent will summarize the title automatically.")}</p></div><button type="button" class="icon-btn" data-action="close-new-feedback">×</button></div><label>${L("消息", "Message")}<textarea name="content" rows="7" required maxlength="20000" autofocus placeholder="${L("输入消息…", "Type a message…")}"></textarea></label><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-new-feedback">${L("取消", "Cancel")}</button><button class="btn-primary">${L("发送", "Send")}</button></div></form></div>` : "";
  return shell(`${pageHeader("Feedback", L("独立会话与 Agent 协作", "Independent conversations and Agent collaboration"), `<button class="btn-primary btn-small" data-action="show-new-feedback">＋ ${L("新会话", "New conversation")}</button>`)}<div class="feedback-workspace">${list}${detail}</div>${createDialog}`);
}

function settingsView() {
  const projectImports = ui.config.imports || [];
  const allImports = [...projectImports, ...(ui.globalImports || [])];
  const importList = allImports.map((item) => `<div class="import-row"><span class="repo-icon">⑂</span><div><strong>${esc(item.name)}</strong><small>${item.target === "knowledge" ? L("知识库", "Knowledge") : "Skills / Rules"} · ${item.scope === "global" ? L("全局", "Global") : L("当前项目", "Current project")} · ${esc(item.url)}${item.subpath ? ` · ${L("路径", "Path")}: ${esc(item.subpath)}` : ""}</small></div><div class="import-actions"><button class="btn-secondary btn-small" data-update-import="${esc(item.id)}" data-import-scope="${esc(item.scope || "project")}" title="${L("拉取最新内容", "Pull latest")}">${L("更新", "Pull")}</button><button class="btn-danger btn-small" data-delete-import="${esc(item.id)}" data-import-scope="${esc(item.scope || "project")}" title="${L("删除此导入", "Remove this import")}">${L("删除", "Delete")}</button><time>${relativeTime(item.importedAt)}</time></div></div>`).join("") || `<div class="empty-list">${L("尚未导入仓库", "No imported repositories")}</div>`;
  const lang = ui.preferences.languageSetting || "auto";
  const feedbackEnabled = ui.config.settings?.feedbackEnabled === true;
  return shell(`${pageHeader(L("设置", "Settings"), `${esc(ui.workspace)} Workspace`)}<div class="content-wrapper settings-content"><div class="settings-grid"><section class="card settings-card"><div class="setting-icon">文</div><div><h3>${L("界面语言", "Interface language")}</h3><p>${L("默认跟随 Cursor / VS Code，也可以在此覆盖。当前编辑器语言：", "Follows Cursor / VS Code by default, or override it here. Editor language: ")}${esc(ui.preferences.editorLanguage)}</p><select id="language-setting"><option value="auto" ${lang === "auto" ? "selected" : ""}>${L("自动（跟随编辑器）", "Auto (follow editor)")}</option><option value="zh-CN" ${lang === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" ${lang === "en" ? "selected" : ""}>English</option></select></div></section><section class="card settings-card"><div class="setting-icon">◐</div><div><h3>${L("外观主题", "Appearance")}</h3><p>${L("自动跟随 Cursor / VS Code 当前的浅色、深色或高对比度主题。", "Automatically follows the current Cursor / VS Code light, dark, or high-contrast theme.")}</p><span class="theme-follow-badge">${L("跟随编辑器", "Follow editor")}</span></div></section><section class="card settings-card"><div class="setting-icon">↔</div><div><h3>${L("反馈交流", "Feedback")}</h3><p>${L("开启后，阶段多轮对话在反馈交流中进行；关闭后，工作台打开 Cursor 原生对话。核心 MCP 始终随项目初始化。", "When enabled, stage conversations run in Feedback; when disabled, the Workbench opens native Cursor chat. The core MCP remains installed.")}</p><label class="switch-row"><input type="checkbox" id="feedback-enabled" ${feedbackEnabled ? "checked" : ""}><span>${feedbackEnabled ? L("已启用", "Enabled") : L("未启用", "Disabled")}</span></label></div></section><section class="card settings-card"><div class="setting-icon">{ }</div><div><h3>Workspace ${L("配置", "configuration")}</h3><p>${L("流程和绑定关系保存在", "Workflows and bindings are stored in")} <code>.daedalus/config.json</code>.</p><button class="btn-secondary" data-action="open-config">${L("打开配置文件", "Open configuration")}</button></div></section></div><div class="settings-import-grid"><form class="card import-form settings-import-form" data-import-form data-target="standards"><div class="card-heading"><div><h3>Skills / Rules Git ${L("导入", "Import")}</h3><p>${L("导入当前项目的规范仓库", "Import a standards repository for this project")}</p></div></div><div class="form-body"><input name="url" required placeholder="${L("Git 仓库地址", "Git repository URL")}"><input name="ref" placeholder="${L("分支或 Tag（可选）", "Branch or tag (optional)")}"><input name="subpath" placeholder="${L("仓库内目录或文件路径（可选）", "Repository directory or file path (optional)")}"><p class="form-hint">${L("例如 docs/knowledge、.cursor/rules 或 skills/review/SKILL.md；留空则导入整个仓库。", "For example docs/knowledge, .cursor/rules, or skills/review/SKILL.md. Leave empty to import the entire repository.")}</p><input type="hidden" name="scope" value="project"><button class="btn-primary">${L("克隆并扫描", "Clone and scan")}</button></div></form><form class="card import-form settings-import-form" data-import-form data-target="knowledge"><div class="card-heading"><div><h3>${L("知识库 Git 导入", "Knowledge Git Import")}</h3><p>${L("导入当前项目或全局 Markdown 知识库", "Import a current-project or global Markdown knowledge repository")}</p></div></div><div class="form-body"><input name="url" required placeholder="${L("Git 仓库地址", "Git repository URL")}"><input name="ref" placeholder="${L("分支或 Tag（可选）", "Branch or tag (optional)")}"><input name="subpath" placeholder="${L("仓库内目录或文件路径（可选）", "Repository directory or file path (optional)")}"><p class="form-hint">${L("例如 docs/knowledge、.cursor/rules 或 skills/review/SKILL.md；留空则导入整个仓库。", "For example docs/knowledge, .cursor/rules, or skills/review/SKILL.md. Leave empty to import the entire repository.")}</p><select name="scope"><option value="project">${L("当前项目", "Current project")}</option><option value="global">${L("全局", "Global")}</option></select><button class="btn-primary">${L("克隆并扫描", "Clone and scan")}</button></div></form></div><section class="card imports-history"><div class="card-heading"><div><h3>${L("导入来源", "Import sources")}</h3><p>${allImports.length} ${L("个仓库", "repositories")}</p></div></div><div class="import-list">${importList}</div></section></div>`);
}

function enhanceThemeControl() {
  if (!ui.initialized) {
    const subtitle = document.querySelector(".page-header p");
    if (subtitle) subtitle.textContent = L("插件通用配置", "Extension settings");
  }
  const badge = document.querySelector(".theme-follow-badge");
  if (!badge) return;
  const card = badge.closest(".settings-card");
  const select = document.createElement("select");
  select.id = "theme-setting";
  select.innerHTML = [["auto", L("自动（跟随编辑器）", "Auto (follow editor)")], ["light", L("浅色", "Light")], ["dark", L("深色", "Dark")]].map(([value, label]) => `<option value="${value}" ${ui.preferences.themeSetting === value ? "selected" : ""}>${label}</option>`).join("");
  badge.replaceWith(select);
  const settingsGrid = document.querySelector(".settings-grid");
  [...(settingsGrid?.querySelectorAll(".settings-card") || [])].slice(0, 2).forEach((settingCard) => {
    settingCard.classList.add("settings-card-compact");
    settingCard.querySelector("p")?.remove();
  });
  const feedbackToggle = document.getElementById("feedback-enabled");
  const feedbackCard = feedbackToggle?.closest(".settings-card");
  if (feedbackCard) {
    const heading = feedbackCard.querySelector("h3");
    const help = L("开启后可在 Feedback 中自主创建独立会话；已初始化 Workspace 的阶段对话也会统一进入 Feedback。", "Create independent conversations in Feedback; initialized Workspace stage conversations are routed there too.");
    if (heading) {
      heading.classList.add("hover-help-title");
      heading.textContent = "Feedback";
      heading.tabIndex = 0;
      heading.dataset.tooltip = help;
    }
    feedbackCard.querySelector("p")?.remove();
    feedbackCard.classList.add("feedback-settings-card");
    const switchRow = feedbackToggle.closest(".switch-row");
    if (switchRow) feedbackCard.append(switchRow);
  }
  const workspaceSettingsCard = document.querySelector('[data-action="open-config"]')?.closest(".settings-card");
  if (!ui.initialized) workspaceSettingsCard?.remove();
  else if (workspaceSettingsCard && settingsGrid) {
    workspaceSettingsCard.querySelector("p")?.remove();
    workspaceSettingsCard.classList.add("workspace-settings-row");
    settingsGrid.insertAdjacentElement("afterend", workspaceSettingsCard);
  }
  const wrapper = settingsGrid?.closest(".content-wrapper");
  if (settingsGrid && !document.getElementById("continuous-feedback-enabled")) {
    const enabled = ui.config.settings?.continuousFeedback === true;
    const help = L("开启后，独立 Feedback 会话和流程对话会在每轮有实质内容的交流后建议用户继续或调整。", "After each substantive cycle, independent Feedback and workflow conversations suggest continuing or adjusting.");
    settingsGrid.insertAdjacentHTML("beforeend", `<section class="card settings-card feedback-settings-card continuous-feedback-settings-card"><div class="setting-icon">↻</div><div><h3 class="hover-help-title" tabindex="0" data-tooltip="${esc(help)}">${L("持续反馈", "Continuous feedback")}</h3></div><label class="switch-row"><input type="checkbox" id="continuous-feedback-enabled" ${enabled ? "checked" : ""}><span>${enabled ? L("已启用", "Enabled") : L("未启用", "Disabled")}</span></label></section>`);
  }
  if (ui.initialized && wrapper && !document.getElementById("auto-execute-enabled")) {
    const autoExec = ui.config.settings?.autoExecuteOnAdvance !== false;
    const autoExecHelp = L("推进到下一步后自动启动 Agent 执行，无需手动点击「执行」按钮。", "Automatically start Agent execution after advancing to the next step, without requiring a manual click.");
    wrapper.insertAdjacentHTML("beforeend", `<section class="card continuous-feedback-card"><div class="continuous-feedback-main"><div class="setting-icon">▶</div><div class="policy-heading"><h3 class="hover-help-title" tabindex="0" data-tooltip="${esc(autoExecHelp)}">${L("推进后自动执行", "Auto-execute on advance")}</h3><span class="status-pill ${autoExec ? "active" : ""}">${autoExec ? L("已启用", "Enabled") : L("已关闭", "Disabled")}</span></div></div><label class="switch-row policy-switch"><input type="checkbox" id="auto-execute-enabled" ${autoExec ? "checked" : ""}><span>${autoExec ? L("开启", "On") : L("关闭", "Off")}</span></label></section>`);
  }
  if (wrapper && !document.querySelector(".maintenance-card")) {
    wrapper.insertAdjacentHTML("beforeend", `<section class="card maintenance-card"><div class="maintenance-copy"><span class="maintenance-mark">!</span><div><h3>${L("清理与卸载", "Cleanup & uninstall")}</h3><p>${L("移除 Daedalus 管理的配置、Cursor 资源和集成。操作需要再次确认。", "Remove Daedalus-managed configuration, Cursor resources, and integrations. A second confirmation is required.")}</p></div></div><div class="maintenance-actions">${ui.initialized ? `<button class="btn-secondary" data-action="show-cleanup-workspace">${L("清理当前 Workspace", "Clean this Workspace")}</button>` : ""}<button class="btn-danger" data-action="show-uninstall-daedalus">${L("卸载 Daedalus", "Uninstall Daedalus")}</button></div></section>`);
  }
  if (wrapper && !document.querySelector(".about-card")) {
    wrapper.insertAdjacentHTML("beforeend", `<section class="card about-card"><div class="about-identity"><span class="about-mark">D</span><div><h3>Daedalus</h3><p>${L("让每一次研发推进都清晰、可控、可追踪", "Clarity, control, and continuity throughout development")}</p></div></div><div class="about-meta"><span><small>${L("版本", "Version")}</small><strong>v${esc(ui.version || "0.0.0")}</strong></span><span><small>${L("运行环境", "Runtime")}</small><strong>Cursor / VS Code</strong></span></div></section>`);
  }
  if (ui.maintenanceAction && !document.getElementById("maintenance-modal")) {
    const uninstalling = ui.maintenanceAction === "uninstall";
    const expected = uninstalling ? "UNINSTALL" : ui.workspace;
    const title = uninstalling ? L("卸载 Daedalus", "Uninstall Daedalus") : L("清理当前 Workspace", "Clean this Workspace");
    const detail = uninstalling
      ? L("将移除当前 Workspace 与全局的 Daedalus Skills、Rules、Agents、MCP、Hooks、设置及数据，随后卸载扩展。", "Removes Workspace and global Daedalus Skills, Rules, Agents, MCP, hooks, settings, and data, then uninstalls the extension.")
      : L("将移除当前 Workspace 的项目级 Skills、Rules、Agents、MCP、Hooks，并删除整个 .daedalus 目录。全局资源和扩展会保留。", "Removes project Skills, Rules, Agents, MCP, hooks, and the entire .daedalus directory from this Workspace. Global resources and the extension remain installed.");
    document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="modal-backdrop" id="maintenance-modal"><form class="modal maintenance-modal" id="maintenance-form" data-maintenance-action="${ui.maintenanceAction}"><div class="modal-head"><div><span class="danger-kicker">${L("不可撤销操作", "IRREVERSIBLE ACTION")}</span><h2>${title}</h2><p>${detail}</p></div><button type="button" class="icon-btn" data-action="close-maintenance">×</button></div><label>${L(`请输入“${expected}”以确认`, `Type “${expected}” to confirm`)}<input name="confirmation" autocomplete="off" data-confirm-value="${esc(expected)}" required></label><div class="modal-actions"><button type="button" class="btn-secondary" data-action="close-maintenance">${L("取消", "Cancel")}</button><button type="submit" class="btn-danger" disabled>${title}</button></div></form></div>`);
  }
}
function enhanceArtifactOutputControl() {
  if (ui.view !== "settings" || !ui.initialized) return;
  const settingsGrid = document.querySelector(".settings-grid");
  if (!settingsGrid || document.getElementById("artifact-output-form")) return;
  const output = ui.config.settings?.artifactOutput || { mode: "workspace", directory: ".daedalus/artifacts" };
  const mode = output.mode === "git" ? "git" : "workspace";
  settingsGrid.insertAdjacentHTML("afterend", `<form class="card artifact-output-card" id="artifact-output-form"><div class="card-heading"><div><h3>${L("Agent 文档输出", "Agent document output")}</h3><p>${L("保存总结、Plan、设计说明等非代码产物。", "Save summaries, plans, design notes, and other non-code artifacts.")}</p></div><span class="status-pill active">${mode === "git" ? "Git" : "Workspace"}</span></div><div class="artifact-output-fields"><label>${L("保存位置", "Destination")}<select name="mode" id="artifact-output-mode"><option value="workspace" ${mode === "workspace" ? "selected" : ""}>Workspace</option><option value="git" ${mode === "git" ? "selected" : ""}>Git ${L("仓库", "repository")}</option></select></label><label>${L("输出目录", "Output directory")}<input name="directory" required value="${esc(output.directory || (mode === "git" ? "daedalus" : ".daedalus/artifacts"))}" placeholder="${mode === "git" ? "docs/daedalus" : ".daedalus/artifacts"}"></label><label class="artifact-git-field ${mode === "git" ? "" : "hidden"}">${L("Git 仓库地址", "Git repository URL")}<input name="repositoryUrl" value="${esc(output.repositoryUrl || "")}" placeholder="https://github.com/team/docs.git"></label><label class="artifact-git-field ${mode === "git" ? "" : "hidden"}">${L("分支或 Tag（可选）", "Branch or tag (optional)")}<input name="ref" value="${esc(output.ref || "")}" placeholder="main"></label><button class="btn-primary artifact-output-save">${L("保存输出配置", "Save output settings")}</button></div><p class="form-hint artifact-output-hint">${mode === "git" ? L("文档将写入该 Git 仓库的指定目录；仓库保存在 Daedalus 工作区数据中。", "Documents are written to the selected directory in this Git repository; its checkout is kept in Daedalus workspace data.") : L("目录相对于当前 Workspace；默认保存到 .daedalus/artifacts。", "The directory is relative to the current Workspace; the default is .daedalus/artifacts.")}</p></form>`);
  const form = document.getElementById("artifact-output-form");
  form?.querySelector(".card-heading")?.insertAdjacentHTML("afterend", `<div class="artifact-current-location"><small>${L("当前输出位置", "Current output location")}</small><code>${mode === "git" ? `${esc(output.repositoryUrl || L("未配置仓库", "Repository not configured"))} / ${esc(output.directory)}` : `${esc(ui.workspace)} / ${esc(output.directory)}`}</code></div>`);
}
function enhanceModuleImports() {
  if (ui.view === "settings") {
    document.querySelector(".settings-import-grid")?.remove();
    document.querySelector(".imports-history")?.remove();
    return;
  }
  if (ui.view !== "standards" && ui.view !== "knowledge") return;
  const target = ui.view;
  const scope = `<label>${L("作用域", "Scope")}<select name="scope"><option value="project">${L("当前项目", "Current project")}</option><option value="global">${L("全局", "Global")}</option></select></label>`;
  const example = target === "knowledge" ? "docs/knowledge" : ".cursor/rules 或 skills/review/SKILL.md";
  if (ui.importTarget !== target) return;
  const localOptions = target === "standards" ? `${scope}<label>${L("规范类型", "Standard type")}<select name="kind"><option value="skill">Skill</option><option value="rule">Rule</option><option value="agent">Agent</option></select></label>` : scope;
  const gitScope = scope;
  document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="modal-backdrop" id="import-modal"><div class="modal modal-wide"><div class="modal-head"><div><h2>${target === "knowledge" ? L("导入知识", "Import knowledge") : L("导入规范", "Import standards")}</h2><p>${L("选择本地 Markdown 文档，或配置 Git 仓库与仓库内路径。", "Choose a local Markdown document, or configure a Git repository and path.")}</p></div><button type="button" class="icon-btn" data-action="close-import">×</button></div><div class="import-mode-tabs"><button class="page-tab ${ui.importMode === "local" ? "active" : ""}" data-import-mode="local">${L("本地 MD", "Local MD")}</button><button class="page-tab ${ui.importMode === "git" ? "active" : ""}" data-import-mode="git">Git</button></div>${ui.importMode === "local" ? `<div class="import-dialog-body">${localOptions}<div class="local-import-callout"><span class="artifact-md-icon">MD</span><div><strong>${L("选择 Markdown 文档", "Choose a Markdown document")}</strong><p>${L("文件会复制到 Daedalus 管理目录，并保留原始来源记录。", "The file is copied into Daedalus storage while retaining its original source record.")}</p></div></div><button class="btn-primary" data-import-local="${target}">${L("选择文件并导入", "Choose file and import")}</button></div>` : `<form class="import-dialog-body" data-import-form data-target="${target}"><label>${L("Git 仓库地址", "Git repository URL")}<input name="url" required placeholder="https://github.com/team/repository.git"></label><label>${L("分支或 Tag（可选）", "Branch or tag (optional)")}<input name="ref" placeholder="main"></label><label>${L("仓库内目录或文件地址（可选）", "Directory or file path in repository (optional)")}<input name="subpath" placeholder="${esc(example)}"></label><p class="form-hint">${L("留空则导入整个仓库。", "Leave empty to import the entire repository.")}</p>${gitScope}<button class="btn-primary">${L("克隆并扫描", "Clone and scan")}</button></form>`}</div></div>`);
}
function enhanceAgentWorkbench() {
  if (ui.view !== "workflow") return;
  const wrapper = document.querySelector(".content-wrapper");
  const workflow = activeWorkflow();
  if (!wrapper || !workflow) return;
  const progress = currentProgress(workflow);
  const step = workflow.steps.find((item) => item.id === progress.currentStepId);
  const output = ui.config.settings?.artifactOutput || { mode: "workspace", directory: ".daedalus/artifacts" };
  const artifacts = ui.artifacts || [];
  const currentAgent = ui.library.find((item) => item.kind === "agent" && item.id === workflow.agentId);
  const currentStageArtifacts = step ? artifacts.filter((item) => item.workflowId === workflow.id && item.stepId === step.id) : [];
  const currentCodeChanges = (ui.git || []).flatMap((repository) => repository.files.map((file) => ({ ...file, repository })));
  const wbExec = ui.agentExecution || { status: "idle" };
  const wbRunning = ["starting", "running", "continuing"].includes(wbExec.status) && wbExec.workflowId === workflow.id;
  const wbStatusLabel = wbExec.status === "waiting_feedback" && wbExec.workflowId === workflow.id ? L("等待反馈", "Waiting") : wbRunning ? L("运行中", "Active") : wbExec.status === "ready_suggested" && wbExec.workflowId === workflow.id ? L("建议完成", "Ready") : wbExec.status === "paused" && wbExec.workflowId === workflow.id ? L("已暂停", "Paused") : wbExec.status === "blocked" && wbExec.workflowId === workflow.id ? L("受阻", "Blocked") : L("空闲", "Idle");
  const wbStatusClass = wbRunning ? "agent-online" : wbExec.status === "waiting_feedback" ? "agent-waiting" : wbExec.status === "blocked" ? "agent-blocked" : "agent-idle";
  wrapper.insertAdjacentHTML("afterbegin", `<section class="agent-workbench-card"><div class="agent-runtime"><span><small>${L("状态", "Status")}</small><strong class="${wbStatusClass}">● ${wbStatusLabel}</strong></span><span><small>${L("当前 Agent", "Current Agent")}</small><strong>${esc(currentAgent ? displayItemName(currentAgent) : L("未选择", "Not selected"))}</strong></span><span><small>${L("当前阶段", "Current stage")}</small><strong>${esc(step ? displayStepName(step) : L("流程已完成", "Completed"))}</strong></span><button class="agent-document-entry" data-stage-changes title="${L("查看当前阶段的文档产出与未提交代码变更", "View stage documents and uncommitted code changes")}"><small>${L("阶段变更", "Stage changes")}</small><strong>${currentStageArtifacts.length} MD · ${currentCodeChanges.length} ${L("文件", "files")} <b>→</b></strong></button></div></section>`);
  if (ui.previewStageChanges) {
    const documentRows = currentStageArtifacts.map((item) => `<button class="artifact-document-row" data-preview-artifact="${esc(item.id)}"><span class="artifact-md-icon">MD</span><span><strong>${esc(item.name)}</strong><small>${esc(item.relativePath)}</small></span><time>${relativeTime(item.updatedAt)}</time></button>`).join("") || `<div class="artifact-empty compact"><strong>${L("当前阶段还没有文档", "No stage documents yet")}</strong></div>`;
    const codeRows = currentCodeChanges.map(({ repository, ...file }) => { const status = gitStatusLabel(file); return `<button class="stage-code-row" data-stage-git-file="${esc(file.path)}" data-stage-git-root="${esc(repository.root)}"><span class="git-file-status ${status.tone}">${status.code}</span><span><strong>${esc(file.path.split("/").pop())}</strong><small>${esc(repository.name)} · ${esc(file.path)}</small></span><i>↗</i></button>`; }).join("") || `<div class="artifact-empty compact"><strong>${L("没有未提交代码变更", "No uncommitted code changes")}</strong></div>`;
    document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="preview-overlay"><section class="preview-panel stage-changes-panel"><div class="preview-head"><div><span class="source-pill">${L("当前阶段", "CURRENT STAGE")}</span><h2>${esc(step ? displayStepName(step) : L("流程已完成", "Completed"))} · ${L("阶段变更", "Stage changes")}</h2><p>${currentStageArtifacts.length} Markdown · ${currentCodeChanges.length} ${L("个代码文件", "code files")}</p></div><div class="preview-actions"><button class="btn-secondary btn-small" data-all-artifacts>${L("全部文档", "All documents")}</button><button class="icon-btn" data-action="close-stage-changes">×</button></div></div><div class="stage-change-sections"><section><div class="stage-change-heading"><strong>${L("文档产出", "Documents")}</strong><span>${currentStageArtifacts.length}</span></div><div class="artifact-document-list">${documentRows}</div></section><section><div class="stage-change-heading"><strong>${L("代码变更", "Code changes")}</strong><span>${currentCodeChanges.length}</span></div><div class="stage-code-list">${codeRows}</div></section></div></section></div>`);
  }
  if (ui.previewAllArtifacts) {
    const rows = artifacts.map((item) => `<button class="artifact-document-row" data-preview-artifact="${esc(item.id)}"><span class="artifact-md-icon">MD</span><span><strong>${esc(item.name)}</strong><small>${esc(item.relativePath)}</small></span><time>${relativeTime(item.updatedAt)}</time></button>`).join("") || `<div class="artifact-empty"><strong>${L("还没有输出文档", "No output documents yet")}</strong><p>${L("Daedalus 产生的总结、Plan 和设计文档会以 Markdown 显示在这里。", "Summaries, plans, and design documents produced by Daedalus will appear here as Markdown.")}</p></div>`;
    document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="preview-overlay"><section class="preview-panel stage-artifact-panel"><div class="preview-head"><div><span class="source-pill">MARKDOWN</span><h2>${L("输出文档", "Output documents")}</h2><p>${artifacts.length} Markdown · ${esc(output.directory)}</p></div><button class="icon-btn" data-action="close-all-artifacts">×</button></div><div class="artifact-document-list stage-artifact-list">${rows}</div></section></div>`);
  }
  if (ui.previewWorkflowArtifacts) {
    const workflowArtifacts = artifacts.filter((item) => item.workflowId === workflow.id);
    const rows = workflowArtifacts.map((item) => `<button class="artifact-document-row" data-preview-artifact="${esc(item.id)}"><span class="artifact-md-icon">MD</span><span><strong>${esc(item.name)}</strong><small>${esc(item.relativePath)}</small></span><time>${relativeTime(item.updatedAt)}</time></button>`).join("") || `<div class="artifact-empty"><strong>${L("此流程还没有文档", "No documents for this workflow")}</strong></div>`;
    document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="preview-overlay"><section class="preview-panel stage-artifact-panel"><div class="preview-head"><div><span class="source-pill">${L("流程文档", "WORKFLOW DOCUMENTS")}</span><h2>${esc(displayWorkflowName(workflow))}</h2><p>${workflowArtifacts.length} Markdown</p></div><button class="icon-btn" data-action="close-workflow-artifacts">×</button></div><div class="artifact-document-list stage-artifact-list">${rows}</div></section></div>`);
  }
  const selectedStep = workflow.steps.find((item) => item.id === ui.previewArtifactStepId);
  if (selectedStep) {
    const stageArtifacts = artifacts.filter((item) => item.workflowId === workflow.id && item.stepId === selectedStep.id);
    const rows = stageArtifacts.map((item) => `<button class="artifact-document-row" data-preview-artifact="${esc(item.id)}"><span class="artifact-md-icon">MD</span><span><strong>${esc(item.name)}</strong><small>${esc(item.relativePath)}</small></span><time>${relativeTime(item.updatedAt)}</time></button>`).join("") || `<div class="artifact-empty"><strong>${L("此阶段还没有文档", "No documents for this stage")}</strong><p>${L("该阶段生成的 Plan、设计说明和总结会显示在这里。", "Plans, design notes, and summaries generated in this stage will appear here.")}</p></div>`;
    document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="preview-overlay"><section class="preview-panel stage-artifact-panel"><div class="preview-head"><div><span class="source-pill">${L("阶段文档", "STAGE DOCUMENTS")}</span><h2>${esc(displayStepName(selectedStep))}</h2><p>${stageArtifacts.length} Markdown</p></div><button class="icon-btn" data-action="close-stage-artifacts">×</button></div><div class="artifact-document-list stage-artifact-list">${rows}</div></section></div>`);
  }
  const selected = artifacts.find((item) => item.id === ui.previewArtifactId);
  if (selected) document.getElementById("root").insertAdjacentHTML("beforeend", `<div class="preview-overlay"><section class="preview-panel"><div class="preview-head"><div><span class="source-pill">MARKDOWN</span><h2>${esc(selected.name)}</h2><p>${esc(selected.relativePath)} · ${relativeTime(selected.updatedAt)}</p></div><button class="icon-btn" data-action="close-artifact-preview">×</button></div><div class="preview-content">${miniMarkdown(selected.content)}</div></section></div>`);
}
function enhanceResizableLayouts() {
  const layouts = [[".feedback-workspace", "feedback", 220], [".git-page", "git", 225], [".stage-change-sections", "stageChanges", 380]];
  for (const [selector, id, fallback] of layouts) {
    const layout = document.querySelector(selector);
    if (!layout || layout.children.length < 2) continue;
    layout.classList.add("resizable-split");
    layout.style.setProperty("--split-left", `${ui.splitSizes[id] || fallback}px`);
    const handle = document.createElement("div");
    handle.className = "split-handle";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = L("拖动调整两侧宽度", "Drag to resize panes");
    layout.insertBefore(handle, layout.children[1]);
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const bounds = layout.getBoundingClientRect();
      const move = (moveEvent) => {
        const width = Math.max(140, Math.min(bounds.width - 260, moveEvent.clientX - bounds.left));
        ui.splitSizes[id] = Math.round(width);
        layout.style.setProperty("--split-left", `${ui.splitSizes[id]}px`);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", () => { handle.removeEventListener("pointermove", move); vscode.setState({ ...(vscode.getState() || {}), splitSizes: ui.splitSizes }); }, { once: true });
    });
  }
}

function enhanceSelectMenus(scope = document) {
  scope.querySelectorAll("select:not(.native-select)").forEach((select) => {
    select.classList.add("native-select");
    const selected = select.options[select.selectedIndex] || select.options[0];
    const menu = document.createElement("details");
    menu.className = `custom-select${select.disabled ? " disabled" : ""}`;
    menu.innerHTML = `<summary><span>${esc(selected?.textContent || "")}</span><i>⌄</i></summary><div class="custom-select-menu">${[...select.options].map((option) => `<button type="button" data-select-value="${esc(option.value)}" class="${option.selected ? "selected" : ""}" ${option.disabled ? "disabled" : ""}><span>${esc(option.textContent || "")}</span>${option.selected ? "<b>✓</b>" : ""}</button>`).join("")}</div>`;
    select.insertAdjacentElement("afterend", menu);
    if (select.disabled) menu.querySelector("summary")?.addEventListener("click", (event) => event.preventDefault());
    menu.querySelectorAll("[data-select-value]").forEach((button) => button.addEventListener("click", () => {
      select.value = button.dataset.selectValue;
      const label = button.querySelector("span")?.textContent || "";
      const summaryLabel = menu.querySelector("summary span");
      if (summaryLabel) summaryLabel.textContent = label;
      menu.querySelectorAll("[data-select-value]").forEach((option) => {
        const active = option === button;
        option.classList.toggle("selected", active);
        option.querySelector("b")?.remove();
        if (active) option.insertAdjacentHTML("beforeend", "<b>✓</b>");
      });
      menu.removeAttribute("open");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }));
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll("details.custom-select[open], details.workflow-manage[open]").forEach((other) => { if (other !== menu) other.removeAttribute("open"); });
    });
  });
}

document.addEventListener("click", (event) => {
  const activeMenu = event.target.closest?.("details.custom-select, details.workflow-manage");
  document.querySelectorAll("details.custom-select[open], details.workflow-manage[open]").forEach((menu) => {
    if (menu !== activeMenu) menu.removeAttribute("open");
  });
});

function welcomeInline() {
  return shell(`${pageHeader(L("研发流程", "Workflows"), esc(ui.workspace))}<div class="content-wrapper"><section class="welcome-inline"><div class="welcome-mark">D</div><h2>${L("初始化 Daedalus", "Initialize Daedalus")}</h2><p>${L("当前 Workspace 尚未初始化。", "This Workspace is not initialized yet.")}</p><button class="btn-primary" data-action="do-initialize">${L("初始化当前 Workspace", "Initialize this Workspace")}</button></section></div>`);
}
function uninitializedPlaceholder(title, subtitle) {
  return shell(`${pageHeader(title, subtitle)}<div class="content-wrapper"><section class="empty-state"><h2>${L("Workspace 尚未初始化", "Workspace not initialized")}</h2><p>${L("请先在工作台页面完成初始化，此页面将自动加载内容。", "Initialize the Workspace from the Workbench first. This page will load automatically.")}</p><button class="btn-secondary" data-view="workflow">${L("前往工作台", "Go to Workbench")}</button></section></div>`);
}
function render() {
  if (!ui.initialized) {
    if (ui.view === "settings" || ui.view === "feedback") {
      document.getElementById("root").innerHTML = (ui.view === "settings" ? settingsView : feedbackView)();
      if (ui.view === "settings") enhanceThemeControl();
      enhanceSelectMenus();
      bindEvents();
      return;
    }
    const uninitViews = {
      workflow: () => welcomeInline(),
      standards: () => uninitializedPlaceholder(L("规范库", "Standards"), L("项目开发使用的 Agents、Skills 与 Rules", "Agents, Skills, and Rules used by project workflows")),
      knowledge: () => uninitializedPlaceholder(L("知识库", "Knowledge"), L("Agent 可检索的当前项目与全局知识", "Current-project and global knowledge searchable by the Agent")),
      git: () => uninitializedPlaceholder(L("变更", "Changes"), L("查看当前工作区的文件变化", "View file changes in the current workspace")),
      settings: () => settingsView(),
      feedback: () => feedbackView(),
    };
    document.getElementById("root").innerHTML = (uninitViews[ui.view] || uninitViews.workflow)();
    document.querySelector("[data-action='do-initialize']")?.addEventListener("click", (event) => { event.currentTarget.disabled = true; event.currentTarget.textContent = L("正在初始化…", "Initializing…"); vscode.postMessage({ type: "initialize_workspace" }); });
    document.querySelectorAll("[data-view]").forEach((el) => el.addEventListener("click", () => { ui.view = el.dataset.view; render(); }));
    document.querySelectorAll("[data-action='toggle-sidebar']").forEach((el) => el.addEventListener("click", () => { ui.sidebarCollapsed = !ui.sidebarCollapsed; vscode.setState({ ...(vscode.getState() || {}), sidebarCollapsed: ui.sidebarCollapsed }); render(); }));
    return;
  }
  const views = { workflow: workflowView, standards: libraryView, knowledge: knowledgeView, git: gitView, feedback: feedbackView, settings: settingsView }; document.getElementById("root").innerHTML = (views[ui.view] || workflowView)(); enhanceThemeControl(); enhanceArtifactOutputControl(); enhanceModuleImports(); enhanceAgentWorkbench(); enhanceResizableLayouts(); enhanceSelectMenus(); bindEvents();
}
function showSimple(mode) {
  const modal = document.getElementById("simple-modal");
  const workflow = activeWorkflow();
  const editing = mode === "edit-workflow";
  modal.classList.remove("hidden");
  modal.querySelector('[name="mode"]').value = mode;
  modal.querySelector('[name="id"]').value = editing ? workflow?.id || "" : "";
  modal.querySelector('[name="name"]').value = editing ? workflow?.name || "" : "";
  modal.querySelector('[name="description"]').value = editing ? workflow?.description || "" : "";
  const workflowMode = editing || mode === "workflow";
  modal.querySelector(".workflow-description-field").classList.toggle("hidden", !workflowMode);
  modal.querySelector(".workflow-agent-field")?.remove();
  if (workflowMode) {
    const agents = ui.library.filter((item) => item.kind === "agent");
    modal.querySelector(".workflow-description-field").insertAdjacentHTML("afterend", `<label class="workflow-agent-field">${L("执行 Agent", "Execution Agent")}<select name="agentId"><option value="">${L("未选择", "Not selected")}</option>${agents.map((item) => `<option value="${esc(item.id)}" ${editing && workflow?.agentId === item.id ? "selected" : ""}>${esc(displayItemName(item))}</option>`).join("")}</select><small>${L("Agent 来自规范库，可在规范库中导入。", "Agents come from the Standards library and can be imported there.")}</small></label>`);
    enhanceSelectMenus(modal);
  }
  modal.querySelector("#simple-title").textContent = editing ? L("编辑研发流程", "Edit workflow") : mode === "workflow" ? L("新建研发流程", "Create workflow") : L("添加流程步骤", "Add workflow step");
  modal.querySelector("#simple-help").textContent = editing ? L("修改流程名称和说明。", "Update the workflow name and description.") : mode === "workflow" ? L("创建后可逐步绑定规范。", "Bind standards to each step after creation.") : L("新步骤会添加到当前流程末尾。", "The new step is added to the end of the workflow.");
  modal.querySelector('[name="name"]').focus();
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((element) => element.addEventListener("click", () => { ui.view = element.dataset.view; ui.editingStep = null; ui.editingKnowledge = null; ui.libraryKind = null; if (ui.view === "workflow" && ui.conversationSignal && !ui.conversationSignal.acknowledgedAt) vscode.postMessage({ type: "acknowledge_conversation_signal" }); render(); }));
  document.querySelectorAll("[data-library-tab]").forEach((element) => element.addEventListener("click", () => { ui.libraryTab = element.dataset.libraryTab; ui.libraryKind = null; ui.previewLibraryId = null; render(); }));
  document.querySelectorAll("[data-knowledge-scope]").forEach((element) => element.addEventListener("click", () => { ui.knowledgeScope = element.dataset.knowledgeScope; ui.previewKnowledgeId = null; render(); }));
  document.getElementById("library-search")?.addEventListener("input", (event) => { if (event.isComposing) return; ui.librarySearch = event.target.value; render(); const input = document.getElementById("library-search"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); });
  document.getElementById("knowledge-search")?.addEventListener("input", (event) => { if (event.isComposing) return; ui.knowledgeSearch = event.target.value; render(); const input = document.getElementById("knowledge-search"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); });
  document.querySelectorAll("[data-add-knowledge]").forEach((element) => element.addEventListener("click", () => { ui.editingKnowledge = "new"; render(); }));
  document.querySelectorAll("[data-action='link-knowledge-dir']").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "link_knowledge_directory", scope: ui.knowledgeScope === "global" ? "global" : "project" })));
  document.querySelectorAll("[data-unlink-dir]").forEach((element) => element.addEventListener("click", () => { if (confirm(L("确定取消关联此目录？已关联的知识条目将不再显示。", "Unlink this directory? Linked knowledge entries will no longer be shown."))) vscode.postMessage({ type: "unlink_knowledge_directory", id: element.dataset.unlinkDir }); }));
  document.querySelectorAll("[data-open-linked-knowledge]").forEach((element) => element.addEventListener("click", (event) => { event.stopPropagation(); vscode.postMessage({ type: "open_file", path: element.dataset.openLinkedKnowledge }); }));
  document.querySelectorAll("[data-edit-knowledge]").forEach((element) => element.addEventListener("click", (event) => { event.stopPropagation(); ui.previewKnowledgeId = null; ui.editingKnowledge = element.dataset.editKnowledge; render(); }));
  document.querySelectorAll("[data-preview-knowledge]").forEach((element) => element.addEventListener("click", () => { ui.previewKnowledgeId = ui.previewKnowledgeId === element.dataset.previewKnowledge ? null : element.dataset.previewKnowledge; render(); }));
  document.querySelectorAll("[data-preview-artifact]").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "open_artifact_preview", id: element.dataset.previewArtifact })));
  document.querySelectorAll("[data-stage-artifacts]").forEach((element) => element.addEventListener("click", () => { ui.previewArtifactId = null; ui.previewArtifactStepId = element.dataset.stageArtifacts; render(); }));
  document.querySelectorAll("[data-workflow-artifacts]").forEach((element) => element.addEventListener("click", () => { ui.previewArtifactId = null; ui.previewWorkflowArtifacts = true; render(); }));
  document.querySelectorAll("[data-stage-changes]").forEach((element) => element.addEventListener("click", () => { ui.previewStageChanges = true; render(); }));
  document.querySelectorAll("[data-all-artifacts]").forEach((element) => element.addEventListener("click", () => { ui.previewArtifactId = null; ui.previewArtifactStepId = null; ui.previewStageChanges = false; ui.previewAllArtifacts = true; render(); }));
  document.getElementById("workflow-select")?.addEventListener("change", (event) => vscode.postMessage({ type: "select_workflow", id: event.target.value }));
  document.querySelectorAll("[data-edit-step]").forEach((element) => element.addEventListener("click", () => { ui.editingStep = element.dataset.editStep; render(); }));
  document.querySelectorAll("[data-revert-step]").forEach((element) => element.addEventListener("click", () => { if (confirm(L("确定回退到此步骤吗？之后的完成记录将被清除。", "Revert to this step? Completion records after it will be cleared."))) vscode.postMessage({ type: "revert_step", workflowId: activeWorkflow()?.id, stepId: element.dataset.revertStep }); }));
  document.querySelectorAll("[data-execute-step]").forEach((element) => element.addEventListener("click", () => { if (confirm(L("确定执行此阶段吗？之前未完成的阶段将标记为跳过，此阶段及之后的完成记录会清除。", "Execute this stage? Earlier unfinished stages will be marked as skipped, and completion records from this stage onward will be cleared."))) vscode.postMessage({ type: "execute_step", workflowId: activeWorkflow()?.id, stepId: element.dataset.executeStep }); }));
  document.querySelectorAll("[data-pick-workflow-input]").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "pick_workflow_input_file", workflowId: activeWorkflow()?.id, inputId: element.dataset.pickWorkflowInput })));
  document.querySelectorAll("[data-add-library]").forEach((element) => element.addEventListener("click", () => { ui.libraryKind = element.dataset.addLibrary; render(); }));
  document.querySelectorAll("[data-show-import]").forEach((element) => element.addEventListener("click", () => { ui.importTarget = element.dataset.showImport; ui.importMode = "local"; render(); }));
  document.querySelectorAll("[data-import-mode]").forEach((element) => element.addEventListener("click", () => { ui.importMode = element.dataset.importMode; render(); }));
  document.querySelectorAll("[data-import-local]").forEach((element) => element.addEventListener("click", () => { const modal = document.getElementById("import-modal"); vscode.postMessage({ type: "import_local_markdown", target: element.dataset.importLocal, scope: modal?.querySelector('[name="scope"]')?.value || "project", kind: modal?.querySelector('[name="kind"]')?.value || "skill" }); }));
  document.querySelectorAll("[data-open-import-source]").forEach((element) => element.addEventListener("click", (event) => { if (event.target.closest("[data-update-import], [data-delete-import]")) return; event.stopPropagation(); vscode.postMessage({ type: "open_import_source", id: element.dataset.openImportSource, scope: element.dataset.importScope }); }));
  document.querySelectorAll("[data-open-item]").forEach((element) => element.addEventListener("click", (event) => { event.stopPropagation(); vscode.postMessage({ type: "open_item", id: element.dataset.openItem }); }));
  document.querySelectorAll("[data-preview-item]").forEach((element) => element.addEventListener("click", () => { ui.previewLibraryId = ui.previewLibraryId === element.dataset.previewItem ? null : element.dataset.previewItem; render(); }));
  document.querySelectorAll("[data-repo-root]").forEach((element) => element.addEventListener("click", () => { ui.activeRepoRoot = element.dataset.repoRoot; render(); }));
  document.querySelectorAll("[data-git-file]").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "git_open_diff", repoRoot: ui.activeRepoRoot, path: element.dataset.gitFile })));
  document.querySelectorAll("[data-stage-git-file]").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "git_open_diff", repoRoot: element.dataset.stageGitRoot, path: element.dataset.stageGitFile })));
  document.querySelectorAll("[data-git-check]").forEach((element) => element.addEventListener("change", () => { const selected = ui.gitSelection[ui.activeRepoRoot]; if (element.checked) selected.add(element.dataset.gitCheck); else selected.delete(element.dataset.gitCheck); render(); }));
  document.getElementById("git-check-all")?.addEventListener("change", (event) => { const repo = ui.git.find((item) => item.root === ui.activeRepoRoot); ui.gitSelection[ui.activeRepoRoot] = event.target.checked ? new Set(repo.files.map((file) => file.path)) : new Set(); render(); });
  document.getElementById("git-commit-message")?.addEventListener("input", (event) => { ui.commitDrafts[ui.activeRepoRoot] = event.target.value; });
  document.getElementById("git-amend")?.addEventListener("change", (event) => { ui.amendByRepo[ui.activeRepoRoot] = event.target.checked; });
  document.querySelectorAll("[data-commit-mode]").forEach((element) => element.addEventListener("click", () => { const repoRoot = ui.activeRepoRoot; vscode.postMessage({ type: "git_commit", repoRoot, paths: [...ui.gitSelection[repoRoot]], message: document.getElementById("git-commit-message")?.value || "", amend: Boolean(document.getElementById("git-amend")?.checked), push: element.dataset.commitMode === "push" }); element.disabled = true; element.textContent = element.dataset.commitMode === "push" ? L("提交并推送中…", "Committing and pushing…") : L("提交中…", "Committing…"); }));
  document.querySelectorAll("[data-gate]").forEach((element) => element.addEventListener("click", () => vscode.postMessage({ type: "resolve_gate", id: element.dataset.gate, decision: element.dataset.decision, response: document.getElementById(`response-${element.dataset.gate}`)?.value || "" })));
  document.querySelectorAll("[data-send-feedback]").forEach((element) => element.addEventListener("click", () => { const input = document.getElementById("standalone-feedback-message"); const content = input?.value.trim() || ""; if (!content) return; element.disabled = true; if (input) input.disabled = true; vscode.postMessage({ type: "send_feedback_message", id: element.dataset.sendFeedback, content }); }));
  document.querySelectorAll("[data-select-gate]").forEach((element) => element.addEventListener("click", () => { ui.selectedGateId = element.dataset.selectGate; render(); }));
  document.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", () => {
    const action = element.dataset.action;
    if (action === "toggle-sidebar") {
      ui.sidebarCollapsed = !ui.sidebarCollapsed;
      vscode.setState({ ...(vscode.getState() || {}), sidebarCollapsed: ui.sidebarCollapsed, splitSizes: ui.splitSizes });
      render();
    }
    if (action === "show-add-workflow") showSimple("workflow");
    if (action === "show-add-step") showSimple("step");
    if (action === "execute-agent") vscode.postMessage({ type: "execute_current_step" });
    if (action === "stop-agent") vscode.postMessage({ type: "stop_current_step" });
    if (action === "advance-from-signal") vscode.postMessage({ type: "advance_from_signal" });
    if (action === "acknowledge-signal") vscode.postMessage({ type: "acknowledge_conversation_signal" });
    if (action === "edit-workflow") showSimple("edit-workflow");
    if (action === "delete-workflow" && confirm(L(`确定删除流程“${activeWorkflow()?.name || ""}”吗？`, `Delete workflow “${activeWorkflow()?.name || ""}”?`))) vscode.postMessage({ type: "delete_workflow", id: activeWorkflow()?.id });
    if (action === "reset-workflow" && confirm(L("确定重置流程吗？所有步骤将回到初始状态。", "Reset the workflow? All steps will return to their initial state."))) vscode.postMessage({ type: "reset_workflow", workflowId: activeWorkflow()?.id });
    if (action === "set-active-workflow") vscode.postMessage({ type: "select_workflow", id: element.dataset.workflowId });
    if (action === "delete-step" && confirm(L("确定删除这个流程步骤吗？", "Delete this workflow step?"))) { vscode.postMessage({ type: "delete_step", workflowId: activeWorkflow()?.id, stepId: ui.editingStep }); ui.editingStep = null; }
    if (action === "close-modal") document.getElementById("simple-modal")?.classList.add("hidden");
    if (action === "move-step-up") { vscode.postMessage({ type: "move_step", workflowId: activeWorkflow()?.id, stepId: ui.editingStep, direction: "up" }); }
    if (action === "move-step-down") { vscode.postMessage({ type: "move_step", workflowId: activeWorkflow()?.id, stepId: ui.editingStep, direction: "down" }); }
    if (action === "close-step") { ui.editingStep = null; render(); }
    if (action === "close-preview") { ui.previewLibraryId = null; render(); }
    if (action === "close-library") { ui.libraryKind = null; render(); }
    if (action === "close-import") { ui.importTarget = null; render(); }
    if (action === "close-knowledge") { ui.editingKnowledge = null; render(); }
    if (action === "cancel-inline-knowledge") { ui.editingKnowledge = null; render(); }
    if (action === "close-knowledge-preview") { ui.previewKnowledgeId = null; render(); }
    if (action === "close-artifact-preview") { ui.previewArtifactId = null; render(); }
    if (action === "close-stage-artifacts") { ui.previewArtifactStepId = null; render(); }
    if (action === "close-workflow-artifacts") { ui.previewWorkflowArtifacts = false; render(); }
    if (action === "close-all-artifacts") { ui.previewAllArtifacts = false; render(); }
    if (action === "close-stage-changes") { ui.previewStageChanges = false; render(); }
    if (action === "show-advance") document.getElementById("advance-modal")?.classList.remove("hidden");
    if (action === "close-advance") document.getElementById("advance-modal")?.classList.add("hidden");
    if (action === "open-config") vscode.postMessage({ type: "open_config" });
    if (action === "show-cleanup-workspace") { ui.maintenanceAction = "cleanup"; render(); }
    if (action === "show-uninstall-daedalus") { ui.maintenanceAction = "uninstall"; render(); }
    if (action === "show-new-feedback") { ui.newFeedbackConversation = true; render(); }
    if (action === "close-new-feedback") { ui.newFeedbackConversation = false; render(); }
    if (action === "close-maintenance") { ui.maintenanceAction = null; render(); }
    if (action === "git-refresh") vscode.postMessage({ type: "git_refresh" });
  }));
  document.getElementById("simple-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const mode = form.get("mode"); if (mode === "edit-workflow") vscode.postMessage({ type: "update_workflow", id: form.get("id"), name: form.get("name"), description: form.get("description"), agentId: form.get("agentId") }); else if (mode === "workflow") vscode.postMessage({ type: "add_workflow", name: form.get("name"), description: form.get("description"), agentId: form.get("agentId") }); else vscode.postMessage({ type: "add_step", name: form.get("name") }); });
  document.getElementById("workflow-inputs-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const inputs = Object.fromEntries((activeWorkflow()?.inputs || []).map((input) => [input.id, String(form.get(input.id) || "").trim()])); vscode.postMessage({ type: "save_workflow_inputs", workflowId: activeWorkflow()?.id, inputs }); });
  document.getElementById("step-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); vscode.postMessage({ type: "save_step", workflowId: activeWorkflow().id, stepId: form.get("stepId"), name: form.get("name"), description: form.get("description"), skillIds: form.getAll("skills"), ruleIds: form.getAll("rules"), knowledgeIds: form.getAll("knowledge"), standards: String(form.get("standards") || "").split("\n") }); ui.editingStep = null; });
  document.getElementById("advance-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); vscode.postMessage({ type: "advance_workflow", summary: form.get("summary") }); });
  document.getElementById("library-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); vscode.postMessage({ type: "create_library_item", kind: form.get("kind"), scope: form.get("scope"), name: form.get("name"), description: form.get("description"), content: form.get("content") }); ui.libraryKind = null; });
  document.getElementById("knowledge-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); vscode.postMessage({ type: "save_knowledge", id: form.get("id"), scope: form.get("scope") || ui.knowledge.find((item) => item.id === form.get("id"))?.scope, name: form.get("name"), description: form.get("description"), content: form.get("content") }); ui.editingKnowledge = null; });
  document.querySelector("[data-knowledge-inline-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); vscode.postMessage({ type: "save_knowledge", id: form.get("id"), scope: form.get("scope"), name: form.get("name"), description: form.get("description"), content: form.get("content") }); ui.editingKnowledge = null; });
  document.getElementById("language-setting")?.addEventListener("change", (event) => {
    const language = event.target.value;
    ui.preferences.languageSetting = language;
    if (language !== "auto") ui.preferences.language = language;
    render();
    vscode.postMessage({ type: "update_language", language });
  });
  document.getElementById("new-feedback-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const button = event.currentTarget.querySelector('button[type="submit"]'); if (button) { button.disabled = true; button.textContent = L("正在发送…", "Sending…"); } vscode.postMessage({ type: "create_feedback_conversation", content: form.get("content") }); ui.newFeedbackConversation = false; });
  document.getElementById("theme-setting")?.addEventListener("change", (event) => { ui.preferences.themeSetting = event.target.value; applyTheme(); vscode.postMessage({ type: "update_theme", theme: event.target.value }); });
  document.getElementById("artifact-output-mode")?.addEventListener("change", (event) => { const git = event.target.value === "git"; document.querySelectorAll(".artifact-git-field").forEach((field) => field.classList.toggle("hidden", !git)); const directory = document.querySelector('#artifact-output-form input[name="directory"]'); if (directory && (directory.value === ".daedalus/artifacts" || directory.value === "daedalus")) directory.value = git ? "daedalus" : ".daedalus/artifacts"; });
  document.getElementById("artifact-output-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const button = event.currentTarget.querySelector("button"); button.disabled = true; button.textContent = L("保存中…", "Saving…"); vscode.postMessage({ type: "update_artifact_output", mode: form.get("mode"), directory: form.get("directory"), repositoryUrl: form.get("repositoryUrl"), ref: form.get("ref") }); });
  document.getElementById("feedback-enabled")?.addEventListener("change", (event) => { event.target.disabled = true; vscode.postMessage({ type: "update_feedback", enabled: event.target.checked }); });
  document.getElementById("continuous-feedback-enabled")?.addEventListener("change", (event) => { event.target.disabled = true; vscode.postMessage({ type: "update_continuous_feedback", enabled: event.target.checked }); });
  document.getElementById("auto-execute-enabled")?.addEventListener("change", (event) => { event.target.disabled = true; vscode.postMessage({ type: "update_auto_execute", enabled: event.target.checked }); });
  const maintenanceForm = document.getElementById("maintenance-form");
  maintenanceForm?.querySelector('[name="confirmation"]')?.addEventListener("input", (event) => { maintenanceForm.querySelector('button[type="submit"]')?.toggleAttribute("disabled", event.target.value !== event.target.dataset.confirmValue); });
  maintenanceForm?.addEventListener("submit", (event) => { event.preventDefault(); const input = event.currentTarget.querySelector('[name="confirmation"]'); if (input.value !== input.dataset.confirmValue) return; const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = L("正在处理…", "Working…"); vscode.postMessage({ type: event.currentTarget.dataset.maintenanceAction === "uninstall" ? "uninstall_daedalus" : "cleanup_workspace" }); });
  document.querySelectorAll("[data-import-form]").forEach((element) => element.addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const button = event.currentTarget.querySelector("button"); button.disabled = true; button.textContent = L("正在克隆…", "Cloning…"); vscode.postMessage({ type: "import_git", target: event.currentTarget.dataset.target, scope: form.get("scope"), url: form.get("url"), ref: form.get("ref"), subpath: form.get("subpath") }); }));
  document.querySelectorAll("[data-update-import]").forEach((element) => element.addEventListener("click", () => { element.disabled = true; element.textContent = L("更新中…", "Pulling…"); vscode.postMessage({ type: "update_import", id: element.dataset.updateImport, scope: element.dataset.importScope }); }));
  document.querySelectorAll("[data-delete-import]").forEach((element) => element.addEventListener("click", () => { if (confirm(L("确定删除此导入仓库吗？", "Remove this imported repository?"))) vscode.postMessage({ type: "delete_import", id: element.dataset.deleteImport, scope: element.dataset.importScope }); }));
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "not_initialized") {
    ui.initialized = false;
    ui.workspace = event.data.workspace || "";
    if (event.data.config) ui.config = event.data.config;
    if (event.data.state) ui.state = event.data.state;
    if (event.data.version) ui.version = event.data.version;
    if (event.data.preferences) ui.preferences = event.data.preferences;
    applyTheme(); render(); return;
  }
  if (event.data?.type === "operation_error") { render(); return; }
  if (event.data?.type === "git_commit_success") {
    ui.commitDrafts[event.data.repoRoot] = "";
    ui.amendByRepo[event.data.repoRoot] = false;
    render();
    return;
  }
  if (event.data?.type !== "state") return;
  ui.initialized = true;
  const nextGit = event.data.git || [];
  const previousPending = new Set((ui.state.gates || []).filter((gate) => gate.status === "pending").map((gate) => gate.id));
  for (const repository of nextGit) {
    const currentPaths = new Set(repository.kind === "local" ? [] : repository.files.map((file) => file.path));
    const previous = ui.gitSelection[repository.root];
    if (!previous) ui.gitSelection[repository.root] = new Set(currentPaths);
    else {
      for (const value of previous) if (!currentPaths.has(value)) previous.delete(value);
      const oldRepo = ui.git.find((item) => item.root === repository.root);
      const oldPaths = new Set(oldRepo?.kind === "local" ? [] : (oldRepo?.files || []).map((file) => file.path));
      for (const value of currentPaths) if (!oldPaths.has(value)) previous.add(value);
    }
  }
  Object.assign(ui, event.data);
  const newlyPending = (ui.state.gates || []).find((gate) => gate.origin !== "user" && gate.status === "pending" && !previousPending.has(gate.id));
  if (newlyPending && ui.config.settings?.feedbackEnabled) { ui.view = "feedback"; ui.selectedGateId = newlyPending.id; }
  applyTheme();
  if (!ui.activeRepoRoot || !nextGit.some((item) => item.root === ui.activeRepoRoot)) ui.activeRepoRoot = nextGit[0]?.root || null;
  render();
});
vscode.postMessage({ type: "ready" });
setTimeout(() => { if (!ui.initialized && !document.getElementById("root")?.children.length) render(); }, 800);
