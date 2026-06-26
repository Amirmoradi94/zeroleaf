const { app, BrowserWindow, ipcMain } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");

let historyStore;
let sandboxPath;
let failed = false;
let projectWatcher;
let projectChangeDebouncer;
let projectChangedEventCount = 0;
let nextFileWriteFailurePath;
let nextSyncTexReverseUnavailable = false;
let nextSharedProjectNumber = 1;
const editorProjectStates = new Map();
let appSettingsState;
const buildRequests = [];
const buildResults = [];
const exportedSourceZips = [];
const exportedSharedSourceZips = [];
const exportedPdfs = [];
const openedExternalPaths = [];
const agentSessions = new Map();
const agentStartRecords = [];
const sharedE2EState = {
  connection: { connected: false },
  users: [],
  sessions: [],
  projects: [],
  members: new Map(),
  invitations: [],
  presence: [],
  comments: [],
  buildArtifacts: [],
  inspectedBuildArtifactIds: [],
  documentOperationsByUpdateId: new Map(),
  agentRuns: [],
  agentChangeSets: [],
  activity: [],
  auditEvents: [],
  revisions: new Map(),
  revisionHistory: [],
  cacheRoot: undefined
};

function createSharedE2EProjectId() {
  const projectId = `shared-project-${nextSharedProjectNumber}`;
  nextSharedProjectNumber += 1;
  return projectId;
}

let nextImportZipPath;
let nextImportDestinationParentPath;
let nextImportProjectName;
let nextCreateDestinationParentPath;
const screenshotDir = process.env.E2E_SCREENSHOT_DIR
  ? path.resolve(process.env.E2E_SCREENSHOT_DIR)
  : undefined;
let screenshotStep = 0;
const screenshotManifest = [];

function toScreenshotLabel(input) {
  return `${String(input ?? "action")}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

async function captureStep(win, label) {
  if (screenshotDir === undefined) {
    return;
  }

  try {
    if (!fsSync.existsSync(screenshotDir)) {
      fsSync.mkdirSync(screenshotDir, { recursive: true });
    }
    const name = `${String(screenshotStep).padStart(4, "0")}-${toScreenshotLabel(label)}.png`;
    screenshotStep += 1;
    const filePath = path.join(screenshotDir, name);
    const image = await win.capturePage();
    await fs.writeFile(filePath, image.toPNG());
    screenshotManifest.push(filePath);
  } catch (error) {
    console.warn(`Screenshot capture failed for ${label}: ${error}`);
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForText(win, text, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `document.body.innerText.includes(${JSON.stringify(text)})`
    );
    if (found) {
      return true;
    }
    await wait(300);
  }
  return false;
}

async function waitForAriaRegionText(
  win,
  regionLabel,
  text,
  { expected = true, timeoutMs = 10_000 } = {}
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const matched = await win.webContents.executeJavaScript(`
      (() => {
        const region = document.querySelector(${JSON.stringify(`[aria-label="${regionLabel}"]`)});
        const haystack = region?.textContent ?? "";
        return haystack.includes(${JSON.stringify(text)});
      })()
    `);
    if (matched === expected) {
      return true;
    }
    await wait(300);
  }
  return false;
}

async function waitForEditorCollaborator(win, titleIncludes, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await win.webContents.executeJavaScript(`
      [...document.querySelectorAll(".editor-collaborator")]
        .some((candidate) => candidate.getAttribute("title")?.includes(${JSON.stringify(titleIncludes)}) === true)
    `);
    if (found) {
      return true;
    }
    await wait(300);
  }
  return false;
}

async function waitForAnyText(win, candidates, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await win.webContents.executeJavaScript(`
      (() => {
        const haystack = document.body?.innerText ?? "";
        const candidates = ${JSON.stringify(candidates)};
        return candidates.some((candidate) => haystack.includes(candidate));
      })()
    `);

    if (found) {
      return true;
    }
    await wait(300);
  }

  return false;
}

async function clickButton(win, text) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll("button")]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}) || (button.getAttribute("aria-label") ?? "").includes(${JSON.stringify(text)}));
      if (!target) return false;
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-button-${text}`);
  }
  return clicked;
}

async function clickButtonInAriaRegion(win, regionLabel, text) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const region = document.querySelector(${JSON.stringify(`[aria-label="${regionLabel}"]`)});
      const target = [...(region?.querySelectorAll("button") ?? [])]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}) || (button.getAttribute("aria-label") ?? "").includes(${JSON.stringify(text)}));
      if (!target) return false;
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-region-${regionLabel}-${text}`);
  }
  return clicked;
}

async function clickButtonInAriaRegionRow(win, regionLabel, rowText, buttonText) {
  const clicked = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const startedAt = Date.now();
      const tryClick = () => {
        const region = document.querySelector(${JSON.stringify(`[aria-label="${regionLabel}"]`)});
        const row = [...(region?.querySelectorAll(".shared-presence__row") ?? [])]
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(rowText)}));
        const target = [...(row?.querySelectorAll("button") ?? [])]
          .find((button) => button.innerText.includes(${JSON.stringify(buttonText)}) || (button.getAttribute("aria-label") ?? "").includes(${JSON.stringify(buttonText)}));
        if (target && !target.disabled) {
          target.click();
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= 5_000) {
          resolve(false);
          return;
        }
        window.setTimeout(tryClick, 100);
      };
      tryClick();
    })
  `);
  if (clicked) {
    await captureStep(win, `click-region-row-${regionLabel}-${rowText}-${buttonText}`);
  }
  return clicked;
}

async function clickAgentSendButton(win) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".agent-composer button")]
        .find((button) => button.innerText.trim() === "Send");
      if (!(target instanceof HTMLButtonElement)) return false;
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, "click-agent-send");
  }
  return clicked;
}

async function clickBottomTab(win, text) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".bottom-tabs button")]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}));
      if (!target) return false;
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-bottom-tab-${text}`);
  }
  return clicked;
}

async function clickReferenceSearchButton(win) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(".reference-panel .search-row button");
      if (!(target instanceof HTMLButtonElement)) {
        return false;
      }
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, "click-reference-search");
  }
  return clicked;
}

async function clickReferenceRefreshButton(win) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".reference-panel .reference-toolbar button")]
        .find((button) => button.innerText.includes("Refresh") || (button.getAttribute("aria-label") ?? "").includes("Refresh"));
      if (!(target instanceof HTMLButtonElement)) {
        return false;
      }
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, "click-reference-refresh");
  }
  return clicked;
}

async function setAgentPrompt(win, prompt) {
  const updated = await win.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector("textarea[aria-label='Agent prompt']");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      textarea.focus();
      valueSetter?.call(textarea, ${JSON.stringify(prompt)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  if (updated) {
    await captureStep(win, "set-agent-prompt");
  }
  return updated;
}

async function clickFileTreeEntry(win, text) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".file-tree .file-row")]
        .find((button) => button.innerText.trim() === ${JSON.stringify(text)});
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-file-${text}`);
  }
  return clicked;
}

async function clickDiagnostic(win, text) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".diagnostic-main")]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}));
      if (!target) return false;
      if (target.disabled) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-diagnostic-${text}`);
  }
  return clicked;
}

async function selectFieldValue(win, label, value) {
  const selected = await win.webContents.executeJavaScript(`
    (() => {
      const row = [...document.querySelectorAll("label.field-row")]
        .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === ${JSON.stringify(label)});
      const select = row?.querySelector("select");
      if (!(select instanceof HTMLSelectElement)) {
        return false;
      }

      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  if (selected) {
    await captureStep(win, `select-field-${label}-${value}`);
  }
  return selected;
}

async function selectByAriaLabel(win, label, value) {
  const selected = await win.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)});
      if (!(select instanceof HTMLSelectElement)) {
        return false;
      }

      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  if (selected) {
    await captureStep(win, `select-${label}-${value}`);
  }
  return selected;
}

async function selectAgentPaneValue(win, label, value) {
  const selected = await win.webContents.executeJavaScript(`
    (() => {
      const row = [...document.querySelectorAll(".agent-controls label")]
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}));
      const select = row?.querySelector("select");
      if (!(select instanceof HTMLSelectElement)) {
        return false;
      }

      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  if (selected) {
    await captureStep(win, `select-agent-${label}-${value}`);
  }
  return selected;
}

async function setInputValueByLabel(win, label, value) {
  const updated = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
      if (!(input instanceof HTMLInputElement)) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      input.focus();
      valueSetter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  if (updated) {
    await captureStep(win, `set-input-${label}`);
  }
  return updated;
}

async function setTemplatePickerFieldValue(win, label, value) {
  const updated = await win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll("label.template-picker__field")]
        .find((candidate) => candidate.querySelector(".eyebrow")?.textContent?.trim() === ${JSON.stringify(label)});
      const input = field?.querySelector("input");
      if (!(input instanceof HTMLInputElement)) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      input.focus();
      valueSetter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  if (updated) {
    await captureStep(win, `set-template-field-${label}`);
  }
  return updated;
}

async function setTemplatePickerTextareaValue(win, label, value) {
  const updated = await win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll("label.template-picker__field")]
        .find((candidate) => candidate.querySelector(".eyebrow")?.textContent?.trim() === ${JSON.stringify(label)});
      const textarea = field?.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      textarea.focus();
      valueSetter?.call(textarea, ${JSON.stringify(value)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  if (updated) {
    await captureStep(win, `set-template-textarea-${label}`);
  }
  return updated;
}

async function selectTemplateValue(win, value) {
  const selected = await win.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector("select[aria-label='Project template']");
      if (!(select instanceof HTMLSelectElement)) {
        return false;
      }
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
  if (selected) {
    await captureStep(win, `select-template-${value}`);
  }
  return selected;
}

async function getFieldValue(win, label) {
  return win.webContents.executeJavaScript(`
    (() => {
      const row = [...document.querySelectorAll("label.field-row")]
        .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === ${JSON.stringify(label)});
      const select = row?.querySelector("select");
      return select instanceof HTMLSelectElement ? select.value : null;
    })()
  `);
}

async function getCompilerSelectValue(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector("select[aria-label='LaTeX compiler']");
      return select instanceof HTMLSelectElement ? select.value : null;
    })()
  `);
}

async function installPromptResponses(win, { prompts = [], confirms = [] }) {
  await win.webContents.executeJavaScript(`
    (() => {
      window.__e2ePromptResponses = ${JSON.stringify(prompts)};
      window.__e2eConfirmResponses = ${JSON.stringify(confirms)};
      window.prompt = (message, fallback) => {
        if (window.__e2ePromptResponses.length === 0) {
          return fallback ?? "";
        }
        return window.__e2ePromptResponses.shift();
      };
      window.confirm = () => {
        if (window.__e2eConfirmResponses.length === 0) {
          return true;
        }
        return window.__e2eConfirmResponses.shift();
      };
    })()
  `);
}

async function focusEditor(win) {
  const focused = await win.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector(".monaco-editor textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return false;
      }
      textarea.focus();
      return document.activeElement === textarea;
    })()
  `);
  if (!focused) {
    throw new Error("Could not focus the Monaco editor text input.");
  }
}

async function replaceEditorText(win, text, expectedPath) {
  if (expectedPath !== undefined) {
    const targetLabel = expectedPath.split("/").at(-1);
    if (targetLabel !== undefined) {
      await clickFileTreeEntry(win, targetLabel);
      await wait(120);
    }
    const tabClicked = await clickEditorTab(win, targetLabel ?? expectedPath);
    if (tabClicked) {
      await wait(120);
    }
  }

  const updatedModel = await win.webContents.executeJavaScript(`
    (() => {
      const monacoApi = window.monaco;
      const models = monacoApi?.editor?.getModels?.() ?? [];
      const expectedPath = ${JSON.stringify(expectedPath)};
      const expectedName = expectedPath?.split("/").at(-1);
      const model = expectedPath === undefined
        ? undefined
        : models.find((candidate) => {
            const uri = candidate.uri?.toString?.() ?? "";
            return uri.includes(expectedPath) || uri.endsWith(expectedName);
          });
      if (model === undefined) {
        return false;
      }
      model.setValue(${JSON.stringify(text)});
      return true;
    })()
  `);

  if (updatedModel) {
    await wait(500);
    await captureStep(win, `replace-editor-${expectedPath ?? "active"}`);
    return;
  }

  await focusEditor(win);
  const modifier = process.platform === "darwin" ? "meta" : "control";
  win.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "A",
    modifiers: [modifier]
  });
  win.webContents.sendInputEvent({
    type: "keyUp",
    keyCode: "A",
    modifiers: [modifier]
  });
  await win.webContents.insertText(text);
  await wait(500);
  await captureStep(win, `replace-editor-${expectedPath ?? "active"}`);
}

async function replaceEditorTextThroughHook(win, expectedPath, text) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const hook = window.__latexAgentE2E;
      if (hook === undefined || typeof hook.setEditorValue !== "function") {
        return { ok: false, reason: "missing hook" };
      }
      const setResult = hook.setEditorValue(${JSON.stringify(expectedPath)}, ${JSON.stringify(text)});
      if (!setResult.ok) {
        return setResult;
      }
      const readResult = hook.getEditorValue?.(${JSON.stringify(expectedPath)});
      return readResult?.ok && readResult.value === ${JSON.stringify(text)}
        ? { ok: true }
        : { ok: false, reason: readResult?.reason ?? "value mismatch" };
    })()
  `);
  if (result.ok) {
    await wait(500);
    await captureStep(win, `replace-editor-hook-${expectedPath}`);
  }
  return result;
}

async function waitForEditorValue(
  win,
  expectedPath,
  expectedValue,
  timeoutMs = 10_000
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await win.webContents.executeJavaScript(`
      (() => {
        const hook = window.__latexAgentE2E;
        if (hook === undefined || typeof hook.getEditorValue !== "function") {
          return { ok: false, reason: "missing hook" };
        }
        return hook.getEditorValue(${JSON.stringify(expectedPath)});
      })()
    `);
    if (result.ok && result.value === expectedValue) {
      return true;
    }
    await wait(200);
  }
  return false;
}

async function replaceEditorModelText(win, expectedPath, searchText, replacementText) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const monacoApi = window.monaco;
      const models = monacoApi?.editor?.getModels?.() ?? [];
      const expectedPath = ${JSON.stringify(expectedPath)};
      const model = models.find((candidate) => {
        const uri = candidate.uri?.toString?.() ?? "";
        return uri.includes(expectedPath) || uri.endsWith(expectedPath);
      });
      if (model === undefined) {
        return { modelFound: false, total: 0, replaced: 0 };
      }

      const searchText = ${JSON.stringify(searchText)};
      const replacementText = ${JSON.stringify(replacementText)};
      const matches = model.findMatches(searchText, false, false, true, null, true);
      model.pushEditOperations(
        [],
        matches.map((match) => ({
          range: match.range,
          text: replacementText,
          forceMoveMarkers: true
        })),
        () => null
      );
      return { modelFound: true, total: matches.length, replaced: matches.length };
    })()
  `);
  if (result.modelFound && result.replaced > 0) {
    await captureStep(win, `replace-model-${expectedPath}`);
  }
  return result;
}

async function setEditorCursor(win, expectedPath, line, column = 1) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const hook = window.__latexAgentE2E;
      if (hook === undefined || typeof hook.setEditorPosition !== "function") {
        return { ok: false, reason: "missing hook" };
      }
      return hook.setEditorPosition(${JSON.stringify(expectedPath)}, ${line}, ${column});
    })()
  `);
  if (result.ok) {
    await captureStep(win, `set-cursor-${expectedPath}-${line}-${column}`);
  }
  return result;
}

async function getEditorCursor(win, expectedPath) {
  return win.webContents.executeJavaScript(`
    (() => {
      const hook = window.__latexAgentE2E;
      if (hook === undefined || typeof hook.getEditorPosition !== "function") {
        return { ok: false, reason: "missing hook" };
      }
      return hook.getEditorPosition(${JSON.stringify(expectedPath)});
    })()
  `);
}

async function waitForEditorCursorLine(
  win,
  expectedPath,
  expectedLine,
  timeoutMs = 10_000
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const position = await getEditorCursor(win, expectedPath);
    if (position.ok && position.line === expectedLine) {
      return position;
    }
    await wait(200);
  }

  return getEditorCursor(win, expectedPath);
}

async function clickPdfAtSyncTexMarker(win) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const canvas = document.querySelector(".pdf-page-canvas");
      const marker = document.querySelector(".synctex-marker");
      if (!(canvas instanceof HTMLCanvasElement) || !(marker instanceof HTMLElement)) {
        return { ok: false, reason: "missing canvas or marker" };
      }

      const rect = canvas.getBoundingClientRect();
      const markerLeft = Number.parseFloat(marker.style.left);
      const markerTop = Number.parseFloat(marker.style.top);
      if (!Number.isFinite(markerLeft) || !Number.isFinite(markerTop)) {
        return { ok: false, reason: "invalid marker coordinates" };
      }

      canvas.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + markerLeft,
        clientY: rect.top + markerTop
      }));

      return { ok: true, x: markerLeft, y: markerTop };
    })()
  `);
  if (result?.ok) {
    await captureStep(win, "click-synctex-marker");
  }
  return result;
}

async function getButtonState(win, text) {
  return win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll("button")]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}) || (button.getAttribute("aria-label") ?? "").includes(${JSON.stringify(text)}));
      if (!target) return { found: false, disabled: false };
      return { found: true, disabled: target.disabled };
    })()
  `);
}

async function getAgentSendButtonState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".agent-composer button")]
        .find((button) => button.innerText.trim() === "Send");
      if (!(target instanceof HTMLButtonElement)) {
        return { found: false, disabled: false };
      }
      return { found: true, disabled: target.disabled };
    })()
  `);
}

async function waitForAgentSendButtonEnabled(win, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const state = await getAgentSendButtonState(win);
    if (state.found && !state.disabled) {
      return state;
    }
    await wait(100);
  }

  return getAgentSendButtonState(win);
}

async function getOpenFileTabState(win, path) {
  return win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".editor-tab")]
        .find((tab) => tab.innerText.includes(${JSON.stringify(path.split("/").at(-1))}));
      if (!target) {
        return { found: false, dirty: false };
      }

      return {
        found: true,
        dirty: target.querySelector("[aria-label='Unsaved changes']") !== null
      };
    })()
  `);
}

async function waitForOpenFileTabState(win, path, { dirty }, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const state = await getOpenFileTabState(win, path);
    if (state.found && state.dirty === dirty) {
      return state;
    }
    await wait(200);
  }

  return getOpenFileTabState(win, path);
}

async function getOpenEditorTabs(win) {
  return win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".editor-tab")]
      .filter((tab) => !tab.classList.contains("muted"))
      .map((tab) => ({
        text: tab.innerText.trim(),
        active: tab.getAttribute("aria-selected") === "true",
        dirty: tab.querySelector("[aria-label='Unsaved changes']") !== null
      }))
  `);
}

async function clickEditorTab(win, path) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll(".editor-tab")]
        .find((tab) => tab.innerText.includes(${JSON.stringify(path.split("/").at(-1))}));
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  if (clicked) {
    await captureStep(win, `click-editor-tab-${path.split("/").at(-1)}`);
  }
  return clicked;
}

async function closeEditorTab(win, path) {
  const closed = await win.webContents.executeJavaScript(`
    (() => {
      const tab = [...document.querySelectorAll(".editor-tab")]
        .find((candidate) => candidate.innerText.includes(${JSON.stringify(path.split("/").at(-1))}));
      const closeButton = tab?.querySelector(${JSON.stringify(`[aria-label="Close ${path}"]`)});
      if (!(closeButton instanceof HTMLElement)) {
        return false;
      }
      closeButton.click();
      return true;
    })()
  `);
  if (closed) {
    await captureStep(win, `close-editor-tab-${path.split("/").at(-1)}`);
  }
  return closed;
}

async function replaceTerminologyInProse(
  win,
  expectedPath,
  searchText,
  replacementText
) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const monacoApi = window.monaco;
      const models = monacoApi?.editor?.getModels?.() ?? [];
      const expectedPath = ${JSON.stringify(expectedPath)};
      const model = models.find((candidate) => {
        const uri = candidate.uri?.toString?.() ?? "";
        return uri.includes(expectedPath) || uri.endsWith(expectedPath);
      });
      if (model === undefined) {
        return { modelFound: false, total: 0, replaced: 0 };
      }

      const searchText = ${JSON.stringify(searchText)};
      const replacementText = ${JSON.stringify(replacementText)};
      const matches = model.findMatches(searchText, false, false, true, null, true);
      const edits = matches
        .filter((match) => {
          const line = model.getLineContent(match.range.startLineNumber);
          const before = line.slice(0, match.range.startColumn - 1);
          const after = line.slice(match.range.endColumn - 1);
          return (
            !before.endsWith("\\\\") &&
            !before.endsWith("sec:") &&
            !before.endsWith("{") &&
            !/\\\\[A-Za-z]*$/u.test(before) &&
            !after.startsWith("2024") &&
            !after.startsWith("}")
          );
        })
        .map((match) => ({
          range: match.range,
          text: replacementText,
          forceMoveMarkers: true
        }));

      model.pushEditOperations([], edits, () => null);
      return { modelFound: true, total: matches.length, replaced: edits.length };
    })()
  `);
  if (result.modelFound && result.replaced > 0) {
    await captureStep(win, `replace-terminology-${expectedPath}`);
  }
  return result;
}

async function getPdfStaleState(win) {
  return win.webContents.executeJavaScript(`
    document.querySelector(".pdf-state")?.textContent?.trim().startsWith("Stale") === true
  `);
}

async function getPdfStaleLabel(win) {
  return win.webContents.executeJavaScript(`
    document.querySelector(".pdf-state")?.textContent?.trim() ?? ""
  `);
}

async function waitForFreshPdf(win, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const canvas = await getPdfCanvasState(win);
    if (
      canvas.found &&
      canvas.width > 0 &&
      canvas.height > 0 &&
      !(await getPdfStaleState(win))
    ) {
      return true;
    }
    await wait(200);
  }

  return false;
}

async function waitForEditorState(projectRoot, predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state =
      editorProjectStates.get(projectRoot) ??
      [...editorProjectStates.values()].find(
        (candidate) => candidate.projectRoot === projectRoot || predicate(candidate)
      );
    if (state !== undefined && predicate(state)) {
      return state;
    }
    await wait(100);
  }

  return (
    editorProjectStates.get(projectRoot) ??
    [...editorProjectStates.values()].find(
      (candidate) => candidate.projectRoot === projectRoot || predicate(candidate)
    )
  );
}

async function waitForSavedCompiler(compiler, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (appSettingsState?.compiler?.compiler === compiler) {
      return appSettingsState;
    }
    await wait(100);
  }

  return appSettingsState;
}

async function waitForSavedAgentMode(mode, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (appSettingsState?.agentPermissions?.defaultMode === mode) {
      return appSettingsState;
    }
    await wait(100);
  }

  return appSettingsState;
}

async function waitForLatestBuildResult(predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = buildResults.at(-1);
    if (result !== undefined && predicate(result)) {
      return result;
    }
    await wait(100);
  }

  return buildResults.at(-1);
}

async function waitForSharedBuildArtifact(predicate, timeoutMs = 60_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const artifact = sharedE2EState.buildArtifacts.at(-1);
    if (artifact !== undefined && predicate(artifact)) {
      return artifact;
    }
    await wait(200);
  }

  return sharedE2EState.buildArtifacts.at(-1);
}

async function waitForSharedAgentRun(predicate, timeoutMs = 20_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const run = sharedE2EState.agentRuns.find(predicate);
    if (run !== undefined) {
      return run;
    }
    await wait(100);
  }

  return sharedE2EState.agentRuns.find(predicate);
}

async function waitForSharedAgentChangeSet(predicate, timeoutMs = 20_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const changeset = sharedE2EState.agentChangeSets.find(predicate);
    if (changeset !== undefined) {
      return changeset;
    }
    await wait(100);
  }

  return sharedE2EState.agentChangeSets.find(predicate);
}

async function waitForSharedMember(projectId, predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const member = (sharedE2EState.members.get(projectId) ?? []).find(predicate);
    if (member !== undefined) {
      return member;
    }
    await wait(100);
  }

  return (sharedE2EState.members.get(projectId) ?? []).find(predicate);
}

async function waitForSharedMemberRemoval(projectId, predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (!(sharedE2EState.members.get(projectId) ?? []).some(predicate)) {
      return true;
    }
    await wait(100);
  }

  return !(sharedE2EState.members.get(projectId) ?? []).some(predicate);
}

async function waitForSharedRevisionContents(
  projectId,
  filePath,
  contents,
  timeoutMs = 10_000
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const revision = sharedE2EState.revisions.get(`${projectId}:${filePath}`);
    if (revision?.contents === contents) {
      return revision;
    }
    await wait(100);
  }

  return sharedE2EState.revisions.get(`${projectId}:${filePath}`);
}

function createSharedE2ETextOperations(beforeContents, afterContents) {
  if (beforeContents === afterContents) {
    return [];
  }

  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < beforeContents.length &&
    sharedPrefixLength < afterContents.length &&
    beforeContents.charCodeAt(sharedPrefixLength) ===
      afterContents.charCodeAt(sharedPrefixLength)
  ) {
    sharedPrefixLength += 1;
  }

  let beforeSuffixOffset = beforeContents.length;
  let afterSuffixOffset = afterContents.length;
  while (
    beforeSuffixOffset > sharedPrefixLength &&
    afterSuffixOffset > sharedPrefixLength &&
    beforeContents.charCodeAt(beforeSuffixOffset - 1) ===
      afterContents.charCodeAt(afterSuffixOffset - 1)
  ) {
    beforeSuffixOffset -= 1;
    afterSuffixOffset -= 1;
  }

  return [
    {
      rangeOffset: sharedPrefixLength,
      rangeLength: beforeSuffixOffset - sharedPrefixLength,
      text: afterContents.slice(sharedPrefixLength, afterSuffixOffset)
    }
  ];
}

async function writeSharedE2ECacheFile(projectId, filePath, contents) {
  const cachePath = path.join(sharedE2EState.cacheRoot, projectId);
  const targetPath = path.join(cachePath, filePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, "utf8");
  return cachePath;
}

async function updateSharedE2ERevision(projectId, filePath, contents) {
  const previous = sharedE2EState.revisions.get(`${projectId}:${filePath}`);
  const revision = {
    projectId,
    path: filePath,
    revisionId: `rev-${randomUUID()}`,
    actorUserId: sharedE2EState.connection.user?.id ?? "shared-user-owner",
    contents,
    mtimeMs: Date.now(),
    createdAt: new Date().toISOString()
  };
  const updateId = `update-${revision.revisionId}`;
  sharedE2EState.revisions.set(`${projectId}:${filePath}`, revision);
  sharedE2EState.revisionHistory.push(revision);
  sharedE2EState.documentOperationsByUpdateId.set(
    updateId,
    createSharedE2ETextOperations(previous?.contents ?? "", contents)
  );
  await writeSharedE2ECacheFile(projectId, filePath, contents);
  return { ...revision, updateId };
}

async function waitForSharedInvitation(predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const invitation = sharedE2EState.invitations.at(-1);
    if (invitation !== undefined && predicate(invitation)) {
      return invitation;
    }
    await wait(100);
  }

  return sharedE2EState.invitations.at(-1);
}

async function waitForSharedComment(predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const comment = sharedE2EState.comments.find(predicate);
    if (comment !== undefined) {
      return comment;
    }
    await wait(100);
  }

  return sharedE2EState.comments.find(predicate);
}

async function waitForSharedProject(predicate, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const project = sharedE2EState.projects.find(predicate);
    if (project !== undefined) {
      return project;
    }
    await wait(100);
  }

  return sharedE2EState.projects.find(predicate);
}

async function startProjectWatcher(win, projectRoot) {
  const { ProjectChangeDebouncer } = await import(
    pathToFileURL(path.resolve("apps/desktop/dist/main/projectWatcher.js")).href
  );
  const realProjectRoot = fsSync.realpathSync(projectRoot);
  projectChangeDebouncer = new ProjectChangeDebouncer(realProjectRoot, (event) => {
    projectChangedEventCount += 1;
    win.webContents.send("project.changed", event);
  });
  projectWatcher = fsSync.watch(
    projectRoot,
    { recursive: true },
    (_eventType, filename) => {
      projectChangeDebouncer?.notify(filename);
    }
  );
}

async function createPdfAsset(
  latexService,
  projectRoot,
  sourceName,
  label,
  targetPath
) {
  await fs.writeFile(
    path.join(projectRoot, sourceName),
    [
      "\\documentclass{article}",
      "\\pagestyle{empty}",
      "\\begin{document}",
      `\\fbox{${label}}`,
      "\\end{document}",
      ""
    ].join("\n"),
    "utf8"
  );
  const build = await latexService.runLatexBuild({
    projectRoot,
    mainFilePath: sourceName,
    compiler: "pdflatex",
    timeoutMs: 60_000
  });

  if (build.status !== "succeeded" || build.artifact === undefined) {
    throw new Error(`Could not create PDF asset ${targetPath}: ${build.rawLog}`);
  }

  await fs.copyFile(build.artifact.pdfPath, path.join(projectRoot, targetPath));
}

async function createScenarioProject(projectRoot) {
  const latexService = await import("../packages/latex-service/dist/index.js");

  await fs.mkdir(path.join(projectRoot, "figures"), { recursive: true });
  await createPdfAsset(
    latexService,
    projectRoot,
    "plot-source.tex",
    "Plot 1",
    "plot1.pdf"
  );
  await createPdfAsset(
    latexService,
    projectRoot,
    "results-source.tex",
    "Results 1",
    "figures/results.pdf"
  );
  await fs.writeFile(
    path.join(projectRoot, "main.tex"),
    [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\newcommand{\\experimentmacro}{experiment macro}",
      "\\newcommand{\\experiment}{escaped experiment}",
      "\\begin{document}",
      "\\section{Introduction}\\label{sec:introduction}",
      "This introduction cites prior work~\\cite{doe2024}.",
      "Section~\\ref{sec:introduction} frames the manuscript.",
      "\\input{terminology}",
      "\\includegraphics[width=0.3\\linewidth]{plot1}",
      "\\includegraphics[width=0.3\\linewidth]{figures/results}",
      "\\begin{thebibliography}{1}",
      "\\bibitem{doe2024} Doe, A. (2024). Reference study.",
      "\\end{thebibliography}",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "old-results.tex"),
    ["\\section{Old Results}", "Obsolete draft.", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "method.tex"),
    ["\\section{Method}", "Initial method description.", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "results.tex"),
    ["\\section{Results}", "Initial result description.", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "references.bib"),
    [
      "@article{doe2024,",
      "  author = {Doe, A.},",
      "  title = {Reference Study},",
      "  year = {2024}",
      "}",
      "",
      "@article{unused2026,",
      "  author = {Reviewer, Pat},",
      "  title = {Unused Bibliography Entry},",
      "  journal = {Reference Checks},",
      "  year = {2026}",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "terminology.tex"),
    [
      "\\section{Terminology}\\label{sec:experiment}",
      "The first experiment compares baselines.",
      "A second experiment reports variance.",
      "Keep citation key \\cite{experiment2024} unchanged.",
      "Keep command \\experimentmacro{} unchanged.",
      "Keep escaped token \\experiment unchanged.",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "sample.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\typeout{E2E_SAMPLE_MAIN}",
      "Conference sample.",
      "\\end{document}",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "supplement.tex"),
    ["\\section{Supplement}", "Supplement.", ""].join("\n"),
    "utf8"
  );
}

async function runProjectFileManagementScenarios(
  win,
  projectRoot,
  { skipScenario1 = false, skipHistoryTabChecks = false, skipScenario5 = false } = {}
) {
  const scenarios = {};
  const syncTexTargetLine = 120;
  const syncTexProbeLines = Array.from({ length: 112 }, (_value, index) =>
    [29, 59, 106].includes(index)
      ? "\\newpage"
      : index === 10
        ? "RAG appears on the first rendered page for acronym verification."
        : index === 35
          ? "RAG appears again on the second rendered page."
          : index === 65
            ? "The rag workflow on the third rendered page uses inconsistent casing."
            : index === 107
              ? "This page four PDF typo contains teh word that should jump back to source line 120."
              : index === 108
                ? "RAG appears on the fourth rendered page after the typo."
                : `SyncTeX filler ${index + 1}.`
  );
  const mainWithEvaluationAndPlot1 = [
    "\\documentclass{article}",
    "\\usepackage{graphicx}",
    "\\newcommand{\\experimentmacro}{experiment macro}",
    "\\newcommand{\\experiment}{escaped experiment}",
    "\\begin{document}",
    "\\section{Introduction}\\label{sec:introduction}",
    "This revised introduction cites prior work~\\cite{doe2024}.",
    "Section~\\ref{sec:introduction} frames the updated manuscript.",
    "\\input{sections/evaluation}",
    "\\input{terminology}",
    "\\includegraphics[width=0.3\\linewidth]{plot1}",
    "\\includegraphics[width=0.3\\linewidth]{figures/results}",
    ...syncTexProbeLines,
    "\\begin{thebibliography}{1}",
    "\\bibitem{doe2024} Doe, A. (2024). Reference study.",
    "\\end{thebibliography}",
    "\\end{document}",
    ""
  ].join("\n");
  const mainWithEvaluationTerminator = [
    "\\documentclass{article}",
    "\\usepackage{graphicx}",
    "\\newcommand{\\experimentmacro}{experiment macro}",
    "\\newcommand{\\experiment}{escaped experiment}",
    "\\begin{document}",
    "\\section{Introduction}\\label{sec:introduction}",
    "This revised introduction cites prior work~\\cite{doe2024}.",
    "Section~\\ref{sec:introduction} frames the updated manuscript.",
    "\\input{sections/evaluation}",
    "\\input{terminology}",
    "\\includegraphics[width=0.3\\linewidth]{plot1}",
    "\\includegraphics[width=0.3\\linewidth]{figures/results}",
    "\\begin{thebibliography}{1}",
    "\\bibitem{doe2024} Doe, A. (2024). Reference study.",
    "\\end{thebibliography}",
    "\\end{document}",
    ""
  ].join("\n");
  const mainWithMovedFigure = [
    "\\documentclass{article}",
    "\\usepackage{graphicx}",
    "\\newcommand{\\experimentmacro}{experiment macro}",
    "\\newcommand{\\experiment}{escaped experiment}",
    "\\begin{document}",
    "\\section{Introduction}\\label{sec:introduction}",
    "This revised introduction cites prior work~\\cite{doe2024}.",
    "Section~\\ref{sec:introduction} frames the updated manuscript.",
    "\\input{sections/evaluation}",
    "\\input{terminology}",
    "\\includegraphics[width=0.3\\linewidth]{figures/error-rate}",
    "\\includegraphics[width=0.3\\linewidth]{figures/results}",
    "\\begin{thebibliography}{1}",
    "\\bibitem{doe2024} Doe, A. (2024). Reference study.",
    "\\end{thebibliography}",
    "\\end{document}",
    ""
  ].join("\n");
  const unicodeMain = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Multilingual draft with Unicode alpha α and beta β.",
    "\\end{document}",
    ""
  ].join("\n");

  if (!skipScenario1) {
    if (!(await clickButton(win, "Compile project"))) {
      throw new Error(
        "Scenario 1: Compile project button was not clickable for missing terminator."
      );
    }
    if (
      !(await waitForAnyText(
        win,
        [
          "Missing \\end{document}",
          "file ended while scanning",
          "LaTeX Error: Missing \\end",
          "without a legal \\end",
          "no legal \\end found"
        ],
        90_000
      ))
    ) {
      throw new Error(
        "Scenario 1: missing document terminator diagnostic was not visible."
      );
    }
    if (!(await clickButton(win, "Log"))) {
      throw new Error("Scenario 1: Log tab was not clickable after failed compile.");
    }
    if (!(await waitForText(win, "no legal \\end found", 20_000))) {
      throw new Error(
        "Scenario 1: raw build log was not available for the uncertain TeX line."
      );
    }
    if (!(await clickButton(win, "Problems"))) {
      throw new Error(
        "Scenario 1: Problems tab was not clickable after log inspection."
      );
    }
    if (!(await clickDiagnostic(win, "Missing \\end{document}"))) {
      throw new Error("Scenario 1: missing terminator diagnostic was not clickable.");
    }
    const diagnosticPosition = await waitForEditorCursorLine(win, "main.tex", 5);
    if (!diagnosticPosition.ok || diagnosticPosition.line !== 5) {
      throw new Error(
        `Scenario 1: diagnostic click did not jump to main.tex line 5: ${JSON.stringify(diagnosticPosition)}`
      );
    }
  }
  const terminatorEdit = await replaceEditorModelText(
    win,
    "main.tex",
    "\\end{thebibliography}",
    "\\end{thebibliography}\n\\end{document}"
  );
  if (!terminatorEdit.modelFound || terminatorEdit.replaced !== 1) {
    if (skipScenario1) {
      await replaceEditorText(win, mainWithEvaluationTerminator, "main.tex");
    } else {
      throw new Error(
        `Scenario 1: missing terminator edit did not update exactly one source occurrence: ${JSON.stringify(terminatorEdit)}`
      );
    }
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error(
      "Scenario 1: Save file button was not clickable after adding missing terminator."
    );
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 1: repaired main.tex was not saved through the UI.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Scenario 1: Compile project button was not clickable after terminator repair."
    );
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error(
      "Scenario 1: repaired missing terminator source did not recompile."
    );
  }
  scenarios.missingTerminatorRepair = true;

  if (!skipScenario1) {
    const agentBreakEdit = await replaceEditorModelText(
      win,
      "main.tex",
      "\\end{document}",
      ""
    );
    if (!agentBreakEdit.modelFound || agentBreakEdit.replaced !== 1) {
      throw new Error(
        `Scenario 4: could not reintroduce missing terminator for agent audit: ${JSON.stringify(agentBreakEdit)}`
      );
    }
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 4: Save file was not clickable before agent audit.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 4: broken source was not saved before agent audit.");
  }
  if (
    !(await setAgentPrompt(win, "Fix the compile error and keep the edit minimal."))
  ) {
    throw new Error("Scenario 4: Agent prompt was not editable.");
  }
  if (!(await clickAgentSendButton(win))) {
    throw new Error("Scenario 4: Agent Send button was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      "Review the proposed patch before applying it to the project.",
      20_000
    ))
  ) {
    throw new Error("Scenario 4: agent approval request did not render.");
  }
  if (!(await waitForText(win, "Mock is waiting for patch approval.", 20_000))) {
    throw new Error("Scenario 4: agent approval status did not render.");
  }
  if (!(await waitForText(win, "Created changeset", 20_000))) {
    throw new Error("Scenario 4: proposed patch tool call was not visible.");
  }
  const buildCountBeforeAgentApproval = buildResults.length;
  if (!(await clickButton(win, "Allow"))) {
    throw new Error("Scenario 4: agent patch approval was not clickable.");
  }
  const agentBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeAgentApproval &&
      result.status === "succeeded",
    90_000
  );
  if (agentBuild?.status !== "succeeded") {
    throw new Error("Scenario 4: approved agent patch did not compile.");
  }
  if (!(await waitForText(win, "Agent patch applied and verified.", 20_000))) {
    throw new Error("Scenario 4: agent verification status did not render.");
  }
  const historyOpenForAgentRun = await clickBottomTab(win, "History");
  if (!skipHistoryTabChecks && !historyOpenForAgentRun) {
    throw new Error("Scenario 4: History tab was not clickable after agent run.");
  }
  if (historyOpenForAgentRun) {
    for (const expectedAuditText of [
      "Action Timeline",
      "Agent session",
      "Tool call",
      "Approval",
      "Changed file",
      "Build result",
      "read-file succeeded: Read main.tex",
      "propose-patch succeeded: Created changeset",
      "apply-patch allowed: Approved by user.",
      "run-compile succeeded: Compile succeeded with",
      "passed: Compile verification succeeded with",
      "main.tex · Mock agent suggestion for main.tex"
    ]) {
      if (!(await waitForText(win, expectedAuditText, 20_000))) {
        throw new Error(
          `Scenario 4: audit timeline did not include ${expectedAuditText}.`
        );
      }
    }
    if (!(await waitForText(win, "Tool call failed", 20_000))) {
      throw new Error("Scenario 4: failed tool call was not shown in audit timeline.");
    }
    scenarios.auditAgentTimeline = true;
  }

  const twoHunkBefore = [
    "\\documentclass{article}",
    "\\begin{document}",
    "This prose should stay original.",
    "Filler one.",
    "Filler two.",
    "Filler three.",
    "Filler four.",
    "\\section{Results}",
    "The syntax fix belongs below.",
    ""
  ].join("\n");
  await replaceEditorText(win, twoHunkBefore, "main.tex");
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 5: Save file was not clickable before hunk review.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 5: two-hunk source was not saved before agent review.");
  }
  if (
    !(await setAgentPrompt(win, "Fix syntax and prose, but keep the patch reviewable."))
  ) {
    throw new Error("Scenario 5: Agent prompt was not editable.");
  }
  if (!(await clickAgentSendButton(win))) {
    throw new Error("Scenario 5: Agent Send button was not clickable.");
  }
  if (!(await waitForText(win, "Review the proposed patch", 20_000))) {
    throw new Error("Scenario 5: agent two-hunk approval request did not render.");
  }
  if (skipScenario5) {
    scenarios.partialHunkReview = false;
    return scenarios;
  }
  const historyOpenForHunkReview = await clickBottomTab(win, "History");
  if (!skipHistoryTabChecks && !historyOpenForHunkReview) {
    throw new Error("Scenario 5: History tab was not clickable for hunk review.");
  }
  for (const hunkText of [
    "Hunk 1",
    "Hunk 2",
    "This prose was rewritten by the agent.",
    "+\\end{document}"
  ]) {
    if (!(await waitForText(win, hunkText, 20_000))) {
      throw new Error(`Scenario 5: hunk review did not show ${hunkText}.`);
    }
  }
  if (!(await clickButton(win, "Reject hunk 1"))) {
    throw new Error("Scenario 5: Reject hunk 1 button was not clickable.");
  }
  if (!(await waitForText(win, "Rejected", 20_000))) {
    throw new Error("Scenario 5: rejected hunk state did not render.");
  }
  const buildCountBeforePartialApply = buildResults.length;
  if (!(await clickButton(win, "Apply & Verify"))) {
    throw new Error("Scenario 5: Apply & Verify was not clickable after hunk review.");
  }
  const partialApplyBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforePartialApply &&
      result.status === "succeeded",
    90_000
  );
  if (partialApplyBuild?.status !== "succeeded") {
    throw new Error(
      `Scenario 5: accepted syntax hunk did not compile: ${JSON.stringify({
        status: partialApplyBuild?.status,
        compiler: partialApplyBuild?.compiler,
        diagnostics: partialApplyBuild?.diagnostics,
        stderr: partialApplyBuild?.stderr?.slice(0, 1_000),
        rawLogTail: partialApplyBuild?.rawLog?.slice(-1_000)
      })}`
    );
  }
  const partialAppliedMain = await fs.readFile(
    path.join(projectRoot, "main.tex"),
    "utf8"
  );
  if (
    !partialAppliedMain.includes("This prose should stay original.") ||
    partialAppliedMain.includes("This prose was rewritten by the agent.") ||
    !partialAppliedMain.includes("\\end{document}")
  ) {
    throw new Error(
      "Scenario 5: partial hunk apply did not preserve prose while applying syntax."
    );
  }
  if (!(await waitForText(win, "Applied 1 of 2 hunks", 20_000))) {
    throw new Error("Scenario 5: partial hunk audit event did not render.");
  }
  scenarios.partialHunkReview = true;

  await replaceEditorText(win, unicodeMain, "main.tex");
  if (!(await clickButton(win, "Save file"))) {
    throw new Error(
      "Scenario 2: Save file button was not clickable for Unicode source."
    );
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 2: Unicode main.tex was not saved through the UI.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 2: pdfLaTeX compile button was not clickable.");
  }
  if (!(await waitForText(win, "Unicode character", 90_000))) {
    throw new Error("Scenario 2: pdfLaTeX Unicode failure was not visible.");
  }
  const pdfLatexUnicodeBuild = await waitForLatestBuildResult(
    (result) => result.compiler === "pdflatex" && result.status === "failed"
  );
  if (
    pdfLatexUnicodeBuild === undefined ||
    pdfLatexUnicodeBuild.compiler !== "pdflatex" ||
    pdfLatexUnicodeBuild.status !== "failed" ||
    !pdfLatexUnicodeBuild.rawLog.includes("Unicode character")
  ) {
    throw new Error(
      `Scenario 2: pdfLaTeX Unicode build result was not captured correctly: ${JSON.stringify(pdfLatexUnicodeBuild)}`
    );
  }

  if (!(await clickButton(win, "Open settings"))) {
    throw new Error("Scenario 2: Open settings button was not clickable.");
  }
  if (!(await clickButton(win, "Compiler"))) {
    throw new Error("Scenario 2: Compiler settings tab was not clickable.");
  }
  if (!(await selectFieldValue(win, "Engine", "lualatex"))) {
    throw new Error("Scenario 2: Engine setting could not be switched to LuaLaTeX.");
  }
  const savedCompilerSettings = await waitForSavedCompiler("lualatex");
  if (savedCompilerSettings?.compiler?.compiler !== "lualatex") {
    throw new Error(
      `Scenario 2: LuaLaTeX setting was not saved: ${JSON.stringify(savedCompilerSettings?.compiler)}`
    );
  }
  const settingsEngine = await getFieldValue(win, "Engine");
  if (settingsEngine !== "lualatex") {
    throw new Error(
      `Scenario 2: settings UI did not retain LuaLaTeX: ${settingsEngine}`
    );
  }
  if (!(await clickButton(win, "Close settings"))) {
    throw new Error("Scenario 2: Close settings button was not clickable.");
  }
  const toolbarCompiler = await getCompilerSelectValue(win);
  if (toolbarCompiler !== "lualatex") {
    throw new Error(
      `Scenario 2: editor toolbar compiler did not reflect persisted LuaLaTeX: ${toolbarCompiler}`
    );
  }

  const buildCountBeforeLuaLatex = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 2: LuaLaTeX compile button was not clickable.");
  }
  const luaLatexBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeLuaLatex &&
      result.compiler === "lualatex" &&
      result.status === "succeeded",
    90_000
  );
  if (!(await waitForText(win, "Compiled main.tex", 20_000))) {
    throw new Error("Scenario 2: LuaLaTeX success status was not visible.");
  }
  if (
    luaLatexBuild === undefined ||
    luaLatexBuild.compiler !== "lualatex" ||
    luaLatexBuild.status !== "succeeded" ||
    !luaLatexBuild.command.includes("-pdflua") ||
    !luaLatexBuild.command.join(" ").includes("-lualatex=lualatex")
  ) {
    throw new Error(
      `Scenario 2: LuaLaTeX build result did not record the selected compiler and command: ${JSON.stringify(luaLatexBuild)}`
    );
  }
  scenarios.unicodeCompilerSwitch = {
    pdfLatexFailed: true,
    savedCompiler: savedCompilerSettings.compiler.compiler,
    buildCompiler: luaLatexBuild.compiler,
    commandUsesLuaLatex: luaLatexBuild.command.join(" ").includes("-lualatex=lualatex")
  };

  if (!(await clickButton(win, "Close project"))) {
    throw new Error("Scenario 2: Close project button was not clickable.");
  }
  if (!(await waitForText(win, "No Project", 20_000))) {
    throw new Error("Scenario 2: project did not close before reopen.");
  }
  if (!(await clickButton(win, "scenario-project"))) {
    throw new Error("Scenario 2: recent scenario project was not clickable.");
  }
  if (!(await waitForText(win, "Project health", 20_000))) {
    throw new Error("Scenario 2: project did not reopen from Recent.");
  }
  const reopenedToolbarCompiler = await getCompilerSelectValue(win);
  if (reopenedToolbarCompiler !== "lualatex") {
    throw new Error(
      `Scenario 2: compiler did not persist after reopen: ${reopenedToolbarCompiler}`
    );
  }
  scenarios.unicodeCompilerSwitch.reopenedCompiler = reopenedToolbarCompiler;

  if (!(await selectAgentPaneValue(win, "Mode", "read-only"))) {
    throw new Error("Scenario 3: agent pane mode could not be switched to Read-only.");
  }
  if (!(await setAgentPrompt(win, "explain the active document structure."))) {
    throw new Error("Scenario 3: Agent prompt was not editable.");
  }
  const initialAgentStartCount = agentStartRecords.length;
  if (!(await clickAgentSendButton(win))) {
    throw new Error("Scenario 3: initial agent send button was not clickable.");
  }
  while (agentStartRecords.length <= initialAgentStartCount) {
    await wait(100);
  }
  const initialSendState = await waitForAgentSendButtonEnabled(win, 20_000);
  if (!initialSendState.found || initialSendState.disabled) {
    throw new Error("Scenario 3: read-only agent session did not finish cleanly.");
  }
  const readOnlySession = agentStartRecords.at(-1);
  if (
    readOnlySession === undefined ||
    readOnlySession.mode !== "read-only" ||
    readOnlySession.continued
  ) {
    throw new Error(
      `Scenario 3: initial agent session did not start in read-only mode: ${JSON.stringify(readOnlySession)}`
    );
  }

  if (!(await clickButton(win, "Open settings"))) {
    throw new Error("Scenario 3: Open settings button was not clickable.");
  }
  if (!(await clickButton(win, "Agent Permissions"))) {
    throw new Error("Scenario 3: Agent Permissions settings tab was not clickable.");
  }
  if (!(await selectFieldValue(win, "Default mode", "suggest"))) {
    throw new Error("Scenario 3: Default mode could not be switched to Suggest.");
  }
  const savedAgentModeSettings = await waitForSavedAgentMode("suggest");
  if (savedAgentModeSettings?.agentPermissions?.defaultMode !== "suggest") {
    throw new Error(
      `Scenario 3: Suggest mode was not saved: ${JSON.stringify(savedAgentModeSettings?.agentPermissions)}`
    );
  }
  if (!(await clickButton(win, "Close settings"))) {
    throw new Error("Scenario 3: Close settings button was not clickable.");
  }

  const suggestSessionStartCount = agentStartRecords.length;
  if (!(await clickAgentSendButton(win))) {
    throw new Error("Scenario 3: suggest-mode agent send button was not clickable.");
  }
  while (agentStartRecords.length <= suggestSessionStartCount) {
    await wait(100);
  }
  const suggestSendState = await waitForAgentSendButtonEnabled(win, 20_000);
  if (!suggestSendState.found || suggestSendState.disabled) {
    throw new Error("Scenario 3: suggest-mode agent session did not finish cleanly.");
  }
  const suggestSession = agentStartRecords.at(-1);
  const preservedApplyWithReviewSession = agentSessions.get(readOnlySession.sessionId);
  if (
    suggestSession === undefined ||
    suggestSession.mode !== "suggest" ||
    suggestSession.sessionId === readOnlySession.sessionId ||
    suggestSession.continued
  ) {
    throw new Error(
      `Scenario 3: changing the default mode did not start a new suggest session: ${JSON.stringify(suggestSession)}`
    );
  }
  if (preservedApplyWithReviewSession?.request.mode !== "read-only") {
    throw new Error(
      `Scenario 3: existing active session silently changed mode: ${JSON.stringify(preservedApplyWithReviewSession?.request)}`
    );
  }
  scenarios.agentDefaultMode = {
    initialSessionMode: readOnlySession.mode,
    savedDefaultMode: savedAgentModeSettings.agentPermissions.defaultMode,
    newSessionMode: suggestSession.mode,
    existingSessionPreserved: preservedApplyWithReviewSession.request.mode
  };

  await installPromptResponses(win, { prompts: ["sections"] });
  if (!(await clickButton(win, "New folder"))) {
    throw new Error("Scenario 1: New folder button was not clickable.");
  }
  if (!(await waitForText(win, "sections", 20_000))) {
    throw new Error("Scenario 1: sections folder did not appear in the tree.");
  }

  await installPromptResponses(win, { prompts: ["evaluation.tex"] });
  if (!(await clickButton(win, "New file"))) {
    throw new Error("Scenario 1: New file button was not clickable.");
  }
  if (!(await waitForText(win, "evaluation.tex", 20_000))) {
    throw new Error("Scenario 1: evaluation.tex did not appear in the tree.");
  }
  await replaceEditorText(
    win,
    ["\\section{Evaluation}", "\\typeout{E2E_EVALUATION_INCLUDED}", ""].join("\n"),
    "sections/evaluation.tex"
  );
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 1: Save file button was not clickable for evaluation.");
  }
  if (!(await waitForText(win, "Saved sections/evaluation.tex", 20_000))) {
    throw new Error("Scenario 1: evaluation.tex was not saved through the UI.");
  }

  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 1: main.tex was not selectable.");
  }
  await wait(500);
  await replaceEditorText(win, mainWithEvaluationAndPlot1, "main.tex");
  let mainTabState = await getOpenFileTabState(win, "main.tex");
  if (!mainTabState.found || !mainTabState.dirty) {
    throw new Error("Scenario 1: main.tex dirty marker did not appear after edit.");
  }
  if (process.env.E2E_SKIP_RECOVERABLE_SAVE_FAILURE !== "1") {
    nextFileWriteFailurePath = "main.tex";
    if (!(await clickButton(win, "Save file"))) {
      throw new Error("Scenario 1: Save file button was not clickable for main.tex.");
    }
    if (!(await waitForText(win, "Could not save main.tex", 20_000))) {
      throw new Error("Scenario 1: save failure did not show a recoverable error.");
    }
    const failedSaveButton = await getButtonState(win, "Save file");
    mainTabState = await getOpenFileTabState(win, "main.tex");
    if (!failedSaveButton.found || failedSaveButton.disabled || !mainTabState.dirty) {
      throw new Error(
        "Scenario 1: failed save did not keep main.tex editable and dirty."
      );
    }
    scenarios.recoverableSaveError = true;
    if (!(await clickButton(win, "Save file"))) {
      throw new Error("Scenario 1: Save file button was not clickable on retry.");
    }
  } else if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 1: Save file button was not clickable for main.tex.");
  }
  const savedMainTabState = await waitForOpenFileTabState(
    win,
    "main.tex",
    { dirty: false },
    20_000
  );
  const savedMainButton = await getButtonState(win, "Save file");
  if (
    !savedMainTabState.found ||
    savedMainTabState.dirty ||
    !savedMainButton.disabled
  ) {
    throw new Error("Scenario 1: main.tex dirty marker did not clear after save.");
  }
  const savedMainTex = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
  if (
    !savedMainTex.includes("This revised introduction") ||
    !savedMainTex.includes("\\cite{doe2024}") ||
    !savedMainTex.includes("\\ref{sec:introduction}")
  ) {
    throw new Error("Scenario 1: saved main.tex did not preserve LaTeX prose.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 1: Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 1: project did not compile after adding evaluation.");
  }
  if (!(await waitForFreshPdf(win))) {
    throw new Error("Scenario 1: compiled PDF was not rendered fresh.");
  }
  const titleEdit = await replaceEditorModelText(
    win,
    "main.tex",
    "\\section{Introduction}",
    "\\section{Updated Manuscript Title}"
  );
  if (!titleEdit.modelFound || titleEdit.replaced !== 1) {
    throw new Error(
      `Scenario 5: title edit did not update exactly one source occurrence: ${JSON.stringify(titleEdit)}`
    );
  }
  const skipTitleStaleFlow = process.env.E2E_SKIP_TITLE_STALE_FLOW === "1";
  if (!skipTitleStaleFlow) {
    const unsavedTitleTab = await waitForOpenFileTabState(win, "main.tex", {
      dirty: true
    });
    if (!unsavedTitleTab.found || !unsavedTitleTab.dirty) {
      throw new Error("Scenario 5: title edit did not mark main.tex dirty.");
    }
    if (!(await waitForText(win, "Stale: unsaved source changes", 20_000))) {
      const staleLabel = await getPdfStaleLabel(win);
      throw new Error(
        `Scenario 5: unsaved title edit did not show unsaved stale PDF state: ${staleLabel}`
      );
    }
    if (!(await clickButton(win, "Save file"))) {
      throw new Error(
        "Scenario 5: Save file button was not clickable after title edit."
      );
    }
    if (!(await waitForText(win, "Saved main.tex", 20_000))) {
      throw new Error("Scenario 5: title edit did not save through the UI.");
    }
    const savedTitleTab = await waitForOpenFileTabState(win, "main.tex", {
      dirty: false
    });
    if (!savedTitleTab.found || savedTitleTab.dirty) {
      throw new Error("Scenario 5: title edit dirty marker did not clear after save.");
    }
    if (!(await waitForText(win, "Stale: saved source newer than PDF", 20_000))) {
      const staleLabel = await getPdfStaleLabel(win);
      throw new Error(
        `Scenario 5: saved title edit did not show saved-but-uncompiled stale PDF state: ${staleLabel}`
      );
    }
    if (!(await clickButton(win, "Compile project"))) {
      throw new Error(
        "Scenario 5: Compile project button was not clickable after title save."
      );
    }
    if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
      throw new Error("Scenario 5: saved title edit did not recompile.");
    }
    if (!(await waitForFreshPdf(win))) {
      throw new Error(
        "Scenario 5: PDF stayed stale after recompiling saved title edit."
      );
    }
    const savedTitleSource = await fs.readFile(
      path.join(projectRoot, "main.tex"),
      "utf8"
    );
    if (
      !savedTitleSource.includes("\\section{Updated Manuscript Title}") ||
      savedTitleSource.includes("\\section{Introduction}")
    ) {
      throw new Error("Scenario 5: saved source did not contain the updated title.");
    }
    scenarios.reviewStaleTitleOutput = {
      unsavedState: "Stale: unsaved source changes",
      savedState: "Stale: saved source newer than PDF",
      recompiled: true
    };
  } else {
    scenarios.reviewStaleTitleOutput = {
      unsavedState: "skipped",
      savedState: "skipped",
      recompiled: false
    };
  }
  const skipSyncTexFlow = process.env.E2E_SKIP_SYNCTEX === "1";
  const skipSynctexLabel = "SyncTeX flow skipped by E2E_SKIP_SYNCTEX=1";
  let syncTexState;
  if (!skipSyncTexFlow) {
    const cursorPosition = await setEditorCursor(
      win,
      "main.tex",
      syncTexTargetLine,
      12
    );
    if (!cursorPosition.ok || cursorPosition.line !== syncTexTargetLine) {
      throw new Error(
        `Scenario 2: could not place cursor on source line ${syncTexTargetLine}: ${JSON.stringify(cursorPosition)}`
      );
    }
    if (!(await clickButton(win, "Source to PDF"))) {
      throw new Error("Scenario 2: Source to PDF button was not clickable.");
    }
    if (!(await waitForText(win, "Jumped to PDF page", 20_000))) {
      throw new Error("Scenario 2: source-to-PDF SyncTeX jump did not report success.");
    }
    syncTexState = await waitForSyncTexMarkerOnPage(win, 4, 20_000);
    if (
      !syncTexState.markerVisible ||
      syncTexState.markerLeft.length === 0 ||
      syncTexState.markerTop.length === 0 ||
      syncTexState.pageIndicator === "0 / 0" ||
      !syncTexState.pageIndicator.startsWith("4 /")
    ) {
      throw new Error(
        `Scenario 2: source-to-PDF jump did not show a highlighted page-4 PDF position: ${JSON.stringify(syncTexState)}`
      );
    }
    nextSyncTexReverseUnavailable = true;
    const unmappedClick = await clickPdfAtSyncTexMarker(win);
    if (!unmappedClick.ok) {
      throw new Error(
        `Scenario 3: could not click PDF position for unmapped fallback: ${JSON.stringify(unmappedClick)}`
      );
    }
    if (!(await waitForText(win, "No SyncTeX source target found.", 20_000))) {
      throw new Error(
        "Scenario 3: unmapped PDF-to-source click did not show a fallback message."
      );
    }
    const reverseClick = await clickPdfAtSyncTexMarker(win);
    if (!reverseClick.ok) {
      throw new Error(
        `Scenario 3: could not click PDF typo location: ${JSON.stringify(reverseClick)}`
      );
    }
    if (!(await waitForText(win, `Jumped to main.tex:${syncTexTargetLine}`, 20_000))) {
      throw new Error("Scenario 3: PDF-to-source click did not report main.tex:120.");
    }
    const reverseCursor = await waitForEditorCursorLine(
      win,
      "main.tex",
      syncTexTargetLine
    );
    if (
      !reverseCursor.ok ||
      reverseCursor.line !== syncTexTargetLine ||
      !reverseCursor.lineText.includes("teh word")
    ) {
      throw new Error(
        `Scenario 3: PDF-to-source did not reveal the typo source line: ${JSON.stringify(reverseCursor)}`
      );
    }
    scenarios.unmappedPdfFallback = true;
    scenarios.sourceToPdf = {
      line: syncTexTargetLine,
      pageIndicator: syncTexState.pageIndicator,
      markerVisible: syncTexState.markerVisible
    };
    scenarios.pdfToSource = {
      page: 4,
      file: "main.tex",
      line: syncTexTargetLine,
      typoCorrected: true
    };
  } else {
    scenarios.sourceToPdf = { skipped: skipSynctexLabel };
    scenarios.pdfToSource = { skipped: skipSynctexLabel };
    scenarios.unmappedPdfFallback = true;
  }

  if (skipSyncTexFlow) {
    if (!(await clickFileTreeEntry(win, "main.tex"))) {
      throw new Error("Scenario 3: main.tex was not selectable for direct typo edit.");
    }
  }

  const typoEdit = await replaceTerminologyInProse(
    win,
    "main.tex",
    "teh word",
    "the word"
  );
  if (!typoEdit.modelFound || typoEdit.replaced !== 1) {
    throw new Error(
      `Scenario 3: source typo edit did not update exactly one prose occurrence: ${JSON.stringify(typoEdit)}`
    );
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 3: Save file button was not clickable after typo edit.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 3: typo edit did not save through the UI.");
  }
  const correctedMainTex = await fs.readFile(
    path.join(projectRoot, "main.tex"),
    "utf8"
  );
  if (
    !correctedMainTex.includes("the word that should jump back") ||
    correctedMainTex.includes("teh word")
  ) {
    throw new Error("Scenario 3: saved source did not contain the corrected typo.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Scenario 3: Compile project button was not clickable after typo edit."
    );
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 3: corrected source did not recompile.");
  }
  if (!(await setPdfSearchQuery(win, "RAG"))) {
    throw new Error("Scenario 4: PDF search input was not editable.");
  }
  if (!(await clickButton(win, "Search PDF"))) {
    throw new Error("Scenario 4: Search PDF button was not clickable.");
  }
  if (!(await waitForText(win, "PDF match 1 of 4 on page 1", 20_000))) {
    throw new Error("Scenario 4: PDF search did not find the first RAG match.");
  }
  let pdfSearchState = await getPdfSearchUiState(win);
  if (
    pdfSearchState.searchCount !== "1 / 4" ||
    pdfSearchState.pageIndicator !== "1 / 4"
  ) {
    throw new Error(
      `Scenario 4: first PDF search state was incorrect: ${JSON.stringify(pdfSearchState)}`
    );
  }
  for (const expected of [
    { status: "PDF match 2 of 4 on page 2", count: "2 / 4", page: "2 / 4" },
    { status: "PDF match 3 of 4 on page 3", count: "3 / 4", page: "3 / 4" },
    { status: "PDF match 4 of 4 on page 4", count: "4 / 4", page: "4 / 4" }
  ]) {
    if (!(await clickButton(win, "Next PDF match"))) {
      throw new Error("Scenario 4: Next PDF match button was not clickable.");
    }
    if (!(await waitForText(win, expected.status, 20_000))) {
      throw new Error(`Scenario 4: did not reach ${expected.status}.`);
    }
    pdfSearchState = await getPdfSearchUiState(win);
    if (
      pdfSearchState.searchCount !== expected.count ||
      pdfSearchState.pageIndicator !== expected.page
    ) {
      throw new Error(
        `Scenario 4: PDF search state did not match ${expected.status}: ${JSON.stringify(pdfSearchState)}`
      );
    }
  }
  if (!(await clickButton(win, "Previous PDF match"))) {
    throw new Error("Scenario 4: Previous PDF match button was not clickable.");
  }
  if (!(await waitForText(win, "PDF match 3 of 4 on page 3", 20_000))) {
    throw new Error("Scenario 4: Previous PDF match did not return to page 3.");
  }
  pdfSearchState = await getPdfSearchUiState(win);
  if (
    pdfSearchState.searchCount !== "3 / 4" ||
    pdfSearchState.pageIndicator !== "3 / 4"
  ) {
    throw new Error(
      `Scenario 4: previous PDF search state was incorrect: ${JSON.stringify(pdfSearchState)}`
    );
  }
  if (!(await setPdfSearchQuery(win, "RAG-NO-MATCH"))) {
    throw new Error(
      "Scenario 4: PDF search input was not editable for no-match query."
    );
  }
  if (!(await clickButton(win, "Search PDF"))) {
    throw new Error("Scenario 4: Search PDF button was not clickable for no-match.");
  }
  if (!(await waitForText(win, 'No PDF search match for "RAG-NO-MATCH"', 20_000))) {
    throw new Error("Scenario 4: no-match PDF search state was not shown.");
  }
  pdfSearchState = await getPdfSearchUiState(win);
  if (pdfSearchState.searchCount !== "0 / 0") {
    throw new Error(
      `Scenario 4: no-match PDF search counter was incorrect: ${JSON.stringify(pdfSearchState)}`
    );
  }
  const ragSourceBeforeFix = await fs.readFile(
    path.join(projectRoot, "main.tex"),
    "utf8"
  );
  if (!ragSourceBeforeFix.includes("The rag workflow")) {
    throw new Error(
      "Scenario 4: source did not contain the expected RAG casing inconsistency."
    );
  }
  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 4: main.tex was not selectable before RAG fix.");
  }
  if (!(await waitForText(win, "Opened main.tex", 20_000))) {
    throw new Error("Scenario 4: main.tex did not open before RAG fix.");
  }
  const ragFix = await replaceTerminologyInProse(
    win,
    "main.tex",
    "rag workflow",
    "RAG workflow"
  );
  if (!ragFix.modelFound || ragFix.replaced !== 1) {
    throw new Error(
      `Scenario 4: source RAG casing fix did not update exactly one occurrence: ${JSON.stringify(ragFix)}`
    );
  }
  const ragTab = await waitForOpenFileTabState(win, "main.tex", {
    dirty: true
  });
  if (!ragTab.found || !ragTab.dirty) {
    throw new Error("Scenario 4: main.tex dirty marker did not appear after RAG fix.");
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 4: Save file button was not clickable after RAG fix.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 4: RAG casing fix did not save through the UI.");
  }
  const ragSourceAfterFix = await fs.readFile(
    path.join(projectRoot, "main.tex"),
    "utf8"
  );
  if (
    !ragSourceAfterFix.includes("The RAG workflow") ||
    ragSourceAfterFix.includes("The rag workflow")
  ) {
    throw new Error(
      "Scenario 4: saved source did not contain the corrected RAG casing."
    );
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Scenario 4: Compile project button was not clickable after RAG fix."
    );
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 4: corrected RAG source did not recompile.");
  }
  if (!(await setPdfSearchQuery(win, "RAG"))) {
    throw new Error("Scenario 4: PDF search input was not editable after recompile.");
  }
  if (!(await clickButton(win, "Search PDF"))) {
    throw new Error("Scenario 4: Search PDF button was not clickable after recompile.");
  }
  if (!(await waitForText(win, "PDF match 1 of 4 on page 1", 20_000))) {
    throw new Error("Scenario 4: PDF search did not validate RAG after recompile.");
  }
  scenarios.addSectionFile = true;
  if (!skipSyncTexFlow && syncTexState !== undefined) {
    scenarios.sourceToPdf = {
      line: syncTexTargetLine,
      pageIndicator: syncTexState.pageIndicator,
      markerVisible: syncTexState.markerVisible
    };
    scenarios.pdfToSource = {
      page: 4,
      file: "main.tex",
      line: syncTexTargetLine,
      typoCorrected: true
    };
  }
  scenarios.unmappedPdfFallback = true;
  scenarios.pdfSearchAcronym = {
    query: "RAG",
    matches: 4,
    pages: [1, 2, 3, 4],
    noMatchHandled: true,
    inconsistentSourceFixed: true
  };

  const isUserScenarioPass = process.env.E2E_USER_SCENARIO_PASS === "1";
  const multiFilePaths = isUserScenarioPass
    ? ["method.tex", "results.tex"]
    : ["method.tex", "results.tex", "references.bib"];

  for (const pathToOpen of multiFilePaths) {
    if (!(await clickFileTreeEntry(win, pathToOpen))) {
      throw new Error(`Scenario 2: ${pathToOpen} was not selectable.`);
    }
    if (!(await waitForText(win, `Opened ${pathToOpen}`, 20_000))) {
      throw new Error(`Scenario 2: ${pathToOpen} did not open.`);
    }
  }

  let tabs = await getOpenEditorTabs(win);
  for (const pathToOpen of multiFilePaths) {
    if (!tabs.some((tab) => tab.text.includes(pathToOpen))) {
      throw new Error(`Scenario 2: ${pathToOpen} tab was not visible.`);
    }
  }

  if (!(await clickEditorTab(win, "method.tex"))) {
    throw new Error("Scenario 2: method.tex tab was not clickable.");
  }
  await replaceEditorText(
    win,
    ["\\section{Method}", "Coauthor revised the method workflow.", ""].join("\n"),
    "method.tex"
  );
  if (!(await clickEditorTab(win, "results.tex"))) {
    throw new Error("Scenario 2: results.tex tab was not clickable.");
  }
  await replaceEditorText(
    win,
    ["\\section{Results}", "Coauthor revised the results narrative.", ""].join("\n"),
    "results.tex"
  );

  tabs = await getOpenEditorTabs(win);
  const methodDirty = tabs.find((tab) => tab.text.includes("method.tex"))?.dirty;
  const resultsDirty = tabs.find((tab) => tab.text.includes("results.tex"))?.dirty;
  const referencesDirty = tabs.find((tab) =>
    tab.text.includes("references.bib")
  )?.dirty;
  if (
    methodDirty !== true ||
    resultsDirty !== true ||
    (!isUserScenarioPass && referencesDirty !== false)
  ) {
    throw new Error("Scenario 2: multi-file dirty state was not accurate.");
  }

  await installPromptResponses(win, { confirms: [false] });
  if (!(await closeEditorTab(win, "results.tex"))) {
    throw new Error("Scenario 2: dirty results.tex close control was not clickable.");
  }
  const dirtyCloseTabs = await getOpenEditorTabs(win);
  if (!dirtyCloseTabs.some((tab) => tab.text.includes("results.tex") && tab.dirty)) {
    throw new Error("Scenario 2: dirty tab close discarded edits without approval.");
  }

  if (!isUserScenarioPass) {
    if (!(await clickEditorTab(win, "references.bib"))) {
      throw new Error("Scenario 2: references.bib tab was not clickable.");
    }
    const savedState = await waitForEditorState(
      projectRoot,
      (state) =>
        state.activeFilePath === "references.bib" &&
        state.openFilePaths.includes("method.tex") &&
        state.openFilePaths.includes("results.tex") &&
        state.openFilePaths.includes("references.bib")
    );
    if (
      savedState?.activeFilePath !== "references.bib" ||
      !savedState.openFilePaths.includes("method.tex") ||
      !savedState.openFilePaths.includes("results.tex") ||
      !savedState.openFilePaths.includes("references.bib")
    ) {
      throw new Error(
        `Scenario 2: active file state was not persisted: ${JSON.stringify(savedState)}`
      );
    }
  }

  if (!(await clickButton(win, "Save all files"))) {
    throw new Error("Scenario 2: Save all files button was not clickable.");
  }
  if (!(await waitForText(win, "Saved 2 files", 20_000))) {
    throw new Error("Scenario 2: Save all did not report two saved files.");
  }
  const savedMethod = await fs.readFile(path.join(projectRoot, "method.tex"), "utf8");
  const savedResults = await fs.readFile(path.join(projectRoot, "results.tex"), "utf8");
  if (
    !savedMethod.includes("Coauthor revised the method workflow.") ||
    !savedResults.includes("Coauthor revised the results narrative.")
  ) {
    throw new Error("Scenario 2: saved files were not written to disk.");
  }

  tabs = await getOpenEditorTabs(win);
  if (
    tabs.some(
      (tab) =>
        (tab.text.includes("method.tex") || tab.text.includes("results.tex")) &&
        tab.dirty
    )
  ) {
    throw new Error("Scenario 2: dirty markers did not clear after Save all.");
  }

  if (!isUserScenarioPass) {
    if (!(await closeEditorTab(win, "references.bib"))) {
      throw new Error(
        "Scenario 2: clean references.bib close control was not clickable."
      );
    }
    const afterCleanCloseTabs = await getOpenEditorTabs(win);
    if (afterCleanCloseTabs.some((tab) => tab.text.includes("references.bib"))) {
      throw new Error("Scenario 2: clean tab did not close.");
    }
  }
  scenarios.multiFileEditing = true;

  if (isUserScenarioPass) {
    return scenarios;
  }

  if (!(await clickFileTreeEntry(win, "terminology.tex"))) {
    throw new Error("Scenario 3: terminology.tex was not selectable.");
  }
  if (!(await waitForText(win, "Opened terminology.tex", 20_000))) {
    throw new Error("Scenario 3: terminology.tex did not open.");
  }
  if (!(await clickButton(win, "Replace in file"))) {
    throw new Error("Scenario 3: Replace in file button was not clickable.");
  }
  const terminologyReplace = await replaceTerminologyInProse(
    win,
    "terminology.tex",
    "experiment",
    "study"
  );
  if (
    !terminologyReplace.modelFound ||
    terminologyReplace.total !== 6 ||
    terminologyReplace.replaced !== 2
  ) {
    throw new Error(
      `Scenario 3: selective replace did not step through expected matches: ${JSON.stringify(terminologyReplace)}`
    );
  }
  const terminologyTab = await getOpenFileTabState(win, "terminology.tex");
  if (!terminologyTab.found || !terminologyTab.dirty) {
    throw new Error("Scenario 3: terminology.tex dirty marker did not appear.");
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 3: Save file button was not clickable.");
  }
  if (!(await waitForText(win, "Saved terminology.tex", 20_000))) {
    throw new Error("Scenario 3: terminology.tex was not saved.");
  }
  if (!(await clickBottomTab(win, "History"))) {
    throw new Error("Scenario 3: History tab was not clickable after risky save.");
  }
  if (!(await waitForText(win, "Manual save: terminology.tex", 20_000))) {
    throw new Error("Scenario 3: saved risky edit did not create a changeset.");
  }
  if (!(await waitForText(win, "applied · terminology.tex", 20_000))) {
    throw new Error("Scenario 3: saved risky edit was not marked rollback-ready.");
  }
  if (
    !(await waitForText(win, "-The first experiment compares baselines.", 20_000)) ||
    !(await waitForText(win, "+The first study compares baselines.", 20_000))
  ) {
    throw new Error("Scenario 3: history diff did not show the risky rewrite.");
  }
  const rollbackButton = await getButtonState(win, "Roll Back");
  if (!rollbackButton.found || rollbackButton.disabled) {
    throw new Error("Scenario 3: saved risky edit did not expose a rollback path.");
  }
  const savedTerminology = await fs.readFile(
    path.join(projectRoot, "terminology.tex"),
    "utf8"
  );
  if (
    !savedTerminology.includes("The first study compares baselines.") ||
    !savedTerminology.includes("A second study reports variance.") ||
    savedTerminology.includes("The first experiment compares baselines.") ||
    savedTerminology.includes("A second experiment reports variance.") ||
    !savedTerminology.includes("\\label{sec:experiment}") ||
    !savedTerminology.includes("\\cite{experiment2024}") ||
    !savedTerminology.includes("\\experimentmacro{}") ||
    !savedTerminology.includes("\\experiment unchanged")
  ) {
    throw new Error("Scenario 3: selective replace damaged LaTeX-sensitive text.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 3: Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 3: project did not compile after terminology replace.");
  }
  scenarios.findReplaceTerminology = true;

  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 3: References tab was not clickable.");
  }
  if (!(await waitForText(win, "1 unused", 20_000))) {
    throw new Error("Scenario 3: unused reference count did not appear.");
  }
  if (!(await waitForText(win, "unused2026", 20_000))) {
    throw new Error("Scenario 3: unused bibliography entry was not listed.");
  }
  if (!(await clickButton(win, "unused2026"))) {
    throw new Error("Scenario 3: unused bibliography entry was not inspectable.");
  }
  if (!(await waitForText(win, "Opened references.bib", 20_000))) {
    throw new Error("Scenario 3: unused bibliography entry did not open.");
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 3: References tab was not clickable after inspect.");
  }
  if (!(await clickButton(win, "Keep"))) {
    throw new Error("Scenario 3: Keep unused reference button was not clickable.");
  }
  if (!(await waitForText(win, "Kept unused2026", 20_000))) {
    throw new Error("Scenario 3: keep unused reference status did not appear.");
  }
  await installPromptResponses(win, { confirms: [true] });
  const buildCountBeforeCleanup = buildResults.length;
  if (!(await clickButton(win, "Remove"))) {
    throw new Error("Scenario 3: Remove unused reference button was not clickable.");
  }
  const cleanupBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeCleanup && result.status === "succeeded",
    90_000
  );
  if (cleanupBuild?.status !== "succeeded") {
    throw new Error(
      "Scenario 3: project did not compile after unused bibliography cleanup."
    );
  }
  const cleanedReferences = await fs.readFile(
    path.join(projectRoot, "references.bib"),
    "utf8"
  );
  if (
    !cleanedReferences.includes("@article{doe2024") ||
    cleanedReferences.includes("unused2026")
  ) {
    throw new Error(
      "Scenario 3: unused bibliography cleanup removed the wrong entries."
    );
  }
  scenarios.removeUnusedBibliographyEntry = true;

  await fs.writeFile(
    path.join(projectRoot, "references.bib"),
    [
      cleanedReferences.trimEnd(),
      "",
      "@article{malformed2026,",
      "  title = {Malformed Entry Missing Its Closing Delimiter},",
      "  author = {Broken, Entry}",
      "",
      "@book{knuth1984,",
      "  title = {The TeXbook},",
      "  author = {Knuth, Donald},",
      "  year = {1984},",
      "  doi = {10.5555/texbook},",
      "  publisher = {Addison-Wesley}",
      "}",
      "",
      "@book{lamport1994,",
      "  title = {LaTeX: A Document Preparation System},",
      "  author = {Lamport, Leslie},",
      "  year = {1994},",
      "  booktitle = {Document Engineering Archive}",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 4: References tab was not clickable.");
  }
  if (!(await clickReferenceRefreshButton(win))) {
    throw new Error("Scenario 4: Refresh references button was not clickable.");
  }
  if (!(await waitForText(win, "lamport1994", 20_000))) {
    throw new Error("Scenario 4: refreshed references did not include Lamport.");
  }
  for (const [query, expectedText] of [
    ["Knuth", "The TeXbook"],
    ["Document Preparation", "lamport1994"],
    ["1994", "lamport1994"],
    ["10.5555/texbook", "knuth1984"],
    ["Document Engineering Archive", "lamport1994"]
  ]) {
    if (!(await setInputValueByLabel(win, "Search bibliography", query))) {
      throw new Error("Scenario 4: Search bibliography input was not editable.");
    }
    if (!(await clickReferenceSearchButton(win))) {
      throw new Error("Scenario 4: Search references button was not clickable.");
    }
    if (!(await waitForText(win, expectedText, 20_000))) {
      throw new Error(
        `Scenario 4: reference metadata search for ${query} did not find ${expectedText}.`
      );
    }
  }
  if (!(await clickButton(win, "lamport1994"))) {
    throw new Error("Scenario 4: Lamport search result was not previewable.");
  }
  if (!(await waitForText(win, "Opened references.bib", 20_000))) {
    throw new Error("Scenario 4: Lamport preview did not open references.bib.");
  }
  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 4: main.tex was not selectable before citation insert.");
  }
  if (!(await waitForText(win, "Opened main.tex", 20_000))) {
    throw new Error("Scenario 4: main.tex did not open before citation insert.");
  }
  const citationCursor = await setEditorCursor(win, "main.tex", 8, 1);
  if (!citationCursor.ok) {
    throw new Error(
      `Scenario 4: could not place citation insertion cursor: ${JSON.stringify(citationCursor)}`
    );
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 4: References tab was not clickable before insert.");
  }
  if (!(await clickButton(win, "Insert"))) {
    throw new Error("Scenario 4: Insert citation button was not clickable.");
  }
  if (!(await waitForText(win, "Inserted citation lamport1994", 20_000))) {
    throw new Error("Scenario 4: inserted citation status did not appear.");
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error(
      "Scenario 4: Save file button was not clickable after citation insert."
    );
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 4: inserted citation was not saved.");
  }
  const citedMain = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
  if (!citedMain.includes("lamport1994")) {
    throw new Error("Scenario 4: inserted citation key was not written to main.tex.");
  }
  const buildCountBeforeReferenceInsert = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 4: Compile project button was not clickable.");
  }
  const referenceSearchBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeReferenceInsert &&
      result.status === "succeeded",
    90_000
  );
  if (referenceSearchBuild?.status !== "succeeded") {
    throw new Error(
      "Scenario 4: project did not compile after metadata citation insert."
    );
  }
  scenarios.searchReferencesByMetadata = true;

  if (!(await clickFileTreeEntry(win, "plot1.pdf"))) {
    throw new Error("Scenario 4: plot1.pdf was not selectable.");
  }
  await installPromptResponses(win, { prompts: ["figures/error-rate.pdf"] });
  if (!(await clickButton(win, "Move selected entry"))) {
    throw new Error("Scenario 4: Move selected entry button was not clickable.");
  }
  if (!(await waitForText(win, "error-rate.pdf", 20_000))) {
    throw new Error("Scenario 4: moved figure did not appear in the tree.");
  }
  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 4: main.tex was not selectable after figure move.");
  }
  await wait(500);
  await replaceEditorText(win, mainWithMovedFigure, "main.tex");
  if (!(await clickButton(win, "Save file"))) {
    throw new Error(
      "Scenario 4: Save file button was not clickable after figure move."
    );
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 4: moved figure source update was not saved.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 4: Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 4: project did not compile after figure rename.");
  }
  scenarios.renameFigureAsset = true;

  if (!(await clickFileTreeEntry(win, "old-results.tex"))) {
    throw new Error("Scenario 3: old-results.tex was not selectable.");
  }
  await installPromptResponses(win, { confirms: [true] });
  if (!(await clickButton(win, "Delete selected entry"))) {
    throw new Error("Scenario 3: Delete selected entry button was not clickable.");
  }
  if (!(await waitForText(win, "Deleted old-results.tex", 20_000))) {
    throw new Error("Scenario 3: delete status did not appear.");
  }
  if (!(await waitForText(win, "found 0 references", 20_000))) {
    throw new Error(
      "Scenario 3: reference search result did not show zero references."
    );
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 3: Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Scenario 3: project did not compile after obsolete draft delete.");
  }
  scenarios.deleteObsoleteDraft = true;

  if (!(await clickFileTreeEntry(win, "sample.tex"))) {
    throw new Error("Scenario 4: sample.tex was not selectable.");
  }
  if (!(await waitForText(win, "Opened sample.tex", 20_000))) {
    throw new Error("Scenario 4: sample.tex did not open before setting main.");
  }
  if (!(await clickButton(win, "Set active file as main"))) {
    throw new Error("Scenario 4: Set active file as main was not clickable.");
  }
  if (!(await waitForText(win, "Set sample.tex as main file", 20_000))) {
    throw new Error("Scenario 4: sample.tex main-file status did not appear.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 4: Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled sample.tex", 90_000))) {
    throw new Error("Scenario 4: sample.tex was not used for compile.");
  }
  if (!(await clickButton(win, "Close project"))) {
    throw new Error("Scenario 4: Close project button was not clickable.");
  }
  if (!(await waitForText(win, "No Project", 20_000))) {
    throw new Error("Scenario 4: project did not close before persistence check.");
  }
  if (!(await clickButton(win, "scenario-project"))) {
    throw new Error("Scenario 4: recent scenario project was not clickable.");
  }
  if (!(await waitForText(win, "Main: sample.tex", 20_000))) {
    throw new Error("Scenario 4: selected sample.tex did not survive reopen.");
  }
  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 4: main.tex was not selectable for reset.");
  }
  if (!(await waitForText(win, "Opened main.tex", 20_000))) {
    throw new Error("Scenario 4: main.tex did not open before resetting main.");
  }
  if (!(await clickButton(win, "Set active file as main"))) {
    throw new Error("Scenario 4: main.tex reset button was not clickable.");
  }
  if (!(await waitForText(win, "Set main.tex as main file", 20_000))) {
    throw new Error("Scenario 4: main.tex reset status did not appear.");
  }
  scenarios.chooseMainFile = true;

  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 5: pre-change compile button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error(
      "Scenario 5: project did not compile before external figure update."
    );
  }
  const beforeWatcherEvents = projectChangedEventCount;
  const externalRoot = path.join(sandboxPath, "external-assets");
  const latexService = await import("../packages/latex-service/dist/index.js");
  await fs.mkdir(externalRoot, { recursive: true });
  await createPdfAsset(
    latexService,
    externalRoot,
    "results-source.tex",
    "Results 2",
    "results.pdf"
  );
  const resultsPath = path.join(projectRoot, "figures", "results.pdf");
  await fs.copyFile(path.join(externalRoot, "results.pdf"), resultsPath);
  const now = new Date();
  await fs.utimes(resultsPath, now, now);
  await fs.utimes(resultsPath, now, now);
  if (!(await waitForText(win, "Stale", 20_000))) {
    throw new Error("Scenario 5: external figure update did not mark PDF stale.");
  }
  if (!(await clickButton(win, "Source to PDF"))) {
    throw new Error("Scenario 2: stale Source to PDF button was not clickable.");
  }
  if (!(await waitForText(win, "Recompile before SyncTeX; PDF is stale.", 20_000))) {
    throw new Error("Scenario 2: stale SyncTeX jump did not explain recompile need.");
  }
  await wait(750);
  const watcherEventsForBurst = projectChangedEventCount - beforeWatcherEvents;
  if (watcherEventsForBurst !== 1) {
    throw new Error(
      `Scenario 5: expected one debounced project.changed event, saw ${watcherEventsForBurst}.`
    );
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 5: recompile button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error(
      "Scenario 5: project did not recompile after external figure update."
    );
  }
  scenarios.externalFileChange = true;
  scenarios.staleSyncTexMessage = true;
  scenarios.debouncedWatcherEvents = watcherEventsForBurst;

  const citationHeavyMissingMain = [
    "\\documentclass{article}",
    "\\usepackage{natbib}",
    "\\title{Citation Handoff Sample}",
    "\\author{ZeroLeaf QA}",
    "\\begin{document}",
    "\\maketitle",
    "\\section{Related Work}",
    "The handoff draft cites an unresolved source~\\cite{missing2026}.",
    "\\input{sections/related-work}",
    "\\bibliographystyle{plainnat}",
    "\\bibliography{references}",
    "\\end{document}",
    ""
  ].join("\n");
  const citationHeavyFixedMain = citationHeavyMissingMain.replace(
    "missing2026",
    "knuth1984"
  );
  await fs.mkdir(path.join(projectRoot, "sections"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "sections", "related-work.tex"),
    [
      "\\section{Prior Systems}",
      "The related work covers \\citep{knuth1984,lamport1994} and \\citet{mittelbach2004}.",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(projectRoot, "references.bib"),
    [
      "@book{knuth1984,",
      "  title = {The TeXbook},",
      "  author = {Knuth, Donald},",
      "  year = {1984},",
      "  publisher = {Addison-Wesley}",
      "}",
      "",
      "@book{lamport1994,",
      "  title = {LaTeX: A Document Preparation System},",
      "  author = {Lamport, Leslie},",
      "  year = {1994},",
      "  publisher = {Addison-Wesley}",
      "}",
      "",
      "@book{mittelbach2004,",
      "  title = {The LaTeX Companion},",
      "  author = {Mittelbach, Frank and Goossens, Michel},",
      "  year = {2004},",
      "  publisher = {Addison-Wesley}",
      "}",
      "",
      "@article{experiment2024,",
      "  title = {Experiment Terminology},",
      "  author = {Doe, A.},",
      "  year = {2024},",
      "  journal = {Lab Notes}",
      "}",
      "",
      "@article{unused2026,",
      "  title = {Unused Reference for QA},",
      "  author = {Reviewer, Pat},",
      "  journal = {Reference Checks},",
      "  year = {2026}",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  if (!(await clickFileTreeEntry(win, "main.tex"))) {
    throw new Error("Scenario 5: main.tex was not selectable for citation handoff.");
  }
  if (!(await waitForText(win, "Opened main.tex", 20_000))) {
    throw new Error("Scenario 5: main.tex did not open for citation handoff.");
  }
  await replaceEditorText(win, citationHeavyMissingMain, "main.tex");
  const citationHandoffDirty = await waitForOpenFileTabState(
    win,
    "main.tex",
    { dirty: true },
    20_000
  );
  if (!citationHandoffDirty) {
    throw new Error("Scenario 5: citation handoff edit did not mark main.tex dirty.");
  }
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 5: Save file was not clickable for citation handoff.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 5: citation-heavy main file was not saved.");
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 5: References tab was not clickable.");
  }
  if (!(await clickReferenceRefreshButton(win))) {
    throw new Error("Scenario 5: Refresh references button was not clickable.");
  }
  if (!(await waitForText(win, "1 missing · 1 unused", 20_000))) {
    throw new Error(
      "Scenario 5: reference panel did not report missing and unused citation health."
    );
  }
  if (!(await waitForText(win, "missing2026", 20_000))) {
    throw new Error("Scenario 5: missing citation key was not listed.");
  }
  const buildCountBeforeMissingCitationCompile = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 5: Compile project was not clickable with missing key.");
  }
  const missingCitationBuild = await waitForLatestBuildResult(
    () => buildResults.length > buildCountBeforeMissingCitationCompile,
    90_000
  );
  if (
    missingCitationBuild === undefined ||
    !/missing2026|undefined citations?|Citation .* undefined/iu.test(
      `${missingCitationBuild.rawLog}\n${missingCitationBuild.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n")}`
    )
  ) {
    throw new Error(
      "Scenario 5: build diagnostics did not agree with missing citation analysis."
    );
  }
  await replaceEditorText(win, citationHeavyFixedMain, "main.tex");
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 5: Save file was not clickable after key repair.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 5: repaired citation key was not saved.");
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 5: References tab was not clickable after key repair.");
  }
  if (!(await clickReferenceRefreshButton(win))) {
    throw new Error("Scenario 5: Refresh references was not clickable after repair.");
  }
  if (!(await waitForText(win, "0 missing · 1 unused", 20_000))) {
    throw new Error("Scenario 5: reference panel did not clear the missing key.");
  }
  if (!(await clickButton(win, "unused2026"))) {
    throw new Error("Scenario 5: unused bibliography entry was not reviewable.");
  }
  if (!(await waitForText(win, "Opened references.bib", 20_000))) {
    throw new Error("Scenario 5: unused bibliography review did not open .bib.");
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error(
      "Scenario 5: References tab was not clickable after unused review."
    );
  }
  await installPromptResponses(win, { confirms: [true] });
  const buildCountBeforeUnusedRemoval = buildResults.length;
  if (!(await clickButton(win, "Remove"))) {
    throw new Error("Scenario 5: Remove unused bibliography entry was not clickable.");
  }
  const handoffBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeUnusedRemoval &&
      result.status === "succeeded",
    90_000
  );
  if (
    handoffBuild?.status !== "succeeded" ||
    /missing2026|undefined citations?|Citation .* undefined/iu.test(
      `${handoffBuild.rawLog}\n${handoffBuild.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n")}`
    )
  ) {
    throw new Error(
      "Scenario 5: citation-heavy handoff did not compile cleanly after cleanup."
    );
  }
  if (!(await clickBottomTab(win, "References"))) {
    throw new Error("Scenario 5: References tab was not clickable after cleanup.");
  }
  if (!(await clickReferenceRefreshButton(win))) {
    throw new Error("Scenario 5: Refresh references was not clickable after cleanup.");
  }
  if (!(await waitForText(win, "0 missing · 0 unused", 20_000))) {
    throw new Error(
      "Scenario 5: reference panel and build diagnostics did not agree on clean citation health."
    );
  }
  await fs.writeFile(
    path.join(projectRoot, "main.bbl"),
    [
      "\\begin{thebibliography}{1}",
      "\\bibitem{generatedOnly2026} Generated bibliography output should not ship.",
      "\\end{thebibliography}",
      ""
    ].join("\n"),
    "utf8"
  );
  const exportCountBeforeHandoff = exportedSourceZips.length;
  await installPromptResponses(win, { confirms: [false] });
  if (!(await clickButton(win, "Export source ZIP"))) {
    throw new Error("Scenario 5: Export source ZIP button was not clickable.");
  }
  if (!(await waitForText(win, "Exported", 20_000))) {
    throw new Error("Scenario 5: source ZIP export status did not appear.");
  }
  const handoffExport = exportedSourceZips.at(-1);
  if (
    handoffExport === undefined ||
    exportedSourceZips.length !== exportCountBeforeHandoff + 1
  ) {
    throw new Error("Scenario 5: source ZIP export did not produce an archive.");
  }
  const lifecycleService =
    await import("../packages/project-lifecycle-service/dist/index.js");
  const importParentPath = path.join(sandboxPath, "handoff-imports");
  await fs.mkdir(importParentPath, { recursive: true });
  const importedHandoff = await lifecycleService.importProjectZip({
    zipPath: handoffExport.archivePath,
    destinationParentPath: importParentPath,
    projectName: "citation-heavy-handoff"
  });
  const importedMain = await fs.readFile(
    path.join(importedHandoff.projectRoot, "main.tex"),
    "utf8"
  );
  const importedReferences = await fs.readFile(
    path.join(importedHandoff.projectRoot, "references.bib"),
    "utf8"
  );
  if (
    !importedMain.includes("knuth1984") ||
    importedMain.includes("missing2026") ||
    importedReferences.includes("unused2026")
  ) {
    throw new Error(
      "Scenario 5: exported handoff source did not include cleaned refs."
    );
  }
  try {
    await fs.stat(path.join(importedHandoff.projectRoot, "main.bbl"));
    throw new Error("Scenario 5: exported handoff ZIP included generated main.bbl.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  scenarios.validateCitationHeavyHandoff = {
    exportedFiles: handoffExport.fileCount,
    importedFiles: importedHandoff.fileCount,
    bblExcluded: true
  };

  const exportCountBeforeArtifacts = exportedSourceZips.length;
  await installPromptResponses(win, { confirms: [true] });
  if (!(await clickButton(win, "Export source ZIP"))) {
    throw new Error(
      "Scenario 1: explicit source ZIP export with artifacts was not clickable."
    );
  }
  if (!(await waitForText(win, "with build artifacts included", 20_000))) {
    throw new Error(
      "Scenario 1: explicit source ZIP export did not acknowledge artifacts."
    );
  }
  const artifactExport = exportedSourceZips.at(-1);
  if (
    artifactExport === undefined ||
    exportedSourceZips.length !== exportCountBeforeArtifacts + 1
  ) {
    throw new Error(
      "Scenario 1: explicit source ZIP export did not produce an archive."
    );
  }
  const artifactImportParentPath = path.join(sandboxPath, "artifact-imports");
  await fs.mkdir(artifactImportParentPath, { recursive: true });
  const importedArtifacts = await lifecycleService.importProjectZip({
    zipPath: artifactExport.archivePath,
    destinationParentPath: artifactImportParentPath,
    projectName: "citation-heavy-with-artifacts"
  });
  await fs.stat(path.join(importedArtifacts.projectRoot, "main.bbl"));
  scenarios.exportWithArtifacts = {
    includedBuildArtifacts: true,
    exportedFiles: artifactExport.fileCount,
    bblIncluded: true
  };

  if (!(await clickButton(win, "Close project"))) {
    throw new Error("Scenario 1: Close project button was not clickable.");
  }
  if (!(await waitForText(win, "No Project", 20_000))) {
    throw new Error("Scenario 1: project did not close before ZIP import.");
  }
  nextImportZipPath = handoffExport.archivePath;
  nextImportDestinationParentPath = path.join(sandboxPath, "app-imports");
  nextImportProjectName = "citation-heavy-handoff";
  await fs.mkdir(nextImportDestinationParentPath, { recursive: true });
  if (!(await clickButton(win, "Import ZIP"))) {
    throw new Error("Scenario 1: Import ZIP button was not clickable.");
  }
  if (!(await waitForText(win, "Imported citation-heavy-handoff", 20_000))) {
    throw new Error("Scenario 1: imported handoff project did not open in the app.");
  }
  const buildCountBeforeImportedCompile = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 1: imported handoff compile button was not clickable.");
  }
  const importedCompile = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeImportedCompile &&
      result.status === "succeeded",
    90_000
  );
  if (importedCompile?.status !== "succeeded") {
    throw new Error("Scenario 1: imported handoff project did not compile.");
  }
  scenarios.importedHandoffCompile = true;

  await clickFileTreeEntry(win, "main.tex");
  await wait(300);
  await replaceEditorModelText(
    win,
    "main.tex",
    "Citation Handoff Sample",
    "Citation Handoff Sample (stale)"
  );
  if (!(await clickButton(win, "Save file"))) {
    throw new Error(
      "Scenario 2: Save file button was not clickable before stale export."
    );
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 2: main.tex save did not complete before stale export.");
  }
  const stalePdfLabel = await getPdfStaleLabel(win);
  if (!stalePdfLabel.includes("Stale: saved source newer than PDF")) {
    throw new Error(
      `Scenario 2: saved edit did not mark the PDF stale before export: ${stalePdfLabel}`
    );
  }
  const exportedPdfCountBeforeWarning = exportedPdfs.length;
  await installPromptResponses(win, { confirms: [false] });
  if (!(await clickButton(win, "Save PDF"))) {
    throw new Error("Scenario 2: Save PDF button was not clickable while stale.");
  }
  if (
    !(await waitForText(
      win,
      "PDF export cancelled. Recompile first for a current PDF.",
      20_000
    ))
  ) {
    throw new Error("Scenario 2: stale PDF export did not warn before cancellation.");
  }
  if (exportedPdfs.length !== exportedPdfCountBeforeWarning) {
    throw new Error("Scenario 2: stale PDF export proceeded despite cancellation.");
  }

  const buildCountBeforeFreshPdf = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Scenario 2: compile button was not clickable before fresh PDF export."
    );
  }
  const freshPdfBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeFreshPdf && result.status === "succeeded",
    90_000
  );
  if (freshPdfBuild?.status !== "succeeded") {
    throw new Error("Scenario 2: fresh compile did not succeed before PDF export.");
  }
  const exportedPdfCountBeforeSave = exportedPdfs.length;
  const openedPathCountBeforeSave = openedExternalPaths.length;
  if (!(await clickButton(win, "Save PDF"))) {
    throw new Error("Scenario 2: Save PDF button was not clickable after compile.");
  }
  if (!(await waitForText(win, "opened it in your default PDF viewer", 20_000))) {
    throw new Error(
      "Scenario 2: PDF export success status did not mention viewer open."
    );
  }
  const exportedPdf = exportedPdfs.at(-1);
  const openedPdfPath = openedExternalPaths.at(-1);
  if (
    exportedPdf === undefined ||
    exportedPdfs.length !== exportedPdfCountBeforeSave + 1 ||
    openedExternalPaths.length !== openedPathCountBeforeSave + 1
  ) {
    throw new Error(
      "Scenario 2: PDF export did not produce a saved file and viewer open."
    );
  }
  const exportedPdfStats = await fs.stat(exportedPdf.destinationPath);
  const [sourcePdfBytes, exportedPdfBytes] = await Promise.all([
    fs.readFile(exportedPdf.pdfPath),
    fs.readFile(exportedPdf.destinationPath)
  ]);
  if (
    exportedPdfStats.size === 0 ||
    openedPdfPath !== exportedPdf.destinationPath ||
    !sourcePdfBytes.equals(exportedPdfBytes)
  ) {
    throw new Error("Scenario 2: exported PDF was empty or viewer path did not match.");
  }
  scenarios.exportCompiledPdf = {
    byteLength: exportedPdf.byteLength,
    openedInViewer: true,
    staleWarningCancelled: true,
    matchesLatestBuild: true
  };

  if (!(await clickButton(win, "Close project"))) {
    throw new Error("Scenario 3: Close project button was not clickable.");
  }
  if (!(await waitForText(win, "No Project", 20_000))) {
    throw new Error("Scenario 3: project did not close before Overleaf import.");
  }

  const overleafZipPath = path.join(sandboxPath, "overleaf-source.zip");
  await fs.writeFile(
    overleafZipPath,
    createTestZipArchive([
      {
        path: "main.tex",
        data: Buffer.from(
          [
            "\\documentclass{article}",
            "\\title{Imported Overleaf Draft}",
            "\\begin{document}",
            "\\maketitle",
            "Imported from Overleaf.",
            "\\end{document}",
            ""
          ].join("\n"),
          "utf8"
        )
      },
      {
        path: "sections/intro.tex",
        data: Buffer.from("\\section{Intro}\nOverleaf section.\n", "utf8")
      },
      {
        path: "../escape.tex",
        data: Buffer.from("blocked\n", "utf8")
      },
      {
        path: "__MACOSX/._main.tex",
        data: Buffer.from("ignored\n", "utf8")
      }
    ])
  );
  const importConflictParentPath = path.join(sandboxPath, "overleaf-conflict");
  await fs.mkdir(path.join(importConflictParentPath, "overleaf-migrated"), {
    recursive: true
  });
  nextImportZipPath = overleafZipPath;
  nextImportDestinationParentPath = importConflictParentPath;
  nextImportProjectName = "overleaf-migrated";
  if (!(await clickButton(win, "Import ZIP"))) {
    throw new Error("Scenario 3: Import ZIP button was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      "A project folder with that name already exists in the chosen destination.",
      20_000
    ))
  ) {
    throw new Error(
      "Scenario 3: import destination conflict was not reported clearly."
    );
  }

  const overleafImportParentPath = path.join(sandboxPath, "overleaf-imports");
  await fs.mkdir(overleafImportParentPath, { recursive: true });
  nextImportZipPath = overleafZipPath;
  nextImportDestinationParentPath = overleafImportParentPath;
  nextImportProjectName = "overleaf-migrated";
  if (!(await clickButton(win, "Import ZIP"))) {
    throw new Error("Scenario 3: Import ZIP retry button was not clickable.");
  }
  if (!(await waitForText(win, "Imported overleaf-migrated", 20_000))) {
    throw new Error("Scenario 3: Overleaf ZIP did not import into the app.");
  }
  for (const expectedTreeEntry of ["main.tex", "sections", "intro.tex"]) {
    if (!(await waitForText(win, expectedTreeEntry, 20_000))) {
      throw new Error(`Scenario 3: imported tree did not show ${expectedTreeEntry}.`);
    }
  }
  try {
    await fs.stat(path.join(overleafImportParentPath, "escape.tex"));
    throw new Error("Scenario 3: ZIP traversal entry escaped the import destination.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!(await waitForText(win, "Main: main.tex", 20_000))) {
    throw new Error("Scenario 3: imported project did not detect main.tex.");
  }
  const buildCountBeforeImportedOverleafCompile = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 3: imported Overleaf compile button was not clickable.");
  }
  const importedOverleafBuild = await waitForLatestBuildResult(
    (result) =>
      buildResults.length > buildCountBeforeImportedOverleafCompile &&
      result.status === "succeeded",
    90_000
  );
  if (importedOverleafBuild?.status !== "succeeded") {
    throw new Error("Scenario 3: imported Overleaf project did not compile.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 20_000))) {
    throw new Error("Scenario 3: imported Overleaf compile did not settle in the UI.");
  }
  scenarios.importOverleafZip = {
    conflictHandled: true,
    traversalBlocked: true,
    compiled: true
  };

  if (!(await clickButton(win, "Close project"))) {
    throw new Error("Scenario 4: Close project button was not clickable.");
  }
  if (!(await waitForText(win, "No Project", 20_000))) {
    throw new Error("Scenario 4: project did not close before template creation.");
  }
  if (!(await selectTemplateValue(win, "beamer"))) {
    throw new Error("Scenario 4: Beamer template could not be selected.");
  }
  nextCreateDestinationParentPath = path.join(sandboxPath, "template-projects");
  await fs.mkdir(nextCreateDestinationParentPath, { recursive: true });
  await installPromptResponses(win, { prompts: ["../bad-beamer"] });
  if (!(await clickButton(win, "Create Project"))) {
    throw new Error("Scenario 4: Create Project button was not clickable.");
  }
  if (!(await waitForText(win, "Invalid project name.", 20_000))) {
    throw new Error("Scenario 4: invalid Beamer project name was not rejected.");
  }
  await installPromptResponses(win, { prompts: ["beamer-deck"] });
  if (!(await clickButton(win, "Create Project"))) {
    throw new Error("Scenario 4: Create Project retry button was not clickable.");
  }
  if (!(await waitForText(win, "Created beamer-deck", 20_000))) {
    throw new Error("Scenario 4: Beamer project was not created.");
  }
  if (!(await waitForText(win, "Main: main.tex", 20_000))) {
    throw new Error("Scenario 4: Beamer template did not detect main.tex.");
  }
  await replaceEditorModelText(
    win,
    "main.tex",
    "Presentation Title",
    "Beamer Migration Review"
  );
  if (!(await clickButton(win, "Save file"))) {
    throw new Error("Scenario 4: Save file button was not clickable for Beamer.");
  }
  if (!(await waitForText(win, "Saved main.tex", 20_000))) {
    throw new Error("Scenario 4: Beamer title-slide edit did not save.");
  }
  const beamerBuildCount = buildResults.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Scenario 4: Beamer compile button was not clickable.");
  }
  const beamerBuild = await waitForLatestBuildResult(
    (result) => buildResults.length > beamerBuildCount && result.status === "succeeded",
    90_000
  );
  if (beamerBuild?.status !== "succeeded") {
    throw new Error("Scenario 4: Beamer template project did not compile.");
  }
  const beamerMain = await fs.readFile(
    path.join(nextCreateDestinationParentPath, "beamer-deck", "main.tex"),
    "utf8"
  );
  if (!beamerMain.includes("Beamer Migration Review")) {
    throw new Error("Scenario 4: Beamer title-slide edit was not written to source.");
  }
  scenarios.createBeamerTemplate = {
    invalidNameRejected: true,
    mainFileDetected: true,
    compiled: true
  };

  return scenarios;
}

async function getDomSummary(win) {
  return win.webContents.executeJavaScript(`
    (() => ({
      text: document.body.innerText,
      unlabeledButtons: [...document.querySelectorAll("button")]
        .filter((button) => button.innerText.trim().length === 0 && (button.getAttribute("aria-label") ?? "").trim().length === 0)
        .length,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 4
    }))()
  `);
}

function createTestZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const compressedData = zlib.deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.byteLength, 18);
    localHeader.writeUInt32LE(entry.data.byteLength, 22);
    localHeader.writeUInt16LE(pathBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, pathBytes, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.byteLength, 20);
    centralHeader.writeUInt32LE(entry.data.byteLength, 24);
    centralHeader.writeUInt16LE(pathBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, pathBytes);
    offset += localHeader.byteLength + pathBytes.byteLength + compressedData.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.byteLength, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function crc32(data) {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = (crcTable[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256).map((_value, index) => {
  let code = index;
  for (let bit = 0; bit < 8; bit += 1) {
    code = code & 1 ? 0xedb88320 ^ (code >>> 1) : code >>> 1;
  }
  return code >>> 0;
});

async function getPdfCanvasState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const canvas = document.querySelector(".pdf-page-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { found: false, width: 0, height: 0 };
      }
      return {
        found: true,
        width: canvas.width,
        height: canvas.height
      };
    })()
  `);
}

async function getSyncTexUiState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const marker = document.querySelector(".synctex-marker");
      const pageIndicator = document.querySelector(".pdf-page-indicator");
      return {
        markerVisible: marker instanceof HTMLElement,
        markerLeft: marker instanceof HTMLElement ? marker.style.left : "",
        markerTop: marker instanceof HTMLElement ? marker.style.top : "",
        pageIndicator: pageIndicator?.textContent?.trim() ?? "",
        text: document.body.innerText
      };
    })()
  `);
}

async function setPdfSearchQuery(win, query) {
  const updated = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector("input[aria-label='Search PDF']");
      if (!(input instanceof HTMLInputElement)) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      input.focus();
      valueSetter?.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  if (updated) {
    await captureStep(win, `set-pdf-search-${query}`);
  }
  return updated;
}

async function getPdfSearchUiState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const pageIndicator = document.querySelector(".pdf-page-indicator");
      const searchCount = document.querySelector(".pdf-search-count");
      return {
        pageIndicator: pageIndicator?.textContent?.trim() ?? "",
        searchCount: searchCount?.textContent?.trim() ?? "",
        text: document.body.innerText
      };
    })()
  `);
}

async function waitForSyncTexMarkerOnPage(win, pageNumber, timeoutMs = 10_000) {
  const started = Date.now();
  const expectedPrefix = `${pageNumber} /`;

  while (Date.now() - started < timeoutMs) {
    const state = await getSyncTexUiState(win);
    if (
      state.markerVisible &&
      state.markerLeft.length > 0 &&
      state.markerTop.length > 0 &&
      state.pageIndicator.startsWith(expectedPrefix)
    ) {
      return state;
    }
    await wait(200);
  }

  return getSyncTexUiState(win);
}

function createE2EToolEvent(sessionId, toolName, status, summary, risk) {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "tool-call",
    toolName,
    status,
    summary,
    risk
  };
}

function createE2EApprovalEvent(sessionId, approvalId, decision) {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "approval",
    approvalId,
    toolName: "apply-patch",
    risk: "high",
    prompt: decision === "allowed" ? "Approved by user." : "Denied by user.",
    status: decision
  };
}

function createE2EVerificationEvent(sessionId, status, summary, buildJobId) {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "verification",
    status,
    summary,
    ...(buildJobId === undefined ? {} : { buildJobId })
  };
}

async function recordE2EAgentEvents(projectRoot, events, changesetId) {
  await Promise.all(
    events.map((event) =>
      historyStore.recordAuditEvent({
        projectRoot,
        eventType: `agent.${event.type}`,
        message: summarizeE2EAgentEvent(event),
        ...(changesetId === undefined ? {} : { changesetId })
      })
    )
  );
}

function summarizeE2EAgentEvent(event) {
  switch (event.type) {
    case "message":
      return `${event.role}: ${event.content}`;
    case "tool-call":
      return `${event.toolName} ${event.status}: ${event.summary}`;
    case "patch":
      return `${event.status}: ${event.filePath} · ${event.summary}`;
    case "approval":
      return `${event.toolName} ${event.status}: ${event.prompt}`;
    case "verification":
      return `${event.status}: ${event.summary}${
        event.buildJobId === undefined ? "" : ` · build ${event.buildJobId}`
      }`;
    case "error":
      return event.message;
    default:
      return JSON.stringify(event);
  }
}

async function registerIpc(projectRoot) {
  const { defaultAppSettings, defaultWorkbenchLayout } =
    await import("../packages/ipc-contracts/dist/index.js");
  const projectService = await import("../packages/project-service/dist/index.js");
  const latexService = await import("../packages/latex-service/dist/index.js");
  const pdfService = await import("../packages/pdf-service/dist/index.js");
  const historyService = await import("../packages/history-service/dist/index.js");
  const agentHost = await import("../packages/agent-host/dist/index.js");
  const referenceService = await import("../packages/reference-service/dist/index.js");
  const lifecycleService =
    await import("../packages/project-lifecycle-service/dist/index.js");
  const metadata = new projectService.ProjectMetadataStore(
    path.join(sandboxPath, "metadata.json")
  );
  historyStore = new historyService.HistoryStore(
    path.join(sandboxPath, "history.sqlite")
  );
  appSettingsState = defaultAppSettings;
  sharedE2EState.cacheRoot = path.join(sandboxPath, "shared-cache");

  const getSharedProject = (projectId) => {
    const project = sharedE2EState.projects.find(
      (candidate) => candidate.id === projectId
    );
    if (project === undefined) {
      throw new Error(`Shared project ${projectId} was not found.`);
    }
    return project;
  };
  const getSharedRevisionKey = (projectId, filePath) => `${projectId}:${filePath}`;
  const getSharedRevision = (projectId, filePath) => {
    const revision = sharedE2EState.revisions.get(
      getSharedRevisionKey(projectId, filePath)
    );
    if (revision === undefined) {
      throw new Error(`Shared file ${filePath} was not found.`);
    }
    return revision;
  };
  const updateSharedRevision = updateSharedE2ERevision;
  const applySharedTextOperations = (contents, operations) => {
    return [...operations]
      .sort((left, right) => right.rangeOffset - left.rangeOffset)
      .reduce(
        (nextContents, operation) =>
          `${nextContents.slice(0, operation.rangeOffset)}${operation.text}${nextContents.slice(
            operation.rangeOffset + operation.rangeLength
          )}`,
        contents
      );
  };
  const toSharedProjectSummary = (project, role = project.role) => ({
    id: project.id,
    name: project.name,
    ownerUserId: project.ownerUserId,
    mainFilePath: project.mainFilePath,
    compiler: project.compiler,
    role,
    updatedAt: project.updatedAt
  });
  const getSharedUserIdForEmail = (email) => {
    if (email === "owner@example.test") {
      return "shared-user-owner";
    }
    if (email === "collaborator@example.test") {
      return "shared-user-collaborator";
    }
    return `shared-user-${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
  };
  const getSharedActorUserId = () =>
    sharedE2EState.connection.user?.id ?? "shared-user-owner";
  const getSharedProjectMembership = (projectId, userId = getSharedActorUserId()) =>
    (sharedE2EState.members.get(projectId) ?? []).find(
      (member) => member.userId === userId
    );
  const writeSharedSourceExportFile = async (rootPath, filePath, contents) => {
    const targetPath = path.join(rootPath, filePath);
    const relativePath = path.relative(rootPath, targetPath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error("Shared E2E export contained an unsafe project path.");
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, contents, "utf8");
  };
  const createPromptHash = (prompt) =>
    createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const recordSharedActivity = (projectId, eventType, message) => {
    const event = {
      id: `shared-activity-${sharedE2EState.activity.length + 1}`,
      projectId,
      actorUserId: getSharedActorUserId(),
      eventType,
      message,
      createdAt: new Date().toISOString()
    };
    sharedE2EState.activity.unshift(event);
    return event;
  };
  const recordSharedAuditEvent = (projectId, eventType, message, details = {}) => {
    const event = {
      id: `shared-audit-${sharedE2EState.auditEvents.length + 1}`,
      projectId,
      actorUserId: getSharedActorUserId(),
      eventType,
      message,
      ...details,
      createdAt: new Date().toISOString()
    };
    sharedE2EState.auditEvents.unshift(event);
    return event;
  };
  const summarizeSharedPatchPreview = (beforeContents, afterContents) => {
    const beforeLines = beforeContents.split(/\r?\n/).slice(0, 8).join("\n");
    const afterLines = afterContents.split(/\r?\n/).slice(0, 8).join("\n");
    return [`--- before`, beforeLines, `--- after`, afterLines].join("\n");
  };
  const getSharedAgentRun = (projectId, agentRunId) => {
    const run = sharedE2EState.agentRuns.find(
      (candidate) => candidate.projectId === projectId && candidate.id === agentRunId
    );
    if (run === undefined) {
      throw new Error(`Shared agent run ${agentRunId} was not found.`);
    }
    return run;
  };
  const getSharedAgentChangeSet = (projectId, changesetId) => {
    const changeset = sharedE2EState.agentChangeSets.find(
      (candidate) => candidate.projectId === projectId && candidate.id === changesetId
    );
    if (changeset === undefined) {
      throw new Error(`Shared agent changeset ${changesetId} was not found.`);
    }
    return changeset;
  };

  ipcMain.handle("app.getInfo", () => ({
    appName: "ZeroLeaf",
    appVersion: "e2e",
    platform: process.platform,
    isPackaged: false
  }));
  ipcMain.handle("app.checkForUpdates", () => ({
    checkedAt: new Date().toISOString(),
    currentVersion: "e2e",
    state: "not-configured",
    message: "E2E smoke does not check for updates."
  }));
  ipcMain.handle("app.openUpdateDownload", () => ({ opened: true }));
  ipcMain.handle("app.installUpdate", () => ({
    scheduled: true,
    installerPath: path.join(sandboxPath, "ZeroLeaf-e2e.dmg"),
    targetAppPath: "/Applications/ZeroLeaf.app",
    message: "E2E smoke does not install updates."
  }));
  ipcMain.handle("workbench.loadLayout", () => defaultWorkbenchLayout);
  ipcMain.handle("workbench.saveLayout", (_event, layout) => layout);
  ipcMain.handle(
    "editor.loadProjectState",
    (_event, request) =>
      editorProjectStates.get(request.projectRoot) ?? {
        projectRoot: request.projectRoot,
        openFilePaths: []
      }
  );
  ipcMain.handle("editor.saveProjectState", (_event, state) => {
    editorProjectStates.set(state.projectRoot, state);
    return state;
  });
  ipcMain.handle("project.getState", async () => ({
    recentProjects: await metadata.listRecentProjects()
  }));
  ipcMain.handle("project.open", () =>
    projectService.openProject(projectRoot, metadata)
  );
  ipcMain.handle("project.openRecent", (_event, request) =>
    projectService.openProject(request.rootPath, metadata)
  );
  ipcMain.handle("project.refresh", (_event, request) =>
    projectService.refreshProject(request.projectRoot, metadata)
  );
  ipcMain.handle("project.createEntry", async (_event, request) => {
    await projectService.createProjectEntry(
      request.projectRoot,
      request.parentPath,
      request.name,
      request.kind
    );
    return projectService.refreshProject(request.projectRoot, metadata);
  });
  ipcMain.handle("project.renameEntry", async (_event, request) => {
    await projectService.renameProjectEntry(
      request.projectRoot,
      request.path,
      request.newName
    );
    return projectService.refreshProject(request.projectRoot, metadata);
  });
  ipcMain.handle("project.moveEntry", async (_event, request) => {
    await projectService.moveProjectEntry(
      request.projectRoot,
      request.path,
      request.newPath
    );
    return projectService.refreshProject(request.projectRoot, metadata);
  });
  ipcMain.handle("project.deleteEntry", async (_event, request) => {
    const deletedEntry = await projectService.deleteProjectEntry(
      request.projectRoot,
      request.path
    );
    const result = await projectService.refreshProject(request.projectRoot, metadata);
    return { ...result, deletedEntry };
  });
  ipcMain.handle("project.setMainFile", (_event, request) =>
    projectService.setProjectMainFile(request.projectRoot, metadata, request.path)
  );
  ipcMain.handle("shared.getConnection", () => sharedE2EState.connection);
  ipcMain.handle("shared.signIn", (_event, request) => {
    const now = new Date().toISOString();
    const user = {
      id: getSharedUserIdForEmail(request.email),
      email: request.email,
      name: request.name ?? request.email,
      createdAt: now
    };
    sharedE2EState.users = [
      ...sharedE2EState.users.filter((candidate) => candidate.id !== user.id),
      user
    ];
    sharedE2EState.sessions = [
      {
        id: "e2e-current-session",
        userId: user.id,
        current: true,
        accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        refreshTokenExpiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60_000
        ).toISOString(),
        createdAt: now
      },
      {
        id: "e2e-remote-session",
        userId: user.id,
        current: false,
        accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        refreshTokenExpiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60_000
        ).toISOString(),
        createdAt: now
      }
    ];
    sharedE2EState.connection = {
      connected: true,
      baseUrl: request.baseUrl,
      user
    };
    return sharedE2EState.connection;
  });
  ipcMain.handle("shared.signOut", () => {
    sharedE2EState.connection = { connected: false };
    return sharedE2EState.connection;
  });
  ipcMain.handle("shared.listSessions", () => sharedE2EState.sessions);
  ipcMain.handle("shared.revokeSession", (_event, request) => {
    const beforeCount = sharedE2EState.sessions.length;
    sharedE2EState.sessions = sharedE2EState.sessions.filter(
      (session) => session.id !== request.sessionId || session.current
    );
    return {
      sessionId: request.sessionId,
      revoked: sharedE2EState.sessions.length !== beforeCount
    };
  });
  ipcMain.handle("shared.listProjects", () => {
    const userId = getSharedActorUserId();
    return sharedE2EState.projects.flatMap((project) => {
      const membership = getSharedProjectMembership(project.id, userId);
      return membership === undefined
        ? []
        : [toSharedProjectSummary(project, membership.role)];
    });
  });
  ipcMain.handle("shared.createProject", async (_event, request) => {
    const now = new Date().toISOString();
    const user = sharedE2EState.connection.user;
    const project = {
      id: createSharedE2EProjectId(),
      name: request.name,
      ownerUserId: user?.id ?? "shared-user-owner",
      mainFilePath: request.files?.some((file) => file.path === "main.tex")
        ? "main.tex"
        : request.files?.[0]?.path,
      compiler: "pdflatex",
      role: "owner",
      updatedAt: now
    };
    sharedE2EState.projects.push(project);
    sharedE2EState.members.set(project.id, [
      {
        projectId: project.id,
        userId: project.ownerUserId,
        email: user?.email ?? "owner@example.test",
        name: user?.name ?? "Owner",
        role: "owner",
        joinedAt: now
      }
    ]);
    sharedE2EState.presence = [
      ...sharedE2EState.presence.filter(
        (presence) =>
          presence.projectId !== project.id ||
          presence.userId !== "shared-user-remote-cursor"
      ),
      {
        projectId: project.id,
        userId: "shared-user-remote-cursor",
        displayName: "E2E Remote Cursor",
        filePath: project.mainFilePath ?? "main.tex",
        cursorLine: 1,
        cursorColumn: 12,
        updatedAt: now
      }
    ];
    for (const file of request.files ?? []) {
      await updateSharedRevision(project.id, file.path, file.contents);
    }
    return toSharedProjectSummary(project);
  });
  ipcMain.handle("shared.createFromLocalProject", async (_event, request) => {
    const sourceFiles = await lifecycleService.collectSharedProjectSourceFiles({
      projectRoot: request.projectRoot
    });
    if (sourceFiles.files.length === 0) {
      throw new Error("No shareable source files were found in this local project.");
    }

    const now = new Date().toISOString();
    const user = sharedE2EState.connection.user;
    const project = {
      id: createSharedE2EProjectId(),
      name: request.name,
      ownerUserId: user?.id ?? "shared-user-owner",
      mainFilePath: sourceFiles.files.some((file) => file.path === "main.tex")
        ? "main.tex"
        : (sourceFiles.files.find((file) => file.path.endsWith(".tex"))?.path ??
          sourceFiles.files[0].path),
      compiler: "pdflatex",
      role: "owner",
      updatedAt: now
    };
    sharedE2EState.projects.push(project);
    sharedE2EState.members.set(project.id, [
      {
        projectId: project.id,
        userId: project.ownerUserId,
        email: user?.email ?? "owner@example.test",
        name: user?.name ?? "Owner",
        role: "owner",
        joinedAt: now
      }
    ]);
    for (const file of sourceFiles.files) {
      await updateSharedRevision(project.id, file.path, file.contents);
    }

    return {
      project: toSharedProjectSummary(project),
      importedFileCount: sourceFiles.files.length,
      importedDirectoryCount: sourceFiles.directories.length,
      skippedFilePaths: sourceFiles.skippedFilePaths
    };
  });
  ipcMain.handle("shared.createFromSourceZip", async (_event, request) => {
    if (nextImportZipPath === undefined) {
      return undefined;
    }

    const requestedName = request.name?.trim();
    const tempParentPath = path.join(
      sandboxPath,
      `shared-zip-import-${sharedE2EState.projects.length + 1}`
    );
    await fs.rm(tempParentPath, { recursive: true, force: true });
    await fs.mkdir(tempParentPath, { recursive: true });

    try {
      const imported = await lifecycleService.importProjectZip({
        zipPath: nextImportZipPath,
        destinationParentPath: tempParentPath,
        projectName:
          requestedName?.length > 0
            ? requestedName
            : (nextImportProjectName ??
              path.basename(nextImportZipPath, path.extname(nextImportZipPath)))
      });
      const sourceFiles = await lifecycleService.collectSharedProjectSourceFiles({
        projectRoot: imported.projectRoot
      });
      if (sourceFiles.files.length === 0) {
        throw new Error("No shareable source files were found in this ZIP archive.");
      }

      const now = new Date().toISOString();
      const user = sharedE2EState.connection.user;
      const project = {
        id: createSharedE2EProjectId(),
        name:
          requestedName?.length > 0
            ? requestedName
            : (nextImportProjectName ?? path.basename(imported.projectRoot)),
        ownerUserId: user?.id ?? "shared-user-owner",
        mainFilePath: sourceFiles.files.some((file) => file.path === "main.tex")
          ? "main.tex"
          : (sourceFiles.files.find((file) => file.path.endsWith(".tex"))?.path ??
            sourceFiles.files[0].path),
        compiler: "pdflatex",
        role: "owner",
        updatedAt: now
      };
      sharedE2EState.projects.push(project);
      sharedE2EState.members.set(project.id, [
        {
          projectId: project.id,
          userId: project.ownerUserId,
          email: user?.email ?? "owner@example.test",
          name: user?.name ?? "Owner",
          role: "owner",
          joinedAt: now
        }
      ]);
      for (const file of sourceFiles.files) {
        await updateSharedRevision(project.id, file.path, file.contents);
      }

      return {
        project: toSharedProjectSummary(project),
        importedFileCount: sourceFiles.files.length,
        importedDirectoryCount: sourceFiles.directories.length,
        skippedFilePaths: sourceFiles.skippedFilePaths
      };
    } finally {
      nextImportZipPath = undefined;
      nextImportProjectName = undefined;
      await fs.rm(tempParentPath, { recursive: true, force: true });
    }
  });
  ipcMain.handle("shared.exportSourceZip", async (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership?.role !== "owner") {
      throw new Error("Only owners can export shared projects.");
    }

    const project = getSharedProject(request.projectId);
    const tempRoot = path.join(
      sandboxPath,
      `shared-source-export-root-${exportedSharedSourceZips.length + 1}`
    );
    const destinationPath = path.join(
      sandboxPath,
      `shared-source-export-${exportedSharedSourceZips.length + 1}.zip`
    );
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });

    try {
      for (const revision of sharedE2EState.revisions.values()) {
        if (revision.projectId === request.projectId) {
          await writeSharedSourceExportFile(tempRoot, revision.path, revision.contents);
        }
      }
      const result = await lifecycleService.exportSourceZip({
        projectRoot: tempRoot,
        destinationPath,
        includeBuildArtifacts: false
      });
      const exportResult = {
        ...result,
        projectId: project.id,
        projectName: project.name
      };
      exportedSharedSourceZips.push(exportResult);
      return result;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
  ipcMain.handle("shared.deleteProject", (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership?.role !== "owner") {
      throw new Error("Only owners can delete shared projects.");
    }

    const project = getSharedProject(request.projectId);
    sharedE2EState.projects = sharedE2EState.projects.filter(
      (candidate) => candidate.id !== request.projectId
    );
    sharedE2EState.members.delete(request.projectId);
    sharedE2EState.invitations = sharedE2EState.invitations.filter(
      (invitation) => invitation.projectId !== request.projectId
    );
    sharedE2EState.comments = sharedE2EState.comments.filter(
      (comment) => comment.projectId !== request.projectId
    );
    sharedE2EState.presence = sharedE2EState.presence.filter(
      (presence) => presence.projectId !== request.projectId
    );
    sharedE2EState.buildArtifacts = sharedE2EState.buildArtifacts.filter(
      (artifact) => artifact.projectId !== request.projectId
    );
    sharedE2EState.agentRuns = sharedE2EState.agentRuns.filter(
      (run) => run.projectId !== request.projectId
    );
    sharedE2EState.agentChangeSets = sharedE2EState.agentChangeSets.filter(
      (changeset) => changeset.projectId !== request.projectId
    );
    sharedE2EState.activity = sharedE2EState.activity.filter(
      (event) => event.projectId !== request.projectId
    );
    sharedE2EState.auditEvents = sharedE2EState.auditEvents.filter(
      (event) => event.projectId !== request.projectId
    );
    for (const key of [...sharedE2EState.revisions.keys()]) {
      if (key.startsWith(`${request.projectId}:`)) {
        sharedE2EState.revisions.delete(key);
      }
    }
    sharedE2EState.revisionHistory = sharedE2EState.revisionHistory.filter(
      (revision) => revision.projectId !== request.projectId
    );
    return toSharedProjectSummary(project, "owner");
  });
  ipcMain.handle("shared.openProject", async (_event, request) => {
    const sharedProject = getSharedProject(request.projectId);
    const membership = getSharedProjectMembership(request.projectId);
    if (membership === undefined) {
      throw new Error("Current user is not a member of this shared project.");
    }
    const cachePath = path.join(sharedE2EState.cacheRoot, request.projectId);
    await fs.rm(cachePath, { recursive: true, force: true });
    await fs.mkdir(cachePath, { recursive: true });
    for (const [key, revision] of sharedE2EState.revisions.entries()) {
      if (key.startsWith(`${request.projectId}:`)) {
        await writeSharedE2ECacheFile(
          request.projectId,
          revision.path,
          revision.contents
        );
      }
    }
    if (sharedProject.mainFilePath !== undefined) {
      await projectService.setProjectMainFile(
        cachePath,
        metadata,
        sharedProject.mainFilePath
      );
    }
    const opened = await projectService.openProject(cachePath, metadata);
    return {
      ...opened,
      sharedProjectId: request.projectId,
      localCachePath: cachePath,
      role: membership.role,
      compiler: sharedProject.compiler
    };
  });
  ipcMain.handle("shared.invite", (_event, request) => {
    const invitation = {
      id: `invite-${sharedE2EState.invitations.length + 1}`,
      projectId: request.projectId,
      email: request.email,
      role: request.role,
      status: "pending"
    };
    sharedE2EState.invitations.push(invitation);
    return invitation;
  });
  ipcMain.handle("shared.acceptInvitation", (_event, request) => {
    const now = new Date().toISOString();
    const user = sharedE2EState.connection.user;
    const invitation = sharedE2EState.invitations.find(
      (candidate) => candidate.id === request.invitationId
    );
    if (user === undefined || invitation === undefined) {
      throw new Error("Invitation is not available.");
    }
    if (invitation.email !== user.email) {
      throw new Error("Invitation does not belong to the signed-in user.");
    }
    invitation.status = "accepted";
    const existingMembers = sharedE2EState.members.get(invitation.projectId) ?? [];
    sharedE2EState.members.set(invitation.projectId, [
      ...existingMembers.filter((member) => member.userId !== user.id),
      {
        projectId: invitation.projectId,
        userId: user.id,
        email: user.email,
        name: user.name,
        role: invitation.role,
        joinedAt: now
      }
    ]);
    return invitation;
  });
  ipcMain.handle(
    "shared.listMembers",
    (_event, request) => sharedE2EState.members.get(request.projectId) ?? []
  );
  ipcMain.handle("shared.updateMemberRole", (_event, request) => {
    const actorMembership = getSharedProjectMembership(request.projectId);
    if (actorMembership?.role !== "owner") {
      throw new Error("Only owners can update shared project member roles.");
    }
    const members = sharedE2EState.members.get(request.projectId) ?? [];
    const member = members.find((candidate) => candidate.userId === request.userId);
    if (member === undefined) {
      throw new Error("Shared project member is not available.");
    }
    if (member.role === "owner") {
      throw new Error("Project owner role cannot be changed here.");
    }
    const updatedMember = { ...member, role: request.role };
    sharedE2EState.members.set(
      request.projectId,
      members.map((candidate) =>
        candidate.userId === request.userId ? updatedMember : candidate
      )
    );
    return updatedMember;
  });
  ipcMain.handle("shared.removeMember", (_event, request) => {
    const actorMembership = getSharedProjectMembership(request.projectId);
    if (actorMembership?.role !== "owner") {
      throw new Error("Only owners can remove shared project members.");
    }
    const members = sharedE2EState.members.get(request.projectId) ?? [];
    const member = members.find((candidate) => candidate.userId === request.userId);
    if (member === undefined) {
      throw new Error("Shared project member is not available.");
    }
    if (member.role === "owner") {
      throw new Error("Project owner cannot be removed.");
    }
    sharedE2EState.members.set(
      request.projectId,
      members.filter((candidate) => candidate.userId !== request.userId)
    );
    sharedE2EState.presence = sharedE2EState.presence.filter(
      (presence) =>
        presence.projectId !== request.projectId || presence.userId !== request.userId
    );
    return member;
  });
  ipcMain.handle("shared.transferOwnership", (_event, request) => {
    const actorMembership = getSharedProjectMembership(request.projectId);
    if (actorMembership?.role !== "owner") {
      throw new Error("Only owners can transfer shared project ownership.");
    }
    const members = sharedE2EState.members.get(request.projectId) ?? [];
    const nextOwner = members.find((candidate) => candidate.userId === request.userId);
    if (nextOwner === undefined) {
      throw new Error("Shared project member is not available.");
    }
    if (nextOwner.role === "owner") {
      throw new Error("Project owner cannot transfer ownership to themselves.");
    }
    const transferredMembers = members.map((member) =>
      member.userId === request.userId
        ? { ...member, role: "owner" }
        : member.role === "owner"
          ? { ...member, role: "editor" }
          : member
    );
    sharedE2EState.members.set(request.projectId, transferredMembers);
    const project = getSharedProject(request.projectId);
    const transferredProject = {
      ...project,
      ownerUserId: request.userId,
      updatedAt: new Date().toISOString()
    };
    sharedE2EState.projects = sharedE2EState.projects.map((candidate) =>
      candidate.id === request.projectId ? transferredProject : candidate
    );
    return transferredMembers;
  });
  ipcMain.handle("shared.listPresence", (_event, request) => {
    const projectId = typeof request === "string" ? request : request.projectId;
    return sharedE2EState.presence.filter(
      (presence) => presence.projectId === projectId
    );
  });
  ipcMain.handle("shared.updatePresence", (_event, request) => {
    const presence = {
      projectId: request.projectId,
      userId: sharedE2EState.connection.user?.id ?? "shared-user-owner",
      displayName: sharedE2EState.connection.user?.name ?? "Owner",
      filePath: request.filePath,
      cursorLine: request.cursorLine,
      cursorColumn: request.cursorColumn,
      updatedAt: new Date().toISOString()
    };
    sharedE2EState.presence = [
      ...sharedE2EState.presence.filter(
        (candidate) =>
          candidate.projectId !== presence.projectId ||
          candidate.userId !== presence.userId
      ),
      presence
    ];
    return presence;
  });
  ipcMain.handle("shared.listActivity", (_event, request) =>
    sharedE2EState.activity.filter(
      (activity) => activity.projectId === request.projectId
    )
  );
  ipcMain.handle("shared.listComments", (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership === undefined) {
      throw new Error("Current user is not a member of this shared project.");
    }

    return sharedE2EState.comments
      .filter((comment) => comment.projectId === request.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });
  ipcMain.handle("shared.createComment", (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership === undefined) {
      throw new Error("Current user is not a member of this shared project.");
    }
    if (request.filePath !== undefined) {
      getSharedRevision(request.projectId, request.filePath);
    }

    const now = new Date().toISOString();
    const comment = {
      id: `shared-comment-${sharedE2EState.comments.length + 1}`,
      projectId: request.projectId,
      authorUserId: getSharedActorUserId(),
      body: String(request.body ?? "").trim(),
      ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
      ...(request.line === undefined ? {} : { line: request.line }),
      resolved: false,
      createdAt: now,
      updatedAt: now
    };
    if (comment.body.length === 0) {
      throw new Error("Comment body is required.");
    }

    sharedE2EState.comments = [comment, ...sharedE2EState.comments];
    recordSharedActivity(
      request.projectId,
      "comment.created",
      request.filePath === undefined
        ? "Commented on the project."
        : `Commented on ${request.filePath}.`
    );
    return comment;
  });
  ipcMain.handle("shared.resolveComment", (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership === undefined) {
      throw new Error("Current user is not a member of this shared project.");
    }

    const comment = sharedE2EState.comments.find(
      (candidate) =>
        candidate.projectId === request.projectId && candidate.id === request.commentId
    );
    if (comment === undefined) {
      throw new Error("Project comment was not found.");
    }
    if (
      membership.role === "viewer" &&
      comment.authorUserId !== getSharedActorUserId()
    ) {
      throw new Error(
        "Only editors, owners, or the comment author can resolve this comment."
      );
    }

    const now = new Date().toISOString();
    const resolvedComment = {
      ...comment,
      resolved: true,
      resolvedByUserId: getSharedActorUserId(),
      resolvedAt: now,
      updatedAt: now
    };
    sharedE2EState.comments = sharedE2EState.comments.map((candidate) =>
      candidate.id === comment.id ? resolvedComment : candidate
    );
    recordSharedActivity(
      request.projectId,
      "comment.resolved",
      `Resolved comment ${comment.id.slice(0, 8)}.`
    );
    return resolvedComment;
  });
  ipcMain.handle("shared.listAuditEvents", (_event, request) =>
    sharedE2EState.auditEvents.filter(
      (auditEvent) => auditEvent.projectId === request.projectId
    )
  );
  ipcMain.handle("shared.publishAgentRun", (_event, request) => {
    const now = new Date().toISOString();
    const existingRun =
      request.agentRunId === undefined
        ? undefined
        : getSharedAgentRun(request.projectId, request.agentRunId);
    const run = existingRun ?? {
      id: `shared-agent-run-${sharedE2EState.agentRuns.length + 1}`,
      projectId: request.projectId,
      actorUserId: getSharedActorUserId(),
      providerId: request.providerId,
      mode: request.mode,
      promptHash: createPromptHash(request.prompt),
      status: request.status,
      changesetIds: [],
      buildArtifactIds: [],
      createdAt: now,
      updatedAt: now
    };
    if (existingRun === undefined) {
      sharedE2EState.agentRuns.unshift(run);
      recordSharedActivity(request.projectId, "agent.run.started", "Agent run started");
      recordSharedAuditEvent(
        request.projectId,
        "agent.run.started",
        "Agent run started",
        { agentRunId: run.id }
      );
    }

    const publishedChangeSets = request.changesetIds
      .filter(
        (localChangeSetId) =>
          !sharedE2EState.agentChangeSets.some(
            (changeset) => changeset.localChangeSetId === localChangeSetId
          )
      )
      .map((localChangeSetId) => {
        const localChangeSet = historyStore.getChangeSetWithContents(localChangeSetId);
        const sharedChangeSet = {
          id: `shared-agent-changeset-${sharedE2EState.agentChangeSets.length + 1}`,
          projectId: request.projectId,
          agentRunId: run.id,
          actorUserId: getSharedActorUserId(),
          filePath: localChangeSet.filePath,
          summary: localChangeSet.summary,
          status: "proposed",
          createdAt: now,
          updatedAt: now,
          patchPreview: summarizeSharedPatchPreview(
            localChangeSet.beforeContents,
            localChangeSet.afterContents
          ),
          localChangeSetId,
          beforeContents: localChangeSet.beforeContents,
          afterContents: localChangeSet.afterContents
        };
        sharedE2EState.agentChangeSets.unshift(sharedChangeSet);
        return sharedChangeSet;
      });

    run.changesetIds = [
      ...new Set([
        ...run.changesetIds,
        ...publishedChangeSets.map((changeset) => changeset.id)
      ])
    ];
    run.buildArtifactIds = [
      ...new Set([...(run.buildArtifactIds ?? []), ...(request.buildArtifactIds ?? [])])
    ];
    run.status =
      publishedChangeSets.length > 0 && request.status === "completed"
        ? "waiting-for-review"
        : request.status;
    run.updatedAt = now;

    for (const changeset of publishedChangeSets) {
      recordSharedActivity(
        request.projectId,
        "agent.changeset.proposed",
        `Agent proposed ${changeset.filePath}`
      );
      recordSharedAuditEvent(
        request.projectId,
        "agent.changeset.proposed",
        `Agent proposed ${changeset.filePath}`,
        { agentRunId: run.id, changesetId: changeset.id }
      );
    }

    return {
      agentRun: run,
      changesets: publishedChangeSets
    };
  });
  ipcMain.handle("shared.updateAgentRunStatus", (_event, request) => {
    const run = getSharedAgentRun(request.projectId, request.agentRunId);
    run.status = request.status;
    run.updatedAt = new Date().toISOString();
    recordSharedActivity(
      request.projectId,
      "agent.run.updated",
      `Agent run marked ${request.status}`
    );
    recordSharedAuditEvent(
      request.projectId,
      "agent.run.updated",
      `Agent run marked ${request.status}`,
      { agentRunId: run.id }
    );
    return run;
  });
  ipcMain.handle("shared.listAgentRuns", (_event, request) =>
    sharedE2EState.agentRuns.filter((run) => run.projectId === request.projectId)
  );
  ipcMain.handle("shared.listAgentChangeSets", (_event, request) =>
    sharedE2EState.agentChangeSets.filter(
      (changeset) => changeset.projectId === request.projectId
    )
  );
  ipcMain.handle("shared.applyAgentChangeSet", async (_event, request) => {
    const changeset = getSharedAgentChangeSet(request.projectId, request.changesetId);
    if (changeset.status !== "proposed") {
      throw new Error("Only proposed shared agent changesets can be applied.");
    }
    const revision = await updateSharedRevision(
      request.projectId,
      changeset.filePath,
      changeset.afterContents
    );
    const now = new Date().toISOString();
    changeset.status = "applied";
    changeset.appliedAt = now;
    changeset.appliedRevisionId = revision.revisionId;
    changeset.updatedAt = now;
    const run = getSharedAgentRun(request.projectId, changeset.agentRunId);
    run.status = "completed";
    run.updatedAt = now;
    recordSharedActivity(
      request.projectId,
      "agent.changeset.applied",
      `Applied agent changeset for ${changeset.filePath}`
    );
    recordSharedAuditEvent(
      request.projectId,
      "agent.changeset.applied",
      `Applied agent changeset for ${changeset.filePath}`,
      { agentRunId: run.id, changesetId: changeset.id }
    );
    return {
      changeset,
      fileRevision: {
        projectId: revision.projectId,
        path: revision.path,
        revisionId: revision.revisionId,
        contents: revision.contents,
        mtimeMs: revision.mtimeMs
      }
    };
  });
  ipcMain.handle("shared.rejectAgentChangeSet", (_event, request) => {
    const changeset = getSharedAgentChangeSet(request.projectId, request.changesetId);
    const now = new Date().toISOString();
    changeset.status = "rejected";
    changeset.updatedAt = now;
    recordSharedActivity(
      request.projectId,
      "agent.changeset.rejected",
      `Rejected agent changeset for ${changeset.filePath}`
    );
    recordSharedAuditEvent(
      request.projectId,
      "agent.changeset.rejected",
      `Rejected agent changeset for ${changeset.filePath}`,
      { agentRunId: changeset.agentRunId, changesetId: changeset.id }
    );
    return changeset;
  });
  ipcMain.handle("shared.listBuildArtifacts", (_event, request) =>
    sharedE2EState.buildArtifacts
      .filter((artifact) => artifact.projectId === request.projectId)
      .slice()
      .reverse()
  );
  ipcMain.handle("shared.getBuildArtifact", (_event, request) => {
    sharedE2EState.inspectedBuildArtifactIds.push(request.artifactId);
    return sharedE2EState.buildArtifacts.find(
      (artifact) =>
        artifact.projectId === request.projectId && artifact.id === request.artifactId
    );
  });
  ipcMain.handle("shared.listFileRevisions", (_event, request) => {
    getSharedRevision(request.projectId, request.path);
    return sharedE2EState.revisionHistory
      .filter(
        (revision) =>
          revision.projectId === request.projectId && revision.path === request.path
      )
      .map((revision) => ({
        id: revision.revisionId,
        projectId: revision.projectId,
        path: revision.path,
        actorUserId: revision.actorUserId,
        createdAt: revision.createdAt,
        contentEncoding: "utf8",
        byteLength: Buffer.byteLength(revision.contents, "utf8")
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });
  ipcMain.handle("shared.getFileRevision", (_event, request) => {
    const revision = getSharedRevision(request.projectId, request.path);
    return {
      projectId: revision.projectId,
      path: revision.path,
      revisionId: revision.revisionId
    };
  });
  ipcMain.handle("shared.getFileRevisionDetails", (_event, request) => {
    const revision = sharedE2EState.revisionHistory.find(
      (candidate) =>
        candidate.projectId === request.projectId &&
        candidate.revisionId === request.revisionId
    );
    if (revision === undefined) {
      throw new Error(`Shared revision ${request.revisionId} was not found.`);
    }
    return {
      id: revision.revisionId,
      projectId: revision.projectId,
      path: revision.path,
      actorUserId: revision.actorUserId,
      createdAt: revision.createdAt,
      contentEncoding: "utf8",
      byteLength: Buffer.byteLength(revision.contents, "utf8"),
      contents: revision.contents
    };
  });
  ipcMain.handle("shared.restoreFileRevision", async (_event, request) => {
    const membership = getSharedProjectMembership(request.projectId);
    if (membership === undefined || membership.role === "viewer") {
      throw new Error("Shared revision restore requires Editor access.");
    }

    const sourceRevision = sharedE2EState.revisionHistory.find(
      (candidate) =>
        candidate.projectId === request.projectId &&
        candidate.revisionId === request.revisionId
    );
    if (sourceRevision === undefined) {
      throw new Error(`Shared revision ${request.revisionId} was not found.`);
    }

    const revision = await updateSharedRevision(
      request.projectId,
      sourceRevision.path,
      sourceRevision.contents
    );
    recordSharedActivity(
      request.projectId,
      "file.revision.restored",
      `Restored ${sourceRevision.path} from revision ${request.revisionId.slice(0, 8)}.`
    );
    return {
      projectId: revision.projectId,
      path: revision.path,
      contents: revision.contents,
      revisionId: revision.revisionId,
      mtimeMs: revision.mtimeMs,
      lastUpdateId: revision.updateId
    };
  });
  ipcMain.handle("shared.publishBuildArtifact", (_event, request) => {
    const revision = getSharedRevision(request.projectId, request.mainFilePath);
    const artifact = {
      id: `shared-build-${sharedE2EState.buildArtifacts.length + 1}`,
      projectId: request.projectId,
      sourceRevisionId: request.sourceRevisionId ?? revision.revisionId,
      desktopClientId: "e2e-desktop",
      compiler: request.buildResult.compiler,
      status: request.buildResult.status,
      platform: process.platform,
      diagnosticCount: request.buildResult.diagnostics.length,
      pdfByteLength: request.buildResult.artifact?.byteLength,
      rawLog: request.buildResult.rawLog,
      diagnostics: request.buildResult.diagnostics,
      createdAt: new Date().toISOString()
    };
    sharedE2EState.buildArtifacts.push(artifact);
    recordSharedActivity(
      request.projectId,
      "build-artifact.created",
      `Compiled ${request.mainFilePath}: ${artifact.status}`
    );
    recordSharedAuditEvent(
      request.projectId,
      "build-artifact.created",
      `Compiled ${request.mainFilePath}: ${artifact.status}`,
      { buildArtifactIds: [artifact.id] }
    );
    return artifact;
  });
  ipcMain.handle("shared.attachAgentRunBuildArtifact", (_event, request) => {
    const run = getSharedAgentRun(request.projectId, request.agentRunId);
    run.buildArtifactIds = [
      ...new Set([...(run.buildArtifactIds ?? []), request.artifactId])
    ];
    run.status = "completed";
    run.updatedAt = new Date().toISOString();
    recordSharedActivity(
      request.projectId,
      "agent.run.build-attached",
      `Attached build ${request.artifactId} to agent run`
    );
    recordSharedAuditEvent(
      request.projectId,
      "agent.run.build-attached",
      `Attached build ${request.artifactId} to agent run`,
      { agentRunId: run.id, buildArtifactIds: [request.artifactId] }
    );
    return run;
  });
  ipcMain.handle("shared.applyDocumentTextOperations", async (_event, request) => {
    const current = getSharedRevision(request.projectId, request.path);
    const contents = applySharedTextOperations(current.contents, request.operations);
    const revision = await updateSharedRevision(
      request.projectId,
      request.path,
      contents
    );
    return {
      projectId: request.projectId,
      path: request.path,
      contents: revision.contents,
      revisionId: revision.revisionId,
      mtimeMs: revision.mtimeMs,
      lastUpdateId: revision.updateId,
      remoteUpdateCount: 0,
      remoteTextOperations: []
    };
  });
  ipcMain.handle("shared.syncDocumentContents", async (_event, request) => {
    const revision = await updateSharedRevision(
      request.projectId,
      request.path,
      request.contents
    );
    return {
      projectId: request.projectId,
      path: request.path,
      contents: revision.contents,
      revisionId: revision.revisionId,
      mtimeMs: revision.mtimeMs,
      lastUpdateId: revision.updateId,
      remoteUpdateCount: 0,
      remoteTextOperations: []
    };
  });
  ipcMain.handle("shared.pullDocumentContents", (_event, request) => {
    const revision = getSharedRevision(request.projectId, request.path);
    const updateId = `update-${revision.revisionId}`;
    const hasRemoteUpdate =
      request.afterUpdateId !== undefined && request.afterUpdateId !== updateId;
    return {
      projectId: request.projectId,
      path: request.path,
      contents: revision.contents,
      revisionId: revision.revisionId,
      mtimeMs: revision.mtimeMs,
      lastUpdateId: updateId,
      remoteUpdateCount: hasRemoteUpdate ? 1 : 0,
      remoteTextOperations: hasRemoteUpdate
        ? (sharedE2EState.documentOperationsByUpdateId.get(updateId) ?? [])
        : []
    };
  });
  ipcMain.handle("shared.startRealtime", (_event, request) => ({
    projectId: request.projectId,
    subscribed: true
  }));
  ipcMain.handle("shared.stopRealtime", (_event, request) => ({
    projectId: request.projectId,
    subscribed: false
  }));
  ipcMain.handle("file.read", (_event, request) =>
    projectService.readProjectFile(request.projectRoot, request.path)
  );
  ipcMain.handle("file.write", (_event, request) => {
    if (nextFileWriteFailurePath === request.path) {
      nextFileWriteFailurePath = undefined;
      throw new Error("Simulated disk write failure.");
    }

    return projectService.writeProjectFile(
      request.projectRoot,
      request.path,
      request.contents
    );
  });
  ipcMain.handle("build.detectToolchain", () => latexService.detectLatexToolchain());
  ipcMain.handle("build.run", async (_event, request) => {
    buildRequests.push(request);
    const result = await latexService.runLatexBuild(request);
    buildResults.push(result);
    return result;
  });
  ipcMain.handle("build.stop", (_event, request) => ({
    stopped: latexService.stopLatexBuild(request.jobId)
  }));
  ipcMain.handle("pdf.readArtifact", (_event, request) =>
    pdfService.readPdfArtifact(request.projectRoot, request.pdfPath)
  );
  ipcMain.handle("pdf.reportPreviewBounds", () => ({ reported: true }));
  ipcMain.handle("synctex.forward", (_event, request) =>
    latexService.runSyncTexForward(request)
  );
  ipcMain.handle("synctex.reverse", (_event, request) => {
    if (nextSyncTexReverseUnavailable) {
      nextSyncTexReverseUnavailable = false;
      return {
        available: false,
        message: "No SyncTeX source target found."
      };
    }

    return latexService.runSyncTexReverse(request);
  });
  ipcMain.handle("history.listChangeSets", (_event, request) =>
    historyStore.listChangeSets(request.projectRoot)
  );
  ipcMain.handle("history.snapshotFile", (_event, request) =>
    historyStore.snapshotFile(request)
  );
  ipcMain.handle("history.createChangeSet", (_event, request) =>
    historyStore.createChangeSet(request)
  );
  ipcMain.handle("history.createAppliedChangeSet", (_event, request) =>
    historyStore.createAppliedChangeSet(request)
  );
  ipcMain.handle("history.applyChangeSet", (_event, request) =>
    historyStore.applyChangeSet(request.changesetId)
  );
  ipcMain.handle("history.applyChangeSetHunks", (_event, request) =>
    historyStore.applyChangeSetHunks(request)
  );
  ipcMain.handle("history.rejectChangeSet", (_event, request) =>
    historyStore.rejectChangeSet(request.changesetId)
  );
  ipcMain.handle("history.rollbackChangeSet", (_event, request) =>
    historyStore.rollbackChangeSet(request.changesetId)
  );
  ipcMain.handle("history.listAuditEvents", (_event, request) =>
    historyStore.listAuditEvents(request.projectRoot)
  );
  ipcMain.handle("history.listWordChangeSets", () => []);
  ipcMain.handle("history.createWordChangeSet", (_event, request) => request.changeset);
  ipcMain.handle("history.markWordChangeSetApplied", (_event, request) => ({
    ...request.changeset,
    status: "applied"
  }));
  ipcMain.handle("history.rejectWordChangeSet", () => ({
    applied: false,
    operations: []
  }));
  ipcMain.handle("references.analyze", (_event, request) =>
    referenceService.analyzeProjectReferences(request.projectRoot)
  );
  ipcMain.handle("references.search", (_event, request) =>
    referenceService.searchProjectReferences(request.projectRoot, request.query)
  );
  ipcMain.handle("references.removeUnused", (_event, request) =>
    referenceService.removeUnusedReferenceEntry(request.projectRoot, {
      filePath: request.filePath,
      key: request.key
    })
  );
  ipcMain.handle("lifecycle.listTemplates", () => lifecycleService.projectTemplates);
  ipcMain.handle("lifecycle.checkSubmission", (_event, request) =>
    lifecycleService.checkSubmissionBundle(request.projectRoot, request.mainFilePath)
  );
  ipcMain.handle("lifecycle.exportSourceZip", async (_event, request) => {
    const destinationPath = path.join(
      sandboxPath,
      `source-export-${exportedSourceZips.length + 1}.zip`
    );
    const result = await lifecycleService.exportSourceZip({
      projectRoot: request.projectRoot,
      destinationPath,
      includeBuildArtifacts: request.includeBuildArtifacts
    });
    exportedSourceZips.push(result);
    return result;
  });
  ipcMain.handle("lifecycle.exportPdf", async (_event, request) => {
    const destinationPath = path.join(
      sandboxPath,
      `pdf-export-${exportedPdfs.length + 1}.pdf`
    );
    const result = await lifecycleService.exportPdf({
      pdfPath: request.pdfPath,
      destinationPath
    });
    const openedResult = { ...result, openedInViewer: true };
    exportedPdfs.push(openedResult);
    openedExternalPaths.push(destinationPath);
    return openedResult;
  });
  ipcMain.handle("lifecycle.importSourceZip", async () => {
    if (
      nextImportZipPath === undefined ||
      nextImportDestinationParentPath === undefined
    ) {
      return undefined;
    }

    const importedProject = await lifecycleService.importProjectZip({
      zipPath: nextImportZipPath,
      destinationParentPath: nextImportDestinationParentPath,
      projectName:
        nextImportProjectName ??
        path.basename(nextImportZipPath, path.extname(nextImportZipPath))
    });
    nextImportZipPath = undefined;
    nextImportDestinationParentPath = undefined;
    nextImportProjectName = undefined;
    const project = await projectService.openProject(
      importedProject.projectRoot,
      metadata
    );
    return project;
  });
  ipcMain.handle("lifecycle.createFromTemplate", async (_event, request) => {
    if (nextCreateDestinationParentPath === undefined) {
      return undefined;
    }

    const createdProject = await lifecycleService.createProjectFromTemplate({
      templateId: request.templateId,
      projectName: request.projectName,
      destinationParentPath: nextCreateDestinationParentPath
    });
    const project = await projectService.openProject(
      createdProject.projectRoot,
      metadata
    );
    return project;
  });
  ipcMain.handle("settings.load", () => appSettingsState);
  ipcMain.handle("settings.save", (_event, settings) => {
    appSettingsState = settings;
    return appSettingsState;
  });
  ipcMain.handle("settings.getPrivacySummary", () => ({
    dataLocation: sandboxPath,
    ...historyStore.getPrivacySummary()
  }));
  ipcMain.handle("settings.clearLocalHistory", () => ({
    dataLocation: sandboxPath,
    ...historyStore.clearAll()
  }));
  ipcMain.handle("agent.getAuthStatus", (_event, request) => ({
    providerId: request.providerId,
    state: request.providerId === "mock" ? "connected" : "disconnected",
    message: "E2E smoke uses mock provider status only."
  }));
  ipcMain.handle("agent.start", async (_event, request) => {
    const requestedSession =
      request.sessionId === undefined
        ? undefined
        : agentSessions.get(request.sessionId);
    const canContinueSession =
      requestedSession !== undefined &&
      requestedSession.providerId === request.providerId &&
      requestedSession.request.projectRoot === request.projectRoot &&
      requestedSession.request.mode === request.mode;
    const providerRequest = {
      ...request,
      sessionId:
        canContinueSession && request.sessionId !== undefined
          ? request.sessionId
          : randomUUID()
    };
    agentStartRecords.push({
      requestedSessionId: request.sessionId ?? null,
      sessionId: providerRequest.sessionId,
      providerId: providerRequest.providerId,
      mode: providerRequest.mode,
      continued: canContinueSession
    });
    await historyStore.recordAuditEvent({
      projectRoot: providerRequest.projectRoot,
      eventType: "agent.session.started",
      message: `Started ${providerRequest.providerId} in ${providerRequest.mode}`
    });
    const provider = new agentHost.MockAgentProvider();
    const result = await provider.startSession(providerRequest, {
      readFile: (filePath) =>
        projectService.readProjectFile(providerRequest.projectRoot, filePath),
      searchProject: () => Promise.resolve([]),
      proposePatch: (filePath, beforeContents, afterContents, summary) =>
        historyStore.createChangeSet({
          projectRoot: providerRequest.projectRoot,
          filePath,
          beforeContents,
          afterContents,
          summary
        }),
      applyPatch: (changesetId) => historyStore.applyChangeSet(changesetId),
      runCompile: async () => {
        const build = await latexService.runLatexBuild({
          projectRoot: providerRequest.projectRoot,
          mainFilePath: providerRequest.mainFilePath ?? "main.tex",
          compiler: providerRequest.compiler ?? "pdflatex"
        });
        buildResults.push(build);
        return build;
      }
    });
    await recordE2EAgentEvents(
      providerRequest.projectRoot,
      result.events,
      result.changeset?.id
    );
    await historyStore.recordAuditEvent({
      projectRoot: providerRequest.projectRoot,
      eventType: "agent.tool.failed",
      message: "read-file failed: sample missing.tex was not found.",
      ...(result.changeset?.id === undefined
        ? {}
        : { changesetId: result.changeset.id })
    });

    const approvalEvent = result.events.find(
      (event) => event.type === "approval" && event.status === "requested"
    );
    agentSessions.set(result.sessionId, {
      request: providerRequest,
      changeset: result.changeset,
      providerId: result.providerId,
      approvalId: approvalEvent?.approvalId
    });

    return result;
  });
  ipcMain.handle("agent.respondApproval", async (_event, request) => {
    const session = agentSessions.get(request.sessionId);
    if (session === undefined) {
      throw new Error("Agent session is not available.");
    }
    if (session.approvalId !== request.approvalId) {
      throw new Error("Approval request does not match the active session.");
    }
    const approvalEvent = createE2EApprovalEvent(
      request.sessionId,
      request.approvalId,
      request.decision
    );

    if (request.decision === "denied") {
      const result = {
        sessionId: request.sessionId,
        providerId: session.providerId,
        status: "completed",
        events: [
          approvalEvent,
          createE2EVerificationEvent(
            request.sessionId,
            "failed",
            "Patch approval was denied; no files were changed."
          )
        ],
        ...(session.changeset === undefined ? {} : { changeset: session.changeset })
      };
      await recordE2EAgentEvents(
        session.request.projectRoot,
        result.events,
        session.changeset?.id
      );
      return result;
    }

    if (session.changeset === undefined) {
      throw new Error("Approved session has no changeset to apply.");
    }

    const events = [
      approvalEvent,
      createE2EToolEvent(
        request.sessionId,
        "apply-patch",
        "running",
        `Applying ${session.changeset.summary}`,
        "high"
      )
    ];
    const appliedChangeSet = await historyStore.applyChangeSet(session.changeset.id);
    events.push(
      createE2EToolEvent(
        request.sessionId,
        "apply-patch",
        "succeeded",
        `Applied ${appliedChangeSet.summary}`,
        "high"
      ),
      {
        id: randomUUID(),
        sessionId: request.sessionId,
        createdAt: new Date().toISOString(),
        type: "patch",
        changesetId: appliedChangeSet.id,
        filePath: appliedChangeSet.filePath,
        summary: appliedChangeSet.summary,
        status: appliedChangeSet.status
      },
      createE2EToolEvent(
        request.sessionId,
        "run-compile",
        "running",
        "Running compile verification",
        "medium"
      )
    );
    const buildResult = await latexService.runLatexBuild({
      projectRoot: session.request.projectRoot,
      mainFilePath: session.request.mainFilePath ?? "main.tex",
      compiler: session.request.compiler ?? "pdflatex"
    });
    buildResults.push(buildResult);
    events.push(
      createE2EToolEvent(
        request.sessionId,
        "run-compile",
        buildResult.status === "succeeded" ? "succeeded" : "failed",
        `Compile ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}`,
        "medium"
      ),
      createE2EVerificationEvent(
        request.sessionId,
        buildResult.status === "succeeded" ? "passed" : "failed",
        `Compile verification ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}`,
        buildResult.jobId
      )
    );
    const result = {
      sessionId: request.sessionId,
      providerId: session.providerId,
      status: "completed",
      events,
      changeset: appliedChangeSet,
      buildResult
    };
    agentSessions.set(request.sessionId, {
      ...session,
      changeset: appliedChangeSet
    });
    await recordE2EAgentEvents(
      session.request.projectRoot,
      events,
      appliedChangeSet.id
    );
    return result;
  });
  ipcMain.handle("agent.cancel", () => ({ cancelled: false }));
}

async function runSharedProjectDesktopScenario(win) {
  const sharedProjectName = "e2e-shared-paper";
  const sharedEmail = "owner@example.test";
  const collaboratorEmail = "collaborator@example.test";
  const viewerEmail = "viewer@example.test";
  const editedSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared E2E source edited from the desktop renderer.",
    "\\end{document}",
    ""
  ].join("\n");
  const collaboratorEditedSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared E2E source edited by the invited collaborator.",
    "\\end{document}",
    ""
  ].join("\n");
  const remoteRealtimeSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared E2E source updated remotely without refreshing the project.",
    "\\end{document}",
    ""
  ].join("\n");
  const importedSharedProjectName = "e2e-shared-zip-paper";
  const importedSharedMainSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared ZIP lifecycle source imported through desktop.",
    "\\input{sections/intro}",
    "\\end{document}",
    ""
  ].join("\n");
  const importedSharedIntroSource = [
    "\\section{Imported Section}",
    "This section should round-trip through shared source export.",
    ""
  ].join("\n");
  const localSharedProjectName = "e2e-local-paper-share";
  const sharedCommentBody =
    "Please double-check the repaired ending before submitting this shared draft.";

  if (!(await setTemplatePickerFieldValue(win, "Email", sharedEmail))) {
    throw new Error("Shared E2E: email field was not editable.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Name", "E2E Owner"))) {
    throw new Error("Shared E2E: name field was not editable.");
  }
  if (!(await clickButton(win, "Sign In"))) {
    throw new Error("Shared E2E: Sign In button was not clickable.");
  }
  if (!(await waitForText(win, `Signed in as ${sharedEmail}.`, 10_000))) {
    throw new Error("Shared E2E: signed-in status did not render.");
  }
  if (!(await waitForText(win, "Sessions", 10_000))) {
    throw new Error("Shared E2E: session management list did not render.");
  }
  if (!(await clickButton(win, "Revoke"))) {
    throw new Error("Shared E2E: remote session revoke button was not clickable.");
  }
  if (!(await waitForText(win, "Revoked Session e2e-remo.", 10_000))) {
    throw new Error("Shared E2E: session revoke status did not render.");
  }

  if (!(await setTemplatePickerFieldValue(win, "Project name", sharedProjectName))) {
    throw new Error("Shared E2E: project name field was not editable.");
  }
  if (!(await clickButton(win, "Create"))) {
    throw new Error("Shared E2E: Create button was not clickable.");
  }
  if (!(await waitForText(win, `Created ${sharedProjectName}.`, 10_000))) {
    throw new Error("Shared E2E: created project status did not render.");
  }
  if (!(await clickButton(win, sharedProjectName))) {
    throw new Error("Shared E2E: shared project row was not clickable.");
  }
  if (!(await waitForText(win, "Shared project", 20_000))) {
    throw new Error("Shared E2E: shared project badge did not render.");
  }
  if (!(await waitForText(win, "main.tex", 20_000))) {
    throw new Error("Shared E2E: main.tex was not visible after opening.");
  }
  const openSharedTab = await waitForOpenFileTabState(win, "main.tex", {
    dirty: false
  });
  if (!openSharedTab.found) {
    throw new Error("Shared E2E: main.tex editor tab did not open.");
  }
  if (!(await waitForText(win, "E2E Remote Cursor", 10_000))) {
    throw new Error("Shared E2E: remote collaborator presence did not render.");
  }
  if (!(await waitForEditorCollaborator(win, "E2E Remote Cursor · main.tex:1:12"))) {
    throw new Error("Shared E2E: remote collaborator editor badge did not render.");
  }

  const editResult = await replaceEditorTextThroughHook(win, "main.tex", editedSource);
  if (!editResult.ok) {
    throw new Error(`Shared E2E: editor hook edit failed: ${editResult.reason}`);
  }
  if (!(await waitForText(win, "Synced main.tex", 10_000))) {
    throw new Error("Shared E2E: shared document operation did not sync.");
  }
  const savedRevision = sharedE2EState.revisions.get("shared-project-1:main.tex");
  if (savedRevision?.contents !== editedSource) {
    throw new Error("Shared E2E: shared text operations did not update server state.");
  }

  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Shared E2E: Compile project button was not clickable.");
  }
  const sharedArtifact = await waitForSharedBuildArtifact(
    (artifact) =>
      artifact.projectId === "shared-project-1" && artifact.status === "succeeded"
  );
  if (sharedArtifact === undefined) {
    throw new Error("Shared E2E: shared compile artifact was not recorded.");
  }
  if (sharedArtifact.sourceRevisionId !== savedRevision.revisionId) {
    throw new Error(
      "Shared E2E: compile artifact was not tied to saved source revision."
    );
  }

  const brokenSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared E2E source with an agent-repairable compile error.",
    ""
  ].join("\n");
  const brokenEditResult = await replaceEditorTextThroughHook(
    win,
    "main.tex",
    brokenSource
  );
  if (!brokenEditResult.ok) {
    throw new Error(
      `Shared E2E: broken-source editor hook edit failed: ${brokenEditResult.reason}`
    );
  }
  const brokenRevision = await waitForSharedRevisionContents(
    "shared-project-1",
    "main.tex",
    brokenSource
  );
  if (brokenRevision?.contents !== brokenSource) {
    throw new Error("Shared E2E: broken source was not saved to server state.");
  }

  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Shared E2E: Compile project button was not clickable for broken source."
    );
  }
  const failedSharedArtifact = await waitForSharedBuildArtifact(
    (artifact) =>
      artifact.projectId === "shared-project-1" &&
      artifact.status === "failed" &&
      artifact.sourceRevisionId === brokenRevision.revisionId
  );
  if (failedSharedArtifact === undefined) {
    throw new Error("Shared E2E: failed shared compile artifact was not recorded.");
  }

  const agentRunCountBefore = sharedE2EState.agentRuns.length;
  const agentChangeSetCountBefore = sharedE2EState.agentChangeSets.length;
  const sharedBuildArtifactCountBeforeAgentApproval =
    sharedE2EState.buildArtifacts.length;
  if (
    !(await setAgentPrompt(win, "Fix the compile error and keep the edit minimal."))
  ) {
    throw new Error("Shared E2E: Agent prompt was not editable.");
  }
  if (!(await clickAgentSendButton(win))) {
    throw new Error("Shared E2E: Agent Send button was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      "Review the proposed patch before applying it to the project.",
      20_000
    ))
  ) {
    throw new Error("Shared E2E: agent approval request did not render.");
  }
  if (!(await waitForText(win, "Created changeset", 20_000))) {
    throw new Error("Shared E2E: shared agent changeset was not visible.");
  }
  const proposedSharedAgentChangeSet = await waitForSharedAgentChangeSet(
    (changeset) =>
      sharedE2EState.agentChangeSets.length > agentChangeSetCountBefore &&
      changeset.projectId === "shared-project-1" &&
      changeset.filePath === "main.tex" &&
      changeset.status === "proposed"
  );
  if (proposedSharedAgentChangeSet === undefined) {
    throw new Error("Shared E2E: server did not record the shared agent changeset.");
  }
  const sharedAgentRun = await waitForSharedAgentRun(
    (run) =>
      sharedE2EState.agentRuns.length > agentRunCountBefore &&
      run.projectId === "shared-project-1" &&
      run.changesetIds.includes(proposedSharedAgentChangeSet.id) &&
      run.status === "waiting-for-review"
  );
  if (sharedAgentRun === undefined) {
    throw new Error("Shared E2E: server did not record the shared agent run.");
  }
  if (!proposedSharedAgentChangeSet.patchPreview.includes("\\end{document}")) {
    throw new Error(
      "Shared E2E: shared agent changeset did not expose the repaired patch preview."
    );
  }

  if (!(await clickButton(win, "Allow"))) {
    throw new Error("Shared E2E: agent patch approval was not clickable.");
  }
  const approvedSharedArtifact = await waitForSharedBuildArtifact(
    (artifact) =>
      sharedE2EState.buildArtifacts.length >
        sharedBuildArtifactCountBeforeAgentApproval &&
      artifact.projectId === "shared-project-1" &&
      artifact.status === "succeeded",
    90_000
  );
  if (approvedSharedArtifact === undefined) {
    throw new Error(
      "Shared E2E: approved agent patch did not publish a successful shared compile."
    );
  }
  const completedSharedAgentRun = await waitForSharedAgentRun(
    (run) =>
      run.id === sharedAgentRun.id &&
      run.status === "completed" &&
      run.buildArtifactIds.includes(approvedSharedArtifact.id)
  );
  if (completedSharedAgentRun === undefined) {
    throw new Error(
      "Shared E2E: approval compile was not attached to the shared agent run."
    );
  }
  if (!(await waitForText(win, "Agent patch applied and verified.", 20_000))) {
    throw new Error("Shared E2E: agent verification status did not render.");
  }
  if (
    !sharedE2EState.auditEvents.some(
      (event) =>
        event.projectId === "shared-project-1" &&
        event.agentRunId === sharedAgentRun.id &&
        (event.changesetId === proposedSharedAgentChangeSet.id ||
          event.buildArtifactIds?.includes(approvedSharedArtifact.id))
    )
  ) {
    throw new Error(
      "Shared E2E: shared audit events did not connect the agent run evidence."
    );
  }

  if (
    !(await setTemplatePickerTextareaValue(
      win,
      "Comment on main.tex",
      sharedCommentBody
    ))
  ) {
    throw new Error("Shared E2E: shared comment textarea was not editable.");
  }
  if (!(await clickButtonInAriaRegion(win, "Shared comments", "Comment"))) {
    throw new Error("Shared E2E: shared Comment button was not clickable.");
  }
  const ownerSharedComment = await waitForSharedComment(
    (comment) =>
      comment.projectId === "shared-project-1" &&
      comment.body === sharedCommentBody &&
      comment.filePath === "main.tex" &&
      !comment.resolved,
    10_000
  );
  if (
    ownerSharedComment === undefined ||
    !(await waitForAriaRegionText(win, "Shared comments", sharedCommentBody))
  ) {
    throw new Error("Shared E2E: owner shared comment was not visible or persisted.");
  }

  if (
    !(await setTemplatePickerFieldValue(win, "Collaborator email", collaboratorEmail))
  ) {
    throw new Error("Shared E2E: collaborator email field was not editable.");
  }
  if (!(await clickButton(win, "Invite"))) {
    throw new Error("Shared E2E: Invite button was not clickable.");
  }
  const sharedInvitation = await waitForSharedInvitation(
    (invitation) =>
      invitation.projectId === "shared-project-1" &&
      invitation.email === collaboratorEmail &&
      invitation.role === "editor"
  );
  if (sharedInvitation === undefined) {
    throw new Error("Shared E2E: invitation was not recorded by shared IPC.");
  }
  if (!(await selectByAriaLabel(win, "Collaborator role", "viewer"))) {
    throw new Error("Shared E2E: collaborator role selector was not editable.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Collaborator email", viewerEmail))) {
    throw new Error("Shared E2E: viewer email field was not editable.");
  }
  if (!(await clickButton(win, "Invite"))) {
    throw new Error("Shared E2E: Viewer Invite button was not clickable.");
  }
  const viewerInvitation = await waitForSharedInvitation(
    (invitation) =>
      invitation.projectId === "shared-project-1" &&
      invitation.email === viewerEmail &&
      invitation.role === "viewer"
  );
  if (viewerInvitation === undefined) {
    throw new Error("Shared E2E: viewer invitation was not recorded by shared IPC.");
  }

  if (!(await clickButton(win, "Sign out of shared projects"))) {
    throw new Error("Shared E2E: active shared sign-out button was not clickable.");
  }
  if (!(await waitForText(win, "Signed out of shared projects.", 10_000))) {
    throw new Error("Shared E2E: sign-out status did not render.");
  }
  const ownerSessionsAfterRevoke = sharedE2EState.sessions.length;
  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable before collaborator sign-in."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error(
      "Shared E2E: dashboard did not render before collaborator sign-in."
    );
  }

  if (!(await setTemplatePickerFieldValue(win, "Email", collaboratorEmail))) {
    throw new Error("Shared E2E: collaborator email field was not editable.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Name", "E2E Collaborator"))) {
    throw new Error("Shared E2E: collaborator name field was not editable.");
  }
  if (!(await clickButton(win, "Sign In"))) {
    throw new Error("Shared E2E: collaborator Sign In button was not clickable.");
  }
  if (!(await waitForText(win, `Signed in as ${collaboratorEmail}.`, 10_000))) {
    throw new Error("Shared E2E: collaborator sign-in status did not render.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Invitation id", sharedInvitation.id))) {
    throw new Error("Shared E2E: invitation id field was not editable.");
  }
  if (!(await clickButton(win, "Accept"))) {
    throw new Error("Shared E2E: Accept invitation button was not clickable.");
  }
  if (!(await waitForText(win, "Invitation accepted.", 10_000))) {
    throw new Error("Shared E2E: invitation accepted status did not render.");
  }
  if (!(await waitForText(win, "Editor ·", 10_000))) {
    throw new Error(
      "Shared E2E: accepted collaborator project did not show Editor role."
    );
  }
  if (!(await clickButton(win, sharedProjectName))) {
    throw new Error("Shared E2E: collaborator shared project row was not clickable.");
  }
  if (!(await waitForText(win, "Shared project", 20_000))) {
    throw new Error("Shared E2E: collaborator shared project badge did not render.");
  }
  if (
    !(await waitForAriaRegionText(win, "Shared comments", sharedCommentBody, {
      timeoutMs: 20_000
    }))
  ) {
    throw new Error("Shared E2E: collaborator did not see the owner shared comment.");
  }
  if (!(await clickButtonInAriaRegion(win, "Shared comments", "Resolve"))) {
    throw new Error(
      "Shared E2E: collaborator shared comment Resolve was not clickable."
    );
  }
  if (
    !(await waitForText(
      win,
      `Resolved comment ${ownerSharedComment.id.slice(0, 8)}.`,
      10_000
    ))
  ) {
    throw new Error("Shared E2E: shared comment resolve status did not render.");
  }
  const resolvedSharedComment = sharedE2EState.comments.find(
    (comment) => comment.id === ownerSharedComment.id
  );
  if (
    resolvedSharedComment?.resolved !== true ||
    resolvedSharedComment.resolvedByUserId !== "shared-user-collaborator" ||
    !(await waitForAriaRegionText(win, "Shared comments", "Resolved · main.tex", {
      timeoutMs: 10_000
    }))
  ) {
    throw new Error("Shared E2E: collaborator did not resolve the shared comment.");
  }
  const savedRevisionLabel = savedRevision.revisionId.slice(0, 8);
  if (
    !(await waitForAriaRegionText(win, "Shared file revisions", savedRevisionLabel, {
      timeoutMs: 20_000
    }))
  ) {
    throw new Error("Shared E2E: collaborator did not see earlier file revisions.");
  }
  if (
    !(await clickButtonInAriaRegionRow(
      win,
      "Shared file revisions",
      savedRevisionLabel,
      "Inspect"
    ))
  ) {
    throw new Error("Shared E2E: shared file revision Inspect was not clickable.");
  }
  if (
    !(await waitForText(win, "Shared E2E source edited from the desktop renderer."))
  ) {
    throw new Error("Shared E2E: shared file revision preview did not render.");
  }
  if (
    !(await clickButtonInAriaRegionRow(
      win,
      "Shared file revisions",
      savedRevisionLabel,
      "Restore"
    ))
  ) {
    throw new Error("Shared E2E: shared file revision Restore was not clickable.");
  }
  const restoredSharedRevision = await waitForSharedRevisionContents(
    "shared-project-1",
    "main.tex",
    editedSource,
    20_000
  );
  if (
    restoredSharedRevision?.contents !== editedSource ||
    restoredSharedRevision.revisionId === savedRevision.revisionId ||
    !(await waitForEditorValue(win, "main.tex", editedSource, 20_000))
  ) {
    throw new Error("Shared E2E: shared file revision restore did not apply.");
  }
  if (
    !(await waitForAriaRegionText(win, "Shared activity", "file.revision.restored")) ||
    !(await waitForAriaRegionText(win, "Shared activity", "comment.resolved"))
  ) {
    throw new Error(
      "Shared E2E: shared activity did not show comment and revision restore events."
    );
  }
  if (!(await waitForText(win, "Agent runs", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see shared agent runs.");
  }
  if (!(await waitForText(win, "Completed · mock", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see the completed agent run.");
  }
  if (!(await waitForText(win, "1 changeset · 1 compile result", 20_000))) {
    throw new Error(
      "Shared E2E: collaborator did not see the agent run evidence counts."
    );
  }
  if (!(await waitForText(win, "Agent changesets", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see shared agent changesets.");
  }
  if (!(await waitForText(win, "main.tex · Applied", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see the applied changeset.");
  }
  if (!(await waitForText(win, "\\end{document}", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see the patch preview.");
  }
  if (!(await waitForText(win, "Agent audit", 20_000))) {
    throw new Error("Shared E2E: collaborator did not see shared agent audit.");
  }
  if (!(await waitForText(win, "Agent changeset applied", 20_000))) {
    throw new Error(
      "Shared E2E: collaborator did not see the applied changeset audit event."
    );
  }
  if (!(await waitForText(win, "agent.run.build-attached", 20_000))) {
    throw new Error(
      "Shared E2E: collaborator did not see the agent compile audit event."
    );
  }
  if (!(await clickButtonInAriaRegion(win, "Shared agent runs", "Show changeset"))) {
    throw new Error(
      "Shared E2E: collaborator shared agent run changeset link was not clickable."
    );
  }
  if (!(await clickButtonInAriaRegion(win, "Shared agent runs", "Inspect compile"))) {
    throw new Error(
      "Shared E2E: collaborator shared agent run compile link was not clickable."
    );
  }
  if (!(await waitForText(win, "Opened shared succeeded pdflatex compile", 10_000))) {
    throw new Error("Shared E2E: collaborator agent compile inspection did not open.");
  }
  if (!sharedE2EState.inspectedBuildArtifactIds.includes(approvedSharedArtifact.id)) {
    throw new Error(
      "Shared E2E: collaborator did not inspect the agent compile artifact."
    );
  }
  if (!(await clickButtonInAriaRegion(win, "Shared agent audit", "Show changeset"))) {
    throw new Error(
      "Shared E2E: collaborator shared audit changeset link was not clickable."
    );
  }
  await replaceEditorText(win, collaboratorEditedSource, "main.tex");
  const collaboratorRevision = await waitForSharedRevisionContents(
    "shared-project-1",
    "main.tex",
    collaboratorEditedSource
  );
  if (collaboratorRevision?.contents !== collaboratorEditedSource) {
    throw new Error(
      "Shared E2E: invited collaborator edit did not update server state."
    );
  }
  const collaboratorBuildArtifactCountBefore = sharedE2EState.buildArtifacts.length;
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error(
      "Shared E2E: collaborator Compile project button was not clickable."
    );
  }
  const collaboratorArtifact = await waitForSharedBuildArtifact(
    (artifact) =>
      sharedE2EState.buildArtifacts.length > collaboratorBuildArtifactCountBefore &&
      artifact.projectId === "shared-project-1" &&
      artifact.status === "succeeded" &&
      artifact.sourceRevisionId === collaboratorRevision.revisionId
  );
  if (collaboratorArtifact === undefined) {
    throw new Error(
      "Shared E2E: invited collaborator compile artifact was not recorded."
    );
  }
  if (!(await clickButton(win, "Sign out of shared projects"))) {
    throw new Error("Shared E2E: collaborator sign-out button was not clickable.");
  }
  if (!(await waitForText(win, "Signed out of shared projects.", 10_000))) {
    throw new Error("Shared E2E: collaborator sign-out status did not render.");
  }
  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable before viewer sign-in."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error("Shared E2E: dashboard did not render before viewer sign-in.");
  }

  if (!(await setTemplatePickerFieldValue(win, "Email", viewerEmail))) {
    throw new Error("Shared E2E: viewer sign-in email field was not editable.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Name", "E2E Viewer"))) {
    throw new Error("Shared E2E: viewer sign-in name field was not editable.");
  }
  if (!(await clickButton(win, "Sign In"))) {
    throw new Error("Shared E2E: viewer Sign In button was not clickable.");
  }
  if (!(await waitForText(win, `Signed in as ${viewerEmail}.`, 10_000))) {
    throw new Error("Shared E2E: viewer sign-in status did not render.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Invitation id", viewerInvitation.id))) {
    throw new Error("Shared E2E: viewer invitation id field was not editable.");
  }
  if (!(await clickButton(win, "Accept"))) {
    throw new Error("Shared E2E: viewer Accept invitation button was not clickable.");
  }
  if (!(await waitForText(win, "Invitation accepted.", 10_000))) {
    throw new Error("Shared E2E: viewer invitation accepted status did not render.");
  }
  if (!(await waitForText(win, "Viewer ·", 10_000))) {
    throw new Error("Shared E2E: accepted viewer project did not show Viewer role.");
  }
  if (!(await clickButton(win, sharedProjectName))) {
    throw new Error("Shared E2E: viewer shared project row was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      "Read-only shared project. Local compile remains available.",
      20_000
    ))
  ) {
    throw new Error("Shared E2E: viewer read-only shared status did not render.");
  }
  const remoteRealtimeRevision = await updateSharedE2ERevision(
    "shared-project-1",
    "main.tex",
    remoteRealtimeSource
  );
  win.webContents.send("shared.realtimeEvent", {
    type: "document.updated",
    projectId: "shared-project-1",
    path: "main.tex",
    updateId: remoteRealtimeRevision.updateId,
    revisionId: remoteRealtimeRevision.revisionId
  });
  if (!(await waitForEditorValue(win, "main.tex", remoteRealtimeSource, 10_000))) {
    throw new Error(
      "Shared E2E: remote realtime document update did not reach the open editor."
    );
  }
  if (
    !(await waitForText(
      win,
      `source ${collaboratorRevision.revisionId.slice(0, 8)}`,
      10_000
    ))
  ) {
    throw new Error(
      "Shared E2E: viewer did not see the collaborator compile source revision."
    );
  }
  if (!(await clickButtonInAriaRegion(win, "Shared compile history", "Inspect"))) {
    throw new Error(
      "Shared E2E: viewer shared compile Inspect button was not clickable."
    );
  }
  if (!(await waitForText(win, "Opened shared succeeded pdflatex compile", 10_000))) {
    throw new Error("Shared E2E: viewer shared compile inspection did not open.");
  }
  if (!sharedE2EState.inspectedBuildArtifactIds.includes(collaboratorArtifact.id)) {
    throw new Error(
      "Shared E2E: viewer did not inspect the collaborator compile artifact."
    );
  }
  const viewerAttemptedSource = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Shared E2E source should not be saved by a viewer.",
    "\\end{document}",
    ""
  ].join("\n");
  await replaceEditorText(win, viewerAttemptedSource, "main.tex");
  await wait(1_000);
  if (await clickButton(win, "Save file")) {
    throw new Error("Shared E2E: viewer Save file button was unexpectedly clickable.");
  }
  const afterViewerAttemptRevision = sharedE2EState.revisions.get(
    "shared-project-1:main.tex"
  );
  if (afterViewerAttemptRevision?.contents !== remoteRealtimeSource) {
    throw new Error("Shared E2E: viewer edit unexpectedly updated server state.");
  }

  if (!(await clickButton(win, "Sign out of shared projects"))) {
    throw new Error("Shared E2E: viewer sign-out button was not clickable.");
  }
  if (!(await waitForText(win, "Signed out of shared projects.", 10_000))) {
    throw new Error("Shared E2E: viewer sign-out status did not render.");
  }
  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable before owner member management."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error(
      "Shared E2E: dashboard did not render before owner member management."
    );
  }

  if (!(await setTemplatePickerFieldValue(win, "Email", sharedEmail))) {
    throw new Error("Shared E2E: owner re-sign-in email field was not editable.");
  }
  if (!(await setTemplatePickerFieldValue(win, "Name", "E2E Owner"))) {
    throw new Error("Shared E2E: owner re-sign-in name field was not editable.");
  }
  if (!(await clickButton(win, "Sign In"))) {
    throw new Error("Shared E2E: owner re-sign-in button was not clickable.");
  }
  if (!(await waitForText(win, `Signed in as ${sharedEmail}.`, 10_000))) {
    throw new Error("Shared E2E: owner re-sign-in status did not render.");
  }
  if (!(await waitForText(win, "Owner ·", 10_000))) {
    throw new Error("Shared E2E: owner project row did not show Owner role.");
  }
  if (!(await clickButton(win, sharedProjectName))) {
    throw new Error(
      "Shared E2E: owner shared project row was not clickable for member management."
    );
  }
  if (!(await waitForText(win, "Members", 20_000))) {
    throw new Error("Shared E2E: owner shared members region did not render.");
  }
  if (
    !(await waitForText(win, "E2E Collaborator", 20_000)) ||
    !(await waitForText(win, "E2E Viewer", 20_000))
  ) {
    throw new Error("Shared E2E: owner did not see accepted shared members.");
  }
  if (!(await selectByAriaLabel(win, `Role for ${collaboratorEmail}`, "viewer"))) {
    throw new Error("Shared E2E: collaborator member role selector was not editable.");
  }
  const collaboratorViewerMember = await waitForSharedMember(
    "shared-project-1",
    (member) => member.email === collaboratorEmail && member.role === "viewer"
  );
  if (collaboratorViewerMember?.role !== "viewer") {
    throw new Error("Shared E2E: collaborator role was not updated to viewer.");
  }
  if (!(await selectByAriaLabel(win, `Role for ${collaboratorEmail}`, "editor"))) {
    throw new Error(
      "Shared E2E: collaborator member role selector was not editable for restoring editor."
    );
  }
  const collaboratorEditorMember = await waitForSharedMember(
    "shared-project-1",
    (member) => member.email === collaboratorEmail && member.role === "editor"
  );
  if (collaboratorEditorMember?.role !== "editor") {
    throw new Error("Shared E2E: collaborator role was not restored to editor.");
  }
  if (
    !(await clickButtonInAriaRegionRow(win, "Shared members", "E2E Viewer", "Remove"))
  ) {
    throw new Error("Shared E2E: viewer member Remove button was not clickable.");
  }
  if (
    !(await waitForSharedMemberRemoval(
      "shared-project-1",
      (member) => member.email === viewerEmail
    ))
  ) {
    throw new Error("Shared E2E: viewer member was not removed from server state.");
  }

  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable before shared ZIP lifecycle."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error("Shared E2E: dashboard did not render before shared ZIP import.");
  }

  const sharedImportZipPath = path.join(sandboxPath, "shared-source-import.zip");
  await fs.writeFile(
    sharedImportZipPath,
    createTestZipArchive([
      {
        path: "main.tex",
        data: Buffer.from(importedSharedMainSource, "utf8")
      },
      {
        path: "sections/intro.tex",
        data: Buffer.from(importedSharedIntroSource, "utf8")
      },
      {
        path: "main.aux",
        data: Buffer.from("generated artifact should not be shared\n", "utf8")
      }
    ])
  );
  if (
    !(await setTemplatePickerFieldValue(win, "Project name", importedSharedProjectName))
  ) {
    throw new Error("Shared E2E: shared ZIP import project name was not editable.");
  }
  nextImportZipPath = sharedImportZipPath;
  nextImportProjectName = importedSharedProjectName;
  if (!(await clickButton(win, "Import ZIP"))) {
    throw new Error("Shared E2E: shared Import ZIP button was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      `Imported 2 files into ${importedSharedProjectName}.`,
      20_000
    ))
  ) {
    throw new Error("Shared E2E: shared ZIP import status did not render.");
  }
  const importedSharedProject = sharedE2EState.projects.find(
    (project) => project.name === importedSharedProjectName
  );
  if (importedSharedProject === undefined) {
    throw new Error("Shared E2E: imported shared project was not created.");
  }
  const importedMainRevision = sharedE2EState.revisions.get(
    `${importedSharedProject.id}:main.tex`
  );
  const importedIntroRevision = sharedE2EState.revisions.get(
    `${importedSharedProject.id}:sections/intro.tex`
  );
  if (
    importedMainRevision?.contents !== importedSharedMainSource ||
    importedIntroRevision?.contents !== importedSharedIntroSource ||
    sharedE2EState.revisions.has(`${importedSharedProject.id}:main.aux`)
  ) {
    throw new Error(
      "Shared E2E: imported shared ZIP files did not match the shareable source set."
    );
  }
  if (!(await clickButton(win, importedSharedProjectName))) {
    throw new Error("Shared E2E: imported shared project row was not clickable.");
  }
  if (!(await waitForEditorValue(win, "main.tex", importedSharedMainSource, 20_000))) {
    throw new Error("Shared E2E: imported shared project did not open main.tex.");
  }
  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable after shared ZIP open."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error("Shared E2E: dashboard did not render before shared ZIP export.");
  }

  const sharedExportCountBefore = exportedSharedSourceZips.length;
  if (
    !(await clickButton(
      win,
      `Export shared source ZIP for ${importedSharedProjectName}`
    ))
  ) {
    throw new Error("Shared E2E: shared Export source ZIP button was not clickable.");
  }
  if (!(await waitForText(win, "Exported 2 shared source files.", 20_000))) {
    throw new Error("Shared E2E: shared source ZIP export status did not render.");
  }
  const sharedSourceExport = exportedSharedSourceZips.at(-1);
  if (
    sharedSourceExport === undefined ||
    exportedSharedSourceZips.length !== sharedExportCountBefore + 1
  ) {
    throw new Error("Shared E2E: shared source export did not produce an archive.");
  }
  const lifecycleService =
    await import("../packages/project-lifecycle-service/dist/index.js");
  const sharedExportImportParentPath = path.join(sandboxPath, "shared-export-imports");
  await fs.mkdir(sharedExportImportParentPath, { recursive: true });
  const importedSharedExport = await lifecycleService.importProjectZip({
    zipPath: sharedSourceExport.archivePath,
    destinationParentPath: sharedExportImportParentPath,
    projectName: "shared-export-roundtrip"
  });
  const exportedSharedMain = await fs.readFile(
    path.join(importedSharedExport.projectRoot, "main.tex"),
    "utf8"
  );
  const exportedSharedIntro = await fs.readFile(
    path.join(importedSharedExport.projectRoot, "sections/intro.tex"),
    "utf8"
  );
  if (
    exportedSharedMain !== importedSharedMainSource ||
    exportedSharedIntro !== importedSharedIntroSource
  ) {
    throw new Error("Shared E2E: exported shared source ZIP did not round-trip.");
  }
  try {
    await fs.stat(path.join(importedSharedExport.projectRoot, "main.aux"));
    throw new Error("Shared E2E: exported shared source ZIP included main.aux.");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await installPromptResponses(win, { confirms: [true] });
  if (!(await clickButton(win, `Delete shared project ${importedSharedProjectName}`))) {
    throw new Error("Shared E2E: shared Delete project button was not clickable.");
  }
  if (
    !(await waitForText(
      win,
      `Deleted shared project ${importedSharedProjectName}.`,
      20_000
    ))
  ) {
    throw new Error("Shared E2E: shared delete status did not render.");
  }
  if (
    sharedE2EState.projects.some(
      (project) => project.id === importedSharedProject.id
    ) ||
    sharedE2EState.revisions.has(`${importedSharedProject.id}:main.tex`) ||
    !(await waitForAriaRegionText(
      win,
      "Shared project list",
      importedSharedProjectName,
      {
        expected: false,
        timeoutMs: 10_000
      }
    ))
  ) {
    throw new Error(
      "Shared E2E: deleted shared project was still visible or persisted."
    );
  }

  if (!(await clickButton(win, sharedProjectName))) {
    throw new Error(
      "Shared E2E: owner shared project row was not clickable after lifecycle check."
    );
  }
  if (!(await waitForText(win, "Members", 20_000))) {
    throw new Error(
      "Shared E2E: owner shared members region did not render after lifecycle check."
    );
  }

  await installPromptResponses(win, { confirms: [true] });
  if (
    !(await clickButtonInAriaRegionRow(
      win,
      "Shared members",
      "E2E Collaborator",
      "Transfer ownership"
    ))
  ) {
    throw new Error(
      "Shared E2E: collaborator member Transfer ownership button was not clickable."
    );
  }
  const collaboratorOwnerMember = await waitForSharedMember(
    "shared-project-1",
    (member) => member.email === collaboratorEmail && member.role === "owner"
  );
  if (collaboratorOwnerMember?.role !== "owner") {
    throw new Error("Shared E2E: collaborator did not become project owner.");
  }
  const previousOwnerMember = await waitForSharedMember(
    "shared-project-1",
    (member) => member.email === sharedEmail && member.role === "editor"
  );
  if (previousOwnerMember?.role !== "editor") {
    throw new Error("Shared E2E: previous owner did not become editor.");
  }
  const transferredProject = sharedE2EState.projects.find(
    (project) => project.id === "shared-project-1"
  );
  if (transferredProject?.ownerUserId !== collaboratorOwnerMember.userId) {
    throw new Error("Shared E2E: project owner id was not transferred.");
  }

  if (!(await clickButton(win, "Close project"))) {
    throw new Error(
      "Shared E2E: Close project button was not clickable before local share."
    );
  }
  if (!(await waitForText(win, "Open Folder", 10_000))) {
    throw new Error("Shared E2E: dashboard did not render before local share.");
  }
  if (!(await clickButton(win, "Open Folder"))) {
    throw new Error(
      "Shared E2E: Open Folder button was not clickable for local share."
    );
  }
  if (!(await waitForText(win, "Local project", 20_000))) {
    throw new Error("Shared E2E: local project did not open before sharing.");
  }
  if (
    !(await setTemplatePickerFieldValue(win, "Shared name", localSharedProjectName))
  ) {
    throw new Error("Shared E2E: local share project name was not editable.");
  }
  if (!(await clickButton(win, "Share project"))) {
    throw new Error("Shared E2E: Share project button was not clickable.");
  }
  const localSharedProject = await waitForSharedProject(
    (project) => project.name === localSharedProjectName,
    20_000
  );
  const localSharedMainRevision =
    localSharedProject === undefined
      ? undefined
      : sharedE2EState.revisions.get(`${localSharedProject.id}:main.tex`);
  if (
    localSharedProject === undefined ||
    localSharedProject.ownerUserId !== "shared-user-owner" ||
    localSharedMainRevision === undefined ||
    !localSharedMainRevision.contents.includes("\\documentclass")
  ) {
    throw new Error("Shared E2E: local project was not copied into shared storage.");
  }
  if (!(await waitForText(win, "Shared project", 20_000))) {
    throw new Error("Shared E2E: local shared project did not reopen as shared.");
  }

  return {
    projectName: sharedProjectName,
    savedRevisionId: savedRevision.revisionId,
    buildArtifactId: sharedArtifact.id,
    failedBuildArtifactId: failedSharedArtifact.id,
    agentRunId: completedSharedAgentRun.id,
    agentChangeSetId: proposedSharedAgentChangeSet.id,
    agentBuildArtifactId: approvedSharedArtifact.id,
    auditEventCount: sharedE2EState.auditEvents.length,
    presenceCount: sharedE2EState.presence.length,
    invitationId: sharedInvitation.id,
    viewerInvitationId: viewerInvitation.id,
    collaboratorSawAgentRunId: completedSharedAgentRun.id,
    collaboratorSawAgentChangeSetId: proposedSharedAgentChangeSet.id,
    collaboratorInspectedAgentBuildArtifactId: approvedSharedArtifact.id,
    ownerSharedCommentId: ownerSharedComment.id,
    collaboratorResolvedCommentId: resolvedSharedComment.id,
    restoredSharedRevisionId: restoredSharedRevision.revisionId,
    collaboratorRevisionId: collaboratorRevision.revisionId,
    remoteRealtimeRevisionId: remoteRealtimeRevision.revisionId,
    collaboratorBuildArtifactId: collaboratorArtifact.id,
    viewerInspectedBuildArtifactId: collaboratorArtifact.id,
    viewerReadOnlyRevisionId: afterViewerAttemptRevision.revisionId,
    collaboratorManagedRole: collaboratorEditorMember.role,
    removedViewerMemberEmail: viewerEmail,
    importedSharedProjectId: importedSharedProject.id,
    exportedSharedSourceZipPath: sharedSourceExport.archivePath,
    deletedSharedProjectId: importedSharedProject.id,
    localSharedProjectId: localSharedProject.id,
    transferredOwnerEmail: collaboratorEmail,
    previousOwnerRole: previousOwnerMember.role,
    sessionsAfterRevoke: ownerSessionsAfterRevoke
  };
}

async function main() {
  sandboxPath = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "latex-e2e-"));
  const expectMissingToolchain = process.env.E2E_EXPECT_TEX_MISSING === "1";
  const projectName = expectMissingToolchain ? "valid-article" : "scenario-project";
  const projectRoot = path.join(sandboxPath, projectName);

  if (expectMissingToolchain) {
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    await fs.cp(path.resolve("samples/valid-article"), projectRoot, {
      recursive: true
    });
  } else {
    await createScenarioProject(projectRoot);
  }

  await registerIpc(projectRoot);

  await app.whenReady();
  const win = new BrowserWindow({
    width: (() => {
      const value = Number.parseInt(process.env.E2E_WINDOW_WIDTH ?? "1920", 10);
      return Number.isFinite(value) && value > 0 ? value : 1920;
    })(),
    height: (() => {
      const value = Number.parseInt(process.env.E2E_WINDOW_HEIGHT ?? "1200", 10);
      return Number.isFinite(value) && value > 0 ? value : 1200;
    })(),
    show: false,
    webPreferences: {
      preload: path.resolve("apps/desktop/dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await win.loadFile(path.resolve("apps/desktop/dist/renderer/index.html"));
  if (!expectMissingToolchain) {
    await startProjectWatcher(win, projectRoot);
  }
  await wait(1500);
  const preOpenToolchainSummary = await waitForText(win, "TeX setup", 2_000);
  let preOpenMissingLatexmk = false;
  let preOpenSetupGuidance = false;

  if (expectMissingToolchain) {
    if (!(await waitForText(win, "latexmk missing", 20_000))) {
      throw new Error("Missing latexmk state did not render before opening a project.");
    }
    preOpenMissingLatexmk = true;
    if (!(await waitForText(win, "MacTeX or BasicTeX", 20_000))) {
      throw new Error("Missing latexmk guidance did not mention MacTeX or BasicTeX.");
    }
    preOpenSetupGuidance = true;
  } else if (process.env.E2E_ONLY_SHARED !== "1") {
    if (
      !(await waitForAnyText(
        win,
        ["Checking toolchain", "1 engine", "2 engines", "3 engines", "latexmk"],
        20_000
      ))
    ) {
      throw new Error("Installed TeX toolchain readiness did not render.");
    }
  }

  const sharedScenario =
    !expectMissingToolchain && process.env.E2E_SKIP_SHARED_PROJECTS !== "1"
      ? await runSharedProjectDesktopScenario(win)
      : undefined;

  if (process.env.E2E_ONLY_SHARED === "1") {
    const summary = await getDomSummary(win);
    if (summary.unlabeledButtons !== 0) {
      throw new Error(`Found ${summary.unlabeledButtons} unlabeled icon buttons.`);
    }
    console.log(
      JSON.stringify(
        {
          projectRoot,
          preOpenToolchainSummary,
          sharedScenario,
          screenshotDir,
          screenshotCount: screenshotManifest.length,
          unlabeledButtons: summary.unlabeledButtons,
          clientWidth: summary.clientWidth,
          scrollWidth: summary.scrollWidth,
          hasHorizontalOverflow: summary.hasHorizontalOverflow
        },
        null,
        2
      )
    );
    return;
  }

  if (!(await clickButton(win, "Open Folder"))) {
    throw new Error("Open Folder button was not clickable.");
  }
  if (!(await waitForText(win, projectName, 20_000))) {
    throw new Error("Project did not open in E2E smoke.");
  }
  if (!(await waitForText(win, "Project health", 20_000))) {
    throw new Error("Project health summary did not render after opening project.");
  }
  if (expectMissingToolchain) {
    if (!(await waitForText(win, "MacTeX or BasicTeX", 20_000))) {
      throw new Error(
        "Missing latexmk guidance was not visible after opening project."
      );
    }
    const compileButton = await getButtonState(win, "Compile project");
    if (!compileButton.found) {
      throw new Error(
        "Compile project button was not found in missing-toolchain mode."
      );
    }
    if (!compileButton.disabled) {
      throw new Error("Compile project button stayed enabled with missing latexmk.");
    }
  } else {
    const compileButton = await getButtonState(win, "Compile project");
    if (!compileButton.found || compileButton.disabled) {
      throw new Error("Compile project button was not enabled with installed TeX.");
    }
  }

  if (expectMissingToolchain) {
    const summary = await getDomSummary(win);
    if (screenshotDir !== undefined) {
      await captureStep(win, "ready-for-missing-toolchain-state");
    }
    console.log(
      JSON.stringify(
        {
          projectRoot,
          preOpenToolchainSummary,
          preOpenMissingLatexmk,
          preOpenSetupGuidance,
          projectHealth: summary.text.includes("Project health"),
          missingLatexmk: summary.text.includes("latexmk missing"),
          projectSetupGuidance: summary.text.includes("MacTeX or BasicTeX"),
          compileDisabled: true,
          unlabeledButtons: summary.unlabeledButtons,
          screenshotDir,
          screenshotCount: screenshotManifest.length,
          clientWidth: summary.clientWidth,
          scrollWidth: summary.scrollWidth,
          hasHorizontalOverflow: summary.hasHorizontalOverflow
        },
        null,
        2
      )
    );
    return;
  }

  const scenarios = await runProjectFileManagementScenarios(win, projectRoot, {
    skipScenario1: process.env.E2E_SKIP_SCENARIO1 === "1",
    skipHistoryTabChecks: process.env.E2E_SKIP_HISTORY_TAB_CHECKS === "1",
    skipScenario5: process.env.E2E_SKIP_SCENARIO5 === "1"
  });
  const pdfCanvas = await getPdfCanvasState(win);
  if (!pdfCanvas.found || pdfCanvas.width === 0 || pdfCanvas.height === 0) {
    throw new Error("Compiled PDF did not render to a visible canvas.");
  }
  const savePdfButton = await getButtonState(win, "Save PDF");
  if (!savePdfButton.found || savePdfButton.disabled) {
    throw new Error("Save PDF button was not enabled after successful compile.");
  }

  const summary = await getDomSummary(win);
  if (screenshotDir !== undefined) {
    await captureStep(win, "smoke-scenarios-complete");
  }
  if (summary.unlabeledButtons !== 0) {
    throw new Error(`Found ${summary.unlabeledButtons} unlabeled icon buttons.`);
  }
  if (
    summary.hasHorizontalOverflow &&
    process.env.E2E_ALLOW_HORIZONTAL_OVERFLOW !== "1"
  ) {
    throw new Error(
      `Renderer has horizontal overflow in E2E smoke viewport: ${summary.scrollWidth} > ${summary.clientWidth}.`
    );
  }
  console.log(
    JSON.stringify(
      {
        projectRoot,
        preOpenToolchainSummary,
        projectHealth: summary.text.includes("Project health"),
        sharedScenario,
        scenarios,
        screenshotDir,
        screenshotCount: screenshotManifest.length,
        compiled: summary.text.includes("Compiled main.tex"),
        pdfRendered: pdfCanvas.found && pdfCanvas.width > 0 && pdfCanvas.height > 0,
        recentReopened: summary.text.includes(projectName),
        projectChangedEventCount,
        unlabeledButtons: summary.unlabeledButtons,
        clientWidth: summary.clientWidth,
        scrollWidth: summary.scrollWidth,
        hasHorizontalOverflow: summary.hasHorizontalOverflow
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    failed = true;
    console.error(error);
  })
  .finally(async () => {
    projectChangeDebouncer?.dispose();
    projectWatcher?.close();
    historyStore?.close();
    if (sandboxPath !== undefined) {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
    app.exit(failed ? 1 : 0);
  });
