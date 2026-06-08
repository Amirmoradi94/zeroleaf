# Zeroleaf

Local-first desktop LaTeX editor with a patch-first AI agent workflow.

Zeroleaf is an alpha Electron app for opening local LaTeX projects, editing
source files, compiling with `latexmk`, previewing PDFs, inspecting diagnostics,
and asking installed local CLI agents such as Codex CLI or Claude Code to propose
reviewable fixes.

## Alpha Status

Current version: `0.0.0-alpha.1`

Private-alpha handoff docs live in `docs/release/`.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run alpha:readiness
npm run alpha:pilot
```

Package the macOS alpha artifact:

```bash
npm run package:mac:zip
```
