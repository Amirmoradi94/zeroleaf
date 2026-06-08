# MVP Security Review

Date: 2026-06-08

## Scope

This review covers the private-alpha desktop MVP: local project access, typed IPC,
LaTeX compilation, PDF reading, history storage, settings, source export/import,
and agent patch workflows.

## Decisions

- Renderer code remains UI-only. It does not read the filesystem, execute shell
  commands, or access provider credentials directly.
- Filesystem access is routed through service packages and typed IPC.
- Project operations are rooted to the selected project directory.
- Agent edits are patch-first and history-backed.
- Codex and Claude use installed local CLI login state. The app stores no provider
  API keys or subscription credentials.
- Shell escape is disabled in app settings and is not passed to `latexmk`.
- Network tools are blocked by default and must remain approval-gated before any
  implementation.
- Browser windows deny new-window creation and run with `nodeIntegration: false`,
  `contextIsolation: true`, and `sandbox: true`.

## Reviewed Surfaces

| Surface                    | Status | Notes                                                                   |
| -------------------------- | ------ | ----------------------------------------------------------------------- |
| Renderer filesystem access | Pass   | No direct `fs` or shell access in renderer.                             |
| IPC contracts              | Pass   | Project, build, history, lifecycle, settings, and agent APIs are typed. |
| Project path handling      | Pass   | Service methods validate roots and reject outside-root paths.           |
| LaTeX compile              | Pass   | Uses `latexmk` without shell escape.                                    |
| Agent tools                | Pass   | Provider-local model calls are not exposed as broker tools.             |
| Credentials                | Pass   | External CLI login only; no secrets persisted in app settings.          |
| Export/import              | Pass   | ZIP import normalizes paths and rejects traversal.                      |
| Privacy controls           | Pass   | User can inspect and clear local history/audit data.                    |

## Follow-Up Before Public Beta

- Add OS-native signing/notarization to packaging.
- Add explicit approval UI before any future network-enabled agent tool.
- Add a dependency audit gate to release CI.
- Add a destructive-operation confirmation policy for bulk deletes and imports.
