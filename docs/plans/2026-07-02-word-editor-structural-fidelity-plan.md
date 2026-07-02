# Word Editor Structural Fidelity Plan (Agent Table/Image/Formatting Edits)

Date: 2026-07-02

## Goal

Let the agent edit tables, images, and formatted content inside ONLYOFFICE
`.docx` documents, not just flat paragraph text. Give the agent a real
document structure to target (headings, tables with cells, images with
position context) instead of inferring position from rendered pixels.

## Problem With The Current Slice

`packages/document-service` (see
[2026-06-23-dual-latex-word-editor-plan.md](2026-06-23-dual-latex-word-editor-plan.md))
extracts `.docx` by regex-walking `<w:t>` runs into flat plain-text
paragraphs, then regenerates a brand-new `.docx` from those paragraphs using
the `docx` npm package on apply. This is explicitly called out under "Known
Limits Of The First Slice": tables, images, headings, lists, footnotes, and
equations do not round-trip. A table today is silently reduced to
concatenated cell text inside a single paragraph. The agent cannot target a
table cell or an image because `WordDocumentBlock` has no representation for
them.

## Guiding Decision: Structure Drives Edits, Vision Verifies Them

Document position ("which table," "which image," "which cell") should come
from ONLYOFFICE's own document object model, not from pixel coordinates in a
screenshot. OOXML/Automation structure gives exact, stable, addressable
targets and produces clean before/after diffs for review and rollback.
Screenshots are unreliable for precise targeting and produce no reviewable
diff. Vision analysis is used only for two secondary purposes: post-edit
visual QA (did a table overflow, does an image now overlap text) and
resolving ambiguous natural-language references from a human ("the chart top
right of page 2") back to a structural element ID.

## Phase 3A: Structural Document Model

- Replace flat-paragraph extraction with a typed node tree in
  `WordDocumentModel`: `paragraph` (style, heading level, list level),
  `table` (rows x cells, each cell holding child blocks with a stable
  `cellId`), `image` (anchor type inline/floating, position context, alt
  text, size), `heading`, `sectionBreak`.
- Source this tree from ONLYOFFICE's **Document Builder** API
  (`Api.GetDocument()`, `oDocument.GetElementsCount/GetElement`,
  `oTable.GetRow/GetCell`, `Api.CreateImage`, etc.) run **headlessly** against
  the Document Server's builder endpoint, instead of regex-walking OOXML by
  hand. Headless execution does not require a live editor session.
- The agent's `activeDocument` context becomes this structural tree with
  stable IDs (e.g. `h-2-...`, `tbl-1-...`, `tbl-1-r2c3-...`, `img-1-...`)
  instead of flat paragraph text.
- Spike first (Phase 3A-0 below) to confirm the local Document Server image
  actually exposes a usable headless Document Builder path before committing
  the rest of the phase to it.

### Phase 3A Implementation Status

Implemented on 2026-07-02:

- Added `WordStructureNode` (`WordStructureParagraphNode` |
  `WordStructureTableNode`) and `WordStructureTableCell` types to
  `ipc-contracts`, plus optional `structure`/`structureWarnings` fields on
  `WordDocumentModel` and `AgentActiveDocument`. Additive only — existing
  `blocks`/`plainText` consumers are unchanged.
- Extended `OnlyOfficeBridgeService` with `extractWordStructure(projectRoot,
  filePath)`: builds a Document Builder script (`buildStructureExtractionScript`)
  that opens the document by URL through the existing session-serving
  mechanism, walks `Api.GetDocument().GetElementsCount()/GetElement(i)`,
  reads paragraph text/style via `GetText()`/`GetStyle().GetName()`, and
  table dimensions/cells via `GetRowsCount()`/`GetRow(r).GetCellsCount()/
  GetCell(c)`, serializes the result as JSON wrapped in marker text inside a
  throwaway output `.docx` (the same mechanism validated in the Phase 3A-0
  spike), then parses that back out. A new
  `/onlyoffice/builder-scripts/:id/:token` route serves the generated script
  to the Document Server, mirroring the existing session-document route.
  Stable structural IDs are computed the same way as existing paragraph
  block IDs (`sha256` of index+content, truncated).
- The method degrades gracefully (returns `{ structure: [], warnings: [...]
  }`, never throws) when ONLYOFFICE is disabled or the Document Server is
  unreachable, so `.docx` reading keeps working exactly as before when
  ONLYOFFICE isn't running.
- Wired into `apps/desktop/src/main/index.ts`: `word.read`,
  `word.applyChangeSet`, and `word.rollbackChangeSet` all merge structure
  into the returned `WordDocumentModel` via a shared `withWordStructure`
  helper, so structure stays fresh after edits.
- Wired into the renderer (`App.tsx`): `EditorFileState` carries
  `wordStructure`/`wordStructureWarnings`, and both `activeDocument`
  construction sites (initial agent call, follow-up/continuation calls) pass
  them through to the agent request.
- Both agent providers (`provider-openai-codex`, `provider-anthropic-claude`)
  gained a `formatActiveWordStructureContext` prompt section that renders
  headings as `Heading (level N): "..."` and tables as a `| cell | cell |`
  grid, explicitly labeled read-only context (table cells cannot be
  targeted by block operations until Phase 3B ships).
- Verified with a live round trip (not just mocked tests): wrote a real
  `.docx` with a heading, body paragraph, and 2x2 table using the `docx` npm
  library (the same library `document-service` uses to write project
  files), then called the shipped `extractWordStructure` against the real
  local Document Server. All fields extracted correctly with zero warnings.
- Added unit tests: a full `extractWordStructure` round trip against a
  mocked Document Server in `onlyoffice-service`, plus prompt-inclusion
  tests in both provider packages confirming headings/tables actually
  appear in the text sent to the model.

### Known Simplifications In This Slice

- **Headings are not a separate node type.** A heading is represented as a
  `paragraph` node with `headingLevel`/`styleName` set, since that is how
  ONLYOFFICE's own object model represents it (a styled paragraph, not a
  distinct element type). This is more faithful to the underlying model than
  the originally sketched separate `heading` node kind and was simpler to
  implement; revisit only if a consumer needs to filter headings without
  also handling plain paragraphs.
- **Image nodes are not implemented.** `Api.GetAllImages()` and
  `paragraph.GetAllDrawings()` do not exist on the validated Document Server
  version (confirmed via live spike — both throw `TypeError`). A paragraph
  containing a drawing shows up as `GetElementsCount() > 0` with an empty
  `GetText()`, which the extraction script flags via
  `hasNonTextContent: true` on the paragraph node as a weak signal, but no
  `image` node with anchor/size/caption metadata is produced yet. Finding
  the correct drawing-introspection call (likely one level deeper, inside
  the paragraph's `run`-classified child elements) is unfinished work for a
  follow-up pass — Phase 3B/3D should not assume image nodes exist until
  that lands.
- **List-level detection is not implemented** for the same reason: not
  validated against a real API call, deliberately left out rather than
  guessed.
- The Claude provider's prompt never lists paragraph block IDs at all (a
  pre-existing gap unrelated to this phase, found while wiring the structure
  formatter next to it) — flagged separately, not fixed here.

## Phase 3A-0: Spike — Document Builder Headless HTTP Path

Purpose: de-risk Phase 3A before investing in the structural model rewrite.

- Confirm the `zeroleaf-onlyoffice-dev` container's Document Server image
  exposes a docbuilder execution endpoint reachable over HTTP from the main
  process, matching the existing `JWT_ENABLED=false` local dev setup.
- Run a minimal builder script against a sample project `.docx` that: (a)
  reads back paragraph/table/image counts, (b) performs one structural edit
  (replace a table cell's text) and confirms the resulting bytes still open
  correctly in ONLYOFFICE.
- Record findings (endpoint shape, auth requirements, script execution
  latency, error modes) directly in this doc under "Spike Findings" once
  done. If the endpoint is not available in the local image, evaluate
  whether the connector/live-session path (Phase 3C) can substitute as the
  primary mechanism instead.

### Spike Findings

Confirmed live 2026-07-02 against the local `zeroleaf-onlyoffice-dev`
container (`http://127.0.0.1:8082`, `JWT_ENABLED=false`). First attempt that
day found Docker Desktop's backend wedged (`docker ps`/`docker info` hung
indefinitely; backend processes had been idle since 2026-06-23 with no main
GUI process running). Force-quitting the stuck `com.docker.backend`/
`com.docker.build` processes and relaunching Docker Desktop fixed it; the
container then started cleanly via `npm run onlyoffice:start`.

With the daemon healthy, ran an end-to-end round-trip:

1. A tiny local HTTP server on the host (`0.0.0.0:8091`) served two builder
   scripts and an intermediate `.docx`, reachable from inside the container
   via `host.docker.internal` (confirmed resolvable with `docker exec ...
   getent hosts host.docker.internal`).
2. **Create phase** — `POST /docbuilder` with
   `{ async: false, url: "http://host.docker.internal:8091/create.js" }`
   ran a script that built a fresh `.docx` from scratch: one paragraph plus a
   2x2 table (`Api.CreateTable(2, 2)`, `table.GetRow(r).GetCell(c)
   .GetContent().GetElement(0).AddText(...)`), saved with
   `builder.SaveFile("docx", "create-result.docx")`. Response came back
   synchronously as `{ key, urls: { "create-result.docx": "<download url>" },
   end: true }`, matching the documented shape exactly. Downloaded and
   confirmed via `word/document.xml` that all four cells and the paragraph
   were present.
3. **Edit phase** — re-served that file, then ran a second script using
   `builder.OpenFile("http://host.docker.internal:8091/sample.docx")` to open
   the *existing* document (not create a new one), used
   `Api.GetDocument().GetElementsCount()` / `GetElement(i).GetClassType()` to
   walk the structure and identify the table among the elements, then
   targeted exactly one cell (`GetRow(1).GetCell(1)`) and replaced its text,
   leaving the paragraph and the other three cells completely untouched.
4. Downloaded the result and verified: the intro paragraph and cells R0C0,
   R0C1, R1C0 were byte-identical to the original; only the targeted cell's
   text changed (`R1C1-ORIGINAL` → `R1C1-EDITED-BY-AGENT`); a diagnostics
   paragraph confirmed `elementsCount=4`, `table.rowCount=2`,
   `cell-edit=ok`. All 7 verification checks passed.

This is the core capability Phase 3A/3B need and the current
paragraph-rebuild approach cannot provide: **read structure, target one
element precisely, edit it, and leave everything else in the document byte-
for-byte untouched.** No JWT token was needed locally (`JWT_ENABLED=false`),
consistent with existing dev setup docs.

The original documentation-level read (kept below for the request/response
shape reference) is now confirmed correct in practice:

- The Document Server exposes `POST /docbuilder` alongside the existing
  `/coauthoring/CommandService.ashx` and `/converter` endpoints already used
  by `OnlyOfficeBridgeService`. Same host/port as the editor and converter
  (`http://127.0.0.1:8082` locally), so no new service/port is needed.
- Request body: `{ url, async, key, token, argument }`, where `url` is an
  **absolute URL to a `.js` builder script** the Document Server fetches and
  runs — not inline script text. This means our bridge needs to serve
  generated builder scripts the same way it already serves session document
  bytes (`/onlyoffice/sessions/:id/:token/document`); a
  `/onlyoffice/sessions/:id/:token/builder-script` route following the same
  pattern is the natural fit.
- The script uses `builder.OpenFile(<absolute url>)` to load an existing
  `.docx` from a URL, `Api.GetDocument()` plus `Api.*` classes
  (`GetElementsCount`, `GetElement`, table row/cell accessors, etc.) to read
  or mutate structure, then `builder.SaveFile(format, filename)` and
  `builder.CloseFile()`. `OpenFile` also takes an absolute URL, so the
  existing document-serving route can be reused as the input source instead
  of a new one.
- Async requests return `{ key, end: false }` and must be polled with the
  same `key` until `{ end: true, urls: {...} }`; synchronous (`async:
  false`) requests block and return the result directly, which matches the
  request/response shape our current `forceSave`/`exportPdf` calls already
  handle synchronously.
- JWT is "required by configuration," consistent with the existing
  `jwtSecret`/`signOnlyOfficeJwt` handling in `OnlyOfficeBridgeService` — the
  same signing helper should cover `/docbuilder` requests with no new crypto
  work.

Net: confirmed — this requires no different Document Server image and no
additional service. It is an incremental extension of
`OnlyOfficeBridgeService`: a new route to serve generated builder scripts
(mirroring the existing `/onlyoffice/sessions/:id/:token/document` route),
a new method to POST `/docbuilder` (with async polling for larger documents),
and reuse of the existing `signOnlyOfficeJwt` helper once JWT is enabled.
Phase 3A can proceed on this mechanism.

Sources:
- [Document Builder API | ONLYOFFICE](https://api.onlyoffice.com/docs/docs-api/additional-api/document-builder-api/)
- [Overview | ONLYOFFICE](https://api.onlyoffice.com/docs/document-builder/get-started/overview/)

## Phase 3B: Table And Image Block Operations

- Extend `WordBlockOperation` with table operations (`replace-cell`,
  `insert-row`, `delete-row`, `insert-column`, `merge-cells`) and image
  operations (`replace-image`, `move-image`, `resize-image`, `set-caption`),
  each targeting the stable structural IDs from Phase 3A.
- `document-service.applyWordChangeSet` translates these into Document
  Builder script calls instead of pure-JS array manipulation, so applied
  `.docx` bytes retain formatting/tables/images that the current rebuild
  destroys.
- No change needed to changeset persistence, snapshot-hash rollback, or
  history storage (Phase 2B/2C) — those are byte-level and agnostic to how
  the new bytes were produced.

### Phase 3B Spike: Table Write API Surface

Before implementing, live-probed which `ApiTable`/`ApiTableRow`/`ApiTableCell`
write methods actually exist and what their real argument order/semantics
are on this Document Server version, the same way Phase 3A-0 de-risked the
read path. Introspected method names via prototype-chain walking, then
exercised each candidate against fresh and opened-from-file tables:

- `Api.CreateTable(nRows, nCols)` — rows first, confirmed by creating an
  asymmetric 2x5 table and reading `GetRowsCount()`/`GetCellsCount()` back.
- `Table.AddRow()` / `Table.AddColumn()` / `Table.RemoveRow(index)` /
  `Table.RemoveColumn(index)` called directly on the table are **not
  position-aware and mostly no-ops or append-only** — `RemoveRow`/
  `RemoveColumn` silently did nothing in testing. Do not use these.
- `Row.AddRows(count, isBefore)` — insert `count` rows immediately
  before/after this row. Confirmed the correct position-aware row insert.
- `Row.Remove()` — removes this row. Confirmed.
- `Cell.AddColumns(count, isBefore)` — insert `count` columns immediately
  before/after this cell's column. Confirmed the correct position-aware
  column insert (lives on `Cell`, not `Row` or `Table`).
- `Cell.RemoveColumn()` — removes this cell's column. Confirmed.
- `Cell.SetText(text)` — replaces cell content with plain text in one call
  (simpler than walking `GetContent()` paragraphs manually). Confirmed.
- `Table.MergeCells([cell1, cell2, ...])` — takes an **array** of cells, not
  two corner cells (`MergeCells(cellA, cellB)` returns `null`/fails). Merged
  cell text is the row-major concatenation of source cells joined by
  `\r\n`; swallowed cells remain as empty entries in the row (matches OOXML
  merge/span representation, so structure extraction sees them as empty
  cells rather than a shrunk row). Confirmed for horizontal, vertical, and
  2x2 block merges.
- Re-validated all of the above against a table opened via `OpenFile` +
  `GetElementsCount()`/`GetElement(i)` scan (not just a freshly
  `Api.CreateTable`'d object in the same script), since that's the real
  code path production uses. Identical behavior.

### Phase 3B Implementation Status

Implemented on 2026-07-02:

- Added `WordParagraphBlockOperation` (the original 5 operation kinds) and
  `WordTableOperation` (`replace-table-cell`, `insert-table-row`,
  `delete-table-row`, `insert-table-column`, `delete-table-column`,
  `merge-table-cells`) to `ipc-contracts`, with `WordBlockOperation` as
  their union and an `isWordTableOperation` type guard. Table operations
  target a table by its `WordStructureTableNode.id` (from Phase 3A) plus
  0-based row/column indices, matching the structure the agent already
  sees.
- **A `WordChangeSet`'s operations must be either all paragraph operations
  or all table operations, never mixed.** Table operations are applied
  through ONLYOFFICE's Document Builder; paragraph operations are applied
  through the existing `docx`-npm full-document rebuild in
  `document-service`. Interleaving them in one changeset would let the
  paragraph rebuild silently destroy table structure, so this is enforced
  in three places: `document-service` throws if handed a table operation
  (`assertParagraphBlockOperations`), the desktop main process
  (`resolveWordTableOperations`) routes a changeset to one path or the
  other and throws on a mixed changeset, and both provider prompts tell the
  model to use separate changesets instead of mixing.
- Added `OnlyOfficeBridgeService.applyWordTableOperations(projectRoot,
  filePath, operations)`: resolves each operation's table back to a
  document element index (encoded in the `tbl-{index}-{hash}` id format
  from Phase 3A, parsed with `parseTableElementIndex`), builds a Document
  Builder script (`buildTableWriteScript`) that opens the document, locates
  each table via `GetElement(index)`, and applies the corresponding
  row/cell/column/merge call from the spike above, then saves the result
  and writes it back to disk via the existing `writeSavedDocument` helper
  (the same atomic-write-plus-history-snapshot-hooks path used for live
  ONLYOFFICE editor saves). Degrades gracefully (`{ ok: false, error }`,
  never throws) when disabled, unreachable, or given a malformed table id.
  No new HTTP route was needed — the existing
  `/onlyoffice/builder-scripts/:id/:token` route from Phase 3A already
  serves arbitrary generated scripts.
- Wired into `apps/desktop/src/main/index.ts`'s `word.applyChangeSet`
  handler: after creating the before-snapshot (unchanged), a table
  changeset calls `onlyOfficeBridge.applyWordTableOperations` instead of
  `document-service`'s `applyWordChangeSet`, then re-reads the document and
  marks the changeset applied through the same history-service calls as
  the paragraph path, so rollback and audit history work identically for
  both kinds of changeset.
- Both agent providers gained the 6 new operation types in their JSON
  schemas (Codex's flat nullable-field schema and Claude's plain-optional
  schema), validation, and — for Codex, which normalizes model output —
  normalization functions. `formatWordStructureNode`'s table grid now
  prints the table id and explicit `R{row}C{col}` labels (previously
  unlabeled) so the model has concrete coordinates to target, and the
  former "read-only, cannot be targeted" prompt caveat was removed since
  tables are now writable.
- Verified with a live round trip against the real Document Server (not
  just mocked tests): wrote a real `.docx` with a heading, paragraph, and
  2x2 table via the `docx` npm library, extracted its structure to get a
  real table id, then called the shipped `applyWordTableOperations` with a
  cell replace + row insert + two cell replaces on the new row. Re-extracted
  the structure afterward and confirmed: the table grew to 3 rows, the
  targeted cell changed, the new row's cells had the right text, the
  untouched row was byte-for-byte the same, and the heading/body paragraphs
  outside the table were untouched in the raw XML.
- Added unit tests: a full `applyWordTableOperations` round trip against a
  mocked Document Server plus malformed-table-id and disabled-integration
  error cases in `onlyoffice-service`, and a table-changeset construction
  test in each provider confirming a `replace-table-cell` operation survives
  parsing/validation/normalization into a proper `WordChangeSet`.

### Known Simplifications In This Slice

- **Image operations are not implemented**, consistent with Phase 3A not
  having image structural nodes yet — there is nothing to target.
- **`insert-table-column`/`delete-table-column` operate through row 0's
  cell** (`table.GetRow(0).GetCell(index)`) since column insert/remove is a
  `Cell`-scoped method with no direct table-level equivalent that works;
  this is transparent to callers (the operation still just takes a table id
  and column index) but assumes the table has at least one row, which every
  table does.
- **No automatic reindexing across operations in one changeset.** If a
  changeset has multiple operations against the same table, row/column
  indices in later operations must already account for shifts caused by
  earlier operations in that same changeset (e.g. deleting row 1 twice in a
  row deletes what was originally rows 1 and 2). The live verification test
  above exercises this directly (insert a row, then address the new row by
  its post-insert index) and the prompt instructions call this out
  explicitly to the model.
- **Table ids are positional snapshots, not persistent identity.** A
  `tbl-{index}-{hash}` id is only valid against the document state it was
  extracted from; if the document structure changes between a structure
  read and a changeset apply (e.g. another edit adds a paragraph before the
  table), the id may resolve to the wrong element. This mirrors how the
  existing paragraph `blockId` system already behaves to a similar extent
  and was an accepted tradeoff in Phase 3A too.
- Merged-away cells are not specially represented in the structural read
  model — after a merge, structure extraction reports the swallowed cells
  as present with empty text rather than shrinking the row's cell count,
  which matches OOXML's own row-span representation but means a consumer
  can't yet distinguish "an empty cell" from "a cell absorbed by a merge to
  its left/above" without also tracking merge history.

## Phase 3C: Live-Session Edit Path

- When a human has the document open in the visible ONLYOFFICE iframe, use
  `docEditor.createConnector().callCommand(...)` to run the same Api.*
  operations inside the live session instead of writing to disk and forcing
  a full iframe reload (current `reloadOnlyOfficeWordDocument` behavior).
  This removes the existing "must not be dirty" restriction on applying
  agent changesets and lets the user watch the edit happen live.
- Headless Document Builder (Phase 3A/3B) remains the path used when no one
  has the file open.

## Phase 3D: Vision As QA/Disambiguation, Not Targeting

- After applying an edit, render before/after page images through the
  existing conversion pipeline (already used for PDF export) and run a
  vision check for layout regressions: table overflow, image/text overlap,
  broken heading styles. Surface results as a changeset warning, not a
  blocker.
- For ambiguous human instructions referencing visual position, render the
  page, use vision to locate the region, then match it to the nearest
  structural `image`/`table` ID from the Phase 3A outline. Vision resolves
  *which* structural node; structure still drives the actual edit.
- Extend the History review panel to show table-grid diffs and before/after
  image thumbnails instead of only paragraph text diffs.

## Sequencing

Phase 3A-0 (spike) first, since it determines whether headless Document
Builder is viable in the local Docker image before the structural model
(3A) and block operations (3B) are built on top of it. 3C and 3D are
independent enhancements layered on afterward.

## Non-Goals (This Round)

- Do not implement tracked-changes/comments support.
- Do not implement equation editing.
- Do not change the renderer's no-filesystem-access security boundary.
