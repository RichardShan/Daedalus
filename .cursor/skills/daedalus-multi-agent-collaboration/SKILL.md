---
name: multi-agent-collaboration
description: "多 Agent 协作模式指南。用于任务拆分、并行调查、跨 Agent 审查等协作场景。"
---

# 多 Agent 协作

## 协作模式

### A. 派遣-等待

主会话派遣专职 Agent，等结果后继续。**用于**可以隔离的独立工作包。

```
主会话 → 派遣 implementation → 等待结果 → 继续
```

### B. 调研-实现

研究 Agent 收集信息写入文件，实现 Agent 读取后执行。**用于**需要大量前期探索的任务。

```
主会话 → 派遣 research → 读输出 → 派遣 implementation
```

### C. 实现-审查

实现 Agent 写代码，质量审查 Agent 检查并修复。**用于**代码质量要求高的场景。

```
主会话 → 派遣 implementation → 派遣 quality-review → 合并修复
```

### D. 并行调查

多个研究任务并行执行。**用于**独立问题可以同时回答的场景。

## Agent 选择

| 需要 | 选择 |
|------|------|
| 写或改代码 | `daedalus-implementation` |
| 审查并修复代码 | `daedalus-quality-review` |
| 探索代码库、调研方案 | `daedalus-research` |

## 派遣规则

1. **上下文要充分** — 当前阶段、验收标准、相关规范文件路径
2. **范围要明确** — 做什么和不做什么
3. **禁止递归** — 子 Agent 不能再派遣同类子 Agent
4. **单一职责** — 一个 dispatch 做一件事

## 不适用于

- 单个 Agent 一次搞定的简单任务
- 需要实时来回对话的任务（直接在主会话中做）
- 用 Agent 派遣替代普通工具调用
