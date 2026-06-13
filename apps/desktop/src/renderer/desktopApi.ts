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
    return {
      ...defaultAppSettings,
      ...(JSON.parse(storedSettings) as Partial<AppSettings>),
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
      })
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
    refresh: () => Promise.reject(new Error("Electron project API unavailable.")),
    createEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    renameEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    moveEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    deleteEntry: () => Promise.reject(new Error("Electron project API unavailable.")),
    setMainFile: () => Promise.reject(new Error("Electron project API unavailable.")),
    onChanged: () => () => undefined
  },
  files: {
    read: () => Promise.reject(new Error("Electron file API unavailable.")),
    write: () => Promise.reject(new Error("Electron file API unavailable."))
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
    readArtifact: () => Promise.reject(new Error("Electron PDF API unavailable."))
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
    createFromTemplate: () => Promise.resolve(undefined),
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
        JSON.stringify({ ...settings, credentials: defaultAppSettings.credentials })
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
