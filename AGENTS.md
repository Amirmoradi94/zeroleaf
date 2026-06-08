<claude-mem-context>
# Memory Context

# [overleaf-clone] recent context, 2026-06-08 1:31pm EDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (18,947t read) | 635,564t work | 97% savings

### Jun 7, 2026
6951 2:48p ✅ Project Directory Created and Senior-Architect Skill Installation Initiated
6952 " 🟣 senior-architect Skill Installed into Overleaf Clone Project
6953 " 🔵 senior-architect Skill Installed at .claude/skills/senior-architect/ Not development/ Subdirectory
6954 " 🟣 brainstorming Skill Installed into Overleaf Clone Project
6955 2:49p 🟣 senior-frontend Skill Installed with React/Next.js Tooling
6956 " 🔵 brainstorming Skill Enforces Design-First Workflow Before Any Implementation
6957 2:51p 🔵 AGENTS.md Exists at Project Root — Codex Configuration File
6958 2:52p 🔵 senior-architect Reference Docs Are Generic Placeholder Content
6959 " 🔵 Codex SDK Confirmed as Programmatic Integration Path for AI Agent in Overleaf Clone
6960 " 🔵 Codex Custom Model Provider Auth via env_key Enables Anthropic Integration
6961 " ✅ docs/architecture/ Directory Created — Project Moving from Research to Documentation Phase
6962 " ⚖️ Full System Architecture Document Written for AI-Powered Desktop LaTeX Editor
6963 2:56p ✅ docs/design/ Directory Created — UI/UX Design Documentation Layer Added
7024 7:12p 🔵 Overleaf Clone Project — Phase 1 Complete, Phase 2 Starting
7025 " 🟣 Phase 2 IPC Contracts Expanded with Full Project and File Management Types
7026 " 🟣 Phase 2 IPC Contracts Expanded for Project and File Management
7027 " 🟣 ProjectService Implementation: Root-Scoped File Operations and Recent Projects
7028 7:16p 🟣 ProjectService Integration Test Suite Added
7029 " ✅ Desktop App Wired to Project Service Package
7030 " 🟣 Electron Main Process Wired with Phase 2 IPC Handlers and FSWatcher
7031 " 🟣 Preload Bridge Extended with Project and File Namespaces
7032 7:17p 🔴 Preload onChanged Type Fixed and desktopApi Fallback Extended
7033 " 🟣 Phase 2: Project Management API Wired into Desktop Renderer
7034 " 🔄 ProjectSidebar, FileRow, and EditorPane Replaced with Live Data-Driven Components
7035 7:18p 🔵 overleaf-clone Tech Stack Confirmed from package-lock.json
7036 7:20p 🔴 Project Callbacks Converted to void-Returning to Match Component Prop Types
7037 " 🟣 Utility Helpers and Open Project Command Enabled
7038 " 🟣 Phase 2 CSS Added for File Tree, Recent Projects, and Editor Empty States
7039 " 🟣 Cmd+O Keyboard Shortcut Wired to Open Project
7040 " 🔴 TypeScript Errors Found and Fixed in Electron Main Process
7041 " 🔵 Phase 2 Plan Status: Steps 1-2 Complete, Step 3 In Progress, Step 4 Pending
7042 7:21p 🔴 Remaining TypeScript Errors Fixed: IpcResponseMap Import and OpenDialogOptions Typing
7043 " 🔵 ESLint Error: Unsafe any Assignment in project-service Test at Line 86
7044 " 🟣 Phase 2 Build, Tests, and Lint All Pass — Full CI Green
7045 7:22p 🔵 No Git History: Entire Repo Is Untracked
7046 " 🟣 projectMoveEntry IPC Channel Added to ipc-contracts
7047 " 🔵 apply_patch Failed on project-service/index.ts Due to Prettier Reformatting
7048 " 🔴 moveProjectEntry Patch Split to Work Around apply_patch Context Mismatch
7049 7:23p 🟣 moveProjectEntry Implementation and Tests Completed in project-service
7050 " 🟣 moveEntry Wired Through All Three Electron Layers
7051 " 🔵 App.tsx Patch Failure: Prettier Collapsed useCallback Arrow Forms
7052 7:24p 🟣 moveActiveFile Callback and onMoveActiveFile Prop Wired in Renderer
7053 " 🟣 Move File Button Added to Sidebar Toolbar — moveEntry UI Fully Wired
7054 " ✅ Phase 2 Marked Complete in Development Plan — All Checks Green
7055 " 🟣 projectSetMainFile IPC Channel Added to ipc-contracts
7056 7:25p 🔵 project-service setProjectMainFile Patch Failed — recordProjectOpened Context Mismatch
7057 " 🟣 ProjectMetadataStore Extended with Per-Project Settings and setProjectMainFile
7058 7:26p 🟣 setProjectMainFile Fully Implemented: Service, Helper Guards, and Main IPC Handler
7059 " 🟣 setMainFile Wired Through Preload, Fallback, and Renderer — EditorPane Receives mainFilePath and onSetMainFile
7060 " 🟣 EditorPane "Set Main" Button and Persistence Test Added for setProjectMainFile

Access 636k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>

# Project Guidance

## Product Direction

This repository is for a local-first desktop LaTeX editor with an integrated AI
agent that can safely inspect, edit, compile, and verify project files. The
target experience is a professional light-only scholarly IDE: avoid dark style
patterns, dark IDE frames, dark panels, and dark-mode-first visual language.

## Architecture Rules

- Use the documented architecture in `docs/architecture/system-architecture.md`.
- Keep the renderer UI-only. It must not access the filesystem, shell, provider
  credentials, or arbitrary OS APIs directly.
- Route renderer actions through typed IPC contracts in `packages/ipc-contracts`.
- Keep local project/file logic in service packages, not in React components.
- Keep AI provider logic behind the provider-neutral agent interface.
- The agent may access the current project root by default, not all user
  projects or arbitrary folders.
- Agent edits must be patch-first, reviewable, snapshot-backed, and reversible.
- Network access, shell escape, outside-root writes, and destructive operations
  require explicit approval or are blocked.

## Repository Layout

- `apps/desktop`: Electron desktop app entry points and renderer shell.
- `packages/core-domain`: shared domain types and pure logic.
- `packages/ipc-contracts`: typed IPC channel and payload contracts.
- `packages/project-service`: project roots, file tree, safe reads/writes.
- `packages/latex-service`: `latexmk`, logs, diagnostics, build jobs.
- `packages/pdf-service`: PDF artifacts, PDF.js/SyncTeX service contracts.
- `packages/reference-service`: `.bib`, citation, and reference workflows.
- `packages/history-service`: snapshots, patches, changesets, rollback.
- `packages/agent-host`: agent process protocol, sessions, tool broker.
- `packages/provider-openai-codex`: Codex adapter only.
- `packages/provider-anthropic-claude`: Claude adapter only.
- `packages/security`: permission, risk, path, and approval helpers.
- `packages/ui`: shared light-only UI tokens and reusable UI pieces.

## Commands

Use these root commands unless a task has more specific verification:

```bash
npm run lint
npm run test
npm run build
npm run format:check
```

For local development:

```bash
npm run dev
```

`npm run dev` is a Phase 0 placeholder until the Electron shell is implemented.

## Implementation Priorities

Follow `docs/development/trackable-development-plan.md`.

The critical vertical slice is:

1. Open local LaTeX project.
2. Open and edit `main.tex`.
3. Compile with `latexmk`.
4. View PDF.
5. Show diagnostics/logs.
6. Ask agent to fix one compile error.
7. Review proposed diff.
8. Apply patch.
9. Recompile and show verified result.

Do not add deferred features such as dark mode, full visual editing, cloud sync,
real-time collaboration, unrestricted shell agents, or autonomous network-enabled
agent operation unless the roadmap is explicitly changed.
