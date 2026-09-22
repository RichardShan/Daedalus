---
name: agent-configuration
description: "Understand and customize the local Daedalus architecture inside a user project. Use when modifying .daedalus/ configuration, agents, skills, rules, workflow settings, spec structure, or knowledge management."
---

# Daedalus Agent Configuration

This skill is for understanding the Daedalus Workspace architecture and customizing it for a specific project. After reading it, an AI should understand the Daedalus architecture, operating model, and customization entry points, then modify the relevant files according to the user's request.

## Daedalus Architecture Overview

Daedalus manages a VS Code / Cursor Workspace through the following directories:

- **`.daedalus/`** — Workspace configuration, state, specs, knowledge, artifacts, and scripts
- **`.cursor/skills/`** — Cursor-native skill definitions (installed by Daedalus)
- **`.cursor/rules/`** — Cursor-native rule definitions (installed by Daedalus)
- **`.cursor/agents/`** — Cursor-native agent definitions (installed by Daedalus)

### Core Files

| File | Purpose |
|------|---------|
| `.daedalus/config.json` | Workspace configuration: workflows, steps, imports, settings |
| `.daedalus/state.json` | Runtime state: progress, completed steps, gates |
| `.daedalus/spec/` | Project-specific coding conventions and design constraints |
| `.daedalus/knowledge/` | Knowledge base entries (markdown files) |
| `.daedalus/artifacts/` | Agent-generated documents (stage outputs) |
| `.daedalus/scripts/` | Hook scripts (conversation-monitor, feedback-resume, session-bind) |

## How To Use

1. **Read `.daedalus/config.json`** to understand the current workspace configuration.
2. **Identify the customization target** from the table below.
3. **Read the relevant files** before making changes.
4. **Treat local content as authoritative** — do not assume defaults when actual files exist.

## Customization Targets

### Workflow Configuration

Workflows are defined in `.daedalus/config.json` under `workflows[]`. Each workflow has:

- `id`, `name`, `description` — identity and metadata
- `steps[]` — ordered workflow stages, each with `skillIds`, `ruleIds`, `knowledgeIds`, and `standards`
- `inputs[]` — optional workflow inputs (text, URL, image)

To modify: Edit `.daedalus/config.json` directly or use the Daedalus Workbench UI.

### Agent, Skill, and Rule Management

Standards (skills, rules, agents) live in two locations:

| Scope | Location |
|-------|----------|
| Project | `.daedalus/skills/`, `.daedalus/rules/`, `.daedalus/agents/` |
| Global | `~/.daedalus/skills/`, `~/.daedalus/rules/`, `~/.daedalus/agents/` |

Daedalus syncs these to `.cursor/skills/`, `.cursor/rules/`, `.cursor/agents/` so Cursor can discover them.

### Spec System

`.daedalus/spec/` stores project-specific coding conventions:

```
.daedalus/spec/
├── <layer>/           # Per-layer standards (backend/, frontend/, etc.)
│   ├── index.md       # Overview with Pre-Development Checklist and Quality Check sections
│   └── *.md           # Topic-specific guidelines
└── guides/            # Thinking checklists
    ├── index.md
    └── *.md
```

Each spec file should contain concrete patterns, file paths, and examples from the real codebase.

### Knowledge Base

Knowledge entries in `.daedalus/knowledge/` are markdown files that can be bound to workflow steps. They provide context that agents read when executing a stage.

### Settings

Settings in `.daedalus/config.json` under `settings`:

| Key | Purpose |
|-----|---------|
| `feedbackEnabled` | Whether the Daedalus Feedback channel is active |
| `continuousFeedback` | Whether agents must ask end-of-cycle questions |
| `artifactOutput.mode` | `workspace` or `git` — where agent documents are saved |
| `artifactOutput.directory` | Output directory path |

### Hooks

Cursor hooks are defined in `.cursor/hooks.json`. Daedalus installs three hooks:

| Hook | Script | Trigger |
|------|--------|---------|
| `afterAgentResponse` | `conversation-monitor.cjs` | After each agent response |
| `stop` | `feedback-resume.cjs` | When agent stops |
| `beforeSubmitPrompt` | `session-bind.cjs` | Before each user prompt |

## Important Rules

- Do not modify `.cursor/skills/` or `.cursor/rules/` directly for Daedalus-managed resources — edit the source in `.daedalus/` and let Daedalus sync.
- Do not delete `.daedalus/config.json` — it is the workspace source of truth.
- Do not modify `.daedalus/scripts/` files — they are managed by the extension and will be overwritten on updates.
- Changes to `.daedalus/config.json` are automatically detected by the Daedalus extension and reflected in the UI.
