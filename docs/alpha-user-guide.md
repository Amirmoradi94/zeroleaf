# Alpha User Guide

## Requirements

- macOS for the current alpha build.
- Node.js 20.19 or newer for source builds.
- A TeX distribution with `latexmk` and `pdflatex`.
- Optional: installed and logged-in Codex CLI or Claude Code CLI for real provider
  agent runs.

## Run From Source

```bash
npm install
npm run build
npm run dev
```

## Open and Compile

1. Open a local LaTeX project folder.
2. Select a `.tex` file in the project tree.
3. Mark the intended root file as main if needed.
4. Use Compile Project.
5. Read diagnostics in Problems and logs in Log.

## Agent Modes

- Read-only: the agent can inspect local project context but cannot propose edits.
- Suggest: the agent can create reviewable changesets.
- Apply with review: the agent can request approval to apply a changeset.
- Autonomous local: reserved for future scoped local automation.

Codex and Claude use the installed CLI login on the computer. The app does not
ask for API keys.

## Templates, Import, and Export

- Use Template to create Article, Report, Thesis, Beamer, or CV projects.
- Use Import ZIP for Overleaf/source ZIP projects.
- Use Export source ZIP to save source without generated build/cache output.
- Use Save PDF after a successful compile to choose a PDF destination.

## Submission Check

Use Check Submission Bundle before sharing a project. The local checker warns
about missing graphics, missing bibliography files, generated artifacts, and main
file issues. Use Agent Submission Checklist to seed the agent with those findings.

## Local Data

Settings and history are stored in the app profile. Privacy settings show the
local data location and can clear stored history/audit rows.
