# User-as-User E2E Scenario Plan (Live App)

## Goal

Validate the editor from an actual user perspective with five high-value editing workflows, each broken down by action-level UI steps and screenshot checks (excluding backend-verification-only moments like compile result assertions).

## Shared test harness settings

- Screenshot dir: `E2E_SCREENSHOT_DIR=/tmp/editor-user-scenarios-v2`
- Viewport: `E2E_WINDOW_WIDTH=1920 E2E_WINDOW_HEIGHT=1200`
- Deterministic skips used in this pass:
  - `E2E_SKIP_RECOVERABLE_SAVE_FAILURE=1`
  - `E2E_SKIP_TITLE_STALE_FLOW=1`
  - `E2E_SKIP_SYNCTEX=1`
  - `E2E_USER_SCENARIO_PASS=1`
- Test file: `scripts/e2e-smoke.cjs`
- Post-run analysis:
  - Validate screenshot existence, file size, and PNG dimensions
  - Attempt OCR with `tesseract` when the installed binary can read local images
  - Validate per-action visual delta against previous screenshot (`sha256`)
  - Validate required screenshot labels exist for every planned scenario

---

## Scenario 1 — Recover from a compile-breaking syntax error

### User intent

_As a user, I open a project, compile, get an actionable error, and fix it in place._

### Step plan

1. Open folder and wait for project health/toolbar readiness.
2. Click **Compile project**.
3. Open **Log** and then **Problems**.
4. Open the missing `\end{document}` diagnostic.
5. Replace content to restore `\end{document}`.
6. **Save file**.
7. Re-run compile and confirm success.

### UI/UX checks (screenshot scope)

- Problem link is selectable and readable.
- Main editor tab shows dirty state after edit and clear save state after save.
- Compile action remains available from error state.
- No layout clipping in header/tool areas.

---

## Scenario 2 — Agent-assisted compile repair with patch review

### User intent

_As a user, I ask the AI agent to repair a compile issue, review the proposed minimal patch, and approve it only after seeing the change._

### Step plan

1. Reintroduce the missing terminator after the first manual repair.
2. Save the broken file.
3. Enter a prompt asking the agent to keep the compile fix minimal.
4. Send the prompt.
5. Review the proposed patch and approval surface.
6. Approve the patch and wait for verified compile success.

### UI/UX checks (screenshot scope)

- Agent prompt input is discoverable and editable.
- Patch approval UI is readable and not hidden by surrounding panels.
- Status updates clearly communicate waiting, applying, and verified states.

---

## Scenario 3 — Cross-file structure editing with file-tree operations

### User intent

_As a user, I create a new project section file, edit it, and wire it into the main document._

### Step plan

1. Click **New folder** and create `sections`.
2. Click **New file** and create `evaluation.tex`.
3. Edit `sections/evaluation.tex` content.
4. Save file.
5. Re-open `main.tex`, update it to include the new section, and compile.

### UI/UX checks (screenshot scope)

- Tree affordances are discoverable and provide immediate visual feedback.
- New entries appear and are selectable.
- Focus and tab switching are stable.
- No unlabeled action icon is introduced in these steps.

---

## Scenario 4 — PDF search and prose correction

### User intent

_As a user, I search compiled PDF output, find repeated terminology, correct the source text, and recompile._

### Step plan

1. Search the PDF for `RAG`.
2. Step through multiple PDF matches.
3. Search for a missing term and confirm the no-match state.
4. Open `main.tex` and correct inconsistent source casing.
5. Save, compile, and search again to confirm visible output remains searchable.

### UI/UX checks (screenshot scope)

- PDF search input and navigation buttons are reachable.
- Match counters and page indicators update visibly.
- No-match feedback is clear.
- Source edit/save/compile state remains coherent after PDF navigation.

---

## Scenario 5 — Multi-file dirty state and save-all

### User intent

_As a user, I keep multiple tabs open, edit two files, and verify the save-all workflow clears only the right dirty states._

### Step plan

1. Open `method.tex` and `results.tex`.
2. Edit `method.tex` and `results.tex`.
3. Confirm only edited tabs show unsaved markers.
4. Attempt to close a dirty tab and cancel the discard confirmation.
5. Click **Save all files**.
6. Verify both edited files saved and dirty markers clear.

### UI/UX checks (screenshot scope)

- Dirty indicators are correct per tab.
- Save-all feedback is explicit and readable.
- Canceling a dirty-tab close does not discard content.
- The canceled dirty-tab close leaves the edited tab visible and dirty.

---

## Screenshot analysis runbook

### 1) Capture

Executed by `npm run e2e` with `E2E_SCREENSHOT_DIR` enabled and the above flags.

### 2) Screenshot validity/per-action validation

For each generated `*.png`:

- Validate file exists and is non-empty.
- Validate PNG header dimensions are non-zero.
- Attempt OCR via `tesseract <image> stdout --psm 6`; OCR text is included when available.

### 3) State mutation validation

For each pair of adjacent screenshots where the expected action is a visible UI mutation:

- Compare `sha256` and report identical adjacent frames for review.

### 4) Defect criteria for this pass

- Missing screenshot
- Zero-byte or invalid PNG screenshot
- Missing required screenshot marker for any of the five planned scenarios

---

## Notes

- SyncTeX navigation is intentionally skipped via `E2E_SKIP_SYNCTEX=1` for this pass to keep this objective focused on core editing, saving, panel, PDF search, and agent workflows.
- Backend correctness (compile status, build return code, and diagnostics) is still asserted by the E2E script where present, but this pass’s UI/UX inspection is centered on screenshot evidence.
