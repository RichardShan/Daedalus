# Daedalus Workspace Governance

Daedalus 是一个面向 Cursor / VS Code 的 Workspace 级项目开发全流程规范工具。它把流程、Skills、Rules、标准化要求和 Agent 运行上下文隔离在每个 Workspace 中。

## 激活原则

- 未发现 `.daedalus/config.json` 时，不自动打开面板，也不运行规范流程。
- 用户必须显式执行 `Daedalus: Initialize Current Workspace`。
- 初始化完成后，该 Workspace 才会获得默认 Skills、Rules、流程配置和 MCP 上下文。
- 不同 Workspace 的配置、状态和导入仓库互不共享。

## 主要能力

- 内置需求澄清、技术设计、增量实现、测试验收 Skills
- 内置 Workspace 边界、安全变更、证据优先 Rules
- 内置 3 个 Cursor Agents、9 个 Skills、1 个持续反馈 Rule 及其参考资料
- 创建自定义 Skill 和 Rule
- 从 Git 仓库导入 `SKILL.md`、Rules `.md/.mdc`
- Git 导入可指定分支/Tag，以及仓库内目录或单个文件路径；未指定路径时扫描整个仓库
- 在统一“规范库”页面通过 Skills / Rules Tab 管理规范
- 直接创建和编辑 Markdown 知识条目
- 当前项目知识库仅属于当前 Workspace，全局知识库可供所有已初始化 Workspace 使用
- 从 Git 仓库导入当前项目或全局知识库
- 自动发现当前 Workspace 下的多个 Git 仓库并按项目目录分组
- 点击变更文件，在 Cursor 原生 Git Diff 中对比
- 按文件勾选提交，支持 Amend、Commit 和 Commit and Push
- 创建研发流程与步骤
- 以 Agent 工作台呈现当前流程、阶段、上下文和下一步行动
- 将 Agent 生成的总结、Plan、设计说明等 Markdown 文档保存到 Workspace 目录，或绑定 Git 仓库及仓库内目录
- 默认提供“标准研发流程”“用例驱动对齐”和“代码 Review”三套流程
- 测试用例流程要求先提供 URL、截图路径/地址或文字内容，未提供时不会推进
- 流程与步骤均可新增、编辑或删除
- 为每个步骤绑定 Skills、Rules 和标准化要求
- Agent 通过 MCP 获取当前步骤的完整执行上下文
- 流程推进与 Agent 协作请求
- 初始化时安装 Daedalus 核心 MCP；工作台可直接启动 Cursor Agent 执行当前阶段，并由 MCP 回写产物和阶段报告
- “反馈交流”按 Workspace 可选启用；开关仅控制 Agent 的反馈/审批请求能力与入口，不影响核心工作台 MCP
- 通过 Cursor `afterAgentResponse` Hook 监控 Agent 回复，检测到可能进入下一流程步骤时在“研发流程”图标显示红点
- 中英文界面可在设置中切换，默认跟随 Cursor / VS Code 的界面语言
- 浅色、深色与高对比度外观自动跟随 Cursor / VS Code 当前主题

## Workspace 数据结构

```text
.daedalus/
├── config.json        # 流程、步骤绑定和 Git 来源
├── state.json         # 当前进度和协作请求
├── skills/            # 内置与自定义 Skills
├── rules/             # 内置与自定义 Rules
├── agents/            # 内置 Cursor Agents
├── scripts/           # Cursor 对话流程监控脚本
├── imports/           # Skills / Rules Git 导入仓库
├── knowledge/         # 当前项目直接编辑知识
└── knowledge-imports/ # 当前项目知识库 Git 导入
```

全局知识及其 Git 来源保存在扩展的 `globalStorageUri` 中，不会写进某个项目目录。初始化时安装的 Workspace MCP 会同时获得该全局目录路径。

## 开发运行

```bash
npm install
npm run build
npm test
```

在 Cursor / VS Code 中打开本目录，按 `F5` 启动 `Run Daedalus Extension`。

1. 在 Extension Host 中打开一个测试 Workspace。
2. 执行 `Daedalus: Initialize Current Workspace`。
3. 执行 `Daedalus: Open Workspace Governance Panel`。
4. 在工作台点击“执行当前阶段”，插件会直接启动 Cursor Agent CLI，并通过 Workspace MCP 注入当前 Agent、Skills、Rules、知识和标准化要求。
5. Agent 完成后会回写 `ready`、`continue` 或 `blocked`；`ready` 由用户在工作台确认后才推进下一阶段。
6. 如需将阶段对话统一路由到插件内，在“设置”中开启“Feedback”。

“执行当前阶段”需要本机可用且已登录的 Cursor Agent CLI。默认自动查找 `cursor-agent` 与 `~/.local/bin/cursor-agent`；特殊安装位置可通过 `daedalus.cursorAgentPath` 指定。

阶段交互根据“Feedback”配置自动路由：开启时，Cursor Agent 通过 `request_feedback` 在同一个 Daedalus 阶段会话中进行多轮交流；关闭时，工作台创建可恢复的 Cursor Agent 会话、直接提交当前阶段任务，并按 session ID 打开对应的 Cursor 原生对话，不经过复制或预填 Prompt。`runId → workflowId → stepId → Cursor sessionId` 会持久化，因此暂停或重启后仍能从同一阶段会话继续。

“持续反馈”是独立设置：启用时，原生 Cursor 对话在每个实质工作循环后必须通过 AskQuestion 等待用户确认；关闭时是否提问由 Cursor 当前启用的 Rules 和任务本身决定。无论是否启用，Agent 只会上报 `ready`、`continue` 或 `blocked` 建议，不会自动推进流程。

反馈开关严格隔离在当前 Workspace：项目 Rule、MCP 配置和 Hooks 都写入当前项目目录；`request_feedback` 还会校验 MCP Client Roots。开启后，如果 Agent 仍在原生回复中直接提问，`afterAgentResponse` 与 `stop` Hooks 会将问题转入当前项目的反馈线程并让 Agent 等待；关闭后 Hook 不创建反馈，MCP 也拒绝请求。其他 Cursor Window 或不包含当前 Workspace Root 的对话不能吊起该项目的反馈交流。

## MCP 工具

- `workspace_status`：读取 Workspace 流程、规范库、进度和待处理协作请求。
- `workflow_context`：取得当前步骤上下文、已安装 Skills/Rules 的引用、绑定知识条目和标准化要求。
- `workflow_report`：以 `ready`、`continue` 或 `blocked` 回写阶段状态、摘要和证据。
- 流程推进只允许由用户在工作台确认；MCP 仅通过 `workflow_report` 回写继续、受阻或完成建议。
- `request_feedback`：向当前 Workspace 的用户请求反馈或审批。
- `knowledge_search`：检索当前项目、全局或全部知识库并返回相关 Markdown。

未初始化 Workspace 调用 MCP 时会明确拒绝执行，而不会隐式创建配置。

## 变更与提交

“变更”页面优先展示当前 Workspace 中各 Git 仓库的实时未提交变化。Daedalus 生成的总结、Plan 和设计文档不会计入这里。每个仓库拥有独立的文件选择和 Commit Message：

- 未跟踪、新增、修改、删除和重命名文件使用不同状态标记。
- 点击文件名调用 Cursor 的原生 Git 对比命令；未跟踪文件直接打开编辑器。
- 提交命令使用 Git 路径限定，只提交勾选文件，不会消耗未勾选的暂存改动。
- `Commit and Push` 仅在 Commit 成功后执行 `git push`。
- 如果 Workspace 中没有 Git 仓库，Daedalus 会以本地记录模式保存文件的创建、修改与删除记录；初始化 Git 后自动切换为 Git 未提交变更。

参考插件的结构分析和简化取舍见 [docs/reference-analysis.md](docs/reference-analysis.md)。
