<claude-mem-context>
# Memory Context

# [overleaf-clone] recent context, 2026-06-20 12:11am EDT

No previous sessions found.
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

## Testing Rules

- Do not use smoke tests as acceptance evidence for agent-panel behavior.
- Do not use mock agent providers, mock data, or simulated provider responses as
  proof that the agent workflow works.
- Agent-panel verification must use real project files, real LaTeX toolchain
  execution, and the connected Codex provider path.
- Codex must be connected before Codex-provider agent tests are considered valid.
  Verify with the app/provider auth path, not only by checking that the `codex`
  binary exists.

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
