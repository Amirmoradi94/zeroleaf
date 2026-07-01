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
    getInfo: () => invoke("app.getInfo", undefined),
    checkForUpdates: () => invoke("app.checkForUpdates", undefined),
    openUpdateDownload: (url) => invoke("app.openUpdateDownload", { url }),
    installUpdate: (url) => invoke("app.installUpdate", { url }),
    showMessageDialog: (request) => invoke("app.showMessageDialog", request)
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
    clearRecent: () => invoke("project.clearRecent", undefined),
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
  shared: {
    getConnection: () => invoke("shared.getConnection", undefined),
    signIn: (request) => invoke("shared.signIn", request),
    signOut: () => invoke("shared.signOut", undefined),
    listSessions: () => invoke("shared.listSessions", undefined),
    revokeSession: (request) => invoke("shared.revokeSession", request),
    listProjects: () => invoke("shared.listProjects", undefined),
    createProject: (request) => invoke("shared.createProject", request),
    createFromLocalProject: (request) =>
      invoke("shared.createFromLocalProject", request),
    createFromSourceZip: (request) => invoke("shared.createFromSourceZip", request),
    updateProjectSettings: (request) => invoke("shared.updateProjectSettings", request),
    deleteProject: (request) => invoke("shared.deleteProject", request),
    exportSourceZip: (request) => invoke("shared.exportSourceZip", request),
    openProject: (projectId) => invoke("shared.openProject", { projectId }),
    invite: (request) => invoke("shared.invite", request),
    acceptInvitation: (request) => invoke("shared.acceptInvitation", request),
    listMembers: (projectId) => invoke("shared.listMembers", { projectId }),
    updateMemberRole: (request) => invoke("shared.updateMemberRole", request),
    transferOwnership: (request) => invoke("shared.transferOwnership", request),
    removeMember: (request) => invoke("shared.removeMember", request),
    listPresence: (projectId) => invoke("shared.listPresence", { projectId }),
    updatePresence: (request) => invoke("shared.updatePresence", request),
    listActivity: (projectId) => invoke("shared.listActivity", { projectId }),
    listComments: (projectId) => invoke("shared.listComments", { projectId }),
    createComment: (request) => invoke("shared.createComment", request),
    resolveComment: (request) => invoke("shared.resolveComment", request),
    listAuditEvents: (projectId) => invoke("shared.listAuditEvents", { projectId }),
    publishAgentRun: (request) => invoke("shared.publishAgentRun", request),
    updateAgentRunStatus: (request) => invoke("shared.updateAgentRunStatus", request),
    listAgentRuns: (projectId) => invoke("shared.listAgentRuns", { projectId }),
    listAgentChangeSets: (projectId) =>
      invoke("shared.listAgentChangeSets", { projectId }),
    applyAgentChangeSet: (request) => invoke("shared.applyAgentChangeSet", request),
    rejectAgentChangeSet: (request) => invoke("shared.rejectAgentChangeSet", request),
    listBuildArtifacts: (projectId) =>
      invoke("shared.listBuildArtifacts", { projectId }),
    getBuildArtifact: (projectId, artifactId) =>
      invoke("shared.getBuildArtifact", { projectId, artifactId }),
    publishBuildArtifact: (request) => invoke("shared.publishBuildArtifact", request),
    attachAgentRunBuildArtifact: (request) =>
      invoke("shared.attachAgentRunBuildArtifact", request),
    getFileRevision: (request) => invoke("shared.getFileRevision", request),
    listFileRevisions: (request) => invoke("shared.listFileRevisions", request),
    getFileRevisionDetails: (request) =>
      invoke("shared.getFileRevisionDetails", request),
    restoreFileRevision: (request) => invoke("shared.restoreFileRevision", request),
    syncDocumentContents: (request) => invoke("shared.syncDocumentContents", request),
    applyDocumentTextOperations: (request) =>
      invoke("shared.applyDocumentTextOperations", request),
    pullDocumentContents: (request) => invoke("shared.pullDocumentContents", request),
    startRealtime: (projectId) => invoke("shared.startRealtime", { projectId }),
    stopRealtime: (projectId) => invoke("shared.stopRealtime", { projectId }),
    onRealtimeEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: unknown) => {
        callback(event as Parameters<typeof callback>[0]);
      };

      ipcRenderer.on("shared.realtimeEvent", listener);
      return () => ipcRenderer.off("shared.realtimeEvent", listener);
    }
  },
  files: {
    read: (request) => invoke("file.read", request),
    write: (request) => invoke("file.write", request)
  },
  word: {
    read: (request) => invoke("word.read", request),
    save: (request) => invoke("word.save", request),
    createChangeSet: (request) => invoke("word.createChangeSet", request),
    applyChangeSet: (request) => invoke("word.applyChangeSet", request),
    rollbackChangeSet: (request) => invoke("word.rollbackChangeSet", request)
  },
  onlyOffice: {
    getStatus: () => invoke("onlyoffice.getStatus", undefined),
    createSession: (request) => invoke("onlyoffice.createSession", request),
    forceSave: (request) => invoke("onlyoffice.forceSave", request),
    exportPdf: (request) => invoke("onlyoffice.exportPdf", request)
  },
  build: {
    detectToolchain: () => invoke("build.detectToolchain", undefined),
    run: (request) => invoke("build.run", request),
    stop: (jobId) => invoke("build.stop", { jobId })
  },
  pdf: {
    readArtifact: (request) => invoke("pdf.readArtifact", request),
    reportPreviewBounds: (request) => invoke("pdf.reportPreviewBounds", request)
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
    listWordChangeSets: (request) => invoke("history.listWordChangeSets", request),
    createWordChangeSet: (request) => invoke("history.createWordChangeSet", request),
    markWordChangeSetApplied: (request) =>
      invoke("history.markWordChangeSetApplied", request),
    rejectWordChangeSet: (changesetId) =>
      invoke("history.rejectWordChangeSet", { changesetId }),
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
    createForAgent: (request) => invoke("lifecycle.createForAgent", request),
    createFromTemplate: (request) => invoke("lifecycle.createFromTemplate", request),
    createFromExternalTemplate: (request) =>
      invoke("lifecycle.createFromExternalTemplate", request),
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
    openProviderSetupTerminal: (providerId, action) =>
      invoke("agent.openProviderSetupTerminal", { providerId, action }),
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
