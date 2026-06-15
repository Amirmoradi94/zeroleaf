<claude-mem-context>
# Memory Context

# [overleaf-clone] recent context, 2026-06-15 1:28pm EDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (19,451t read) | 990,373t work | 98% savings

### Jun 11, 2026
7518 12:59p 🔵 Codex Provider Architecture and Agent Host IPC Contracts Mapped
7519 " 🔵 createFileBackedAgentBroker and HistoryStore Integration Pattern Confirmed
7521 " 🔵 project-service Public API Surface Mapped for Test Runner
7523 " 🟣 Real Codex Agent Test Runner Script Created
7524 1:02p 🔴 Case 01 Initial Compile Expectation Corrected to "succeeded"
7525 " 🔵 First Real Codex Test Run: Two Initial Compile Expectation Mismatches Found
7526 " 🔴 Both Compile Expectation Mismatches Fixed After Real Test Run Evidence
7527 " 🔴 Compile Expectation Patch Matched Wrong Cases — Case 02 Accidentally Swapped
7529 " 🔵 Third Run: Cases 01, 02, 03 All PASS — Compile Expectations Now Correct
7528 1:03p 🔴 Compile Expectations for Cases 02 and 04 Correctly Fixed Using ID Anchors
7530 1:04p 🟣 All 5 Real Codex Agent Test Cases Pass — Full Suite Green
7531 " 🔵 Codex Agent Patch Content Verified — All Four Edit Cases Produced Minimal Correct Diffs
7532 1:05p ✅ Real Codex Agent QA Session Completed — All Artifacts Untracked, AGENTS.md Updated
7542 2:46p 🔵 Workbench Layout System Mapped — Default Widths May Clip Agent Panel
7543 " 🔵 content-row Grid Structure Requires ~1472px Total to Show All Panes at Defaults
7544 " 🔵 Layout Load Effect Does Not Call constrainLayoutToContentWidth — Root Cause Confirmed
7545 2:47p 🔴 Default Agent Panel Width Increased and Minimum Raised to Fix Agent Panel Clipping
7546 " 🔴 useLayoutEffect Added to Constrain Layout After Load and on Window Resize
7547 2:48p ✅ Dev Server Restarted on Port 5174 to Apply Layout Fix
7578 7:15p 🟣 AgentLiveStatus widget replaces flat provider-status text
7579 " 🔄 Agent event stream split into conversation and activity sections
7580 " 🔄 AgentEventCard redesigned with structured header layout and helper formatters
7581 " 🟣 Agent pane CSS fully redesigned with chat-bubble and activity-feed visual language
### Jun 12, 2026
7630 2:26p 🔵 Agent Panel Architecture Discovered in Overleaf Clone
7631 " 🟣 Agent Panel Header Redesigned with Provider Badge and Connection Pill
7632 " 🟣 AgentEventCard Restructured with Icon + Body Layout and Tone Classes
7633 " 🟣 Live Status Banner Redesigned as Floating Card with Pulse Animation
7634 2:31p 🟣 Full Agent Panel CSS Overhaul: Chat Bubbles, Timeline, Animations, and Accessibility
7636 " ✅ Agent Panel Redesign Tests Pass — App.render.test.tsx Green
7637 " ✅ Agent Panel Redesign Passes TypeCheck and Production Build
7638 " ✅ Electron Dev Server Started for Visual Verification of Agent Panel Redesign
7639 " 🔵 Visual Verification Blocked: iab Browser Unavailable, Playwright/Puppeteer Not Installed
7640 2:33p 🔵 Electron Dev App Confirmed Running but Visual Verification Abandoned
7641 " 🔵 App.tsx Excluded from Project ESLint Config — Lint Passes on Scripts Only
7642 " 🔴 Prettier Formatting Applied to App.tsx After Agent Panel Redesign Patches
7643 " ✅ Agent Panel Redesign Complete — All Quality Gates Pass
7644 " 🔵 Full Diff Reveals Agent Panel Redesign Scope vs Pre-Existing Changes
7655 " ⚖️ Two Agent Panel UX Requirements Identified: Activity Cleanup and Markdown Rendering
7645 2:34p 🔵 Working-Tree Diff Scale: 5145 Insertions, 720 Deletions Across Agent Panel Files
### Jun 14, 2026
7822 11:13p ✅ Remove Bibliography/References from Left Panel
7823 11:14p 🔵 Bibliography/References Left Panel Location Identified in App.tsx
7824 " 🔵 References Panel Exists in Both Left Sidebar AND Bottom Panel
7825 " ✅ Removed Bibliography/References Panel from Left Sidebar Activity Rail
7826 " 🟣 Agent History Persisted to localStorage Across Sessions
7827 " ✅ Agent Mode "read-only" Renamed to "suggest" Throughout Codebase
7828 " 🟣 Agent Can Create Projects Without an Open Project via NLP Command Parsing
7829 " 🟣 Agent Pane Gains Elapsed Timer, Clear History Button, and Auto-Scroll
7830 " 🟣 Agent Build Results Update PDF Preview After Successful Compile
7832 " ⚖️ Cloud-Based Project Sharing Identified as Required Feature
7831 11:16p ✅ References Removal Verified: TypeCheck and Render Tests Pass

Access 990k tokens of past work via get_observations([IDs]) or mem-search skill.
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
