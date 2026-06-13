import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopApi,
  IpcChannel,
  IpcRequestMap,
  IpcResponseMap,
  ProjectChangeEvent
} from "@latex-agent/ipc-contracts";

function invoke<TChannel extends IpcChannel>(
  channel: TChannel,
  payload: IpcRequestMap[TChannel]
): Promise<IpcResponseMap[TChannel]> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResponseMap[TChannel]>;
}

const api: DesktopApi = {
  app: {
    getInfo: () => invoke("app.getInfo", undefined)
  },
  workbench: {
    loadLayout: () => invoke("workbench.loadLayout", undefined),
    saveLayout: (layout) => invoke("workbench.saveLayout", layout)
  },
  editor: {
    loadProjectState: (projectRoot) =>
      invoke("editor.loadProjectState", { projectRoot }),
    saveProjectState: (state) => invoke("editor.saveProjectState", state)
  },
  project: {
    getState: () => invoke("project.getState", undefined),
    open: () => invoke("project.open", undefined),
    openRecent: (rootPath) => invoke("project.openRecent", { rootPath }),
    refresh: (projectRoot) => invoke("project.refresh", { projectRoot }),
    createEntry: (request) => invoke("project.createEntry", request),
    renameEntry: (request) => invoke("project.renameEntry", request),
    moveEntry: (request) => invoke("project.moveEntry", request),
    deleteEntry: (request) => invoke("project.deleteEntry", request),
    setMainFile: (request) => invoke("project.setMainFile", request),
    onChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProjectChangeEvent
      ) => {
        callback(payload);
      };

      ipcRenderer.on("project.changed", listener);
      return () => ipcRenderer.off("project.changed", listener);
    }
  },
  files: {
    read: (request) => invoke("file.read", request),
    write: (request) => invoke("file.write", request)
  },
  build: {
    detectToolchain: () => invoke("build.detectToolchain", undefined),
    run: (request) => invoke("build.run", request),
    stop: (jobId) => invoke("build.stop", { jobId })
  },
  pdf: {
    readArtifact: (request) => invoke("pdf.readArtifact", request)
  },
  synctex: {
    forward: (request) => invoke("synctex.forward", request),
    reverse: (request) => invoke("synctex.reverse", request)
  },
  history: {
    listChangeSets: (request) => invoke("history.listChangeSets", request),
    snapshotFile: (request) => invoke("history.snapshotFile", request),
    createChangeSet: (request) => invoke("history.createChangeSet", request),
    createAppliedChangeSet: (request) =>
      invoke("history.createAppliedChangeSet", request),
    applyChangeSet: (changesetId) => invoke("history.applyChangeSet", { changesetId }),
    applyChangeSetHunks: (request) => invoke("history.applyChangeSetHunks", request),
    rejectChangeSet: (changesetId) =>
      invoke("history.rejectChangeSet", { changesetId }),
    rollbackChangeSet: (changesetId) =>
      invoke("history.rollbackChangeSet", { changesetId }),
    listAuditEvents: (request) => invoke("history.listAuditEvents", request)
  },
  references: {
    analyze: (request) => invoke("references.analyze", request),
    search: (request) => invoke("references.search", request),
    removeUnused: (request) => invoke("references.removeUnused", request)
  },
  lifecycle: {
    listTemplates: () => invoke("lifecycle.listTemplates", undefined),
    exportSourceZip: (request) => invoke("lifecycle.exportSourceZip", request),
    exportPdf: (request) => invoke("lifecycle.exportPdf", request),
    importSourceZip: () => invoke("lifecycle.importSourceZip", undefined),
    createFromTemplate: (request) => invoke("lifecycle.createFromTemplate", request),
    checkSubmission: (request) => invoke("lifecycle.checkSubmission", request)
  },
  settings: {
    load: () => invoke("settings.load", undefined),
    save: (settings) => invoke("settings.save", settings),
    getPrivacySummary: () => invoke("settings.getPrivacySummary", undefined),
    clearLocalHistory: () => invoke("settings.clearLocalHistory", undefined)
  },
  agent: {
    getAuthStatus: (providerId) => invoke("agent.getAuthStatus", { providerId }),
    start: (request) => invoke("agent.start", request),
    respondApproval: (request) => invoke("agent.respondApproval", request),
    cancel: (sessionId) => invoke("agent.cancel", { sessionId }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: unknown) => {
        callback(event as Parameters<typeof callback>[0]);
      };
      ipcRenderer.on("agent.event", listener);
      return () => {
        ipcRenderer.removeListener("agent.event", listener);
      };
    }
  }
};

contextBridge.exposeInMainWorld("latexAgent", api);
