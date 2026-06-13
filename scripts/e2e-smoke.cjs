const { app, BrowserWindow, ipcMain } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
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
const editorProjectStates = new Map();
let appSettingsState;
const buildRequests = [];
const buildResults = [];
const exportedSourceZips = [];
const exportedPdfs = [];
const openedExternalPaths = [];
const agentSessions = new Map();
const agentStartRecords = [];
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

  ipcMain.handle("app.getInfo", () => ({
    appName: "ZeroLeaf",
    appVersion: "e2e",
    platform: process.platform,
    isPackaged: false
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
  } else {
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
