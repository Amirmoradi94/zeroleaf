import {
  defaultAppSettings,
  defaultWorkbenchLayout,
  type AppInfo,
  type AppSettings,
  type DesktopApi,
  type ProjectOpenResult,
  type WorkbenchLayout
} from "@latex-agent/ipc-contracts";

const fallbackLayoutKey = "latex-agent.workbench.layout";
const fallbackEditorStateKey = "latex-agent.editor.projectState";
const fallbackSettingsKey = "latex-agent.app.settings";

function getBrowserPlatform(): AppInfo["platform"] {
  if (navigator.userAgent.includes("Windows")) {
    return "win32";
  }

  if (navigator.userAgent.includes("Mac")) {
    return "darwin";
  }

  return "linux";
}

function readFallbackLayout(): WorkbenchLayout {
  const storedLayout = window.localStorage.getItem(fallbackLayoutKey);

  if (storedLayout === null) {
    return defaultWorkbenchLayout;
  }

  try {
    return {
      ...defaultWorkbenchLayout,
      ...(JSON.parse(storedLayout) as Partial<WorkbenchLayout>)
    };
  } catch {
    return defaultWorkbenchLayout;
  }
}

function readFallbackEditorState(projectRoot: string) {
  const storedState = window.localStorage.getItem(fallbackEditorStateKey);

  if (storedState === null) {
    return {
      projectRoot,
      openFilePaths: []
    };
  }

  try {
    const stateByRoot = JSON.parse(storedState) as Record<string, unknown>;
    const state = stateByRoot[projectRoot] as
      | { readonly openFilePaths?: readonly string[]; readonly activeFilePath?: string }
      | undefined;
    const openFilePaths = Array.isArray(state?.openFilePaths)
      ? state.openFilePaths.filter((path): path is string => typeof path === "string")
      : [];

    return state?.activeFilePath === undefined
      ? { projectRoot, openFilePaths }
      : { projectRoot, openFilePaths, activeFilePath: state.activeFilePath };
  } catch {
    return {
      projectRoot,
      openFilePaths: []
    };
  }
}

function readFallbackSettings(): AppSettings {
  const storedSettings = window.localStorage.getItem(fallbackSettingsKey);

  if (storedSettings === null) {
    return defaultAppSettings;
  }

  try {
    const parsed = JSON.parse(storedSettings) as Partial<AppSettings>;
    return {
      ...defaultAppSettings,
      ...parsed,
      editor: { ...defaultAppSettings.editor, ...parsed.editor },
      compiler: { ...defaultAppSettings.compiler, ...parsed.compiler },
      agentPermissions: {
        ...defaultAppSettings.agentPermissions,
        ...parsed.agentPermissions
      },
      appearance: { ...defaultAppSettings.appearance, ...parsed.appearance },
      updates: { ...defaultAppSettings.updates, ...parsed.updates },
      onlyOffice: { ...defaultAppSettings.onlyOffice, ...parsed.onlyOffice },
      privacy: { ...defaultAppSettings.privacy, ...parsed.privacy },
      credentials: defaultAppSettings.credentials
    };
  } catch {
    return defaultAppSettings;
  }
}

const fallbackApi: DesktopApi = {
  app: {
    getInfo: () =>
      Promise.resolve({
        appName: "ZeroLeaf",
        appVersion: "dev",
        platform: getBrowserPlatform(),
        isPackaged: false
      }),
    checkForUpdates: () =>
      Promise.resolve({
        checkedAt: new Date().toISOString(),
        currentVersion: "dev",
        state: "not-configured",
        message: "Update checks are unavailable in browser fallback."
      }),
    openUpdateDownload: () =>
      Promise.reject(new Error("Electron app update API unavailable.")),
    installUpdate: () =>
      Promise.reject(new Error("Electron app update install API unavailable.")),
    showMessageDialog: (request) => {
      const text = [request.message, request.detail].filter(Boolean).join("\n\n");
      const confirmed = window.confirm(text);
      const cancelId = request.cancelId ?? request.buttons.length - 1;
      return Promise.resolve({ buttonIndex: confirmed ? 0 : cancelId });
    }
  },
  workbench: {
    loadLayout: () => Promise.resolve(readFallbackLayout()),
    saveLayout: (layout) => {
      window.localStorage.setItem(fallbackLayoutKey, JSON.stringify(layout));
      return Promise.resolve(layout);
    }
  },
  editor: {
    loadProjectState: (projectRoot) =>
      Promise.resolve(readFallbackEditorState(projectRoot)),
    saveProjectState: (state) => {
      const storedState = window.localStorage.getItem(fallbackEditorStateKey);
      const stateByRoot =
        storedState === null
          ? {}
          : (JSON.parse(storedState) as Record<string, unknown>);
      window.localStorage.setItem(
        fallbackEditorStateKey,
        JSON.stringify({ ...stateByRoot, [state.projectRoot]: state })
      );
      return Promise.resolve(state);
    }
  },
  project: {
    getState: () => Promise.resolve({ recentProjects: [] }),
    open: () => Promise.resolve(undefined),
    openRecent: () => Promise.reject(new Error("Electron project API unavailable.")),
    clearRecent: () => Promise.resolve({ recentProjects: [] }),
    refresh: () => Promise.reject(new Error("Electron project API unavailable.")),
    createEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    renameEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    moveEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    deleteEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    setMainFile: () => Promise.reject(new Error("Electron project API unavailable.")),
    onChanged: () => () => undefined
  },
  shared: {
    getConnection: () => Promise.resolve({ connected: false }),
    signIn: () => Promise.reject(new Error("Electron shared project API unavailable.")),
    signOut: () => Promise.resolve({ connected: false }),
    listSessions: () => Promise.resolve([]),
    revokeSession: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listProjects: () => Promise.resolve([]),
    createProject: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    createFromLocalProject: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    createFromSourceZip: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    updateProjectSettings: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    deleteProject: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    exportSourceZip: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    openProject: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    invite: () => Promise.reject(new Error("Electron shared project API unavailable.")),
    acceptInvitation: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listMembers: () => Promise.resolve([]),
    updateMemberRole: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    transferOwnership: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    removeMember: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listPresence: () => Promise.resolve([]),
    updatePresence: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listActivity: () => Promise.resolve([]),
    listComments: () => Promise.resolve([]),
    createComment: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    resolveComment: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listAuditEvents: () => Promise.resolve([]),
    publishAgentRun: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    updateAgentRunStatus: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listAgentRuns: () => Promise.resolve([]),
    listAgentChangeSets: () => Promise.resolve([]),
    applyAgentChangeSet: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    rejectAgentChangeSet: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listBuildArtifacts: () => Promise.resolve([]),
    getBuildArtifact: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    publishBuildArtifact: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    attachAgentRunBuildArtifact: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    getFileRevision: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    listFileRevisions: () => Promise.resolve([]),
    getFileRevisionDetails: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    restoreFileRevision: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    syncDocumentContents: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    applyDocumentTextOperations: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    pullDocumentContents: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    startRealtime: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    stopRealtime: () =>
      Promise.reject(new Error("Electron shared project API unavailable.")),
    onRealtimeEvent: () => () => undefined
  },
  files: {
    read: () => Promise.reject(new Error("Electron file API unavailable.")),
    write: () => Promise.reject(new Error("Electron file API unavailable."))
  },
  word: {
    read: () => Promise.reject(new Error("Electron Word API unavailable.")),
    save: () => Promise.reject(new Error("Electron Word API unavailable.")),
    createChangeSet: () =>
      Promise.reject(new Error("Electron Word changeset API unavailable.")),
    applyChangeSet: () =>
      Promise.reject(new Error("Electron Word changeset API unavailable.")),
    rollbackChangeSet: () =>
      Promise.reject(new Error("Electron Word changeset API unavailable."))
  },
  onlyOffice: {
    getStatus: () =>
      Promise.resolve({
        configured: false,
        bridgeListening: false,
        documentServerReachable: false,
        documentServerUrl: "",
        message: "Electron ONLYOFFICE API unavailable."
      }),
    createSession: () =>
      Promise.reject(new Error("Electron ONLYOFFICE API unavailable.")),
    forceSave: () => Promise.reject(new Error("Electron ONLYOFFICE API unavailable.")),
    exportPdf: () => Promise.reject(new Error("Electron ONLYOFFICE API unavailable."))
  },
  build: {
    detectToolchain: () =>
      Promise.resolve({
        latexmkAvailable: false,
        synctexAvailable: false,
        availableCompilers: []
      }),
    run: () => Promise.reject(new Error("Electron build API unavailable.")),
    stop: () => Promise.resolve({ stopped: false })
  },
  pdf: {
    readArtifact: () => Promise.reject(new Error("Electron PDF API unavailable.")),
    reportPreviewBounds: () => Promise.resolve({ reported: false })
  },
  synctex: {
    forward: () =>
      Promise.resolve({
        available: false,
        message: "Electron SyncTeX API unavailable."
      }),
    reverse: () =>
      Promise.resolve({
        available: false,
        message: "Electron SyncTeX API unavailable."
      })
  },
  history: {
    listChangeSets: () => Promise.resolve([]),
    snapshotFile: () => Promise.reject(new Error("Electron history API unavailable.")),
    createChangeSet: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    createAppliedChangeSet: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    applyChangeSet: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    applyChangeSetHunks: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    rejectChangeSet: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    rollbackChangeSet: () =>
      Promise.reject(new Error("Electron history API unavailable.")),
    listWordChangeSets: () => Promise.resolve([]),
    createWordChangeSet: () =>
      Promise.reject(new Error("Electron Word history API unavailable.")),
    markWordChangeSetApplied: () =>
      Promise.reject(new Error("Electron Word history API unavailable.")),
    rejectWordChangeSet: () =>
      Promise.reject(new Error("Electron Word history API unavailable.")),
    listAuditEvents: () => Promise.resolve([])
  },
  references: {
    analyze: () =>
      Promise.resolve({
        entries: [],
        citations: [],
        missingCitations: [],
        unusedEntries: []
      }),
    search: () => Promise.resolve([]),
    removeUnused: () => Promise.reject(new Error("Electron reference API unavailable."))
  },
  lifecycle: {
    listTemplates: () =>
      Promise.resolve([
        {
          id: "article",
          name: "Article",
          description: "Compact scholarly article with bibliography."
        },
        {
          id: "report",
          name: "Report",
          description: "Structured technical report with chapters."
        },
        {
          id: "thesis",
          name: "Thesis",
          description: "Long-form thesis skeleton with front matter."
        },
        {
          id: "beamer",
          name: "Beamer",
          description: "Presentation slides using Beamer."
        },
        {
          id: "cv",
          name: "CV",
          description: "Academic CV template."
        }
      ]),
    exportSourceZip: () => Promise.resolve(undefined),
    exportPdf: () => Promise.resolve(undefined),
    importSourceZip: () => Promise.resolve(undefined),
    createForAgent: () => Promise.resolve(undefined),
    createFromTemplate: () => Promise.resolve(undefined),
    createFromExternalTemplate: () => Promise.resolve(undefined),
    checkSubmission: () =>
      Promise.resolve({
        checkedAt: new Date().toISOString(),
        items: [
          {
            severity: "warning",
            message: "Electron lifecycle API unavailable."
          }
        ]
      })
  },
  settings: {
    load: () => Promise.resolve(readFallbackSettings()),
    save: (settings) => {
      window.localStorage.setItem(
        fallbackSettingsKey,
        JSON.stringify({
          ...settings,
          credentials: defaultAppSettings.credentials
        })
      );
      return Promise.resolve({
        ...settings,
        credentials: defaultAppSettings.credentials
      });
    },
    getPrivacySummary: () =>
      Promise.resolve({
        dataLocation: "Browser local storage",
        projectCount: 0,
        snapshotCount: 0,
        changesetCount: 0,
        auditEventCount: 0,
        buildJobCount: 0,
        agentSessionCount: 0
      }),
    clearLocalHistory: () =>
      Promise.resolve({
        dataLocation: "Browser local storage",
        projectCount: 0,
        snapshotCount: 0,
        changesetCount: 0,
        auditEventCount: 0,
        buildJobCount: 0,
        agentSessionCount: 0
      })
  },
  agent: {
    getAuthStatus: (providerId) =>
      Promise.resolve({
        providerId,
        state: providerId === "mock" ? "connected" : "disconnected",
        message:
          providerId === "mock"
            ? "Mock provider is available in browser fallback."
            : "Electron agent host is unavailable."
      }),
    openProviderSetupTerminal: () =>
      Promise.reject(new Error("Electron terminal setup API unavailable.")),
    start: () => Promise.reject(new Error("Electron agent API unavailable.")),
    respondApproval: () => Promise.reject(new Error("Electron agent API unavailable.")),
    cancel: () => Promise.resolve({ cancelled: false }),
    onEvent: () => () => undefined
  }
};

export const desktopApi = window.latexAgent ?? fallbackApi;

export function hasOpenProject(
  project: ProjectOpenResult | undefined
): project is ProjectOpenResult {
  return project !== undefined;
}
