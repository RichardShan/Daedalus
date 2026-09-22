# 参考插件代码分析

分析对象：`vchat-pipeline-orchestrator-1.0.0` 发布目录。该目录没有原始 `src` 和前端工程，但 `dist/extension.cjs.map` 含 71 份 `sourcesContent`，因此可以确认扩展宿主的大部分真实模块结构；前端由打包后的 React 代码与 CSS 反向梳理。

## 系统结构

参考版本不是单一的 VS Code 面板，而是四层组合：

1. VS Code/Cursor Extension：生命周期、命令、Webview、文件监听与 Git 操作。
2. Webview UI：React 状态界面，使用 VS Code 主题变量适配明暗主题。
3. MCP Server / Gate CLI：供 AI Agent 创建流水线、上报阶段完成、请求人工反馈。
4. 本地状态与文件 IPC：流水线状态、门禁请求和响应通过本地文件完成跨进程通信。

扩展宿主主要模块包括：

- `extension.ts`：激活、命令注册、文件监听和首次使用流程。
- `pipeline-manager.ts` / `pipeline-unit.ts`：连接 Gate、状态与面板。
- `state-manager.ts`：聚合流水线、项目、知识库、配置和 Git 状态后推送给 Webview。
- `gate-watcher.ts`：监听反馈、阶段完成、模块完成等 Gate 文件。
- `action-router.ts` + `handlers/*`：按 Webview 消息类型拆分行为。
- `pipeline-store.ts` / `phase-config-loader.ts`：流水线数据和动态阶段模板。
- `git-manager.ts` / `vscode-git-adapter.ts`：分支、暂存、提交、推送和 Diff。
- `version/*` / `auto-updater.ts`：远程版本探测、影子仓库和自动更新。

## UI 设计规律

- 左侧固定窄导航，右侧为内容区；页面标题栏固定在顶部。
- 导航顺序为工程化、反馈交流、Git 控制、知识库、模板、本地测试、设置、关于。
- 主视觉尽量复用编辑器主题变量，不强制一套独立明暗色。
- 内容以低对比度卡片、细边框、6–9px 圆角和紧凑字号组织。
- 状态通过强调色、成功色、警告色和错误色统一表达。
- 反馈页既是 Gate 操作区也是对话历史；工程化页同时承担流水线列表、创建和阶段进度。
- 原版前端体积约 4.9 MB，并包含 Markdown、代码高亮、图表等较重依赖。

## 简化版取舍

| 参考能力 | 首版处理 | 原因 |
| --- | --- | --- |
| Workspace 初始化开关 | 新增并强化 | 未初始化项目不得吊起或执行规范 |
| 流程配置、选择、阶段推进 | 保留并重构 | 每一步显式绑定 Skills、Rules 和标准要求 |
| MCP 上下文、推进、反馈门禁 | 保留并重构 | Agent 执行前获取完整步骤规范 |
| 左侧导航、卡片、阶段轨道、主题适配 | 保留 | 保持整体设计语言 |
| 内置与自定义 Skills / Rules | 新增 | 形成 Workspace 级规范库 |
| Git 规范仓库导入 | 新增 | 支持团队复用规范资产 |
| 当前项目与全局知识库 | 新增 | 当前项目资料隔离，同时复用组织级知识 |
| GitLab 文档与 Token | 移除 | 强组织耦合且原包存在明文默认 Token |
| 自动升级、影子仓库 | 移除 | 安装维护复杂、风险高 |
| 微服务 Mesh / Redis / 自动化测试面板 | 移除 | 非通用核心能力 |
| 复杂模板、知识库、图片与图表渲染 | 暂缓 | 显著增加前端体积和协议复杂度 |

## 新版本映射

- `src/extension.ts`：显式初始化、面板生命周期、规范管理、Git 导入和 MCP 配置生成。
- `src/mcp-server.ts`：Workspace 状态、步骤上下文、流程推进与反馈门禁。
- `src/shared.ts`：配置/进度模型、内置规范、规范扫描和原子状态写入。
- `media/webview.js`：无框架 Webview，降低运行时和构建复杂度。
- `media/webview.css`：复用参考版本的布局语言，并使用 VS Code 主题变量。
- `.daedalus/config.json`：Workspace 是否启用以及流程绑定关系的唯一配置源。
- `.daedalus/state.json`：独立保存运行进度和门禁，避免污染规范配置。
