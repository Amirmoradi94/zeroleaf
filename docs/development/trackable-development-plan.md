# Trackable Development Plan

Date: 2026-06-07

## Purpose

This plan turns the product architecture, UI/UX system, and feature inventory into an implementation roadmap for the desktop AI-powered LaTeX editor.

The app is large, so development should proceed through vertical slices. Each phase must produce a usable workflow, not only isolated UI or backend code.

## Source Documents

- Architecture: `docs/architecture/system-architecture.md`
- UI/UX system: `docs/design/ui-ux-design-system.md`
- Feature inventory: `docs/product/app-feature-inventory.md`

## Global Product Constraints

- The interface is light-only. Do not implement dark mode or dark-style shells.
- The app is local-first. Project files remain normal files on disk.
- The renderer has no direct filesystem, shell, or credential access.
- All renderer-to-main communication uses typed IPC.
- Agent edits are patch-first and reviewable.
- Agent access is scoped to the current project root unless the user explicitly grants more context.
- LaTeX compilation and agent edits must be verifiable through logs, diagnostics, diffs, or PDF output.
- The MVP should avoid real-time collaboration, cloud sync, visual editing, and unrestricted shell agents.

## Status Legend

Use this status vocabulary in the tables:

- `Not Started`
- `In Progress`
- `Blocked`
- `Ready for Review`
- `Done`
- `Deferred`

## Release Milestones

| Milestone | Goal                                | Exit Criteria                                                                      | Target Status |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| M0        | Repo and desktop foundation         | App runs locally with secure Electron shell and light-only workbench frame.        | Done          |
| M1        | Local project editor                | User can open a project, browse files, edit `.tex`, save, and persist layout.      | Done          |
| M2        | Compile and PDF preview             | User can compile with `latexmk`, see diagnostics, logs, and rendered PDF.          | Done          |
| M3        | SyncTeX and diagnostics UX          | User can jump source/PDF, click diagnostics, and understand errors.                | Done          |
| M4        | History and diff safety             | User/agent changes can be snapshotted, diffed, accepted/rejected, and rolled back. | Done          |
| M5        | Mock agent workflow                 | Fake agent can propose/apply patches, run compile, and drive UI safely.            | Done          |
| M6        | Real Agent Host and Codex adapter   | Codex can inspect project, propose fixes, and verify compile through tool broker.  | Done          |
| M7        | Claude adapter                      | Claude works through the same provider interface and safety model.                 | Done          |
| M8        | Bibliography and citation workflows | `.bib` parsing, citation autocomplete/search, and citation agent actions work.     | Done          |
| M9        | MVP hardening                       | Settings, permissions, export, tests, accessibility, packaging, and docs complete. | Done          |
| M10       | Private alpha pilot                 | Packaged app and real Codex/Claude CLI project scenarios pass on local machine.    | Done          |
| M11       | Alpha release handoff               | Versioned tester artifact, handoff docs, and feedback loop are ready.              | Done          |

## Critical Vertical Slice

This is the first end-to-end workflow the project must prove:

1. Open local LaTeX project.
2. Open `main.tex`.
3. Edit and save.
4. Compile with `latexmk`.
5. View PDF.
6. Show diagnostics/logs.
7. Ask agent to fix one compile error.
8. Review proposed diff.
9. Apply patch.
10. Recompile and show verified result.

Do not expand into advanced features until this path works with a mock agent.

## Phase 0: Product and Engineering Foundation

Goal: create a stable implementation base with predictable tooling, process boundaries, and project conventions.

| ID   | Task                                           | Dependencies | Acceptance Criteria                                                                     | Status |
| ---- | ---------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | ------ |
| P0.1 | Initialize Git repository if absent            | None         | `git status` works and baseline docs are tracked.                                       | Done   |
| P0.2 | Choose package manager and workspace structure | None         | Monorepo layout matches architecture: `apps/desktop`, `packages/*`.                     | Done   |
| P0.3 | Configure TypeScript base settings             | P0.2         | Shared strict `tsconfig` available for app and packages.                                | Done   |
| P0.4 | Configure linting and formatting               | P0.2         | ESLint/Prettier or equivalent runs from root.                                           | Done   |
| P0.5 | Configure test framework                       | P0.2         | Unit test command runs with an example passing test.                                    | Done   |
| P0.6 | Configure app build scripts                    | P0.2         | Root scripts support dev, build, test, lint.                                            | Done   |
| P0.7 | Create architecture package boundaries         | P0.2         | Empty packages created for domain, IPC, services, agent host, providers, UI.            | Done   |
| P0.8 | Define coding conventions in `AGENTS.md`       | P0.1         | Persistent repo guidance includes commands, architecture rules, and light-only UI rule. | Done   |

Verification:

```bash
npm run lint
npm run test
npm run build
```

Phase exit gate:

- Tooling is repeatable from a clean checkout.
- No app code depends on undocumented global state.
- Repo guidance is written.

## Phase 1: Secure Desktop Shell and Light Workbench

Goal: ship the desktop frame and renderer/main/preload boundary.

| ID   | Task                              | Dependencies | Acceptance Criteria                                                                                    | Status |
| ---- | --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| P1.1 | Scaffold Electron app             | P0           | Desktop window launches in dev mode.                                                                   | Done   |
| P1.2 | Configure secure BrowserWindow    | P1.1         | `nodeIntegration: false`, `contextIsolation: true`, preload bridge enabled.                            | Done   |
| P1.3 | Create typed IPC contract package | P1.1         | Renderer can call a typed sample IPC method.                                                           | Done   |
| P1.4 | Build light-only app frame        | P1.1         | App has title bar, activity rail, sidebar region, editor region, PDF region, bottom panel, status bar. | Done   |
| P1.5 | Implement resizable panes         | P1.4         | Sidebar, editor/PDF split, agent area, and bottom panel can resize and persist dimensions.             | Done   |
| P1.6 | Add command palette shell         | P1.4         | Keyboard shortcut opens command palette with placeholder commands.                                     | Done   |
| P1.7 | Add settings dialog shell         | P1.4         | Settings opens with Editor, Compiler, AI Providers, Agent Permissions, Appearance, Privacy tabs.       | Done   |
| P1.8 | Add accessibility basics          | P1.4         | Icon buttons have labels/tooltips; focus ring visible; keyboard reaches major regions.                 | Done   |

Verification:

```bash
npm run dev
npm run lint
npm run test
```

Manual QA:

- Launch app.
- Resize panes.
- Open command palette.
- Open settings.
- Navigate with keyboard.
- Confirm no dark theme styling is present.

Phase exit gate:

- The app shell feels like the intended workbench.
- Renderer has no direct filesystem or shell access.

## Phase 2: Project Service and File Management

Goal: open and manage local LaTeX projects safely.

| ID    | Task                                | Dependencies | Acceptance Criteria                                                        | Status |
| ----- | ----------------------------------- | ------------ | -------------------------------------------------------------------------- | ------ |
| P2.1  | Implement project-open dialog       | P1.3         | User can choose a folder from native dialog.                               | Done   |
| P2.2  | Implement project root validation   | P2.1         | Service rejects invalid/non-readable roots and path traversal.             | Done   |
| P2.3  | Implement project metadata store    | P2.1         | Recent projects and project settings persist locally.                      | Done   |
| P2.4  | Build project file tree UI          | P2.1         | Files/folders render in sidebar with icons and selection.                  | Done   |
| P2.5  | Implement file read IPC             | P2.2         | Renderer can request file content only inside project root.                | Done   |
| P2.6  | Implement safe file write IPC       | P2.2         | Renderer can save edited file inside root; outside-root write is rejected. | Done   |
| P2.7  | Implement create/rename/move/delete | P2.6         | File tree actions update disk and UI.                                      | Done   |
| P2.8  | Implement file watcher              | P2.4         | External file changes update dirty/stale state.                            | Done   |
| P2.9  | Detect main `.tex` file             | P2.4         | Service finds likely main file and lets user override.                     | Done   |
| P2.10 | Build recent projects dashboard     | P2.3         | User can open recent project from dashboard.                               | Done   |

Verification:

```bash
npm run test -- project
npm run lint
```

Manual QA:

- Open valid project.
- Attempt outside-root file access and confirm rejection.
- Create/rename/delete a file.
- Modify a file externally and confirm UI notices.

Phase exit gate:

- Project and file operations are reliable and root-scoped.

## Phase 3: Monaco Source Editor

Goal: provide a serious LaTeX source editing surface.

| ID    | Task                                   | Dependencies | Acceptance Criteria                                | Status |
| ----- | -------------------------------------- | ------------ | -------------------------------------------------- | ------ |
| P3.1  | Integrate Monaco editor                | P2.5         | `.tex` file opens in editor.                       | Done   |
| P3.2  | Implement editor tabs                  | P3.1         | Multiple files open/close with dirty markers.      | Done   |
| P3.3  | Implement save and save-all            | P2.6, P3.2   | Dirty buffers save to disk and update status.      | Done   |
| P3.4  | Add find/replace                       | P3.1         | Current file search and replace works.             | Done   |
| P3.5  | Add project search UI                  | P2.4         | Search across project files and jump to results.   | Done   |
| P3.6  | Add LaTeX snippets                     | P3.1         | Common environments insert through snippets.       | Done   |
| P3.7  | Add basic LaTeX autocomplete           | P3.1         | Commands/environments autocomplete in `.tex`.      | Done   |
| P3.8  | Add outline extractor                  | P3.1         | Sections/subsections/labels show in outline panel. | Done   |
| P3.9  | Implement command palette file actions | P1.6, P3.2   | Quick open file and editor commands work.          | Done   |
| P3.10 | Persist editor layout state            | P2.3, P3.2   | Open tabs and active file restore per project.     | Done   |

Verification:

```bash
npm run test -- editor
npm run lint
```

Manual QA:

- Open multiple `.tex` files.
- Edit, save, close, reopen.
- Use quick open and command palette.
- Insert common environments.
- Use project search.

Phase exit gate:

- User can comfortably edit local LaTeX files without compilation yet.

## Phase 4: LaTeX Build Service and PDF Preview

Goal: compile a project and render output in the app.

| ID    | Task                            | Dependencies | Acceptance Criteria                                                      | Status |
| ----- | ------------------------------- | ------------ | ------------------------------------------------------------------------ | ------ |
| P4.1  | Detect TeX toolchain            | P2.3         | App detects `latexmk`, engines, and TeX path; shows missing setup state. | Done   |
| P4.2  | Implement build job model       | P2.3         | Build jobs have status, command, timestamps, artifacts, logs.            | Done   |
| P4.3  | Run `latexmk` safely            | P4.1, P4.2   | Service compiles current main file with timeout and output cap.          | Done   |
| P4.4  | Capture raw logs                | P4.3         | `.log` and process output are available to UI.                           | Done   |
| P4.5  | Implement diagnostics parser v1 | P4.4         | Errors/warnings parse into file/line/severity/message where possible.    | Done   |
| P4.6  | Build diagnostics panel         | P4.5         | Errors/warnings list with click-to-line.                                 | Done   |
| P4.7  | Integrate PDF.js preview        | P4.3         | Successful build renders PDF in preview pane.                            | Done   |
| P4.8  | Add PDF toolbar                 | P4.7         | Page nav, zoom, fit width/page, search, download.                        | Done   |
| P4.9  | Add stale PDF indicator         | P3.3, P4.7   | PDF shows stale/current relative to saved source.                        | Done   |
| P4.10 | Add stop build                  | P4.3         | Running compile can be cancelled and process tree killed.                | Done   |
| P4.11 | Add compiler settings           | P1.7, P4.1   | User can set engine, main file, shell escape disabled by default.        | Done   |

Verification:

```bash
npm run test -- latex
npm run test -- diagnostics
npm run lint
```

Manual QA:

- Compile valid sample article.
- Compile intentionally broken sample.
- Inspect logs.
- Click diagnostic to source line.
- Confirm shell escape is disabled.
- Confirm PDF stale state changes after edit.

Phase exit gate:

- The app can replace basic Overleaf editing/preview for a local project.

## Phase 5: SyncTeX and PDF-Aware Navigation

Goal: connect source and rendered output.

| ID   | Task                           | Dependencies | Acceptance Criteria                               | Status |
| ---- | ------------------------------ | ------------ | ------------------------------------------------- | ------ |
| P5.1 | Enable SyncTeX output          | P4.3         | Builds produce `.synctex.gz`.                     | Done   |
| P5.2 | Implement source-to-PDF lookup | P5.1         | Cursor line can jump to PDF page/position.        | Done   |
| P5.3 | Implement PDF-to-source lookup | P5.1, P4.7   | PDF click can jump to source file/line.           | Done   |
| P5.4 | Add SyncTeX UI controls        | P5.2, P5.3   | Divider/toolbar buttons trigger jumps.            | Done   |
| P5.5 | Add fallback states            | P5.2         | UI explains when SyncTeX is unavailable or stale. | Done   |

Verification:

```bash
npm run test -- synctex
npm run lint
```

Manual QA:

- Jump from section heading source to PDF.
- Jump from PDF paragraph to source.
- Edit/recompile and confirm mapping updates.

Phase exit gate:

- User can navigate between source and PDF reliably enough for daily writing.

## Phase 6: History, Snapshots, and Diff Review

Goal: build safety infrastructure before real agent writes.

| ID   | Task                          | Dependencies | Acceptance Criteria                                          | Status |
| ---- | ----------------------------- | ------------ | ------------------------------------------------------------ | ------ |
| P6.1 | Implement local SQLite app DB | P2.3         | DB stores projects, build jobs, sessions, changesets.        | Done   |
| P6.2 | Implement snapshot storage    | P6.1         | File snapshots are stored before risky operations.           | Done   |
| P6.3 | Implement changeset model     | P6.1, P6.2   | Patches have ID, summary, status, base snapshot, timestamps. | Done   |
| P6.4 | Implement patch generation    | P3.3, P6.3   | Service can diff file before/after into patch.               | Done   |
| P6.5 | Build diff viewer             | P6.4         | Inline/split diff UI displays changed files and hunks.       | Done   |
| P6.6 | Implement accept/reject hunk  | P6.5         | User can apply or reject individual hunks.                   | Done   |
| P6.7 | Implement rollback changeset  | P6.3         | Applied changeset can be reverted.                           | Done   |
| P6.8 | Add changeset list panel      | P6.3         | User can browse local changesets.                            | Done   |
| P6.9 | Add audit log basics          | P6.1         | Edit/apply/revert events are recorded.                       | Done   |

Verification:

```bash
npm run test -- history
npm run test -- diff
npm run lint
```

Manual QA:

- Edit file and snapshot.
- Generate diff.
- Accept/reject hunk.
- Roll back changeset.

Phase exit gate:

- The app can safely review and recover from automated edits.

## Phase 7: Mock Agent Vertical Slice

Goal: validate agent UX and safety without provider complexity.

| ID    | Task                                  | Dependencies | Acceptance Criteria                                                                  | Status |
| ----- | ------------------------------------- | ------------ | ------------------------------------------------------------------------------------ | ------ |
| P7.1  | Define `AgentProvider` interface      | P6.3         | Provider interface supports auth, session, message stream, cancel.                   | Done   |
| P7.2  | Define normalized `AgentEvent` schema | P7.1         | Events include message, tool call, patch, approval, verification, error.             | Done   |
| P7.3  | Build Agent Panel UI                  | P1.4         | Panel has provider picker, mode selector, composer, context chips.                   | Done   |
| P7.4  | Build tool-call timeline UI           | P7.3         | Read/search/edit/compile actions render as compact cards.                            | Done   |
| P7.5  | Build approval request UI             | P7.3         | Risky action card supports allow/deny.                                               | Done   |
| P7.6  | Implement mock provider               | P7.1         | Mock agent streams deterministic events and patch proposals.                         | Done   |
| P7.7  | Implement tool broker v1              | P6.3         | Tools expose read/search/propose patch/apply patch/run compile through app services. | Done   |
| P7.8  | Add selection-based AI actions        | P3.1, P7.3   | `Cmd/Ctrl+I` and context menu open agent task with selected text.                    | Done   |
| P7.9  | Add diagnostics "Fix with AI" action  | P4.6, P7.3   | Diagnostic can launch mock repair flow.                                              | Done   |
| P7.10 | Complete mock compile-fix loop        | P4, P6, P7.6 | Mock agent proposes patch, user accepts, app applies, recompiles, reports result.    | Done   |

Verification:

```bash
npm run test -- agent
npm run test -- ipc
npm run lint
```

Manual QA:

- Select text and ask mock agent to rewrite.
- Run mock diagnostic fix.
- Review diff.
- Apply patch.
- Recompile.
- Roll back.

Phase exit gate:

- The full agent workflow is proven with deterministic behavior.

## Phase 8: Agent Host Process and Tool Broker Hardening

Goal: isolate real provider SDKs and enforce permissions.

| ID   | Task                               | Dependencies | Acceptance Criteria                                                    | Status |
| ---- | ---------------------------------- | ------------ | ---------------------------------------------------------------------- | ------ |
| P8.1 | Create Agent Host process package  | P7.1         | Separate Node process starts/stops under main process supervision.     | Done   |
| P8.2 | Define Agent Host protocol         | P8.1         | Main and Agent Host communicate with typed messages/events.            | Done   |
| P8.3 | Implement session lifecycle        | P8.2         | Start, resume, cancel, fail, complete session states work.             | Done   |
| P8.4 | Move mock provider into Agent Host | P8.1, P7.6   | Mock provider works through host process.                              | Done   |
| P8.5 | Implement permission modes         | P7.7         | Read-only, Suggest, Apply with Review, Autonomous Local Loop enforced. | Done   |
| P8.6 | Implement tool allowlist           | P8.5         | Tools allowed/blocked by mode and risk level.                          | Done   |
| P8.7 | Implement approval routing         | P8.6         | Host pauses for UI approval on risky tool calls.                       | Done   |
| P8.8 | Implement audit event persistence  | P6.9, P8.2   | Tool calls, approvals, patches, compile verification are stored.       | Done   |
| P8.9 | Add crash recovery                 | P8.1         | Host crash does not corrupt files; UI shows recoverable state.         | Done   |

Verification:

```bash
npm run test -- agent-host
npm run test -- permissions
npm run lint
```

Manual QA:

- Start/cancel agent task.
- Deny risky approval.
- Crash/restart Agent Host during task.
- Confirm changesets remain recoverable.

Phase exit gate:

- Real providers can be added without changing core UI/service contracts.

## Phase 9: OpenAI Codex Adapter

Goal: connect Codex to the internal agent platform.

| ID   | Task                                 | Dependencies | Acceptance Criteria                                                       | Status |
| ---- | ------------------------------------ | ------------ | ------------------------------------------------------------------------- | ------ |
| P9.1 | Add Codex provider package           | P8.1         | Adapter package compiles and implements `AgentProvider`.                  | Done   |
| P9.2 | Implement Codex auth status          | P9.1         | UI shows connected/disconnected/needs login/error.                        | Done   |
| P9.3 | Implement Codex session start/resume | P9.1, P8.3   | Provider can start and continue project-scoped sessions.                  | Done   |
| P9.4 | Map Codex events to `AgentEvent`     | P9.3         | Messages, tool calls, patches, and errors appear in Agent Panel.          | Done   |
| P9.5 | Connect Codex to tool broker         | P9.4, P8.6   | Codex can read/search/propose patch/run compile only via approved tools.  | Done   |
| P9.6 | Implement Codex compile-fix workflow | P9.5         | Codex can fix a sample LaTeX compile error with review and verification.  | Done   |
| P9.7 | Add Codex fallback path              | P9.1         | `codex exec --json` fallback works for one-shot tasks if SDK unavailable. | Done   |
| P9.8 | Add Codex provider settings          | P1.7, P9.2   | Settings UI shows auth, default mode, and provider notes.                 | Done   |

Verification:

```bash
npm run test -- provider-openai-codex
npm run test -- agent
npm run lint
```

Manual QA:

- Connect Codex.
- Ask project summary.
- Ask selected text rewrite.
- Ask compile error fix.
- Review diff and apply.
- Verify compile.

Phase exit gate:

- Codex can do useful project-scoped work safely.

## Phase 10: Anthropic Claude Adapter

Goal: connect Claude through the same provider-neutral platform.

| ID    | Task                                  | Dependencies | Acceptance Criteria                                                                | Status |
| ----- | ------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ------ |
| P10.1 | Add Claude provider package           | P8.1         | Adapter package compiles and implements `AgentProvider`.                           | Done   |
| P10.2 | Implement Claude Code CLI auth status | P10.1        | UI shows connected/disconnected/needs-login/error from local CLI auth.             | Done   |
| P10.3 | Implement Claude session start/resume | P10.1, P8.3  | Provider can run project-scoped sessions.                                          | Done   |
| P10.4 | Map Claude events to `AgentEvent`     | P10.3        | Messages, tool calls, patches, and errors appear in Agent Panel.                   | Done   |
| P10.5 | Connect Claude to tool broker         | P10.4, P8.6  | Claude can read/search/propose patch/run compile only via approved tools.          | Done   |
| P10.6 | Implement Claude compile-fix workflow | P10.5        | Claude can fix sample LaTeX compile error with review and verification.            | Done   |
| P10.7 | Add Claude provider settings          | P1.7, P10.2  | Settings UI shows auth, default mode, and provider limitations.                    | Done   |
| P10.8 | Add provider comparison harness       | P9, P10      | Same prompt can run against mock/Codex/Claude in test project and compare patches. | Done   |

Verification:

```bash
npm run test -- provider-anthropic-claude
npm run test -- agent
npm run compare:providers -- --providers=openai-codex,anthropic-claude
npm run lint
```

Manual QA:

- Sign in with Claude Code CLI.
- Ask selected text rewrite.
- Ask missing citation fix.
- Ask compile error fix.
- Verify permission prompts and diffs.

Phase exit gate:

- Codex and Claude both work through one UI and one safety model.

## Phase 11: Bibliography and Citation Workflows

Goal: make citation management useful without leaving the editor.

| ID    | Task                               | Dependencies | Acceptance Criteria                                                   | Status   |
| ----- | ---------------------------------- | ------------ | --------------------------------------------------------------------- | -------- |
| P11.1 | Implement `.bib` parser            | P2.5         | Parser extracts key, title, author, year, DOI, venue.                 | Done     |
| P11.2 | Build citation search panel        | P11.1        | User can search and preview bibliography entries.                     | Done     |
| P11.3 | Add citation autocomplete          | P3.7, P11.1  | Editor suggests citation keys in citation commands.                   | Done     |
| P11.4 | Detect missing citations           | P11.1, P4.5  | Missing keys show in diagnostics/reference panel.                     | Done     |
| P11.5 | Detect unused references           | P11.1        | Unused `.bib` entries list in reference panel.                        | Done     |
| P11.6 | Add insert citation action         | P11.2        | User can insert selected citation at cursor.                          | Done     |
| P11.7 | Add agent citation suggestion      | P8, P11.1    | Agent can suggest citation insertion using local `.bib`.              | Done     |
| P11.8 | Add missing citation repair        | P8, P11.4    | Agent can match likely `.bib` entry or ask for source.                | Done     |
| P11.9 | Add DOI/arXiv import with approval | P8.7, P11.1  | Network import requires approval and creates reviewable `.bib` patch. | Deferred |

Verification:

```bash
npm run test -- references
npm run test -- editor
npm run lint
```

Manual QA:

- Search `.bib`.
- Insert citation.
- Trigger autocomplete.
- Detect missing/unused references.
- Ask agent to fix missing citation.

Phase exit gate:

- Citation workflows cover the common academic writing loop.

## Phase 12: Settings, Permissions, and Privacy

Goal: expose critical controls without overwhelming users.

| ID    | Task                          | Dependencies | Acceptance Criteria                                                              | Status |
| ----- | ----------------------------- | ------------ | -------------------------------------------------------------------------------- | ------ |
| P12.1 | Persist editor preferences    | P1.7, P3     | Font, size, line height, minimap, autocomplete persist.                          | Done   |
| P12.2 | Persist compiler preferences  | P1.7, P4     | Engine, main file, TeX path, build profile persist.                              | Done   |
| P12.3 | Persist agent permissions     | P1.7, P8     | Mode, max turns, network policy, approval defaults persist.                      | Done   |
| P12.4 | Implement credential storage  | P9, P10      | Uses external Codex/Claude Code CLI login state; app stores no provider secrets. | Done   |
| P12.5 | Add privacy settings          | P6.9, P8.8   | User can inspect/clear logs, history, agent sessions.                            | Done   |
| P12.6 | Add keybindings reference     | P1.6         | Shortcuts are visible and searchable.                                            | Done   |
| P12.7 | Add light appearance settings | P1.4         | Density/accent/editor theme can change without dark styling.                     | Done   |
| P12.8 | Add high-contrast light mode  | P12.7        | High-contrast light theme passes contrast checks.                                | Done   |

Verification:

```bash
npm run test -- settings
npm run lint
```

Manual QA:

- Change editor setting and restart.
- Change compiler setting and compile.
- Change agent permission and verify enforcement.
- Disconnect provider and confirm secrets removed.

Phase exit gate:

- Users can control behavior, privacy, and agent autonomy.

## Phase 13: Export, Templates, and Submission Basics

Goal: support real project lifecycle workflows.

| ID    | Task                           | Dependencies | Acceptance Criteria                                                    | Status |
| ----- | ------------------------------ | ------------ | ---------------------------------------------------------------------- | ------ |
| P13.1 | Export source zip              | P2           | Project source exports excluding build/cache unless selected.          | Done   |
| P13.2 | Export PDF                     | P4.7         | Current PDF downloads/saves to selected destination.                   | Done   |
| P13.3 | Import Overleaf/source zip     | P2           | Zip imports safely into new project folder.                            | Done   |
| P13.4 | Add built-in templates         | P2.10        | Article/report/thesis/Beamer/CV templates create projects.             | Done   |
| P13.5 | Add arXiv bundle check         | P4, P11      | App warns about missing files, generated files, main file issues.      | Done   |
| P13.6 | Add agent submission checklist | P8, P13.5    | Agent can inspect project and produce checklist with actionable fixes. | Done   |

Verification:

```bash
npm run test -- export
npm run lint
```

Manual QA:

- Create project from template.
- Compile.
- Export PDF and source.
- Import zip.
- Run arXiv checklist on sample.

Phase exit gate:

- Users can start, work on, and export a realistic paper project.

## Phase 14: MVP Hardening and Quality Gates

Goal: make the MVP stable enough for private alpha.

| ID     | Task                                     | Dependencies    | Acceptance Criteria                                                             | Status |
| ------ | ---------------------------------------- | --------------- | ------------------------------------------------------------------------------- | ------ |
| P14.1  | Add sample test projects                 | P4              | Valid, broken, citation-heavy, figure-heavy, and thesis-like samples exist.     | Done   |
| P14.2  | Add integration tests for critical slice | P7-P11          | Tests cover open/edit/compile/agent patch/recompile.                            | Done   |
| P14.3  | Add renderer component tests             | P1-P13          | Workbench, dialogs, panels, agent UI tested.                                    | Done   |
| P14.4  | Add E2E smoke tests                      | P1-P13          | App launches and critical workflows run in automation.                          | Done   |
| P14.5  | Performance pass                         | P3-P11          | Large project/file tree/editor/PDF interactions are responsive.                 | Done   |
| P14.6  | Accessibility audit                      | P1-P13          | Keyboard navigation, labels, focus, and contrast pass.                          | Done   |
| P14.7  | Security review                          | P2, P4, P8, P12 | Filesystem, credentials, agent tools, shell escape, network approvals reviewed. | Done   |
| P14.8  | Packaging setup                          | P1              | macOS build package produced; Windows/Linux later if scoped.                    | Done   |
| P14.9  | Crash/error reporting policy             | P12             | Local-first privacy-respecting error logging defined.                           | Done   |
| P14.10 | Alpha user documentation                 | P13             | Docs cover install, TeX setup, project open, compile, agent modes.              | Done   |

Verification:

```bash
npm run lint
npm run test
npm run build
npm run e2e
```

Manual QA:

- Complete critical vertical slice on all sample projects.
- Try broken LaTeX examples.
- Try provider disconnect/reconnect.
- Try denied approvals.
- Try rollback after agent edit.
- Confirm no dark UI patterns.

Phase exit gate:

- App is ready for private alpha with known limitations documented.

## Phase 15: Private Alpha Pilot and Bug Triage

Goal: prove the packaged alpha build on real local workflows before handing it to testers.

| ID    | Task                                | Dependencies | Acceptance Criteria                                                                 | Status |
| ----- | ----------------------------------- | ------------ | ----------------------------------------------------------------------------------- | ------ |
| P15.1 | Smoke-launch packaged macOS app     | P14.8        | `release/mac/ZeroLeaf.app` starts without immediate process failure.                | Done   |
| P15.2 | Run real sample-project pilot       | P14          | Five realistic local project scenarios pass with real `latexmk` output.             | Done   |
| P15.3 | Run real Codex and Claude CLI flows | P9, P10      | Both installed CLIs repair a broken LaTeX project through the app agent host.       | Done   |
| P15.4 | Capture pilot report                | P15.2        | Machine-readable report records projects, artifacts, provider IDs, and PDF outputs. | Done   |
| P15.5 | Triage release blockers             | P15.4        | Bugs are documented or the release is marked ready for tester handoff.              | Done   |

Verification:

```bash
npm run package:mac
npm run alpha:pilot
```

Manual QA:

- Open packaged app.
- Open a real local project.
- Edit, save, compile, inspect PDF, and export.
- Ask Codex CLI and Claude Code to repair a compile error.
- Review/apply patch and recompile.

Phase exit gate:

- Private alpha can be shared with testers with a known pilot report and no blocking local failures.

## Phase 16: Alpha Release Handoff and Feedback Loop

Goal: prepare the private-alpha build for tester distribution and structured bug intake.

| ID    | Task                       | Dependencies | Acceptance Criteria                                                       | Status |
| ----- | -------------------------- | ------------ | ------------------------------------------------------------------------- | ------ |
| P16.1 | Set alpha release version  | P15          | Root package version is `0.0.0-alpha.1`.                                  | Done   |
| P16.2 | Create versioned macOS ZIP | P15          | `release/mac/ZeroLeaf-0.0.0-alpha.1-mac.zip` exists.                      | Done   |
| P16.3 | Write tester handoff doc   | P15          | Install, requirements, workflows, and known limitations are documented.   | Done   |
| P16.4 | Write feedback template    | P16.3        | Testers have a structured bug/feedback report format.                     | Done   |
| P16.5 | Run final release gate     | P16.1        | Format, lint, typecheck, tests, readiness, and pilot commands pass.       | Done   |
| P16.6 | Record tag status          | P16.1        | Git tag is created or explicitly deferred until an initial commit exists. | Done   |

Verification:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run alpha:readiness
npm run alpha:pilot
npm run package:mac:zip
```

Phase exit gate:

- Private-alpha handoff package is ready for tester distribution.

## Deferred Post-MVP Work

| ID  | Feature                           | Reason Deferred                                                       | Status   |
| --- | --------------------------------- | --------------------------------------------------------------------- | -------- |
| D1  | Full visual editor                | Large separate editing model; source editor must be excellent first.  | Deferred |
| D2  | Real-time collaboration           | Requires CRDT/cloud/server architecture and conflict handling.        | Deferred |
| D3  | Cloud sync/storage                | Local-first MVP avoids account/backend complexity.                    | Deferred |
| D4  | Full track changes/reviewer roles | Needs mature comment/suggestion metadata and collaboration semantics. | Deferred |
| D5  | Template marketplace              | Built-in templates are enough for MVP.                                | Deferred |
| D6  | Journal direct submission         | Export/checklist is enough initially.                                 | Deferred |
| D7  | Mobile UI                         | Product is desktop-first.                                             | Deferred |
| D8  | Dark mode                         | Explicitly excluded by product design rule.                           | Deferred |
| D9  | Unrestricted shell agent          | Too risky for MVP; app-native tools are safer.                        | Deferred |
| D10 | Autonomous network-enabled agent  | Network access should remain explicit and approval-gated.             | Deferred |

## Cross-Phase Backlog Rules

Use these rules when adding new tasks:

- Every task must have an ID, dependency, acceptance criteria, and status.
- Every feature touching files must specify project-root scoping.
- Every feature touching agent writes must specify diff/review behavior.
- Every feature touching compilation must specify diagnostics and logs behavior.
- Every UI feature must support the light-only visual system.
- Every provider feature must use the provider-neutral `AgentProvider` interface.
- Every network feature must include explicit approval behavior.

## Suggested Sprint Grouping

Assuming 1-2 engineers, use two-week sprints. If a larger team exists, run frontend workbench, local services, and agent platform in parallel only after Phase 1 contracts are stable.

| Sprint | Focus         | Main Deliverables                                          |
| ------ | ------------- | ---------------------------------------------------------- |
| S1     | P0 + P1 start | Tooling, Electron shell, typed IPC sample.                 |
| S2     | P1 complete   | Light workbench, panes, command palette, settings shell.   |
| S3     | P2            | Project open, file tree, safe read/write, recent projects. |
| S4     | P3            | Monaco editor, tabs, save, search, snippets.               |
| S5     | P4 start      | TeX detection, build service, logs.                        |
| S6     | P4 complete   | Diagnostics, PDF.js preview, compiler settings.            |
| S7     | P5 + P6 start | SyncTeX, snapshots, changesets.                            |
| S8     | P6 complete   | Diff viewer, accept/reject, rollback.                      |
| S9     | P7            | Mock agent vertical slice.                                 |
| S10    | P8            | Agent Host process, permissions, approval routing.         |
| S11    | P9            | Codex adapter and compile-fix workflow.                    |
| S12    | P10           | Claude adapter and provider parity.                        |
| S13    | P11           | Bibliography and citation workflows.                       |
| S14    | P12 + P13     | Settings, credentials, export, templates.                  |
| S15    | P14           | Hardening, E2E tests, packaging, docs.                     |

## Risk Register

| Risk                                          | Impact                            | Mitigation                                                                                    | Owner            |
| --------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| LaTeX toolchain availability varies by OS     | Builds fail or setup is confusing | Detect toolchain early; provide setup guidance; support custom TeX path.                      | Build Service    |
| Diagnostics parsing is imperfect              | Users cannot act on errors        | Always keep raw log; parse common cases first; allow agent/log context.                       | Build Service    |
| Agent provider APIs/auth change               | Provider integration breaks       | Keep provider adapters isolated; preserve mock provider; fallback to CLI/JSON where feasible. | Agent Platform   |
| Agent writes unsafe changes                   | Data loss/trust loss              | Snapshot before edits; patch-first review; rollback; scoped tools; approvals.                 | Agent Platform   |
| Renderer security regression                  | Files/secrets exposed             | Keep filesystem/credentials in main/services; typed IPC; security tests.                      | Desktop Platform |
| App becomes too visually dense                | Poor writing experience           | Follow light-only workbench design; progressive disclosure; user density settings.            | Frontend         |
| Scope creep into collaboration/visual editing | MVP slips                         | Keep deferred list explicit; protect critical vertical slice.                                 | Product          |

## MVP Completion Checklist

- [x] User can open a local LaTeX project.
- [x] User can edit and save `.tex` files.
- [x] User can compile with `latexmk`.
- [x] User can view PDF output.
- [x] User can inspect diagnostics and raw logs.
- [x] User can jump between source and PDF with SyncTeX.
- [x] User can search and insert citations from `.bib`.
- [x] User can view local snapshots and diffs.
- [x] Mock agent can complete the critical vertical slice.
- [x] Codex can complete the compile-fix workflow.
- [x] Claude can complete the compile-fix workflow.
- [x] Agent edits are reviewable and reversible.
- [x] Agent permissions are configurable.
- [x] Provider credentials are not exposed to renderer.
- [x] UI is light-only and accessible by keyboard.
- [x] App passes lint, unit, integration, and E2E smoke tests.
- [x] Private alpha docs are written.

## Tracking Template for New Tasks

```md
| ID   | Task | Dependencies | Acceptance Criteria | Status      |
| ---- | ---- | ------------ | ------------------- | ----------- |
| P?.? |      |              |                     | Not Started |
```

## Tracking Template for Bugs

```md
| Bug ID | Area | Description | Repro Steps | Expected | Actual | Severity | Status      |
| ------ | ---- | ----------- | ----------- | -------- | ------ | -------- | ----------- |
| B-001  |      |             |             |          |        |          | Not Started |
```

## Tracking Template for Release Readiness

```md
| Check                             | Owner | Evidence                                                                    | Status |
| --------------------------------- | ----- | --------------------------------------------------------------------------- | ------ |
| Critical vertical slice completed | Codex | `npm run test`, `npm run alpha:readiness`                                   | Done   |
| Security review completed         | Codex | `docs/security/mvp-security-review.md`, `npm run test -- packages/security` | Done   |
| Accessibility review completed    | Codex | `apps/desktop/src/renderer/accessibility.test.ts`, `npm run e2e`            | Done   |
| Sample projects pass              | Codex | `npm run alpha:readiness`                                                   | Done   |
| Packaging smoke test completed    | Codex | `npm run package:mac`, `release/mac/ZeroLeaf.app`                           | Done   |
```
