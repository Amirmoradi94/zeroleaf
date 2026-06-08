const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

let historyStore;
let sandboxPath;
let failed = false;

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

async function clickButton(win, text) {
  return win.webContents.executeJavaScript(`
    (() => {
      const target = [...document.querySelectorAll("button")]
        .find((button) => button.innerText.includes(${JSON.stringify(text)}) || (button.getAttribute("aria-label") ?? "").includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
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

async function registerIpc(projectRoot) {
  const { defaultAppSettings, defaultWorkbenchLayout } =
    await import("../packages/ipc-contracts/dist/index.js");
  const projectService = await import("../packages/project-service/dist/index.js");
  const latexService = await import("../packages/latex-service/dist/index.js");
  const pdfService = await import("../packages/pdf-service/dist/index.js");
  const historyService = await import("../packages/history-service/dist/index.js");
  const referenceService = await import("../packages/reference-service/dist/index.js");
  const lifecycleService =
    await import("../packages/project-lifecycle-service/dist/index.js");
  const metadata = new projectService.ProjectMetadataStore(
    path.join(sandboxPath, "metadata.json")
  );
  historyStore = new historyService.HistoryStore(
    path.join(sandboxPath, "history.sqlite")
  );

  ipcMain.handle("app.getInfo", () => ({
    appName: "AI LaTeX Editor",
    appVersion: "e2e",
    platform: process.platform,
    isPackaged: false
  }));
  ipcMain.handle("workbench.loadLayout", () => defaultWorkbenchLayout);
  ipcMain.handle("workbench.saveLayout", (_event, layout) => layout);
  ipcMain.handle("editor.loadProjectState", (_event, request) => ({
    projectRoot: request.projectRoot,
    openFilePaths: []
  }));
  ipcMain.handle("editor.saveProjectState", (_event, state) => state);
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
    await projectService.deleteProjectEntry(request.projectRoot, request.path);
    return projectService.refreshProject(request.projectRoot, metadata);
  });
  ipcMain.handle("project.setMainFile", (_event, request) =>
    projectService.setProjectMainFile(request.projectRoot, metadata, request.path)
  );
  ipcMain.handle("file.read", (_event, request) =>
    projectService.readProjectFile(request.projectRoot, request.path)
  );
  ipcMain.handle("file.write", (_event, request) =>
    projectService.writeProjectFile(request.projectRoot, request.path, request.contents)
  );
  ipcMain.handle("build.detectToolchain", () => latexService.detectLatexToolchain());
  ipcMain.handle("build.run", (_event, request) => latexService.runLatexBuild(request));
  ipcMain.handle("build.stop", (_event, request) => ({
    stopped: latexService.stopLatexBuild(request.jobId)
  }));
  ipcMain.handle("pdf.readArtifact", (_event, request) =>
    pdfService.readPdfArtifact(request.projectRoot, request.pdfPath)
  );
  ipcMain.handle("synctex.forward", (_event, request) =>
    latexService.runSyncTexForward(request)
  );
  ipcMain.handle("synctex.reverse", (_event, request) =>
    latexService.runSyncTexReverse(request)
  );
  ipcMain.handle("history.listChangeSets", (_event, request) =>
    historyStore.listChangeSets(request.projectRoot)
  );
  ipcMain.handle("history.snapshotFile", (_event, request) =>
    historyStore.snapshotFile(request)
  );
  ipcMain.handle("history.createChangeSet", (_event, request) =>
    historyStore.createChangeSet(request)
  );
  ipcMain.handle("history.applyChangeSet", (_event, request) =>
    historyStore.applyChangeSet(request.changesetId)
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
  ipcMain.handle("lifecycle.listTemplates", () => lifecycleService.projectTemplates);
  ipcMain.handle("lifecycle.checkSubmission", (_event, request) =>
    lifecycleService.checkSubmissionBundle(request.projectRoot, request.mainFilePath)
  );
  ipcMain.handle("lifecycle.exportSourceZip", () => undefined);
  ipcMain.handle("lifecycle.exportPdf", () => undefined);
  ipcMain.handle("lifecycle.importSourceZip", () => undefined);
  ipcMain.handle("lifecycle.createFromTemplate", () => undefined);
  ipcMain.handle("settings.load", () => defaultAppSettings);
  ipcMain.handle("settings.save", (_event, settings) => settings);
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
  ipcMain.handle("agent.start", () => {
    throw new Error("Agent sessions are covered by integration tests.");
  });
  ipcMain.handle("agent.respondApproval", () => {
    throw new Error("Agent approvals are covered by integration tests.");
  });
  ipcMain.handle("agent.cancel", () => ({ cancelled: false }));
}

async function main() {
  sandboxPath = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "latex-e2e-"));
  const projectRoot = path.join(sandboxPath, "valid-article");
  await fs.cp(path.resolve("samples/valid-article"), projectRoot, { recursive: true });
  await registerIpc(projectRoot);

  await app.whenReady();
  const win = new BrowserWindow({
    width: 1440,
    height: 950,
    show: false,
    webPreferences: {
      preload: path.resolve("apps/desktop/dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await win.loadFile(path.resolve("apps/desktop/dist/renderer/index.html"));
  await wait(1500);
  if (!(await clickButton(win, "Open Folder"))) {
    throw new Error("Open Folder button was not clickable.");
  }
  if (!(await waitForText(win, "valid-article", 20_000))) {
    throw new Error("Project did not open in E2E smoke.");
  }
  if (!(await clickButton(win, "Compile project"))) {
    throw new Error("Compile project button was not clickable.");
  }
  if (!(await waitForText(win, "Compiled main.tex", 90_000))) {
    throw new Error("Project did not compile in E2E smoke.");
  }

  const summary = await getDomSummary(win);
  if (summary.unlabeledButtons !== 0) {
    throw new Error(`Found ${summary.unlabeledButtons} unlabeled icon buttons.`);
  }
  if (summary.hasHorizontalOverflow) {
    throw new Error(
      `Renderer has horizontal overflow in E2E smoke viewport: ${summary.scrollWidth} > ${summary.clientWidth}.`
    );
  }
  console.log(
    JSON.stringify(
      {
        projectRoot,
        compiled: summary.text.includes("Compiled main.tex"),
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
    historyStore?.close();
    if (sandboxPath !== undefined) {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
    app.exit(failed ? 1 : 0);
  });
