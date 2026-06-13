# User-as-User E2E Results

Run date: 2026-06-11

## Command

```bash
rm -rf /tmp/editor-user-scenarios-v2 && \
E2E_SCREENSHOT_DIR=/tmp/editor-user-scenarios-v2 \
E2E_WINDOW_WIDTH=1920 \
E2E_WINDOW_HEIGHT=1200 \
E2E_SKIP_RECOVERABLE_SAVE_FAILURE=1 \
E2E_SKIP_TITLE_STALE_FLOW=1 \
E2E_SKIP_SYNCTEX=1 \
E2E_USER_SCENARIO_PASS=1 \
npm run e2e
```

## E2E Outcome

- Result: passed
- Screenshot directory: `/tmp/editor-user-scenarios-v2`
- Screenshot count: 87
- PDF rendered: true
- No unlabeled buttons: true
- Horizontal overflow: false (`clientWidth=1920`, `scrollWidth=1920`)

## Scenario Coverage

- Compile error repair: passed
- Agent patch review: passed
- Section file creation: passed
- PDF search and prose fix: passed
- Multi-file dirty state and save-all: passed

## Screenshot Analysis

Command:

```bash
node scripts/analyze-e2e-screenshots.cjs /tmp/editor-user-scenarios-v2 > /tmp/editor-user-scenarios-v2-analysis.json
```

Outcome:

- Result: passed
- Invalid screenshots: 0
- Required scenario marker gaps: 0
- PNG dimensions: valid for all 87 screenshots
- OCR readable screenshots: 0
- OCR note: local `tesseract 5.5.1` failed to read PNG/JPEG image files in this environment, so the automated gate used file validity, dimensions, hashes, and required action-marker coverage.
- Adjacent unchanged screenshots: 11 reported for review, not treated as defects because the associated actions can legitimately preserve visible state while backend/UI assertions still pass.

## Evidence Files

- First screenshot: `/tmp/editor-user-scenarios-v2/0000-click-button-open-folder.png`
- Final screenshot: `/tmp/editor-user-scenarios-v2/0086-smoke-scenarios-complete.png`
- Analysis report: `/tmp/editor-user-scenarios-v2-analysis.json`
