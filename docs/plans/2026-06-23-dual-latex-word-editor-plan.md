# Dual LaTeX and Word Editor Plan

Date: 2026-06-23

## Goal

ZeroLeaf should support two first-class editing surfaces in one local-first desktop app:

- A LaTeX source editor for `.tex`, `.bib`, `.sty`, `.cls`, Markdown, and plain text files.
- A Word document editor for `.docx` files.

The integrated agent must be able to read both active editor contexts and eventually propose reviewable edits to either surface without direct renderer filesystem access or unsafe binary file mutation.

## Architecture

Add a dedicated document service for Word workflows:

```text
Renderer Word editor
  -> typed IPC
  -> Electron main
  -> packages/document-service
  -> project-scoped .docx file
```

The renderer remains UI-only. It never reads `.docx` bytes directly. It receives a structured `WordDocumentModel` with stable block IDs, editable text blocks, and extraction warnings. The service reads and writes `.docx` files inside the current project root only.

The agent request gains an optional `activeDocument` context. For LaTeX files this context is still source text. For Word files it is extracted plain text plus structured blocks. Providers use that context instead of attempting to read raw `.docx` bytes.

## Phases

1. **Foundation implemented first**
   - Add `packages/document-service`.
   - Add typed IPC for `word.read` and `word.save`.
   - Open `.docx` files in a separate Word editor surface.
   - Save edited Word paragraphs back to `.docx`.
   - Include active Word document context in agent requests.

2. **Reviewable Word agent edits**
   - Add Word changesets based on block operations:
     `replace-block`, `insert-block-after`, `delete-block`, `move-block`, and `replace-selection`.
   - Store Word snapshots separately from text patch snapshots.
   - Show paragraph/table diffs before apply.
   - Apply accepted block operations through `document-service`.

3. **Richer Word fidelity**
   - Preserve headings, lists, tables, footnotes, comments, images, and equations.
   - Warn when a feature is imported but cannot yet round-trip exactly.
   - Add export validation by reopening saved `.docx` and comparing the block model.

4. **Cross-document agent workflows**
   - Let the agent compare a `.tex` file and a `.docx` file.
   - Let the agent move content between Word and LaTeX through explicit conversions.
   - Keep compile verification LaTeX-only and add DOCX round-trip verification for Word edits.

## Acceptance Criteria

- `.docx` files appear in the project tree and can be opened without corrupting binary content.
- The Word editor uses a different surface from Monaco.
- Editing text in the Word editor and saving produces a valid `.docx` file.
- Agent requests from a Word document include extracted document context.
- Renderer still does not access filesystem, shell, credentials, or arbitrary OS APIs.
- Word write operations are project-root scoped and path traversal safe.

## Known Limits Of The First Slice

The first slice intentionally prioritizes safe project-scoped Word reading/editing over full Microsoft Word fidelity. It round-trips paragraphs as a clean `.docx`; complex formatting, tracked changes, comments, equations, and advanced tables require the later block changeset/fidelity phases.

## Phase 2 Implementation Status

Implemented on 2026-06-23:

- Added `WordBlockOperation`, `WordChangeSet`, and `WordChangeSetApplyResult` IPC contracts.
- Added `word.createChangeSet` and `word.applyChangeSet` IPC channels.
- Added document-service support for paragraph block operations:
  `replace-block`, `insert-block-after`, `delete-block`, `move-block`, and `replace-selection`.
- Applying a Word changeset now saves the `.docx` and reopens it to verify the document is readable.
- Added a History-panel Word review path with before/after paragraph previews and apply/reject actions.
- Updated the mock agent to produce a reviewable Word changeset from active Word document context.
- Updated real provider prompts to describe Word block operations instead of raw `.docx` patching.
- Extended Codex and Claude provider response schemas/parsers with a structured `word-edit`
  action and `wordChangesets` payload.
- Wrapped provider-returned Word block operations as app-owned reviewable `WordChangeSet`
  objects using the active Word document block snapshot.

Remaining Phase 2 follow-up:

- Persist Word changesets in durable history storage once the binary-document history schema is finalized.

## Phase 2B Durable Word Changeset History Plan

Purpose: make Word changesets survive app reloads and keep apply/reject status in
the same local history system used by text patches, without treating `.docx`
files as text diffs.

### Scope

- Store Word changesets in SQLite under `packages/history-service`.
- Keep Word document reading/writing in `packages/document-service`.
- Expose typed IPC methods for listing, creating, marking applied, and rejecting
  Word changesets.
- Load persisted Word changesets into the History panel whenever project history
  refreshes.
- Persist provider-created Word changesets before showing them in the review UI.
- Persist Word apply/reject status changes.

### Data Model

Add a dedicated `word_changesets` table instead of overloading text
`changesets`:

- `id`, `project_id`, `project_root`, `file_path`, `summary`, `status`
- `base_blocks_json` for the reviewed Word block snapshot
- `operations_json` for the block operations
- `created_at`, `updated_at`, `applied_at`

This table has the same project ownership and audit-event behavior as text
changesets. It intentionally does not support hunk acceptance or rollback yet.
Rollback for binary documents needs a richer saved-document snapshot model and
will stay out of this phase.

### Service APIs

Add `HistoryStore` methods:

- `listWordChangeSets(projectRoot)`
- `createWordChangeSet(changeset)`
- `markWordChangeSetApplied(changeset)`
- `rejectWordChangeSet(changesetId)`

`createWordChangeSet` normalizes project root/path, stores the base blocks and
operations as JSON, and records `word-changeset.created`. Apply/reject update
the durable row and record `word-changeset.applied` or
`word-changeset.rejected`.

### IPC And App Flow

Add typed history IPC channels:

- `history.listWordChangeSets`
- `history.createWordChangeSet`
- `history.markWordChangeSetApplied`
- `history.rejectWordChangeSet`

Renderer `refreshHistory()` loads both text and Word changesets. Agent results
that include `wordChangesets` are persisted through `history.createWordChangeSet`
before being selected in the History panel. Applying a Word changeset still calls
`word.applyChangeSet` first; after document-service verifies the saved `.docx`,
the renderer calls `history.markWordChangeSetApplied`. Reject calls the history
IPC instead of mutating React state only.

### Acceptance Criteria

- A proposed Word changeset remains visible after `refreshHistory()` or app
  reload.
- Applying a Word changeset saves/verifies the `.docx` and persists status
  `applied`.
- Rejecting a Word changeset persists status `rejected` and does not write the
  `.docx`.
- Clearing local history removes Word changesets.
- Existing text changeset behavior and tests remain unchanged.

## Phase 2C Agent Word Rollback Plan

Purpose: protect agent-applied `.docx` edits with exact binary rollback while
leaving manual Word editor saves as direct saves.

### Scope

- Capture exact `.docx` bytes before applying an agent Word changeset.
- Store the pre-apply binary snapshot in local history with a content hash.
- Record the post-apply `.docx` content hash on the Word changeset.
- Allow rollback only for applied Word changesets whose current file hash still
  matches the recorded post-apply hash.
- Restore the exact pre-apply bytes and reopen the document through
  `document-service` to verify it is readable.
- Keep manual Word saves out of changeset history.

### Data Model

Add a `word_document_snapshots` table:

- `id`, `project_id`, `project_root`, `file_path`
- `content_hash`, `byte_length`, `contents_base64`
- `created_at`

Extend `word_changesets` with:

- `before_snapshot_id`
- `applied_content_hash`
- `reverted_at`

The before snapshot is attached only when the Word changeset is applied. Proposed
and rejected changesets do not need binary snapshots.

### Flow

1. Renderer calls `word.applyChangeSet`.
2. Main process asks history-service to snapshot the current `.docx` bytes.
3. Main process applies the Word changeset through `document-service`.
4. Main process asks history-service to mark the changeset applied, linking the
   before snapshot and recording the new file hash.
5. Renderer shows rollback for applied Word changesets.
6. Rollback calls `word.rollbackChangeSet`.
7. Main process asks history-service to compare current hash with the recorded
   applied hash, restore the exact before snapshot bytes, mark the changeset
   reverted, and then reopen the restored `.docx` through `document-service`.

### Safety Rules

- Rollback is blocked if the current `.docx` no longer matches the hash created
  immediately after the agent edit was applied.
- Rollback is blocked if no before snapshot is linked.
- Rollback never runs for proposed, rejected, failed, or already reverted Word
  changesets.
- Manual Word saves remain direct saves and do not create Word changesets.
