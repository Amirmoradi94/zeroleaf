# UI/UX Design System for ZeroLeaf

Date: 2026-06-07

## Goal

Design a professional desktop LaTeX editor that feels like a serious writing and publishing workbench, not a generic AI writing dashboard. The interface should serve three high-focus workflows:

- Write and edit LaTeX with confidence.
- Compile, inspect, and navigate the PDF result quickly.
- Delegate project-level work to an AI agent while keeping edits reviewable and safe.

## Research Inputs

### Dribbble Inspiration

The useful Dribbble patterns were not literal LaTeX clones. The strongest patterns came from document editors, AI writing tools, and developer dashboards:

- Piilot manuscript editor: guided structure on the left, central writing surface, and a clear "Ask AI" action integrated into the writing workflow.
- HotMemos document editor: focused canvas, contextual/floating toolbars, metadata tags, and AI/team chat in the right sidebar.
- Textia AI writing dashboard: large legible content area, persistent sidebar filters, clear primary/secondary hierarchy, modular shortcuts.
- Modern Writing & Documents: calm, distraction-reduced writing layouts with subtle visual cues and minimal structure.
- SharePad: classic collaborative document editor direction with restrained color and workspace utility.
- Dribbble dev-dashboard search results: recurring patterns around compact side navigation, command centers, AI/code-editor compositions, and modular panels.

These are good for visual mood and layout ideas, but Dribbble concepts should be filtered heavily. A production LaTeX editor needs dense information, predictable controls, keyboard speed, readable logs, and sober error handling.

### Product Benchmarks

Overleaf's redesigned editor keeps the editor on the left and PDF viewer on the right, adds a simplified top bar, moves key tools into a left vertical rail, and keeps error logs near the recompile action. It also preserves pane resizing/hiding and SyncTeX navigation between source and PDF.

VS Code's workbench model is the best ergonomic reference for a dense desktop tool: activity bar, primary sidebar, editor groups, secondary sidebar, status bar, and bottom panel. Its value is not visual style alone; it preserves project context while maximizing editor space.

Codetta is a useful AI-editor benchmark: file tree, AI chats as first-class tabs/rails, live tool calls, inline diffs, command palette, diagnostics panel, and workspace state persistence.

## Recommended Design Direction

Use a "scholarly IDE" direction:

- Dense enough for power users.
- Calm enough for long writing sessions.
- AI-native without making the app feel like a chat wrapper.
- Academic and precise, not futuristic or flashy.
- Familiar to users coming from Overleaf, VS Code, Cursor, and scientific writing tools.
- Light-only by default. Do not use dark IDE frames, dark panels, or dark-mode product styling patterns.

Primary layout:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title bar / command center / project controls / compile status / provider    │
├──────┬────────────────────┬──────────────────────────┬──────────────────────┤
│ Rail │ Project sidebar     │ Editor / visual writer    │ PDF preview          │
│      │ files/search/review │ tabs, source, outline     │ pages, search, logs  │
│      │                    │                          │                      │
├──────┴────────────────────┴──────────────────────────┴──────────────────────┤
│ Bottom panel: diagnostics, build log, references, terminal-lite, history      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Status bar: branch, compiler, main file, spellcheck, SyncTeX, agent state     │
└──────────────────────────────────────────────────────────────────────────────┘
                             optional right agent inspector
```

The editor and PDF split is the default. The AI agent panel should open on the right as an inspector/sidebar, not replace the PDF. In smaller windows, use mode tabs: Editor, PDF, Agent.

## Visual Style

### Palette

Avoid a one-note purple AI theme. Use neutral editor surfaces with academic accent colors.

Light-only theme:

```text
app-bg:          #F6F7F8
surface-1:       #FFFFFF
surface-2:       #F0F2F4
surface-3:       #E5E8EC
border-subtle:   #D8DDE3
text-primary:    #14171A
text-secondary:  #5C6670
text-muted:      #8A949E
accent:          #2F6F73  // teal-slate
accent-strong:   #1D5559
link:            #1D5FA8
success:         #23845D
warning:         #A76513
danger:          #C33D3D
agent:           #6B5BD6  // controlled accent, not dominant
pdf-paper:       #FFFFFF
editor-bg:       #FBFCFD
```

Use color semantically:

- Teal: app identity and active navigation.
- Blue: links and source/PDF navigation.
- Green: successful compile, accepted changes.
- Amber: warnings, stale PDF, unresolved suggestions.
- Red: compile errors, destructive actions.
- Purple: agent state, but only as an accent.

### Typography

UI:

- System font stack: `Inter`, `SF Pro`, `Segoe UI`, `system-ui`, sans-serif.
- Base UI text: 13px.
- Dense panel labels: 12px.
- Section titles: 13px semibold.
- Dialog titles: 16px semibold.

Editor:

- Default monospace: `JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`, monospace.
- Default editor size: 14px.
- Line height: 1.55.
- User setting range: 12px to 18px.

PDF:

- PDF is rendered as actual output, not restyled. Keep PDF page background neutral with subtle shadow only when useful for page separation.

### Shape and Spacing

- Use 8px grid.
- Panel border radius: 0 to 6px.
- Cards only for repeated items, tool calls, and modals. Do not put page sections inside decorative cards.
- Icon buttons: 28px or 32px square.
- Toolbar height: 40px.
- Status bar height: 24px.
- Sidebar rail width: 48px.
- Primary sidebar default width: 280px.
- Agent sidebar default width: 360px.
- Bottom panel default height: 220px.

## Screen Inventory

### 1. Project Dashboard

Purpose: open recent projects, create/import projects, manage templates.

Components:

- Recent project table/list
- Template gallery
- Import project button
- Open folder button
- Provider connection status
- TeX installation status

Keep it utilitarian. No marketing hero.

### 2. Editor Workbench

Default workspace screen.

Regions:

- Top bar: project menu, command search, compile button/status, layout selector, share/export later.
- Activity rail: Files, Search, References, Review, Agent, History, Settings.
- Primary sidebar: selected activity content.
- Main editor: Monaco tabs, source editor, optional visual mode.
- PDF preview: PDF toolbar, page nav, zoom, search, SyncTeX controls.
- Agent inspector: optional right sidebar with task, transcript, tool calls, diffs.
- Bottom panel: diagnostics, logs, build output, references, history.
- Status bar: project path, compiler, main file, agent mode, dirty state.

### 3. Agent Review Screen

Purpose: review and accept/reject agent changes.

Components:

- Changeset summary
- File list with changed-line counts
- Inline/split diff viewer
- Compile verification result
- Accept all / reject all / accept file / open in editor
- Agent rationale and tool transcript collapsed by default

### 4. Compile Diagnostics Screen

Purpose: turn LaTeX errors into action.

Components:

- Grouped diagnostics by severity
- File/line jump
- Error explanation
- Raw log expand/copy
- "Ask agent to fix" button
- Build timeline
- Compiler settings shortcut

### 5. References Screen

Purpose: manage `.bib` files and citation insertion.

Components:

- Bibliography file selector
- Citation search input
- Result list with title/author/year/key
- Missing references list
- Unused references list
- Insert citation action
- DOI/import action later

### 6. Settings

Tabs:

- Editor: font, theme, keybindings, spellcheck, autocomplete.
- Compiler: engine, main file, TeX path, shell escape toggle, build output path.
- AI Providers: Codex, Claude, local models, auth status.
- Agent Permissions: modes, approval rules, network access, max turns.
- Appearance: light theme density, editor font, editor color theme, PDF background.
- Privacy: telemetry, local history, logs, credential storage.

## Component Kit

### Foundation Components

- `Button`: primary, secondary, ghost, destructive.
- `IconButton`: toolbar actions with tooltip.
- `SplitButton`: compile with advanced options.
- `SegmentedControl`: Code / Visual, Editor / PDF / Agent in compact mode.
- `Tabs`: file tabs, settings tabs, bottom panel tabs.
- `Tooltip`: required for icon-only controls.
- `Popover`: inline citation, symbol picker, quick settings.
- `Dialog`: settings, confirmations, provider auth.
- `Sheet`: mobile/narrow side panels.
- `Toast`: save, compile, provider auth, low-risk confirmations.
- `Badge`: compiler, provider, review status, citation type.
- `Progress`: compile and agent task progress.
- `Skeleton`: PDF/loading/project open states.

Implementation recommendation: shadcn/ui on Radix primitives, styled with Tailwind tokens. Radix is appropriate because it handles focus, roles, keyboard navigation, and accessible primitives while remaining styleable.

### Workbench Components

- `AppTitleBar`
- `CommandCenter`
- `ActivityRail`
- `ActivityRailButton`
- `ResizableWorkbench`
- `PanelHeader`
- `PanelToolbar`
- `StatusBar`
- `BreadcrumbPath`
- `KbdShortcut`
- `EmptyPanelState`
- `ContextMenu`

### Project Components

- `ProjectTree`
- `ProjectTreeItem`
- `FileIcon`
- `FileTab`
- `OpenEditorsList`
- `ProjectSearch`
- `SearchResultItem`
- `TemplateCard`
- `RecentProjectRow`

### Editor Components

- `LatexEditor`
- `VisualEditorShell`
- `EditorTabBar`
- `InlineToolbar`
- `SymbolPalette`
- `CommandPalette`
- `OutlinePanel`
- `SelectionActionMenu`
- `AutocompletePopover`
- `SpellcheckMarker`

### PDF Components

- `PdfViewer`
- `PdfToolbar`
- `PageNavigator`
- `ZoomControl`
- `PdfSearch`
- `SynctexJumpButton`
- `StalePdfBanner`
- `PdfPageThumbnailRail`

### Build and Diagnostics Components

- `CompileButton`
- `CompileStatusPill`
- `BuildTimeline`
- `DiagnosticList`
- `DiagnosticItem`
- `LogViewer`
- `ErrorExplanationPanel`
- `FixWithAgentButton`

### Agent Components

- `AgentPanel`
- `AgentComposer`
- `AgentModeSelector`
- `ProviderPicker`
- `ToolCallCard`
- `ToolCallTimeline`
- `ApprovalRequest`
- `AgentTaskHeader`
- `AgentDiffSummary`
- `AgentVerificationResult`
- `ContextAttachmentChip`
- `AgentSessionList`

Agent UI rules:

- Tool calls are visible but compact.
- File edits show inline diff previews.
- Risky tool calls require explicit approval UI.
- The agent can ask clarifying questions with compact choice buttons.
- The composer supports attachments: file, selection, diagnostics, PDF page, bibliography entry.

### Review and History Components

- `ChangeSetList`
- `ChangeSetCard`
- `DiffViewer`
- `InlineDiffBlock`
- `AcceptRejectBar`
- `VersionTimeline`
- `RestoreVersionDialog`
- `CommentThread`
- `SuggestionMarker`

### Reference Components

- `BibFileSelector`
- `CitationSearch`
- `CitationResultRow`
- `ReferencePreview`
- `MissingReferenceList`
- `UnusedReferenceList`
- `CitationInsertMenu`

## Interaction Best Practices

### Keyboard First

Required shortcuts:

- `Cmd/Ctrl+P`: quick open file.
- `Cmd/Ctrl+Shift+P`: command palette.
- `Cmd/Ctrl+B`: toggle sidebar.
- `Cmd/Ctrl+Enter`: compile.
- `Cmd/Ctrl+I`: ask AI about selection/current file.
- `Cmd/Ctrl+Shift+E`: focus diagnostics.
- `Cmd/Ctrl+Alt+Left/Right`: SyncTeX source/PDF jump.

Expose shortcuts in command palette and tooltips. Monaco's accessibility guide highlights command palette and keyboard navigation as essential for mouse-free editor usage.

### Status Visibility

Every long operation must show state:

- Saving
- Compiling
- PDF stale/current
- Agent reading/editing/running build/waiting for approval
- Provider disconnected/rate limited
- SyncTeX unavailable

This follows the UX heuristic that users need timely system feedback.

### Error Recovery

LaTeX errors should never be only raw logs.

Each diagnostic item should include:

- Severity
- File and line
- Plain-language summary
- Raw log excerpt
- Suggested next step
- "Open line"
- "Ask agent to fix"

### Progressive Disclosure

Default panes should be clean, but advanced users need depth:

- Show concise diagnostics first, raw logs behind disclosure.
- Show agent result first, full transcript behind disclosure.
- Show compile settings in a compact menu, full settings in dialog.
- Show citation preview on demand.

### Layout Persistence

Persist per-project layout:

- Open files
- Split ratios
- Active sidebar activity
- Bottom panel visibility
- PDF zoom/page mode
- Agent panel width

VS Code and Codetta both show the value of preserving workspace state across sessions.

## Accessibility Requirements

- All icon-only buttons need accessible labels and visible tooltips.
- Full keyboard operation for project tree, tabs, command palette, dialogs, and diagnostics.
- Focus rings must be visible in the light theme.
- Support a high-contrast light theme.
- Use semantic colors plus icons/text, not color alone.
- Monaco screen-reader mode must remain available.
- Resizable dividers need keyboard alternatives.
- Minimum text contrast: WCAG AA.
- Do not use tiny 11px text for critical data like errors, file names, or agent approvals.

## What Not To Copy From Dribbble

- Oversized rounded cards for everything.
- Decorative gradient backgrounds behind dense editor UI.
- Dark IDE frames and dark application shells.
- Mobile-first bento grids for desktop writing workflows.
- AI chatbot UI that hides file operations and diffs.
- One-note purple/blue palettes.
- Floating toolbars for critical compile/save/file actions.
- Hero-style typography inside operational panels.

## MVP UI Scope

Ship these first:

1. Project dashboard.
2. Workbench shell with activity rail, project tree, Monaco editor, PDF pane.
3. Compile button/status and diagnostics panel.
4. Settings dialog for editor/compiler/provider basics.
5. Agent panel with provider picker, task composer, tool-call timeline, and diff summary.
6. Diff review screen.
7. Citation search panel.

Defer these:

- Full visual editor.
- Real-time multiplayer collaboration.
- Comments and track changes beyond local agent suggestions.
- Template marketplace polish.
- Mobile layout.
- Heavy dashboard analytics.

## Recommended UI Library Stack

- React + TypeScript
- Tailwind CSS with CSS-variable design tokens
- shadcn/ui component source as the starting kit
- Radix primitives for accessible dialogs, menus, popovers, tabs, tooltips, toggles, and command surfaces
- Lucide React for icons
- Monaco Editor for LaTeX/source editing
- PDF.js for preview
- xterm.js only if a terminal becomes necessary; avoid terminal in MVP unless needed for build visibility

## Source References

- Dribbble Piilot manuscript editor: https://dribbble.com/shots/26748697-AI-Content-Manuscript-Editor-UX-UI-design
- Dribbble HotMemos document editor: https://dribbble.com/shots/27237616-HotMemos-AI-Powered-Document-Editor-Collaboration-Space
- Dribbble Textia AI writing dashboard: https://dribbble.com/shots/25974030-Textia-Dashboard-UI-Design-for-an-AI-Writing-Assistant
- Dribbble Modern Writing & Documents: https://dribbble.com/shots/26925720-Modern-Writing-Documents-App-UI-UX-Design
- Dribbble SharePad collaborative editor: https://dribbble.com/shots/1740023-SharePad-UI-Design
- Dribbble dev dashboard search: https://dribbble.com/search/dev-dashboard
- Overleaf redesigned editor: https://docs.overleaf.com/getting-started/how-do-i-use-overleaf/redesigned-overleaf-editor
- VS Code user interface: https://code.visualstudio.com/docs/editing/userinterface
- Codetta AI editor benchmark: https://codetta.dev/
- Nielsen Norman Group usability heuristics: https://www.nngroup.com/articles/ten-usability-heuristics/
- Monaco accessibility guide: https://github.com/microsoft/monaco-editor/wiki/Monaco-Editor-Accessibility-Guide
- Radix primitives docs: https://www.radix-ui.com/primitives/docs
- shadcn/ui components: https://ui.shadcn.com/docs/components
- Lucide icons: https://lucide.dev/
