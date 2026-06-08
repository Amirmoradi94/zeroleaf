# AI-Powered Desktop LaTeX Editor Feature Inventory

Date: 2026-06-07

## Product Summary

This app is a local-first desktop LaTeX writing environment with Overleaf-class editing and compilation, plus an integrated AI agent that can operate on the project. The agent should not only chat about LaTeX; it should read files, propose edits, apply approved changes, compile the document, inspect errors, and verify results.

General design rule: the product uses a professional light-only interface. Avoid dark style patterns, dark IDE frames, and dark-mode-first visual language.

## Priority Legend

- MVP: required for the first serious usable product.
- P1: important after the MVP.
- P2: advanced or future capability.

## 1. Project Dashboard

| Feature                     | Description                                                                                     | Priority |
| --------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| Recent projects             | List recently opened local projects with path, last opened time, and compile status.            | MVP      |
| Open folder/project         | Open an existing local LaTeX project folder.                                                    | MVP      |
| Create blank project        | Create a basic LaTeX project with `main.tex` and optional `refs.bib`.                           | MVP      |
| Create from template        | Start from article, thesis, report, CV, Beamer, IEEE, ACM, arXiv, or journal templates.         | P1       |
| Import zip project          | Import an Overleaf/source zip into a local project.                                             | P1       |
| Project health summary      | Show TeX installation status, main file, compiler, missing dependencies, and last build result. | MVP      |
| Provider connection summary | Show Codex/Claude connection status without exposing secrets.                                   | MVP      |
| Project tags                | Organize projects by course, paper, client, journal, or status.                                 | P2       |

## 2. Project and File Management

| Feature                 | Description                                                              | Priority |
| ----------------------- | ------------------------------------------------------------------------ | -------- |
| File tree               | Browse, create, rename, move, duplicate, and delete files/folders.       | MVP      |
| Main document selection | Detect and set the main `.tex` file.                                     | MVP      |
| File upload/import      | Add images, `.bib`, `.sty`, `.cls`, PDFs, and other assets.              | MVP      |
| Drag and drop assets    | Drop figures or bibliography files into the project tree.                | P1       |
| Generated files view    | Inspect generated outputs such as `.aux`, `.bbl`, `.log`, `.synctex.gz`. | P1       |
| File metadata           | Show size, type, last modified date, and build relevance.                | P1       |
| Safe path handling      | Block path traversal and writes outside the project root.                | MVP      |
| Project export          | Export source zip and compiled PDF.                                      | MVP      |
| Reveal in OS            | Open selected file/folder in Finder/Explorer.                            | P1       |

## 3. Source Editor

| Feature                      | Description                                                                                             | Priority |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Monaco LaTeX editor          | Code editor with line numbers, syntax highlighting, folding, multi-cursor, find/replace.                | MVP      |
| File tabs                    | Open multiple files with dirty state, close, pin, and split support.                                    | MVP      |
| Code/Visual toggle           | Toggle between source editor and future visual writing mode. MVP can ship source-only with placeholder. | P1       |
| LaTeX autocomplete           | Commands, environments, labels, citations, packages, and snippets.                                      | MVP      |
| Label/reference autocomplete | Suggest `\label`, `\ref`, `\autoref`, `\eqref` targets.                                                 | MVP      |
| Citation autocomplete        | Suggest citation keys from local `.bib` files.                                                          | MVP      |
| Symbol palette               | Insert math symbols, Greek letters, arrows, operators, and relation symbols.                            | P1       |
| Outline panel                | Navigate chapters, sections, subsections, labels, equations, figures, and tables.                       | MVP      |
| Spellcheck                   | Language-aware spellcheck for prose while respecting LaTeX commands.                                    | P1       |
| Word count                   | Count words using LaTeX-aware rules.                                                                    | P1       |
| Snippets                     | Insert common environments like theorem, proof, figure, table, align, itemize.                          | MVP      |
| Command palette              | Keyboard-first command launcher for files, actions, settings, and agent tasks.                          | MVP      |
| Vim/Emacs keybindings        | Optional advanced editor keybinding modes.                                                              | P2       |

## 4. PDF Preview and Navigation

| Feature               | Description                                                          | Priority |
| --------------------- | -------------------------------------------------------------------- | -------- |
| PDF.js preview        | Render compiled PDF next to the editor.                              | MVP      |
| Recompile button      | Compile current project and refresh PDF.                             | MVP      |
| Auto compile          | Optional compile after save or debounce interval.                    | P1       |
| PDF toolbar           | Page navigation, zoom, fit width/page, search, download PDF.         | MVP      |
| SyncTeX source-to-PDF | Jump from source location to rendered PDF location.                  | MVP      |
| SyncTeX PDF-to-source | Click PDF text/area and jump back to source.                         | MVP      |
| Stale PDF state       | Clearly show when the PDF is older than saved source.                | MVP      |
| Page thumbnails       | Thumbnail rail for larger documents.                                 | P1       |
| Multi-PDF artifacts   | Support appendices or generated PDFs as secondary preview artifacts. | P2       |

## 5. Build, Logs, and Diagnostics

| Feature                  | Description                                                                            | Priority |
| ------------------------ | -------------------------------------------------------------------------------------- | -------- |
| `latexmk` build pipeline | Compile through `latexmk` using pdfLaTeX, XeLaTeX, or LuaLaTeX.                        | MVP      |
| Compiler settings        | Select engine, main file, bibliography tool, TeX path, and build profile.              | MVP      |
| Diagnostics parser       | Parse LaTeX errors, warnings, overfull boxes, missing references, and citation errors. | MVP      |
| Diagnostics panel        | Group errors/warnings with file, line, message, and jump action.                       | MVP      |
| Raw log viewer           | Inspect, search, and copy raw build logs.                                              | MVP      |
| Build timeline           | Show build steps, duration, and failure point.                                         | P1       |
| Stop build               | Cancel a running compile and clean process tree.                                       | MVP      |
| Clear build cache        | Remove generated files and rebuild from scratch.                                       | P1       |
| Shell escape control     | Disabled by default; prompt before enabling.                                           | MVP      |
| Build profiles           | Draft, final, arXiv, journal submission, fast preview.                                 | P1       |

## 6. Bibliography and References

| Feature                      | Description                                                                 | Priority |
| ---------------------------- | --------------------------------------------------------------------------- | -------- |
| `.bib` parser                | Read local bibliography files and expose citation metadata.                 | MVP      |
| Citation search              | Search by key, title, author, year, venue, DOI.                             | MVP      |
| Insert citation              | Insert `\cite{}`, `\parencite{}`, `\textcite{}` depending on project style. | MVP      |
| Missing citation detector    | Find citations with no bibliography entry.                                  | MVP      |
| Unused reference detector    | List bibliography entries not cited in the document.                        | P1       |
| Duplicate reference detector | Identify likely duplicate bibliography entries.                             | P1       |
| DOI metadata import          | Create `.bib` entry from DOI/arXiv URL.                                     | P1       |
| Zotero integration           | Import or sync references from Zotero.                                      | P2       |
| Mendeley/Papers integration  | Optional external reference manager integrations.                           | P2       |

## 7. History, Review, and Versioning

| Feature                 | Description                                                   | Priority |
| ----------------------- | ------------------------------------------------------------- | -------- |
| Local snapshots         | Snapshot files before agent edits and major user operations.  | MVP      |
| Changeset list          | Show user and agent changesets with timestamps and summaries. | MVP      |
| Diff viewer             | Review inline and split diffs for file changes.               | MVP      |
| Restore file version    | Restore a file to an earlier state.                           | P1       |
| Restore project version | Restore a full project snapshot.                              | P1       |
| Agent edit review       | Accept/reject all, by file, or by hunk.                       | MVP      |
| Comment threads         | Add local comments to selections or files.                    | P1       |
| Track changes           | Local suggested edits similar to manuscript review.           | P2       |
| Git integration         | Detect Git repo, show changes, commit, branch, pull/push.     | P1       |

## 8. AI Agent: Core Capabilities

The AI agent is a first-class editor operator. It should work through visible tools, approval states, and reviewable changesets.

### 8.1 Provider and Session Features

| Feature                    | Description                                                                          | Priority |
| -------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Provider picker            | Choose Codex, Claude, or future local model provider per session.                    | MVP      |
| Provider auth status       | Show connected/disconnected/rate-limited/error states.                               | MVP      |
| Provider-specific sessions | Preserve session history and provider thread IDs per project.                        | MVP      |
| Agent mode selector        | Read-only, Suggest, Apply with Review, Autonomous Local Loop.                        | MVP      |
| Agent task history         | List previous tasks, results, changed files, and verification status.                | P1       |
| Model/settings selector    | Pick model, reasoning/effort level, max turns, and tool permissions where supported. | P1       |
| Multi-agent compare        | Run the same task through multiple providers and compare proposed patches.           | P2       |

### 8.2 In-Editor Entry Points

| Feature                       | Description                                                                         | Priority |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Ask AI on selection           | Explain, rewrite, simplify, expand, convert, or fix selected text/LaTeX.            | MVP      |
| Ask AI on current file        | Ask questions or request edits scoped to the active file.                           | MVP      |
| Ask AI on diagnostics         | Send selected compile error/warning to the agent with relevant context.             | MVP      |
| Ask AI from PDF               | Ask about the rendered output, selected PDF page, or visual mismatch.               | P1       |
| Context attachment chips      | Attach selected file, selection, diagnostics, PDF page, `.bib` entry, or build log. | MVP      |
| Inline action menu            | Right-click or shortcut menu with agent actions near selection.                     | MVP      |
| Agent command palette actions | Run common tasks from the command palette.                                          | MVP      |
| Agent quick prompts           | Prebuilt prompts for common LaTeX workflows.                                        | MVP      |

### 8.3 Writing and Editing Actions

| Feature                    | Description                                                                   | Priority |
| -------------------------- | ----------------------------------------------------------------------------- | -------- |
| Improve academic tone      | Rewrite prose for clarity, precision, and academic style.                     | MVP      |
| Simplify dense prose       | Make a paragraph easier to read without changing meaning.                     | MVP      |
| Expand notes into prose    | Turn outline bullets or rough notes into a polished section.                  | MVP      |
| Shorten section            | Reduce length while preserving citations and claims.                          | MVP      |
| Fix grammar and style      | Apply grammar, punctuation, and style corrections inside LaTeX.               | MVP      |
| Preserve LaTeX commands    | Rewrite prose while preserving commands, labels, citations, and environments. | MVP      |
| Convert text to LaTeX      | Convert plain text, Markdown, or rough math into valid LaTeX.                 | MVP      |
| Generate section outline   | Create or revise a document/section outline.                                  | P1       |
| Reorganize section         | Move paragraphs, headings, and transitions for better flow.                   | P1       |
| Add transitions            | Add connecting sentences between paragraphs or sections.                      | P1       |
| Consistency pass           | Normalize terminology, notation, capitalization, and variable names.          | P1       |
| Abstract/title generation  | Draft or improve title, abstract, and keywords from document content.         | P1       |
| Reviewer response drafting | Draft responses to reviewer comments based on manuscript changes.             | P2       |

### 8.4 LaTeX-Specific Editing Actions

| Feature                 | Description                                                                              | Priority |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------- |
| Fix LaTeX syntax        | Repair unbalanced braces, missing `\end`, invalid commands, and environment errors.      | MVP      |
| Create environments     | Insert theorem, lemma, proof, align, figure, table, algorithm, and listing environments. | MVP      |
| Equation generation     | Convert natural language or rough math into LaTeX equations.                             | MVP      |
| Equation explanation    | Explain an equation and identify notation used.                                          | MVP      |
| Equation refactor       | Convert inline equations to display equations, align equations, or split long equations. | P1       |
| Table generation        | Generate LaTeX tables from text, CSV-like input, or pasted data.                         | MVP      |
| Table cleanup           | Improve table alignment, captions, labels, column widths, and booktabs usage.            | P1       |
| Figure insertion        | Add figure environment, include graphics, captions, labels, and placement hints.         | MVP      |
| Package suggestion      | Suggest required packages for commands/environments and add them to preamble.            | MVP      |
| Preamble cleanup        | Remove duplicate packages, organize package order, and resolve package conflicts.        | P1       |
| Label normalization     | Create or rename labels using project conventions.                                       | P1       |
| Cross-reference cleanup | Fix broken refs, convert manual references to `\ref`/`\autoref`.                         | P1       |
| Template adaptation     | Adapt content to a target class/template while preserving structure.                     | P2       |

### 8.5 Compile Error Repair Loop

| Feature                   | Description                                                                              | Priority |
| ------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| Diagnose build failure    | Read diagnostics and logs, identify likely root cause, explain in plain language.        | MVP      |
| Fix top error first       | Apply focused patches starting from the first blocking LaTeX error.                      | MVP      |
| Recompile after edit      | Run compile after agent changes to verify the fix.                                       | MVP      |
| Iterate within limits     | Continue fix/recompile loop until success or configured limit.                           | MVP      |
| Show verification result  | Report build status, remaining errors, changed files, and PDF freshness.                 | MVP      |
| Rollback failed fix       | Revert agent changes if requested or if the patch made the build worse.                  | P1       |
| Cache/log cleanup advice  | Suggest clearing generated files when stale artifacts cause false failures.              | P1       |
| Explain unresolved errors | If the agent cannot fix an error, explain what is missing and what user input is needed. | MVP      |

### 8.6 Project-Wide Agent Actions

| Feature                  | Description                                                                                    | Priority |
| ------------------------ | ---------------------------------------------------------------------------------------------- | -------- |
| Summarize project        | Summarize document structure, main claims, missing sections, and build health.                 | MVP      |
| Create project scaffold  | Generate a new LaTeX project from a prompt or template choice.                                 | P1       |
| Reorganize project files | Split monolithic `main.tex` into chapter/section files with `\input`.                          | P1       |
| Rename files safely      | Rename files and update `\input`, `\include`, `\includegraphics`, and bibliography references. | P1       |
| Find TODOs               | Collect TODO comments, unresolved notes, missing citations, and draft placeholders.            | MVP      |
| Submission checklist     | Check arXiv/journal readiness: main file, figures, bibliography, class, generated files.       | P1       |
| Accessibility pass       | Suggest improvements for accessible PDF generation, alt text, and semantic structure.          | P2       |
| Consistency audit        | Scan document for inconsistent notation, naming, abbreviations, and section structure.         | P1       |
| Literature gap notes     | Based on existing `.bib` and manuscript text, identify places that need citations.             | P1       |

### 8.7 Bibliography Agent Actions

| Feature                    | Description                                                                          | Priority |
| -------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Suggest citation insertion | Identify paragraphs that need citations and suggest existing keys.                   | MVP      |
| Fix missing citations      | Resolve missing keys by matching likely `.bib` entries or asking for source details. | MVP      |
| Clean bibliography entries | Normalize fields, remove invalid characters, fix capitalization braces.              | P1       |
| Generate BibTeX from DOI   | Fetch or draft BibTeX from DOI/arXiv URL where network access is approved.           | P1       |
| Citation style adaptation  | Adjust citation commands for BibTeX, BibLaTeX, natbib, or journal style.             | P1       |
| Detect citation misuse     | Flag unsupported claims, outdated placeholders, or citation command mismatches.      | P2       |

### 8.8 PDF-Aware Agent Actions

| Feature                      | Description                                                                           | Priority |
| ---------------------------- | ------------------------------------------------------------------------------------- | -------- |
| Inspect rendered page        | Use rendered PDF page context to reason about layout issues.                          | P1       |
| Fix overfull/underfull boxes | Find source locations and suggest line/table/equation fixes.                          | P1       |
| Improve figure/table layout  | Adjust placement, sizing, captions, and float behavior.                               | P1       |
| Compare source and output    | Identify why an expected change did not appear in PDF.                                | P1       |
| Explain PDF artifact         | Explain unexpected spacing, numbering, missing references, or broken links.           | P1       |
| Final formatting review      | Check page layout, references, lists, equations, figures, and warnings before export. | P2       |

### 8.9 Agent Review, Diff, and Approval

| Feature               | Description                                                                      | Priority |
| --------------------- | -------------------------------------------------------------------------------- | -------- |
| Patch-first proposals | Agent edits are represented as patches/changesets before final acceptance.       | MVP      |
| Inline diff preview   | Show proposed edits inside editor or review panel.                               | MVP      |
| Accept/reject hunk    | Accept or reject individual hunks.                                               | MVP      |
| Explain change        | Ask agent why a specific change was made.                                        | MVP      |
| Edit proposed patch   | User can manually adjust proposed patch before applying.                         | P1       |
| Tool-call timeline    | Show reads, writes, searches, compiles, and approvals in chronological order.    | MVP      |
| Approval requests     | Prompt before risky write, delete, network, shell escape, or external operation. | MVP      |
| Changeset rollback    | Revert a completed agent changeset.                                              | MVP      |

### 8.10 Agent Safety and Controls

| Feature                  | Description                                                              | Priority |
| ------------------------ | ------------------------------------------------------------------------ | -------- |
| Read-only mode           | Agent can inspect and explain but cannot edit.                           | MVP      |
| Suggest mode             | Agent can propose patches but cannot apply them.                         | MVP      |
| Apply with review        | Agent can apply edits after explicit approval.                           | MVP      |
| Autonomous local loop    | Agent can edit and compile within project root and configured limits.    | P1       |
| Tool allowlist           | Configure which tools the agent can use by mode.                         | MVP      |
| Network approval         | Network access requires explicit user approval.                          | MVP      |
| Outside-root write block | Agent cannot write outside the project root by default.                  | MVP      |
| Destructive action block | Dangerous operations are blocked or require strong confirmation.         | MVP      |
| Max turns/time budget    | Limit autonomous runs by turns, time, and compile attempts.              | MVP      |
| Audit log                | Store agent actions, approvals, changed files, and verification results. | MVP      |

## 9. AI Agent UI Components

| Component          | Purpose                                                            | Priority |
| ------------------ | ------------------------------------------------------------------ | -------- |
| Agent panel        | Right-side inspector for chat, tool calls, diffs, and approvals.   | MVP      |
| Agent composer     | Prompt input with attachments, mode selector, and provider picker. | MVP      |
| Context chips      | Visible list of files/selections/logs attached to the prompt.      | MVP      |
| Tool call cards    | Compact cards for read/search/edit/compile actions.                | MVP      |
| Approval card      | Explicit allow/deny UI for higher-risk actions.                    | MVP      |
| Diff summary card  | Shows changed files and verification status.                       | MVP      |
| Agent session list | Switch between previous agent sessions.                            | P1       |
| Quick action menu  | Selection-based editor actions like explain, rewrite, cite, fix.   | MVP      |
| Agent status pill  | Shows idle, thinking, editing, compiling, waiting, done, failed.   | MVP      |

## 10. Settings and Preferences

| Feature                        | Description                                                                                 | Priority |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------- |
| Light-only appearance settings | Adjust density, fonts, editor theme, PDF background, and accent color without dark styling. | MVP      |
| Editor settings                | Font, font size, line height, minimap, autocomplete, spellcheck.                            | MVP      |
| Compiler settings              | Main file, engine, TeX path, build profile, shell escape.                                   | MVP      |
| AI provider settings           | Connect/disconnect Codex and Claude, provider status, default provider.                     | MVP      |
| Agent permissions              | Configure modes, approval rules, max turns, network policy.                                 | MVP      |
| Keybindings                    | View and customize shortcuts.                                                               | P1       |
| Privacy settings               | Local history, logs, telemetry, credential storage, provider data notes.                    | MVP      |

## 11. Integrations and Export

| Feature                    | Description                                                       | Priority |
| -------------------------- | ----------------------------------------------------------------- | -------- |
| Git local integration      | Status, diff, stage, commit, branch.                              | P1       |
| GitHub sync                | Push/pull project with GitHub.                                    | P2       |
| Overleaf import/export     | Import source zip and export source/PDF compatible with Overleaf. | P1       |
| arXiv export               | Produce source bundle suitable for arXiv submission.              | P1       |
| Journal submission package | Bundle files for a selected journal template.                     | P2       |
| Zotero integration         | Reference import/sync.                                            | P2       |
| Local model provider       | Optional local LLM provider adapter.                              | P2       |

## 12. Accessibility and Usability

| Feature                   | Description                                                      | Priority |
| ------------------------- | ---------------------------------------------------------------- | -------- |
| Full keyboard navigation  | Navigate major surfaces without mouse.                           | MVP      |
| Command palette coverage  | All important commands exposed through command palette.          | MVP      |
| Accessible labels         | Every icon-only button and status indicator has accessible text. | MVP      |
| High-contrast light theme | Light-only high-contrast option for accessibility.               | P1       |
| Resizable panes           | Mouse and keyboard controls for pane resizing.                   | MVP      |
| Clear status feedback     | Save, compile, PDF stale state, agent state, provider state.     | MVP      |
| Error recovery guidance   | Plain-language error messages and actionable next steps.         | MVP      |

## 13. MVP Feature Cut

The MVP should include:

1. Project dashboard with recent projects, open folder, create blank project.
2. File tree and local project metadata.
3. Monaco LaTeX editor with tabs, autocomplete basics, snippets, search.
4. `latexmk` compile pipeline with diagnostics and raw log viewer.
5. PDF.js preview with Recompile, page navigation, zoom, and stale PDF indicator.
6. SyncTeX source/PDF navigation.
7. `.bib` parser, citation search, citation autocomplete, missing citation diagnostics.
8. Local snapshots, changesets, and diff viewer.
9. Agent panel with provider picker, mode selector, composer, context chips, tool-call timeline.
10. AI actions for selection rewrite/explain, LaTeX syntax fix, table/equation generation, citation suggestions, and compile-error repair.
11. Patch-first agent review with accept/reject and compile verification.
12. Settings for light-only appearance, editor, compiler, AI providers, and agent permissions.

## 14. Features Explicitly Deferred

- Full visual/WYSIWYG editor.
- Real-time multiplayer collaboration.
- Cloud project storage.
- Full track changes and reviewer roles.
- Template marketplace.
- Journal direct submission.
- Mobile UI.
- Dark mode or dark-style interface skins.
- Unrestricted shell agent.
- Autonomous network-enabled agent operation.
