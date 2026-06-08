# Changelog

## 0.0.0-alpha.1 - 2026-06-08

- Added the local-first Electron LaTeX workbench.
- Added project open, file tree, source editing, search, save, and layout state.
- Added `latexmk` compilation, diagnostics, logs, PDF preview, and SyncTeX hooks.
- Added snapshots, changesets, diff review, apply/reject, and rollback.
- Added patch-first agent workflows through mock, Codex CLI, and Claude Code providers.
- Added bibliography parsing, citation search, missing/unused citation detection, and citation insertion.
- Added templates, source ZIP import/export, PDF export, and submission checks.
- Added private-alpha readiness and pilot gates with real LaTeX compiles and real installed CLI agent scenarios.
- Added macOS private-alpha packaging and tester handoff docs.

Known limitations:

- macOS package is unsigned and not notarized.
- Windows/Linux packages are deferred.
- Provider behavior depends on local CLI installation and subscription login state.
- Renderer bundle currently has a non-blocking large chunk warning.
