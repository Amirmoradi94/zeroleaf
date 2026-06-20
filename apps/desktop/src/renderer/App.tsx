import type {
  CSSProperties,
  RefObject,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { Editor } from "@monaco-editor/react";
import type * as MonacoApi from "monaco-editor";
import type { editor as MonacoEditorApi, IPosition } from "monaco-editor";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { defaultAppSettings } from "@latex-agent/ipc-contracts";
import type {
  AgentAuthStatus,
  AgentEvent,
  AgentMode,
  AgentProviderId,
  AgentSelectionContext,
  AgentProviderSetupAction,
  AgentSessionResult,
  AgentToolCallEvent,
  AgentToolName,
  AppInfo,
  AppSettings,
  AppUpdateCheckResult,
  BibliographyEntry,
  BuildResult,
  AuditEvent,
  CitationOccurrence,
  ExternalProjectTemplateId,
  HistoryChangeSet,
  LatexCompiler,
  LatexDiagnostic,
  LatexToolchainStatus,
  PdfArtifactData,
  PrivacySummary,
  ProjectFileSnapshot,
  ProjectFileTreeNode,
  ProjectOpenResult,
  ProjectState,
  ProjectTemplate,
  ProjectTemplateId,
  ReferenceAnalysis,
  ReferenceSearchResult,
  RecentProject,
  SubmissionCheckResult,
  WorkbenchLayout
} from "@latex-agent/ipc-contracts";
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Command as CommandIcon,
  Copy,
  Download,
  FileText,
  FolderPlus,
  FolderOpen,
  MessageSquareText,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";

import {
  commandDefinitions,
  type CommandDefinition,
  type CommandId
} from "./commands.js";
import { IconButton } from "./components/IconButton.js";
import { PdfPane } from "./components/PdfPane.js";
import { desktopApi } from "./desktopApi.js";
import zeroleafMarkUrl from "./assets/zeroleaf-mark.png";
import { formatPdfStaleReason, type PdfStaleReason } from "./pdfPreviewModel.js";
import {
  buildProjectLatexOutline,
  clearLatexCompletionProject,
  createCitationCommand,
  createDiagnosticAgentPrompt,
  createFinalFormattingReviewPrompt,
  createNumberingMismatchAgentPrompt,
  createSelectionContextFromText,
  createLatexCompletionState,
  createReferenceEntryAgentPrompt,
  getEditableProjectFiles,
  getLanguageForPath,
  getLatexLabelReferences,
  groupMissingCitations,
  insertTextAtLineColumn,
  isEditableTextPath,
  latexSnippets,
  planEditorRestore,
  searchFileContents,
  shouldMarkPdfStaleForProjectChange,
  finishPdfPreviewBuild,
  startLatexCompletionProject,
  startPdfPreviewBuild,
  type LatexOutlineItem,
  type LatexOutlineSource,
  type ProjectSearchResult,
  updateLatexCompletionCitations,
  updateLatexCompletionLabels
} from "./editorModel.js";
import {
  initialWorkbenchLayout,
  clampPaneSizes,
  constrainWorkbenchLayoutToContentWidth,
  resizeWorkbenchPane,
  type ResizeTarget
} from "./layout.js";

type Monaco = typeof MonacoApi;
type MonacoStandaloneEditor = MonacoEditorApi.IStandaloneCodeEditor;

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const settingsTabs = [
  "Editor",
  "Compiler",
  "AI Providers",
  "Agent Permissions",
  "Appearance",
  "Updates",
  "Keybindings",
  "Privacy"
] as const;

type SettingsTab = (typeof settingsTabs)[number];
type BottomTab =
  | "Problems"
  | "References"
  | "Search"
  | "Outline"
  | "History"
  | "Log"
  | "Output";
type SidebarTab = "files" | "search" | "templates";

const INLINE_SELECTION_PROMPT_AUTO_OPEN_DELAY_MS = 450;
type AgentAuthStatusByProvider = Readonly<Record<AgentProviderId, AgentAuthStatus>>;
type SelectionAgentAction =
  | "explain"
  | "expand-notes"
  | "improve-academic-tone"
  | "shorten-abstract"
  | "rewrite";
type AgentLiveStatus = {
  readonly detail: string;
  readonly title: string;
  readonly tone: "idle" | "running" | "success" | "warning" | "danger";
};
type NoProjectAgentCommand = {
  readonly kind: "create-project";
  readonly projectName: string;
  readonly templateId: ProjectTemplateId;
};
type ExternalTemplateAgentCommand = {
  readonly kind: "create-external-template-project";
  readonly projectName: string;
  readonly templateId: ExternalProjectTemplateId;
};
type AgentEventTone = "neutral" | "running" | "success" | "warning" | "danger";
type AgentThreadItem =
  | {
      readonly type: "user";
      readonly event: AgentEvent & { readonly type: "message"; readonly role: "user" };
    }
  | {
      readonly type: "assistant-run";
      readonly sessionId: string;
      readonly createdAt: string;
      readonly events: readonly AgentEvent[];
    };
type AgentRichTextBlock =
  | {
      readonly type: "paragraph";
      readonly lines: readonly string[];
    }
  | {
      readonly type: "code-block";
      readonly code: string;
      readonly language: string | null;
    }
  | {
      readonly type: "ordered-list";
      readonly items: readonly string[];
    }
  | {
      readonly type: "unordered-list";
      readonly items: readonly string[];
    }
  | {
      readonly type: "table";
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

type InlineSelectionPromptState = {
  readonly action: SelectionAgentAction;
  readonly left: number;
  readonly open: boolean;
  readonly prompt: string;
  readonly selectionContext: AgentSelectionContext | null;
  readonly selectedText: string;
  readonly top: number;
};

const agentProviderIds = [
  "mock",
  "openai-codex",
  "anthropic-claude"
] as const satisfies readonly AgentProviderId[];
const agentHistoryStorageKey = "zeroleaf-agent-history";
const agentProviderStorageKey = "zeroleaf-agent-provider";

const emptyReferenceAnalysis: ReferenceAnalysis = {
  entries: [],
  citations: [],
  missingCitations: [],
  unusedEntries: []
};

type EditorFileState = ProjectFileSnapshot & {
  readonly savedContents: string;
  readonly stale: boolean;
};

type SavedEditorFile = {
  readonly file: EditorFileState;
  readonly changeset?: HistoryChangeSet;
};

type PdfSearchMatch = {
  readonly page: number;
  readonly matchIndex: number;
};

type ChangeSetVerificationStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

type ChangeSetVerification = {
  readonly status: ChangeSetVerificationStatus;
  readonly summary: string;
  readonly buildJobId?: string;
  readonly finishedAt?: string;
};

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [layout, setLayout] = useState<WorkbenchLayout>(initialWorkbenchLayout);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [projectState, setProjectState] = useState<ProjectState>({
    recentProjects: []
  });
  const [projectResult, setProjectResult] = useState<ProjectOpenResult | null>(null);
  const [openFiles, setOpenFiles] = useState<readonly EditorFileState[]>([]);
  const [outlineFiles, setOutlineFiles] = useState<readonly LatexOutlineSource[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [selectedProjectDirectoryPath, setSelectedProjectDirectoryPath] = useState(".");
  const [selectedProjectEntryPath, setSelectedProjectEntryPath] = useState<
    string | null
  >(null);
  const [pendingRevealLine, setPendingRevealLine] = useState<number | null>(null);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [projectSearchResults, setProjectSearchResults] = useState<
    readonly ProjectSearchResult[]
  >([]);
  const [referenceAnalysis, setReferenceAnalysis] =
    useState<ReferenceAnalysis>(emptyReferenceAnalysis);
  const [referenceSearchQuery, setReferenceSearchQuery] = useState("");
  const [referenceSearchResults, setReferenceSearchResults] = useState<
    readonly ReferenceSearchResult[]
  >([]);
  const [referenceMessage, setReferenceMessage] = useState(
    "Open a project to scan references."
  );
  const [projectTemplates, setProjectTemplates] = useState<readonly ProjectTemplate[]>(
    []
  );
  const [selectedTemplateId, setSelectedTemplateId] =
    useState<ProjectTemplateId>("article");
  const [templateProjectName, setTemplateProjectName] = useState("article");
  const [submissionCheckResult, setSubmissionCheckResult] =
    useState<SubmissionCheckResult | null>(null);
  const [toolchainStatus, setToolchainStatus] = useState<LatexToolchainStatus | null>(
    null
  );
  const [selectedCompiler, setSelectedCompiler] = useState<LatexCompiler>("pdflatex");
  const [buildRunning, setBuildRunning] = useState(false);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [activeBuildJobId, setActiveBuildJobId] = useState<string | null>(null);
  const [pdfArtifactData, setPdfArtifactData] = useState<PdfArtifactData | null>(null);
  const [pdfStale, setPdfStale] = useState(false);
  const [pdfStaleReason, setPdfStaleReason] = useState<PdfStaleReason | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfSearchQuery, setPdfSearchQuery] = useState("");
  const [pdfSearchMatches, setPdfSearchMatches] = useState<readonly PdfSearchMatch[]>(
    []
  );
  const [pdfSearchActiveIndex, setPdfSearchActiveIndex] = useState(-1);
  const [pdfSearchMatchQuery, setPdfSearchMatchQuery] = useState("");
  const [syncTexMessage, setSyncTexMessage] = useState("SyncTeX unavailable");
  const [syncTexTarget, setSyncTexTarget] = useState<{
    readonly page: number;
    readonly x?: number;
    readonly y?: number;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState("No project opened");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("Editor");
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [updateCheckResult, setUpdateCheckResult] =
    useState<AppUpdateCheckResult | null>(null);
  const [updateCheckRunning, setUpdateCheckRunning] = useState(false);
  const [updateInstallRunning, setUpdateInstallRunning] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>("files");
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [privacySummary, setPrivacySummary] = useState<PrivacySummary | null>(null);
  const [keybindingQuery, setKeybindingQuery] = useState("");
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTab>("Problems");
  const [commandQuery, setCommandQuery] = useState("");
  const [historyChangeSets, setHistoryChangeSets] = useState<
    readonly HistoryChangeSet[]
  >([]);
  const [acceptedHunkIndexesByChangeSet, setAcceptedHunkIndexesByChangeSet] = useState<
    Readonly<Record<string, readonly number[]>>
  >({});
  const [changeSetVerifications, setChangeSetVerifications] = useState<
    Readonly<Record<string, ChangeSetVerification>>
  >({});
  const [auditEvents, setAuditEvents] = useState<readonly AuditEvent[]>([]);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [historyMessage, setHistoryMessage] = useState("No history action yet.");
  const [agentProviderId, setAgentProviderId] = useState<AgentProviderId>(() =>
    readStoredAgentProvider(defaultAppSettings.agentPermissions.defaultProviderId)
  );
  const [agentMode, setAgentMode] = useState<AgentMode>(
    defaultAppSettings.agentPermissions.defaultMode
  );
  const [agentAuthStatuses, setAgentAuthStatuses] = useState<AgentAuthStatusByProvider>(
    () => createInitialAgentAuthStatuses()
  );
  const [agentAuthRefreshRunning, setAgentAuthRefreshRunning] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentSelectedText, setAgentSelectedText] = useState<string | null>(null);
  const [activeAgentSelectionContext, setActiveAgentSelectionContext] =
    useState<AgentSelectionContext | null>(null);
  const [inlineSelectionPrompt, setInlineSelectionPrompt] =
    useState<InlineSelectionPromptState>({
      action: "rewrite",
      left: 0,
      open: false,
      prompt: "",
      selectionContext: null,
      selectedText: "",
      top: 0
    });
  const [agentEvents, setAgentEvents] = useState<readonly AgentEvent[]>(() =>
    readStoredAgentHistory()
  );
  const [agentLiveStatus, setAgentLiveStatus] = useState<AgentLiveStatus | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const [agentSessionProjectRoot, setAgentSessionProjectRoot] = useState<string | null>(
    null
  );
  const [agentSessionProviderId, setAgentSessionProviderId] =
    useState<AgentProviderId | null>(null);
  const agentComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineSelectionPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineSelectionPromptRepositionRafRef = useRef<ReturnType<
    typeof requestAnimationFrame
  > | null>(null);
  const editorLayoutRafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(
    null
  );
  const editorResizeObserverRef = useRef<ResizeObserver | null>(null);
  const contentRowRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<MonacoStandaloneEditor | null>(null);
  const pdfCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const selectionChangeSubscriptionRef = useRef<{ dispose: () => void } | null>(null);
  const editorSelectionPointerListenersRef = useRef<{ dispose: () => void } | null>(
    null
  );
  const editorSelectionPointerDownRef = useRef(false);
  const editorSelectionPendingAfterPointerUpRef = useRef(false);
  const selectionPromptOpenTimeoutRef = useRef<
    number | ReturnType<typeof setTimeout> | null
  >(null);
  const appWrittenProjectPathsRef = useRef<Set<string>>(new Set());

  const scheduleEditorLayout = useCallback(() => {
    if (editorLayoutRafRef.current !== null) {
      window.cancelAnimationFrame(editorLayoutRafRef.current);
    }

    editorLayoutRafRef.current = window.requestAnimationFrame(() => {
      layoutMonacoEditorToContainer(editorRef.current);
      editorLayoutRafRef.current = window.requestAnimationFrame(() => {
        layoutMonacoEditorToContainer(editorRef.current);
        editorLayoutRafRef.current = null;
      });
    });
  }, []);

  useEffect(() => {
    return () => {
      selectionChangeSubscriptionRef.current?.dispose();
      editorSelectionPointerListenersRef.current?.dispose();
      editorSelectionPointerListenersRef.current = null;
      if (selectionPromptOpenTimeoutRef.current !== null) {
        window.clearTimeout(selectionPromptOpenTimeoutRef.current);
        selectionPromptOpenTimeoutRef.current = null;
      }
      if (inlineSelectionPromptRepositionRafRef.current !== null) {
        window.cancelAnimationFrame(inlineSelectionPromptRepositionRafRef.current);
        inlineSelectionPromptRepositionRafRef.current = null;
      }
      if (editorLayoutRafRef.current !== null) {
        window.cancelAnimationFrame(editorLayoutRafRef.current);
        editorLayoutRafRef.current = null;
      }
      editorResizeObserverRef.current?.disconnect();
      editorResizeObserverRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    scheduleEditorLayout();

    return () => {
      if (editorLayoutRafRef.current !== null) {
        window.cancelAnimationFrame(editorLayoutRafRef.current);
        editorLayoutRafRef.current = null;
      }
    };
  }, [
    bottomPanelOpen,
    layout.agentWidth,
    layout.bottomPanelHeight,
    layout.pdfWidth,
    layout.sidebarWidth,
    scheduleEditorLayout
  ]);

  const refreshAgentAuthStatuses = useCallback(
    async ({ silent = false }: { readonly silent?: boolean } = {}) => {
      if (!silent) {
        setStatusMessage("Checking AI provider status...");
      }
      setAgentAuthRefreshRunning(true);

      try {
        const statuses = await Promise.all(
          agentProviderIds.map(async (providerId) => {
            try {
              return await desktopApi.agent.getAuthStatus(providerId);
            } catch (error) {
              return {
                providerId,
                state: "error" as const,
                message: getErrorMessage(error)
              };
            }
          })
        );

        setAgentAuthStatuses(
          statuses.reduce<AgentAuthStatusByProvider>(
            (nextStatuses, status) => ({
              ...nextStatuses,
              [status.providerId]: status
            }),
            createInitialAgentAuthStatuses()
          )
        );

        if (!silent) {
          const connectedProviderLabels = statuses
            .filter((status) => status.state === "connected")
            .map((status) => getAgentProviderLabel(status.providerId));
          const errorStatus = statuses.find((status) => status.state === "error");

          if (errorStatus !== undefined) {
            setStatusMessage(
              `${getAgentProviderLabel(errorStatus.providerId)} status check failed: ${errorStatus.message ?? "Unknown error"}`
            );
          } else if (connectedProviderLabels.length > 0) {
            setStatusMessage(
              `Provider status refreshed: ${connectedProviderLabels.join(", ")} connected.`
            );
          } else {
            setStatusMessage(
              "Provider status refreshed. No provider is connected yet."
            );
          }
        }
      } finally {
        setAgentAuthRefreshRunning(false);
      }
    },
    []
  );

  const installUpdate = useCallback(async (url: string) => {
    setUpdateInstallRunning(true);
    setStatusMessage("Downloading and installing the ZeroLeaf update...");
    try {
      const result = await desktopApi.app.installUpdate(url);
      setStatusMessage(result.message);
      return result;
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
      throw error;
    } finally {
      setUpdateInstallRunning(false);
    }
  }, []);

  const checkForAppUpdates = useCallback(async () => {
    setUpdateCheckRunning(true);
    try {
      const result = await desktopApi.app.checkForUpdates();
      setUpdateCheckResult(result);
      if (result.state === "available") {
        setStatusMessage(
          `ZeroLeaf ${result.latestVersion} is available. Installing...`
        );
        if (result.downloadUrl !== undefined) {
          void installUpdate(result.downloadUrl);
        }
      } else if (result.state === "error") {
        setStatusMessage(result.message);
      }
      return result;
    } catch (error) {
      const result: AppUpdateCheckResult = {
        checkedAt: new Date().toISOString(),
        currentVersion: "unknown",
        state: "error",
        message: getErrorMessage(error)
      };
      setUpdateCheckResult(result);
      setStatusMessage(result.message);
      return result;
    } finally {
      setUpdateCheckRunning(false);
    }
  }, [installUpdate]);

  const openUpdateDownload = useCallback(async (url: string) => {
    try {
      await desktopApi.app.openUpdateDownload(url);
      setStatusMessage("Opened ZeroLeaf update download in your browser.");
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }, []);

  const openProviderSetupTerminal = useCallback(
    async (providerId: AgentProviderId, action: AgentProviderSetupAction) => {
      try {
        const result = await desktopApi.agent.openProviderSetupTerminal(
          providerId,
          action
        );
        setStatusMessage(
          `Opened Terminal for ${getAgentProviderLabel(providerId)} ${action}.`
        );

        if (result.action === "login") {
          window.setTimeout(() => {
            void refreshAgentAuthStatuses({ silent: true });
          }, 1000);
        }
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
      }
    },
    [refreshAgentAuthStatuses]
  );

  const refreshToolchainStatus = useCallback(async () => {
    const status = await desktopApi.build.detectToolchain();
    setToolchainStatus(status);
    return status;
  }, []);

  useEffect(() => {
    void desktopApi.app.getInfo().then(setAppInfo);
    void desktopApi.project.getState().then(setProjectState);
    void desktopApi.workbench.loadLayout().then((loadedLayout) => {
      setLayout(loadedLayout);
      setLayoutLoaded(true);
    });
    void desktopApi.settings.load().then((settings) => {
      setAppSettings(settings);
      setSelectedCompiler(settings.compiler.compiler);
      setAgentProviderId(
        readStoredAgentProvider(settings.agentPermissions.defaultProviderId)
      );
      setAgentMode(settings.agentPermissions.defaultMode);
      if (settings.updates.checkOnStartup) {
        void checkForAppUpdates();
      }
    });
    void desktopApi.lifecycle.listTemplates().then(setProjectTemplates);
    void desktopApi.settings.getPrivacySummary().then(setPrivacySummary);
    void refreshToolchainStatus();
    void refreshAgentAuthStatuses({ silent: true });
  }, [checkForAppUpdates, refreshAgentAuthStatuses, refreshToolchainStatus]);

  useEffect(() => {
    return desktopApi.agent.onEvent((event) => {
      setAgentEvents((events) => mergeAgentThreadEvents([...events, event]));

      const liveStatus = createAgentLiveStatusFromEvent(event);
      if (liveStatus !== undefined) {
        setAgentLiveStatus(liveStatus);
      }
    });
  }, []);

  useEffect(() => {
    writeStoredAgentHistory(agentEvents);
  }, [agentEvents]);

  useEffect(() => {
    if (!layoutLoaded) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      void desktopApi.workbench.saveLayout(layout);
    }, 180);

    return () => window.clearTimeout(saveTimer);
  }, [layout, layoutLoaded]);

  useEffect(() => {
    if (toolchainStatus === null) {
      return;
    }

    setSyncTexMessage(
      toolchainStatus.synctexAvailable ? "" : "SyncTeX command missing"
    );
  }, [toolchainStatus]);

  const currentProject = projectResult?.project;
  const toolchainIssue = useMemo(
    () =>
      toolchainStatus === null
        ? undefined
        : getToolchainSetupIssue(toolchainStatus, selectedCompiler),
    [selectedCompiler, toolchainStatus]
  );
  const compileUnavailable = toolchainStatus === null || toolchainIssue !== undefined;

  const updateAppSettings = useCallback(
    (updater: (settings: AppSettings) => AppSettings) => {
      setAppSettings((currentSettings) => {
        const nextSettings = updater(currentSettings);
        void desktopApi.settings
          .save(nextSettings)
          .then(setAppSettings)
          .catch((error) => {
            setStatusMessage(`Could not save settings: ${getErrorMessage(error)}`);
          });
        return nextSettings;
      });
    },
    []
  );

  const updateSelectedCompiler = useCallback(
    (compiler: LatexCompiler) => {
      setSelectedCompiler(compiler);
      updateAppSettings((settings) => ({
        ...settings,
        compiler: {
          ...settings.compiler,
          compiler
        }
      }));
    },
    [updateAppSettings]
  );

  const updateAgentProviderId = useCallback(
    (providerId: AgentProviderId) => {
      setAgentProviderId(providerId);
      writeStoredAgentProvider(providerId);
      void refreshAgentAuthStatuses({ silent: true });
      updateAppSettings((settings) => ({
        ...settings,
        agentPermissions: {
          ...settings.agentPermissions,
          defaultProviderId: providerId
        }
      }));
    },
    [refreshAgentAuthStatuses, updateAppSettings]
  );

  const clearAgentHistory = useCallback(() => {
    setAgentEvents([]);
    setAgentLiveStatus(null);
    setAgentSessionId(null);
    setAgentSessionProjectRoot(null);
    setAgentSessionProviderId(null);
    setActiveAgentSelectionContext(null);
    setStatusMessage("Agent transcript cleared.");
  }, []);

  const updateAgentMode = useCallback(
    (mode: AgentMode) => {
      setAgentMode(mode);
      updateAppSettings((settings) => ({
        ...settings,
        agentPermissions: {
          ...settings.agentPermissions,
          defaultMode: mode
        }
      }));
    },
    [updateAppSettings]
  );

  const refreshPrivacySummary = useCallback(async () => {
    setPrivacySummary(await desktopApi.settings.getPrivacySummary());
  }, []);

  const clearLocalHistory = useCallback(() => {
    void desktopApi.settings.clearLocalHistory().then((summary) => {
      setPrivacySummary(summary);
      setHistoryChangeSets([]);
      setAcceptedHunkIndexesByChangeSet({});
      setChangeSetVerifications({});
      setAuditEvents([]);
      setSelectedChangeSetId(null);
      setHistoryMessage("Local history cleared.");
    });
  }, []);
  const activeFile =
    activeFilePath === null
      ? null
      : (openFiles.find((file) => file.path === activeFilePath) ?? null);
  const activeFileDirty =
    activeFile !== null && activeFile.contents !== activeFile.savedContents;
  const dirtyFiles = openFiles.filter((file) => file.contents !== file.savedContents);
  const editableProjectFiles = useMemo(
    () => getEditableProjectFiles(projectResult?.tree ?? []),
    [projectResult]
  );
  const outlineSources = useMemo(() => {
    const sourcesByPath = new Map(
      outlineFiles.map((file) => [file.path, file] as const)
    );

    for (const file of openFiles) {
      if (getLanguageForPath(file.path) === "latex") {
        sourcesByPath.set(file.path, {
          path: file.path,
          contents: file.contents
        });
      }
    }

    return Array.from(sourcesByPath.values());
  }, [openFiles, outlineFiles]);
  const projectOutline = useMemo(
    () =>
      buildProjectLatexOutline({
        files: outlineSources,
        mainFilePath: currentProject?.mainFilePath ?? activeFile?.path
      }),
    [activeFile, currentProject, outlineSources]
  );

  useEffect(() => {
    if (currentProject === undefined) {
      updateMonacoLabelCompletions(null, []);
      return;
    }

    updateMonacoLabelCompletions(
      currentProject.rootPath,
      getLatexLabelReferences(projectOutline)
    );
  }, [currentProject, projectOutline]);

  useEffect(() => {
    if (currentProject === undefined) {
      setOutlineFiles([]);
      return;
    }

    let cancelled = false;
    const texFiles = editableProjectFiles
      .filter((file) => getLanguageForPath(file.path) === "latex")
      .slice(0, 500);

    void Promise.all(
      texFiles.map(async (file) => {
        const snapshot = await readProjectFileForRoot(
          currentProject.rootPath,
          file.path
        );
        return {
          path: snapshot.path,
          contents: snapshot.contents
        };
      })
    )
      .then((files) => {
        if (!cancelled) {
          setOutlineFiles(files);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatusMessage(`Could not refresh outline: ${getErrorMessage(error)}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentProject, editableProjectFiles]);

  const closeProject = useCallback(() => {
    if (buildRunning) {
      setStatusMessage("Stop the active compile before closing the project.");
      return;
    }

    if (
      dirtyFiles.length > 0 &&
      !window.confirm("Close project and discard unsaved changes?")
    ) {
      return;
    }

    setProjectResult(null);
    setOpenFiles([]);
    setOutlineFiles([]);
    setActiveFilePath(null);
    setSelectedProjectDirectoryPath(".");
    setSelectedProjectEntryPath(null);
    setPendingRevealLine(null);
    setProjectSearchQuery("");
    setProjectSearchResults([]);
    setReferenceAnalysis(emptyReferenceAnalysis);
    setReferenceSearchQuery("");
    setReferenceSearchResults([]);
    setReferenceMessage("Open a project to scan references.");
    clearMonacoProjectCompletions();
    setSubmissionCheckResult(null);
    setBuildResult(null);
    setActiveBuildJobId(null);
    setPdfArtifactData(null);
    setPdfStale(false);
    setPdfStaleReason(null);
    setPdfPageNumber(1);
    setPdfPageCount(0);
    setPdfSearchQuery("");
    setSyncTexMessage(
      toolchainStatus?.synctexAvailable === true ? "" : "SyncTeX unavailable"
    );
    setSyncTexTarget(null);
    setProjectError(null);
    setActiveBottomTab("Problems");
    setHistoryChangeSets([]);
    setAcceptedHunkIndexesByChangeSet({});
    setChangeSetVerifications({});
    setAuditEvents([]);
    setSelectedChangeSetId(null);
    setHistoryMessage("No history action yet.");
    setAgentEvents([]);
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setAgentSessionId(null);
    setAgentSessionProjectRoot(null);
    setAgentSessionProviderId(null);
    setStatusMessage("Project closed");
  }, [buildRunning, dirtyFiles.length, toolchainStatus]);

  const readProjectFile = useCallback(
    async (path: string, revealLine?: number) => {
      if (currentProject === undefined) {
        return;
      }

      const snapshot = await desktopApi.files.read({
        projectRoot: currentProject.rootPath,
        path
      });
      setOpenFiles((files) =>
        upsertOpenFile(files, {
          ...snapshot,
          savedContents: snapshot.contents,
          stale: false
        })
      );
      setActiveFilePath(snapshot.path);
      setPendingRevealLine(revealLine ?? null);
      setStatusMessage(`Opened ${snapshot.path}`);
    },
    [currentProject]
  );

  const loadProjectEditorState = useCallback(
    async (
      result: ProjectOpenResult,
      preferredFilePath?: string
    ): Promise<{
      readonly files: readonly EditorFileState[];
      readonly activePath: string | null;
    }> => {
      const savedState = await desktopApi.editor.loadProjectState(
        result.project.rootPath
      );
      const availablePaths = new Set(
        getEditableProjectFiles(result.tree).map((file) => file.path)
      );
      const restorePlan = planEditorRestore({
        availablePaths,
        savedState,
        mainFilePath: result.project.mainFilePath,
        preferredFilePath
      });

      const snapshots = await Promise.all(
        restorePlan.filePaths.map((path) =>
          readProjectFileForRoot(result.project.rootPath, path)
        )
      );
      const files = snapshots.map((snapshot) => ({
        ...snapshot,
        savedContents: snapshot.contents,
        stale: false
      }));

      return {
        files,
        activePath: restorePlan.activeFilePath ?? null
      };
    },
    []
  );

  const applyProjectResult = useCallback(
    async (result: ProjectOpenResult, preferredFilePath?: string) => {
      const projectChanged = currentProject?.rootPath !== result.project.rootPath;

      setMonacoCompletionProject(result.project.rootPath);
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setProjectError(null);
      setStatusMessage(`Opened ${result.project.displayName}`);
      if (projectChanged) {
        setAgentEvents([]);
        setAgentSelectedText(null);
        setActiveAgentSelectionContext(null);
        setAgentSessionId(null);
        setAgentSessionProjectRoot(null);
        setAgentSessionProviderId(null);
      }

      const editorState = await loadProjectEditorState(result, preferredFilePath);
      setOpenFiles(editorState.files);
      setActiveFilePath(editorState.activePath);
      setSelectedProjectDirectoryPath(getProjectDirectoryPath(editorState.activePath));
      setSelectedProjectEntryPath(editorState.activePath);
      setPendingRevealLine(null);
    },
    [currentProject?.rootPath, loadProjectEditorState]
  );

  const showErrorInTerminal = useCallback(
    (message: string) => {
      setProjectError(message);
      setBuildResult(
        createSetupFailureBuildResult(crypto.randomUUID(), selectedCompiler, message)
      );
      setBottomPanelOpen(true);
      setActiveBottomTab("Log");
    },
    [selectedCompiler]
  );

  const runProjectOperation = useCallback(
    async (operation: () => Promise<void>) => {
      try {
        setProjectError(null);
        await operation();
      } catch (error) {
        showErrorInTerminal(getErrorMessage(error));
      }
    },
    [showErrorInTerminal]
  );

  const refreshHistory = useCallback(async () => {
    if (currentProject === undefined) {
      setHistoryChangeSets([]);
      setAcceptedHunkIndexesByChangeSet({});
      setAuditEvents([]);
      setSelectedChangeSetId(null);
      return;
    }

    const [changeSets, events] = await Promise.all([
      desktopApi.history.listChangeSets({ projectRoot: currentProject.rootPath }),
      desktopApi.history.listAuditEvents({ projectRoot: currentProject.rootPath })
    ]);
    setHistoryChangeSets(changeSets);
    setAcceptedHunkIndexesByChangeSet((acceptedByChangeSet) => {
      const changesetIds = new Set(changeSets.map((changeSet) => changeSet.id));
      return Object.fromEntries(
        Object.entries(acceptedByChangeSet).filter(([changesetId]) =>
          changesetIds.has(changesetId)
        )
      );
    });
    setChangeSetVerifications((verifications) => {
      const changesetIds = new Set(changeSets.map((changeSet) => changeSet.id));
      return Object.fromEntries(
        Object.entries(verifications).filter(([changesetId]) =>
          changesetIds.has(changesetId)
        )
      );
    });
    setAuditEvents(events);
    setSelectedChangeSetId((selectedId) => {
      if (
        selectedId !== null &&
        changeSets.some((changeSet) => changeSet.id === selectedId)
      ) {
        return selectedId;
      }

      return changeSets[0]?.id ?? null;
    });
  }, [currentProject]);

  const refreshReferences = useCallback(async () => {
    if (currentProject === undefined) {
      setReferenceAnalysis(emptyReferenceAnalysis);
      setReferenceSearchResults([]);
      setReferenceMessage("Open a project to scan references.");
      clearMonacoProjectCompletions();
      return;
    }

    const projectRoot = currentProject.rootPath;
    const analysis = await desktopApi.references.analyze({
      projectRoot
    });
    setReferenceAnalysis(analysis);
    setReferenceMessage(
      `${analysis.entries.length} references · ${analysis.missingCitations.length} missing · ${analysis.unusedEntries.length} unused`
    );
    updateMonacoCitationCompletions(projectRoot, analysis.entries);
  }, [currentProject]);

  const openProject = useCallback(() => {
    void runProjectOperation(async () => {
      const result = await desktopApi.project.open();
      if (result !== undefined) {
        await applyProjectResult(result);
      }
    });
  }, [applyProjectResult, runProjectOperation]);

  const openRecentProject = useCallback(
    (rootPath: string) => {
      void runProjectOperation(async () => {
        await applyProjectResult(await desktopApi.project.openRecent(rootPath));
      });
    },
    [applyProjectResult, runProjectOperation]
  );

  const refreshProjectTree = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      const result = await desktopApi.project.refresh(currentProject.rootPath);
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setStatusMessage(`Refreshed ${result.project.displayName}`);
    });
  }, [currentProject, runProjectOperation]);

  const importSourceZip = useCallback(() => {
    void runProjectOperation(async () => {
      const result = await desktopApi.lifecycle.importSourceZip();
      if (result !== undefined) {
        await applyProjectResult(result);
        setStatusMessage(`Imported ${result.project.displayName}`);
      }
    });
  }, [applyProjectResult, runProjectOperation]);

  const createProjectFromSelectedTemplate = useCallback(() => {
    void runProjectOperation(async () => {
      const projectName = templateProjectName.trim();

      if (projectName.length === 0) {
        setStatusMessage("Enter a project name before creating a template project.");
        return;
      }

      const result = await desktopApi.lifecycle.createFromTemplate({
        templateId: selectedTemplateId,
        projectName
      });
      if (result !== undefined) {
        await applyProjectResult(result, result.project.mainFilePath);
        setStatusMessage(`Created ${result.project.displayName}`);
      }
    });
  }, [
    applyProjectResult,
    runProjectOperation,
    selectedTemplateId,
    templateProjectName
  ]);

  const changeSelectedTemplate = useCallback(
    (templateId: ProjectTemplateId) => {
      const currentDefaultName = getDefaultProjectNameForTemplate(
        projectTemplates,
        selectedTemplateId
      );
      const nextDefaultName = getDefaultProjectNameForTemplate(
        projectTemplates,
        templateId
      );

      setSelectedTemplateId(templateId);
      setTemplateProjectName((currentName) =>
        currentName.trim().length === 0 || currentName === currentDefaultName
          ? nextDefaultName
          : currentName
      );
    },
    [projectTemplates, selectedTemplateId]
  );

  const runNoProjectAgentCommand = useCallback(
    async (prompt: string, command: NoProjectAgentCommand) => {
      const sessionId = `agent-session-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const userEvent = buildAgentMessageEvent({
        content: prompt,
        role: "user",
        sessionId
      });
      const templateName =
        projectTemplates.find((template) => template.id === command.templateId)?.name ??
        command.templateId;

      setAgentRunning(true);
      setAgentLiveStatus({
        detail: `Choose a destination folder for ${command.projectName}.`,
        title: "Creating project",
        tone: "running"
      });
      setStatusMessage(`Creating ${command.projectName}...`);

      try {
        const result = await desktopApi.lifecycle.createFromTemplate({
          projectName: command.projectName,
          templateId: command.templateId
        });

        if (result === undefined) {
          const assistantEvent = buildAgentMessageEvent({
            content: "Project creation was cancelled. No project was created.",
            role: "assistant",
            sessionId
          });
          setAgentEvents((events) =>
            mergeAgentThreadEvents([...events, userEvent, assistantEvent])
          );
          setAgentLiveStatus({
            detail: "No folder was selected.",
            title: "Project creation cancelled",
            tone: "warning"
          });
          setStatusMessage("Project creation cancelled.");
          return;
        }

        await applyProjectResult(result, result.project.mainFilePath);

        const assistantEvent = buildAgentMessageEvent({
          content: `Created **${result.project.displayName}** from the ${templateName} template and opened the main TeX file.`,
          role: "assistant",
          sessionId
        });
        setAgentEvents((events) =>
          mergeAgentThreadEvents([...events, userEvent, assistantEvent])
        );
        setAgentLiveStatus({
          detail: "The new project is open and ready for editing or compilation.",
          title: "Project created",
          tone: "success"
        });
        setStatusMessage(`Created ${result.project.displayName}`);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const assistantEvent = buildAgentMessageEvent({
          content: `Could not create **${command.projectName}**: ${errorMessage}`,
          role: "assistant",
          sessionId
        });
        setAgentEvents((events) =>
          mergeAgentThreadEvents([...events, userEvent, assistantEvent])
        );
        setAgentLiveStatus({
          detail: errorMessage,
          title: "Project creation failed",
          tone: "danger"
        });
        setStatusMessage("Project creation failed.");
      } finally {
        setAgentRunning(false);
      }
    },
    [applyProjectResult, projectTemplates]
  );

  const runExternalTemplateAgentCommand = useCallback(
    async (prompt: string, command: ExternalTemplateAgentCommand) => {
      const sessionId = `agent-session-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const userEvent = buildAgentMessageEvent({
        content: prompt,
        role: "user",
        sessionId
      });

      setAgentRunning(true);
      setAgentEvents((events) => mergeAgentThreadEvents([...events, userEvent]));
      setAgentLiveStatus({
        detail:
          "Preparing the project name, template source, and destination workflow.",
        title: "Understanding request",
        tone: "running"
      });
      setStatusMessage(`Creating ${command.projectName} from external template...`);

      try {
        setAgentLiveStatus({
          detail:
            "Fetching the IEEEtran journal skeleton from the official CTAN mirror redirect.",
          title: "Searching official sources",
          tone: "running"
        });
        const result = await desktopApi.lifecycle.createFromExternalTemplate({
          projectName: command.projectName,
          templateId: command.templateId
        });

        if (result === undefined) {
          const assistantEvent = buildAgentMessageEvent({
            content: "Project creation was cancelled. No project was created.",
            role: "assistant",
            sessionId
          });
          setAgentEvents((events) =>
            mergeAgentThreadEvents([...events, assistantEvent])
          );
          setAgentLiveStatus({
            detail: "No destination folder was selected.",
            title: "Project creation cancelled",
            tone: "warning"
          });
          setStatusMessage("Project creation cancelled.");
          return;
        }

        setAgentLiveStatus({
          detail:
            "Opening the new project and selecting the generated IEEE-style main file.",
          title: "Comparing with project",
          tone: "running"
        });
        await applyProjectResult(result, result.project.mainFilePath);

        const assistantEvent = buildAgentMessageEvent({
          content: [
            `Created **${result.project.displayName}** from the IEEE Systems Journal template workflow.`,
            `Opened **${result.project.mainFilePath}** in the project explorer and wrote the fetched IEEEtran journal skeleton into it.`,
            "Source used: https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/bare_jrnl.tex"
          ].join("\n\n"),
          role: "assistant",
          sessionId
        });
        setAgentEvents((events) => mergeAgentThreadEvents([...events, assistantEvent]));
        setAgentLiveStatus({
          detail:
            "The new project is open with the external IEEE template in main.tex.",
          title: "Final response",
          tone: "success"
        });
        setStatusMessage(`Created ${result.project.displayName}`);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const assistantEvent = buildAgentMessageEvent({
          content: `Could not create **${command.projectName}** from the external template: ${errorMessage}`,
          role: "assistant",
          sessionId
        });
        setAgentEvents((events) => mergeAgentThreadEvents([...events, assistantEvent]));
        setAgentLiveStatus({
          detail: errorMessage,
          title: "Template project failed",
          tone: "danger"
        });
        setStatusMessage("External template project creation failed.");
      } finally {
        setAgentRunning(false);
      }
    },
    [applyProjectResult]
  );

  const exportCurrentPdf = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || pdfArtifactData === null) {
        return;
      }

      if (
        pdfStale &&
        !window.confirm(
          `The current PDF preview is stale (${formatPdfStaleReason(
            pdfStaleReason
          ).toLowerCase()}). Export the last successful PDF anyway?`
        )
      ) {
        setStatusMessage("PDF export cancelled. Recompile first for a current PDF.");
        return;
      }

      const result = await desktopApi.lifecycle.exportPdf({
        projectRoot: currentProject.rootPath,
        pdfPath: pdfArtifactData.pdfPath
      });

      if (result !== undefined) {
        setStatusMessage(
          result.openedInViewer === false
            ? `Exported PDF to ${getBaseName(result.destinationPath)}. Could not open viewer: ${result.viewerOpenError ?? "Unknown error."}`
            : `Exported PDF to ${getBaseName(result.destinationPath)} and opened it in your default PDF viewer.`
        );
      }
    });
  }, [currentProject, pdfArtifactData, pdfStale, pdfStaleReason, runProjectOperation]);

  const runSubmissionCheck = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      const result = await desktopApi.lifecycle.checkSubmission({
        projectRoot: currentProject.rootPath,
        ...(currentProject.mainFilePath === undefined
          ? {}
          : { mainFilePath: currentProject.mainFilePath })
      });
      setSubmissionCheckResult(result);
      setActiveBottomTab("Output");
      setStatusMessage(
        `Submission check found ${result.items.filter((item) => item.severity !== "info").length} issues`
      );
    });
  }, [currentProject, runProjectOperation]);

  const askAgentForSubmissionChecklist = useCallback(() => {
    setAgentPrompt(
      createFinalFormattingReviewPrompt(
        buildResult,
        referenceAnalysis,
        submissionCheckResult
      )
    );
    setAgentMode("suggest");
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setActiveBottomTab("Output");
    agentComposerRef.current?.focus();
  }, [buildResult, referenceAnalysis, submissionCheckResult]);

  const askAgentForFigureNumberingMismatch = useCallback(() => {
    setAgentPrompt(createNumberingMismatchAgentPrompt());
    setAgentMode("suggest");
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setActiveBottomTab("Output");
    agentComposerRef.current?.focus();
  }, []);

  useEffect(() => {
    void runProjectOperation(refreshHistory);
  }, [refreshHistory, runProjectOperation]);

  useEffect(() => {
    void runProjectOperation(refreshReferences);
  }, [refreshReferences, runProjectOperation]);

  const selectFile = useCallback(
    (path: string) => {
      void runProjectOperation(async () => {
        setSelectedProjectEntryPath(path);
        setSelectedProjectDirectoryPath(getProjectDirectoryPath(path));

        if (!isEditableTextPath(path)) {
          setStatusMessage(`Selected ${path}`);
          return;
        }

        await readProjectFile(path);
      });
    },
    [readProjectFile, runProjectOperation]
  );

  const selectProjectDirectory = useCallback((path: string) => {
    setSelectedProjectDirectoryPath(path);
    setSelectedProjectEntryPath(path);
    setStatusMessage(`Selected ${path}`);
  }, []);

  const createManualSaveVerification = useCallback(
    (changeset: HistoryChangeSet): ChangeSetVerification => ({
      status: "pending",
      summary: `Saved edit captured locally. Review this diff, compile the project, or roll back ${changeset.filePath}.`
    }),
    []
  );

  const rememberManualSaveChangeSets = useCallback(
    (changesets: readonly HistoryChangeSet[]) => {
      if (changesets.length === 0) {
        return;
      }

      const selectedChangeSet = changesets.at(-1);
      setSelectedChangeSetId(selectedChangeSet?.id ?? null);
      setChangeSetVerifications((verifications) => ({
        ...verifications,
        ...Object.fromEntries(
          changesets.map((changeset) => [
            changeset.id,
            createManualSaveVerification(changeset)
          ])
        )
      }));
      setHistoryMessage(
        changesets.length === 1
          ? `Captured rollback diff for ${changesets[0]?.filePath ?? "saved file"}.`
          : `Captured rollback diffs for ${changesets.length} saved files.`
      );
    },
    [createManualSaveVerification]
  );

  const saveEditorFileWithLocalHistory = useCallback(
    async (file: EditorFileState): Promise<SavedEditorFile> => {
      if (currentProject === undefined) {
        throw new Error("Open a project before saving.");
      }

      const editorContents =
        file.path === activeFilePath
          ? (editorRef.current?.getValue() ?? file.contents)
          : file.contents;
      const fileToSave = {
        ...file,
        contents: editorContents
      };

      let result: Awaited<ReturnType<typeof desktopApi.files.write>>;
      try {
        result = await desktopApi.files.write({
          projectRoot: currentProject.rootPath,
          path: fileToSave.path,
          contents: fileToSave.contents
        });
      } catch (error) {
        throw new Error(`Could not save ${file.path}: ${getErrorMessage(error)}`);
      }

      const savedFile = {
        ...fileToSave,
        savedContents: fileToSave.contents,
        mtimeMs: result.mtimeMs,
        stale: false
      };

      if (fileToSave.contents === file.savedContents) {
        return { file: savedFile };
      }

      try {
        const changeset = await desktopApi.history.createAppliedChangeSet({
          projectRoot: currentProject.rootPath,
          filePath: file.path,
          beforeContents: file.savedContents,
          afterContents: fileToSave.contents,
          summary: `Manual save: ${file.path}`
        });
        return { file: savedFile, changeset };
      } catch (error) {
        setHistoryMessage(
          `Saved ${file.path}; history capture failed: ${getErrorMessage(error)}`
        );
        return { file: savedFile };
      }
    },
    [activeFilePath, currentProject]
  );

  const saveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      const saved = await saveEditorFileWithLocalHistory(activeFile);

      setOpenFiles((files) => replaceOpenFile(files, saved.file));
      appWrittenProjectPathsRef.current.add(normalizeProjectPath(activeFile.path));
      if (saved.changeset !== undefined) {
        rememberManualSaveChangeSets([saved.changeset]);
        await refreshHistory();
      }
      if (pdfArtifactData !== null && pdfStale) {
        setPdfStaleReason("saved");
      }
      setStatusMessage(
        saved.changeset === undefined
          ? `Saved ${activeFile.path}`
          : `Saved ${activeFile.path}; local history captured`
      );
      await refreshReferences();
    });
  }, [
    activeFile,
    currentProject,
    pdfArtifactData,
    pdfStale,
    refreshHistory,
    refreshReferences,
    rememberManualSaveChangeSets,
    runProjectOperation,
    saveEditorFileWithLocalHistory
  ]);

  const saveDirtyFiles = useCallback(async () => {
    if (currentProject === undefined || dirtyFiles.length === 0) {
      return 0;
    }

    const savedResults = await Promise.all(
      dirtyFiles.map((file) => saveEditorFileWithLocalHistory(file))
    );
    const savedFiles = savedResults.map((result) => result.file);
    const changesets = savedResults.flatMap((result) =>
      result.changeset === undefined ? [] : [result.changeset]
    );

    for (const file of savedFiles) {
      appWrittenProjectPathsRef.current.add(normalizeProjectPath(file.path));
    }
    if (changesets.length > 0) {
      rememberManualSaveChangeSets(changesets);
      await refreshHistory();
    }
    if (pdfArtifactData !== null && savedFiles.length > 0 && pdfStale) {
      setPdfStaleReason("saved");
    }

    setOpenFiles((files) =>
      savedFiles.reduce(
        (nextFiles, savedFile) => replaceOpenFile(nextFiles, savedFile),
        files
      )
    );
    await refreshReferences();
    return savedFiles.length;
  }, [
    currentProject,
    dirtyFiles,
    pdfArtifactData,
    pdfStale,
    refreshHistory,
    refreshReferences,
    rememberManualSaveChangeSets,
    saveEditorFileWithLocalHistory
  ]);

  const exportSourceArchive = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      await saveDirtyFiles();
      const includeBuildArtifacts = window.confirm(
        "Include generated build artifacts and cache files in this ZIP? Choose Cancel to export source only."
      );
      const result = await desktopApi.lifecycle.exportSourceZip({
        projectRoot: currentProject.rootPath,
        includeBuildArtifacts
      });

      if (result !== undefined) {
        setStatusMessage(
          `Exported ${result.fileCount} files to ${getBaseName(result.archivePath)}${result.includedBuildArtifacts ? " with build artifacts included." : "."}`
        );
      }
    });
  }, [currentProject, runProjectOperation, saveDirtyFiles]);

  const saveAllFiles = useCallback(() => {
    void runProjectOperation(async () => {
      const savedCount = await saveDirtyFiles();
      if (savedCount === 0) {
        return;
      }

      setStatusMessage(`Saved ${savedCount} files`);
    });
  }, [runProjectOperation, saveDirtyFiles]);

  const snapshotActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        setHistoryMessage("Open a file before creating a snapshot.");
        return;
      }

      const snapshot = await desktopApi.history.snapshotFile({
        projectRoot: currentProject.rootPath,
        filePath: activeFile.path,
        contents: activeFile.contents
      });
      setHistoryMessage(`Snapshotted ${snapshot.filePath}`);
      setActiveBottomTab("History");
      await refreshHistory();
    });
  }, [activeFile, currentProject, refreshHistory, runProjectOperation]);

  const createActiveFileChangeSet = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        setHistoryMessage("Open a file before creating a changeset.");
        return;
      }

      if (!activeFileDirty) {
        setHistoryMessage("Edit the active file before creating a changeset.");
        return;
      }

      const changeset = await desktopApi.history.createChangeSet({
        projectRoot: currentProject.rootPath,
        filePath: activeFile.path,
        beforeContents: activeFile.savedContents,
        afterContents: activeFile.contents,
        summary: `Review changes to ${activeFile.path}`
      });
      setHistoryMessage(`Created changeset for ${changeset.filePath}`);
      setSelectedChangeSetId(changeset.id);
      setChangeSetVerifications((verifications) => ({
        ...verifications,
        [changeset.id]: {
          status: "pending",
          summary: "Review the diff, then apply the patch to run compile verification."
        }
      }));
      setActiveBottomTab("History");
      await refreshHistory();
    });
  }, [
    activeFile,
    activeFileDirty,
    currentProject,
    refreshHistory,
    runProjectOperation
  ]);

  const verifyChangeSet = useCallback(
    async (changeset: HistoryChangeSet, operation: "apply" | "rollback" = "apply") => {
      const actionLabel = operation === "apply" ? "applying" : "rolling back";
      const statusLabel = operation === "apply" ? "Agent patch" : "Rollback";

      if (currentProject?.mainFilePath === undefined) {
        const summary = "Choose a main .tex file before compile verification.";
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changeset.id]: {
            status: "failed",
            summary,
            finishedAt: new Date().toISOString()
          }
        }));
        showErrorInTerminal(summary);
        return;
      }

      if (!appSettings.agentPermissions.compileAfterPatch) {
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changeset.id]: {
            status: "skipped",
            summary: "Compile-after-patch is disabled in Agent Permissions.",
            finishedAt: new Date().toISOString()
          }
        }));
        return;
      }

      const jobId = crypto.randomUUID();
      setChangeSetVerifications((verifications) => ({
        ...verifications,
        [changeset.id]: {
          status: "running",
          summary: `Compiling ${currentProject.mainFilePath} after ${actionLabel} ${changeset.filePath}.`,
          buildJobId: jobId
        }
      }));

      const currentToolchain = toolchainStatus ?? (await refreshToolchainStatus());
      const setupIssue = getToolchainSetupIssue(currentToolchain, selectedCompiler);

      if (setupIssue !== undefined) {
        const setupResult = createSetupFailureBuildResult(
          jobId,
          selectedCompiler,
          setupIssue
        );
        setBuildResult(setupResult);
        setActiveBottomTab("Log");
        showErrorInTerminal(setupIssue);
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changeset.id]: {
            status: "failed",
            summary: setupIssue,
            buildJobId: jobId,
            finishedAt: setupResult.finishedAt
          }
        }));
        return;
      }

      await saveDirtyFiles();
      setBuildRunning(true);
      setActiveBuildJobId(jobId);
      setBuildResult(null);
      const buildStartPreview = startPdfPreviewBuild({
        artifactData: pdfArtifactData,
        stale: pdfStale
      });
      setPdfArtifactData(buildStartPreview.artifactData);
      setPdfStale(buildStartPreview.stale);
      setStatusMessage("Compiling applied patch...");

      try {
        const result = await desktopApi.build.run({
          jobId,
          projectRoot: currentProject.rootPath,
          mainFilePath: currentProject.mainFilePath,
          compiler: selectedCompiler
        });

        setBuildResult(result);
        if (result.status !== "succeeded") {
          setBottomPanelOpen(true);
        }

        if (result.artifact !== undefined && result.status === "succeeded") {
          const artifactData = await desktopApi.pdf.readArtifact({
            projectRoot: currentProject.rootPath,
            pdfPath: result.artifact.pdfPath
          });
          const previewState = finishPdfPreviewBuild({
            state: buildStartPreview,
            result,
            artifactData
          });
          setPdfArtifactData(previewState.artifactData);
          setPdfStale(previewState.stale);
          setPdfStaleReason(null);
          setPdfPageNumber(1);
          setSyncTexMessage(
            result.artifact.synctexPath === undefined
              ? "SyncTeX unavailable for this build"
              : "SyncTeX ready"
          );
        } else {
          const previewState = finishPdfPreviewBuild({
            state: buildStartPreview,
            result
          });
          setPdfArtifactData(previewState.artifactData);
          setPdfStale(previewState.stale);
          if (previewState.stale && pdfStaleReason === null) {
            setPdfStaleReason("saved");
          }
        }

        setActiveBottomTab(result.status === "succeeded" ? "History" : "Log");
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changeset.id]: {
            status: result.status === "succeeded" ? "passed" : "failed",
            summary: `${statusLabel} compile verification ${result.status} with ${result.diagnostics.length} diagnostic${result.diagnostics.length === 1 ? "" : "s"}.`,
            buildJobId: result.jobId,
            finishedAt: result.finishedAt
          }
        }));
        setStatusMessage(
          result.status === "succeeded"
            ? `${statusLabel} compile verification passed.`
            : `${statusLabel} compile verification failed.`
        );
      } finally {
        setActiveBuildJobId(null);
        setBuildRunning(false);
      }
    },
    [
      appSettings.agentPermissions.compileAfterPatch,
      currentProject,
      pdfArtifactData,
      pdfStale,
      pdfStaleReason,
      refreshToolchainStatus,
      showErrorInTerminal,
      saveDirtyFiles,
      selectedCompiler,
      toolchainStatus
    ]
  );

  const applyChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const pendingChangeSet = historyChangeSets.find(
          (changeset) => changeset.id === changesetId
        );
        const diffHunks =
          pendingChangeSet === undefined
            ? []
            : parseUnifiedDiffHunks(pendingChangeSet.patch);
        const acceptedHunkIndexes =
          acceptedHunkIndexesByChangeSet[changesetId] ??
          diffHunks.map((hunk) => hunk.index);

        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changesetId]: {
            status: "running",
            summary:
              diffHunks.length > 1
                ? `Applying ${acceptedHunkIndexes.length} of ${diffHunks.length} accepted hunks before compile verification.`
                : "Applying approved patch before compile verification."
          }
        }));
        const changeset =
          diffHunks.length > 1
            ? await desktopApi.history.applyChangeSetHunks({
                changesetId,
                acceptedHunkIndexes
              })
            : await desktopApi.history.applyChangeSet(changesetId);
        setHistoryMessage(`Applied ${changeset.summary}; running verification.`);
        setSelectedChangeSetId(changeset.id);
        setActiveBottomTab("History");
        await readProjectFile(changeset.filePath);
        await refreshHistory();
        await verifyChangeSet(changeset);
      });
    },
    [
      acceptedHunkIndexesByChangeSet,
      historyChangeSets,
      readProjectFile,
      refreshHistory,
      runProjectOperation,
      verifyChangeSet
    ]
  );

  const rejectChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const changeset = await desktopApi.history.rejectChangeSet(changesetId);
        setHistoryMessage(`Rejected ${changeset.summary}`);
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changeset.id]: {
            status: "skipped",
            summary: "Rejected before apply; no files were changed.",
            finishedAt: new Date().toISOString()
          }
        }));
        await refreshHistory();
      });
    },
    [refreshHistory, runProjectOperation]
  );

  const setChangeSetHunkAccepted = useCallback(
    (changesetId: string, hunkIndex: number, accepted: boolean) => {
      const changeset = historyChangeSets.find(
        (candidate) => candidate.id === changesetId
      );

      if (changeset === undefined) {
        return;
      }

      const hunks = parseUnifiedDiffHunks(changeset.patch);
      const defaultAcceptedIndexes = hunks.map((hunk) => hunk.index);

      setAcceptedHunkIndexesByChangeSet((acceptedByChangeSet) => {
        const currentIndexes = new Set(
          acceptedByChangeSet[changesetId] ?? defaultAcceptedIndexes
        );

        if (accepted) {
          currentIndexes.add(hunkIndex);
        } else {
          currentIndexes.delete(hunkIndex);
        }

        return {
          ...acceptedByChangeSet,
          [changesetId]: [...currentIndexes].sort((left, right) => left - right)
        };
      });
    },
    [historyChangeSets]
  );

  const rollbackChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        setChangeSetVerifications((verifications) => ({
          ...verifications,
          [changesetId]: {
            status: "running",
            summary: "Rolling back changeset before compile verification."
          }
        }));

        try {
          const changeset = await desktopApi.history.rollbackChangeSet(changesetId);
          setHistoryMessage(`Rolled back ${changeset.summary}; running verification.`);
          setSelectedChangeSetId(changeset.id);
          setActiveBottomTab("History");
          await readProjectFile(changeset.filePath);
          await refreshHistory();
          await verifyChangeSet(changeset, "rollback");
        } catch (error) {
          const message = getErrorMessage(error);
          setHistoryMessage(`Rollback failed: ${message}`);
          setChangeSetVerifications((verifications) => ({
            ...verifications,
            [changesetId]: {
              status: "failed",
              summary: `Rollback failed: ${message}`,
              finishedAt: new Date().toISOString()
            }
          }));
          throw error;
        }
      });
    },
    [readProjectFile, refreshHistory, runProjectOperation, verifyChangeSet]
  );

  const runBuild = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject?.mainFilePath === undefined) {
        showErrorInTerminal("Choose a main .tex file before compiling.");
        return;
      }

      const jobId = crypto.randomUUID();
      const currentToolchain = toolchainStatus ?? (await refreshToolchainStatus());
      const setupIssue = getToolchainSetupIssue(currentToolchain, selectedCompiler);

      if (setupIssue !== undefined) {
        setBuildResult(
          createSetupFailureBuildResult(jobId, selectedCompiler, setupIssue)
        );
        setStatusMessage("Toolchain needs attention before compile.");
        showErrorInTerminal(setupIssue);
        return;
      }

      await saveDirtyFiles();
      setBuildRunning(true);
      setActiveBuildJobId(jobId);
      setBuildResult(null);
      const buildStartPreview = startPdfPreviewBuild({
        artifactData: pdfArtifactData,
        stale: pdfStale
      });
      setPdfArtifactData(buildStartPreview.artifactData);
      setPdfStale(buildStartPreview.stale);
      setStatusMessage("Compiling project...");

      try {
        const result = await desktopApi.build.run({
          jobId,
          projectRoot: currentProject.rootPath,
          mainFilePath: currentProject.mainFilePath,
          compiler: selectedCompiler
        });

        setBuildResult(result);
        setActiveBottomTab("Log");
        if (result.status !== "succeeded") {
          setBottomPanelOpen(true);
        }

        if (result.artifact !== undefined && result.status === "succeeded") {
          const artifactData = await desktopApi.pdf.readArtifact({
            projectRoot: currentProject.rootPath,
            pdfPath: result.artifact.pdfPath
          });
          const previewState = finishPdfPreviewBuild({
            state: buildStartPreview,
            result,
            artifactData
          });
          setPdfArtifactData(previewState.artifactData);
          setPdfStale(previewState.stale);
          setPdfStaleReason(null);
          setPdfPageNumber(1);
          setSyncTexMessage(
            result.artifact.synctexPath === undefined
              ? "SyncTeX unavailable for this build"
              : "SyncTeX ready"
          );
          setStatusMessage(`Compiled ${currentProject.mainFilePath}`);
        } else {
          const previewState = finishPdfPreviewBuild({
            state: buildStartPreview,
            result
          });
          setPdfArtifactData(previewState.artifactData);
          setPdfStale(previewState.stale);
          if (previewState.stale && pdfStaleReason === null) {
            setPdfStaleReason("saved");
          }
          setStatusMessage(`Compile ${result.status}`);
        }
      } finally {
        setActiveBuildJobId(null);
        setBuildRunning(false);
      }
    });
  }, [
    currentProject,
    pdfArtifactData,
    pdfStale,
    pdfStaleReason,
    showErrorInTerminal,
    refreshToolchainStatus,
    runProjectOperation,
    saveDirtyFiles,
    selectedCompiler,
    toolchainStatus
  ]);

  const startAgentTask = useCallback(
    (options?: {
      readonly prompt?: string;
      readonly selectedText?: string;
      readonly selectionContext?: AgentSelectionContext;
      readonly diagnostic?: LatexDiagnostic;
      readonly activeFilePath?: string;
      readonly mode?: AgentMode;
    }) => {
      void runProjectOperation(async () => {
        const prompt =
          options?.prompt?.trim() ??
          agentPrompt.trim() ??
          "Inspect the current LaTeX context and propose a safe edit.";

        if (prompt.length === 0) {
          setStatusMessage("Enter an agent prompt first.");
          return;
        }

        const externalTemplateCommand = parseExternalTemplateAgentCommand(
          prompt,
          agentEvents
        );

        if (externalTemplateCommand !== undefined) {
          await runExternalTemplateAgentCommand(prompt, externalTemplateCommand);
          if (options?.prompt === undefined) {
            setAgentPrompt("");
          }
          return;
        }

        if (currentProject === undefined) {
          const noProjectCommand = parseNoProjectAgentCommand(prompt);

          if (noProjectCommand?.kind === "create-project") {
            await runNoProjectAgentCommand(prompt, noProjectCommand);
            if (options?.prompt === undefined) {
              setAgentPrompt("");
            }
            return;
          }

          const sessionId = `agent-session-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const userEvent = buildAgentMessageEvent({
            content: prompt,
            role: "user",
            sessionId
          });
          const assistantEvent = buildAgentMessageEvent({
            content:
              "Open or create a project first so I can safely inspect files, edit TeX sources, and compile inside a project root.\n\nTry: **create a new project and name it front-postdoc**",
            role: "assistant",
            sessionId
          });

          setAgentEvents((events) =>
            mergeAgentThreadEvents([...events, userEvent, assistantEvent])
          );
          setAgentLiveStatus({
            detail: "Project-scoped agent work needs a project root.",
            title: "No project open",
            tone: "warning"
          });
          setStatusMessage(
            "Open or create a project before project-scoped agent work."
          );
          if (options?.prompt === undefined) {
            setAgentPrompt("");
          }
          return;
        }

        const continuationSessionId =
          agentSessionId !== null &&
          agentSessionProjectRoot === currentProject.rootPath &&
          agentSessionProviderId === agentProviderId
            ? agentSessionId
            : undefined;
        const continuedSelectionContext =
          continuationSessionId === undefined ||
          options?.selectedText !== undefined ||
          options?.diagnostic !== undefined ||
          options?.activeFilePath !== undefined
            ? undefined
            : (activeAgentSelectionContext ?? undefined);
        const selectionContext = options?.selectionContext ?? continuedSelectionContext;
        const selectedText =
          selectionContext?.selectedText ??
          options?.selectedText ??
          agentSelectedText ??
          undefined;
        const effectiveAgentMode = options?.mode ?? agentMode;
        const authStatus = agentAuthStatuses[agentProviderId];
        const providerLabel = getAgentProviderLabel(agentProviderId);
        const requestSessionId =
          continuationSessionId ??
          `agent-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const buildUserEvent = (content: string): AgentEvent => ({
          id: `${requestSessionId}-user-prompt-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          sessionId: requestSessionId,
          createdAt: new Date().toISOString(),
          type: "message",
          role: "user",
          content
        });

        if (authStatus.state !== "connected") {
          setStatusMessage(
            `${providerLabel} is ${formatAgentAuthState(authStatus.state)}. Check AI Providers settings.`
          );
          return;
        }

        setAgentRunning(true);
        setAgentLiveStatus(createStartingAgentLiveStatus(prompt, providerLabel));
        if (selectionContext !== undefined) {
          setActiveAgentSelectionContext(selectionContext);
        }
        setAgentEvents((events) => [...events, buildUserEvent(prompt)]);
        if (options?.prompt === undefined) {
          setAgentPrompt("");
        }
        setStatusMessage(`${providerLabel} is preparing the request...`);

        try {
          const result = await desktopApi.agent.start({
            providerId: agentProviderId,
            mode: effectiveAgentMode,
            projectRoot: currentProject.rootPath,
            maxTurns: appSettings.agentPermissions.maxTurns,
            ...(continuationSessionId === undefined
              ? {}
              : { sessionId: continuationSessionId }),
            prompt,
            ...(activeFile === null ? {} : { activeFilePath: activeFile.path }),
            ...(options?.activeFilePath === undefined
              ? {}
              : { activeFilePath: options.activeFilePath }),
            ...(selectedText === undefined ? {} : { selectedText }),
            ...(selectionContext === undefined ? {} : { selectionContext }),
            ...(currentProject.mainFilePath === undefined
              ? {}
              : { mainFilePath: currentProject.mainFilePath }),
            compiler: selectedCompiler,
            ...(options?.diagnostic === undefined
              ? {}
              : { diagnostic: options.diagnostic })
          });

          setAgentSessionId(result.sessionId);
          setAgentSessionProjectRoot(currentProject.rootPath);
          setAgentSessionProviderId(agentProviderId);
          const displayResultEvents = prepareAgentDisplayEvents(result.events).filter(
            (event) =>
              event.type !== "message" ||
              event.role !== "user" ||
              event.content !== prompt
          );
          const summaryEvent = buildAgentCompletionSummaryEvent(result);
          setAgentEvents((events) => {
            const normalizedEvents = events.map((event) =>
              event.sessionId === requestSessionId
                ? { ...event, sessionId: result.sessionId }
                : event
            );
            const existingEventIds = new Set(normalizedEvents.map((event) => event.id));
            return mergeAgentThreadEvents([
              ...normalizedEvents,
              ...displayResultEvents.filter((event) => !existingEventIds.has(event.id)),
              ...(summaryEvent === undefined || existingEventIds.has(summaryEvent.id)
                ? []
                : [summaryEvent])
            ]);
          });

          const proposedChangeSets = result.changesets ?? [];
          const proposedChangeSet = result.changeset;
          if (proposedChangeSet !== undefined) {
            setSelectedChangeSetId(proposedChangeSet.id);
            setHistoryMessage(
              proposedChangeSets.length > 1
                ? `Agent proposed ${proposedChangeSets.length} reviewable changes`
                : `Agent proposed ${proposedChangeSet.summary}`
            );
            setChangeSetVerifications((verifications) => ({
              ...verifications,
              ...Object.fromEntries(
                (proposedChangeSets.length > 0
                  ? proposedChangeSets
                  : [proposedChangeSet]
                ).map((changeset) => [
                  changeset.id,
                  {
                    status: "pending",
                    summary:
                      "Review the inline diff, then approve the patch to run compile verification."
                  }
                ])
              )
            }));
            setActiveBottomTab("History");
            await refreshHistory();
          }

          if (agentSetMainFile(result.events)) {
            const refreshedProject = await desktopApi.project.refresh(
              currentProject.rootPath
            );
            setProjectResult(refreshedProject);
            setProjectState({ recentProjects: refreshedProject.recentProjects });
          }

          const agentBuildResult = result.buildResult;
          if (agentBuildResult !== undefined) {
            setBuildResult(agentBuildResult);
            setActiveBottomTab("Log");
            if (agentBuildResult.status !== "succeeded") {
              setBottomPanelOpen(true);
            }

            if (
              agentBuildResult.artifact !== undefined &&
              agentBuildResult.status === "succeeded"
            ) {
              const artifactData = await desktopApi.pdf.readArtifact({
                projectRoot: currentProject.rootPath,
                pdfPath: agentBuildResult.artifact.pdfPath
              });
              const previewState = finishPdfPreviewBuild({
                state: {
                  artifactData: pdfArtifactData,
                  stale: pdfStale
                },
                result: agentBuildResult,
                artifactData
              });
              setPdfArtifactData(previewState.artifactData);
              setPdfStale(previewState.stale);
              setPdfStaleReason(null);
              setPdfPageNumber(1);
            }
          }

          const approvalToolName = getRequestedApprovalToolName(result.events);
          setStatusMessage(
            result.status === "failed"
              ? `${providerLabel} could not complete the task.`
              : result.status === "awaiting-approval" &&
                  approvalToolName === "network-fetch"
                ? `${providerLabel} is waiting for web access approval.`
                : result.status === "awaiting-approval" &&
                    approvalToolName === "delete-entry"
                  ? `${providerLabel} is waiting for delete approval.`
                  : result.status === "awaiting-approval"
                    ? `${providerLabel} is waiting for patch approval.`
                    : `${providerLabel} completed.`
          );
          setAgentLiveStatus(
            result.status === "failed"
              ? {
                  detail: "Review the event timeline for the provider or tool failure.",
                  title: `${providerLabel} could not complete the task`,
                  tone: "danger"
                }
              : result.status === "awaiting-approval"
                ? createAwaitingApprovalLiveStatus(approvalToolName)
                : {
                    detail:
                      proposedChangeSet === undefined
                        ? "The response is ready in the transcript."
                        : "A reviewable patch is ready in History.",
                    title:
                      isExternalResearchPrompt(prompt) &&
                      proposedChangeSet === undefined
                        ? "Final response"
                        : `${providerLabel} completed`,
                    tone: "success"
                  }
          );
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          const failureEvents: AgentEvent[] = [
            {
              id: `${requestSessionId}-failed-error`,
              sessionId: requestSessionId,
              createdAt: new Date().toISOString(),
              type: "error",
              message: errorMessage,
              recoverable: true
            },
            {
              id: `${requestSessionId}-failed-message`,
              sessionId: requestSessionId,
              createdAt: new Date().toISOString(),
              type: "message",
              role: "assistant",
              content: `${providerLabel} could not complete the task: ${errorMessage}`
            }
          ];

          setAgentEvents((events) => {
            const existingEventIds = new Set(events.map((event) => event.id));

            return [
              ...events,
              ...failureEvents.filter((event) => !existingEventIds.has(event.id))
            ];
          });
          setStatusMessage(`${providerLabel} could not complete the task.`);
          setAgentLiveStatus({
            detail: errorMessage,
            title: `${providerLabel} stopped with an error`,
            tone: "danger"
          });
          throw error;
        } finally {
          setAgentRunning(false);
        }
      });
    },
    [
      activeFile,
      agentAuthStatuses,
      agentEvents,
      agentMode,
      agentPrompt,
      agentProviderId,
      agentSessionId,
      agentSessionProjectRoot,
      agentSessionProviderId,
      agentSelectedText,
      activeAgentSelectionContext,
      currentProject,
      pdfArtifactData,
      pdfStale,
      refreshHistory,
      runProjectOperation,
      runExternalTemplateAgentCommand,
      runNoProjectAgentCommand,
      selectedCompiler
    ]
  );

  const startDiagnosticAgentFix = useCallback(
    (diagnostic: LatexDiagnostic) => {
      setAgentMode("apply-with-review");
      setAgentSelectedText(null);
      setActiveAgentSelectionContext(null);
      startAgentTask({
        prompt: createDiagnosticAgentPrompt(diagnostic, buildResult),
        diagnostic,
        ...(diagnostic.filePath === undefined
          ? {}
          : { activeFilePath: diagnostic.filePath }),
        mode: "apply-with-review"
      });
    },
    [buildResult, startAgentTask]
  );

  const closeInlineSelectionPrompt = useCallback(() => {
    setInlineSelectionPrompt((promptState) =>
      promptState.open
        ? {
            ...promptState,
            open: false
          }
        : promptState
    );
  }, []);

  const getInlineSelectionPromptPosition = useCallback(() => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();

    if (
      editor === null ||
      editor === undefined ||
      selection === undefined ||
      selection === null ||
      selection.isEmpty() ||
      editor.getDomNode() === null
    ) {
      return null;
    }

    const startPosition = editor.getScrolledVisiblePosition(
      selection.getStartPosition()
    );
    const endPosition = editor.getScrolledVisiblePosition(selection.getEndPosition());
    if (startPosition === null || endPosition === null) {
      return null;
    }

    const editorNode = editor.getDomNode();
    if (editorNode === null) {
      return null;
    }

    const bounds = editorNode.getBoundingClientRect();
    const startX = bounds.left + (startPosition.left ?? 0);
    const endX = bounds.left + (endPosition.left ?? 0);
    const startY = bounds.top + (startPosition.top ?? 0);
    const endY = bounds.top + (endPosition.top ?? 0);
    const margin = 12;
    const popupWidth = Math.max(240, Math.min(392, window.innerWidth - margin * 2));
    const popupHeight = 252;
    const anchorLeft = Math.round(Math.min(startX, endX) + 8);
    const anchorBelowTop = Math.round(Math.max(startY, endY) + 24);
    const anchorAboveTop = Math.round(Math.min(startY, endY) - popupHeight - 8);

    const canPlaceBelow = anchorBelowTop + popupHeight <= window.innerHeight - margin;
    const canPlaceAbove = anchorAboveTop >= margin;
    const preferredTop = canPlaceBelow ? anchorBelowTop : anchorAboveTop;
    const rawTop =
      canPlaceBelow || canPlaceAbove
        ? preferredTop
        : Math.max(margin, window.innerHeight - popupHeight - margin);

    return {
      left: Math.max(
        margin,
        Math.min(anchorLeft, window.innerWidth - popupWidth - margin)
      ),
      top: Math.max(margin, Math.min(rawTop, window.innerHeight - popupHeight - margin))
    };
  }, []);

  const openInlineSelectionPrompt = useCallback(
    (action?: SelectionAgentAction, options?: { readonly silent: boolean }) => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      const selectionContext =
        editor !== null &&
        editor !== undefined &&
        selection !== null &&
        selection !== undefined
          ? createAgentSelectionContext(editor, selection)
          : null;
      const selectedText = selectionContext?.selectedText;
      const hasSelection = selectedText !== undefined && selectedText.trim().length > 0;
      const nextAction = action ?? (agentMode === "suggest" ? "explain" : "rewrite");

      if (selection === undefined || selection === null || !hasSelection) {
        if (options?.silent !== true) {
          setStatusMessage("Select text in the editor before opening this panel.");
        }
        closeInlineSelectionPrompt();
        return;
      }

      if (editor === null || editor.getDomNode() === null) {
        closeInlineSelectionPrompt();
        return;
      }

      if (selection.isEmpty()) {
        if (options?.silent !== true) {
          setStatusMessage("Select text in the editor before opening this panel.");
        }
        closeInlineSelectionPrompt();
        return;
      }

      const promptPosition = getInlineSelectionPromptPosition();
      if (promptPosition === null) {
        if (options?.silent !== true) {
          setStatusMessage("Select text in the editor before opening this panel.");
        }
        closeInlineSelectionPrompt();
        return;
      }

      setInlineSelectionPrompt({
        action: nextAction,
        left: promptPosition.left,
        open: true,
        prompt: "",
        selectionContext,
        selectedText,
        top: promptPosition.top
      });
      if (options?.silent !== true) {
        window.setTimeout(() => inlineSelectionPromptRef.current?.focus(), 0);
      }
    },
    [agentMode, closeInlineSelectionPrompt, getInlineSelectionPromptPosition]
  );

  const clearSelectionPromptAutoOpenTimer = useCallback(() => {
    if (selectionPromptOpenTimeoutRef.current !== null) {
      window.clearTimeout(selectionPromptOpenTimeoutRef.current);
      selectionPromptOpenTimeoutRef.current = null;
    }
  }, []);

  const scheduleSelectionPromptAutoOpen = useCallback(() => {
    clearSelectionPromptAutoOpenTimer();
    selectionPromptOpenTimeoutRef.current = window.setTimeout(() => {
      selectionPromptOpenTimeoutRef.current = null;

      if (editorSelectionPointerDownRef.current) {
        editorSelectionPendingAfterPointerUpRef.current = true;
        return;
      }

      openInlineSelectionPrompt(undefined, { silent: true });
    }, INLINE_SELECTION_PROMPT_AUTO_OPEN_DELAY_MS);
  }, [clearSelectionPromptAutoOpenTimer, openInlineSelectionPrompt]);

  const updateInlineSelectionPromptPosition = useCallback(() => {
    const promptPosition = getInlineSelectionPromptPosition();
    if (promptPosition === null) {
      closeInlineSelectionPrompt();
      return;
    }

    setInlineSelectionPrompt((promptState) =>
      promptState.open
        ? promptState.left === promptPosition.left &&
          promptState.top === promptPosition.top
          ? promptState
          : {
              ...promptState,
              left: promptPosition.left,
              top: promptPosition.top
            }
        : promptState
    );
  }, [closeInlineSelectionPrompt, getInlineSelectionPromptPosition]);

  const queueInlineSelectionPromptPositionUpdate = useCallback(() => {
    if (inlineSelectionPromptRepositionRafRef.current !== null) {
      return;
    }

    inlineSelectionPromptRepositionRafRef.current = window.requestAnimationFrame(() => {
      inlineSelectionPromptRepositionRafRef.current = null;
      updateInlineSelectionPromptPosition();
    });
  }, [updateInlineSelectionPromptPosition]);

  useEffect(() => {
    if (!inlineSelectionPrompt.open) {
      return;
    }

    const editor = editorRef.current;
    const editorNode = editor?.getDomNode() ?? null;
    const disposeListeners: Array<{ dispose: () => void }> = [];

    const reposition = () => {
      queueInlineSelectionPromptPositionUpdate();
    };

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    editorNode?.addEventListener("scroll", reposition, true);

    if (editor !== null) {
      disposeListeners.push(
        editor.onDidScrollChange(() => {
          reposition();
        })
      );
    }

    if (editorNode !== null && typeof ResizeObserver !== "undefined") {
      const editorResizeObserver = new ResizeObserver(() => {
        reposition();
      });
      editorResizeObserver.observe(editorNode);
      disposeListeners.push({ dispose: () => editorResizeObserver.disconnect() });
    }

    reposition();

    return () => {
      if (inlineSelectionPromptRepositionRafRef.current !== null) {
        window.cancelAnimationFrame(inlineSelectionPromptRepositionRafRef.current);
        inlineSelectionPromptRepositionRafRef.current = null;
      }
      disposeListeners.forEach((subscription) => subscription.dispose());
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      editorNode?.removeEventListener("scroll", reposition, true);
    };
  }, [inlineSelectionPrompt.open, queueInlineSelectionPromptPositionUpdate]);

  const runInlineSelectionPrompt = useCallback(
    (actionOverride?: SelectionAgentAction) => {
      const action = actionOverride ?? inlineSelectionPrompt.action;
      const prompt =
        inlineSelectionPrompt.prompt.trim() || getSelectionAgentDefaultPrompt(action);
      const selectedText =
        inlineSelectionPrompt.selectionContext?.selectedText ??
        inlineSelectionPrompt.selectedText;

      if (selectedText.trim().length === 0) {
        setStatusMessage(
          "Select text in the editor before sending a selection request."
        );
        return;
      }

      if (prompt.length === 0) {
        setStatusMessage("Enter an agent prompt first.");
        return;
      }

      const effectiveAgentMode = action === "explain" ? "suggest" : agentMode;

      setInlineSelectionPrompt((promptState) => ({
        ...promptState,
        action,
        open: false
      }));
      startAgentTask({
        mode: effectiveAgentMode,
        prompt,
        selectedText,
        ...(inlineSelectionPrompt.selectionContext === null
          ? {}
          : { selectionContext: inlineSelectionPrompt.selectionContext })
      });
    },
    [
      inlineSelectionPrompt.action,
      inlineSelectionPrompt.prompt,
      inlineSelectionPrompt.selectionContext,
      inlineSelectionPrompt.selectedText,
      agentMode,
      startAgentTask
    ]
  );

  const submitSelectionPromptAction = useCallback(
    (nextAction: SelectionAgentAction) => {
      runInlineSelectionPrompt(nextAction);
    },
    [runInlineSelectionPrompt]
  );

  const respondAgentApproval = useCallback(
    (
      sessionId: string,
      approvalId: string,
      toolName: AgentToolName,
      decision: "allowed" | "denied"
    ) => {
      void runProjectOperation(async () => {
        setAgentLiveStatus({
          detail:
            toolName === "network-fetch"
              ? decision === "allowed"
                ? "Checking whether the approved web request can run in this local-first build."
                : "Continuing without external sources; no network request will be made."
              : toolName === "delete-entry"
                ? decision === "allowed"
                  ? "Deleting the approved project entry and refreshing the file tree."
                  : "Recording the denial without deleting project files."
                : decision === "allowed"
                  ? "Applying the reviewed patch and waiting for compile verification."
                  : "Recording the denial without changing project files.",
          title:
            toolName === "network-fetch"
              ? decision === "allowed"
                ? "Web access approved"
                : "Web access denied"
              : toolName === "delete-entry"
                ? decision === "allowed"
                  ? "Delete approved"
                  : "Delete denied"
                : decision === "allowed"
                  ? "Approval accepted"
                  : "Approval denied",
          tone: decision === "allowed" ? "running" : "warning"
        });
        const result = await desktopApi.agent.respondApproval({
          sessionId,
          approvalId,
          decision
        });
        const displayResultEvents = prepareAgentDisplayEvents(result.events);
        const summaryEvent = buildAgentCompletionSummaryEvent(result, {
          decision
        });

        setAgentEvents((events) =>
          mergeAgentThreadEvents([
            ...events,
            ...displayResultEvents.filter(
              (event) => !events.some((existingEvent) => existingEvent.id === event.id)
            ),
            ...(summaryEvent === undefined ||
            events.some((event) => event.id === summaryEvent.id)
              ? []
              : [summaryEvent])
          ])
        );

        const approvedChangeSets = result.changesets ?? [];
        const approvedChangeSet = result.changeset;
        if (approvedChangeSet !== undefined) {
          setHistoryMessage(
            approvedChangeSets.length > 1
              ? `${decision === "allowed" ? "Applied" : "Reviewed"} ${approvedChangeSets.length} agent changes`
              : `${decision === "allowed" ? "Applied" : "Reviewed"} ${approvedChangeSet.summary}`
          );
          setSelectedChangeSetId(approvedChangeSet.id);
          setChangeSetVerifications((verifications) => ({
            ...verifications,
            ...Object.fromEntries(
              (approvedChangeSets.length > 0
                ? approvedChangeSets
                : [approvedChangeSet]
              ).map((changeset) => [
                changeset.id,
                decision === "denied"
                  ? {
                      status: "skipped",
                      summary: "Patch approval was denied; no files were changed.",
                      finishedAt: new Date().toISOString()
                    }
                  : {
                      status: "running",
                      summary: "Patch approved; waiting for compile verification."
                    }
              ])
            )
          }));
          if (decision === "allowed") {
            await readProjectFile(approvedChangeSet.filePath);
          }
        }

        const approvalBuildResult = result.buildResult;
        if (approvalBuildResult !== undefined) {
          setBuildResult(approvalBuildResult);
          if (approvalBuildResult.status !== "succeeded") {
            setBottomPanelOpen(true);
            setActiveBottomTab("Log");
          } else {
            setActiveBottomTab(
              approvalBuildResult.diagnostics.length > 0 ? "Problems" : "Log"
            );
          }

          if (
            currentProject !== undefined &&
            approvalBuildResult.artifact !== undefined &&
            approvalBuildResult.status === "succeeded"
          ) {
            const artifactData = await desktopApi.pdf.readArtifact({
              projectRoot: currentProject.rootPath,
              pdfPath: approvalBuildResult.artifact.pdfPath
            });
            setPdfArtifactData(artifactData);
            setPdfStale(false);
            setPdfStaleReason(null);
            setPdfPageNumber(1);
          }
          if (approvedChangeSet !== undefined) {
            setChangeSetVerifications((verifications) => ({
              ...verifications,
              ...Object.fromEntries(
                ((result.changesets ?? []).length > 0
                  ? (result.changesets ?? [])
                  : [approvedChangeSet]
                ).map((changeset) => [
                  changeset.id,
                  {
                    status:
                      approvalBuildResult.status === "succeeded" ? "passed" : "failed",
                    summary: `Compile verification ${approvalBuildResult.status} with ${approvalBuildResult.diagnostics.length} diagnostic${approvalBuildResult.diagnostics.length === 1 ? "" : "s"}.`,
                    buildJobId: approvalBuildResult.jobId,
                    finishedAt: approvalBuildResult.finishedAt
                  }
                ])
              )
            }));
          }
        }

        if (
          decision === "allowed" &&
          currentProject !== undefined &&
          (result.deleteEntries?.length ?? 0) > 0
        ) {
          const refreshedProject = await desktopApi.project.refresh(
            currentProject.rootPath
          );
          setProjectResult(refreshedProject);
          setProjectState({ recentProjects: refreshedProject.recentProjects });
          const deletedPaths = new Set(
            result.deleteEntries?.map((entry) => entry.path)
          );
          setOpenFiles((files) => files.filter((file) => !deletedPaths.has(file.path)));
          setActiveFilePath((path) =>
            path !== null && deletedPaths.has(path) ? null : path
          );
          setSelectedProjectEntryPath((path) =>
            path !== null && deletedPaths.has(path) ? null : path
          );
        }

        await refreshHistory();
        const resultApprovalToolName = getResolvedApprovalToolName(result.events);
        setStatusMessage(
          resultApprovalToolName === "network-fetch"
            ? decision === "allowed"
              ? "Web access approval handled."
              : "Web access denied."
            : resultApprovalToolName === "delete-entry"
              ? decision === "allowed"
                ? "Agent delete completed."
                : "Agent delete denied."
              : decision === "allowed"
                ? "Agent patch applied and verified."
                : "Agent approval denied."
        );
        setAgentLiveStatus({
          detail:
            resultApprovalToolName === "network-fetch"
              ? decision === "allowed"
                ? "Approved source context was fetched and passed to the agent."
                : "No external request was made. Paste source material if you want a local-only follow-up."
              : resultApprovalToolName === "delete-entry"
                ? decision === "allowed"
                  ? "The approved project entry was deleted and the file tree was refreshed."
                  : "No project files were deleted."
                : decision === "allowed"
                  ? "Patch handling finished; check History for verification details."
                  : "No files were changed.",
          title:
            resultApprovalToolName === "network-fetch"
              ? decision === "allowed"
                ? "Web context fetched"
                : "Network request skipped"
              : resultApprovalToolName === "delete-entry"
                ? decision === "allowed"
                  ? "Delete complete"
                  : "Delete denied"
                : decision === "allowed"
                  ? "Patch review complete"
                  : "Patch denied",
          tone: decision === "allowed" ? "success" : "warning"
        });
      });
    },
    [currentProject, readProjectFile, refreshHistory, runProjectOperation]
  );

  const stopBuild = useCallback(() => {
    if (activeBuildJobId === null) {
      setStatusMessage("No active build to stop.");
      return;
    }

    void desktopApi.build.stop(activeBuildJobId).then((result) => {
      if (result.stopped) {
        setStatusMessage("Stopping build...");
      } else {
        setStatusMessage("No active build to stop.");
      }
    });
  }, [activeBuildJobId]);

  const runPdfSearch = useCallback(() => {
    void runProjectOperation(async () => {
      const document = pdfDocumentRef.current;
      const query = pdfSearchQuery.trim();

      if (document === null || query.length === 0) {
        setPdfSearchMatches([]);
        setPdfSearchActiveIndex(-1);
        return;
      }

      const currentMatches =
        pdfSearchMatches.length > 0 && pdfSearchMatchQuery === query
          ? pdfSearchMatches
          : await collectPdfSearchMatches(document, query);

      if (currentMatches.length === 0) {
        setPdfSearchMatches([]);
        setPdfSearchActiveIndex(-1);
        setPdfSearchMatchQuery(query);
        setStatusMessage(`No PDF search match for "${query}"`);
        return;
      }

      const nextIndex =
        pdfSearchMatches.length > 0 && pdfSearchMatchQuery === query
          ? (pdfSearchActiveIndex + 1) % currentMatches.length
          : 0;
      const match = currentMatches[nextIndex];

      setPdfSearchMatches(currentMatches);
      setPdfSearchActiveIndex(nextIndex);
      setPdfSearchMatchQuery(query);
      setPdfPageNumber(match?.page ?? 1);
      setStatusMessage(
        `PDF match ${nextIndex + 1} of ${currentMatches.length} on page ${match?.page ?? 1}`
      );
    });
  }, [
    pdfSearchActiveIndex,
    pdfSearchMatches,
    pdfSearchMatchQuery,
    pdfSearchQuery,
    runProjectOperation
  ]);

  const stepPdfSearch = useCallback(
    (direction: "next" | "previous") => {
      void runProjectOperation(async () => {
        const document = pdfDocumentRef.current;
        const query = pdfSearchQuery.trim();
        const matches =
          pdfSearchMatches.length > 0 && pdfSearchMatchQuery === query
            ? pdfSearchMatches
            : document === null || query.length === 0
              ? []
              : await collectPdfSearchMatches(document, query);

        if (matches.length === 0) {
          setPdfSearchMatches([]);
          setPdfSearchActiveIndex(-1);
          setPdfSearchMatchQuery(query);
          setStatusMessage(
            query.length === 0
              ? "Enter a PDF search query."
              : `No PDF search match for "${query}"`
          );
          return;
        }

        const nextIndex =
          direction === "next"
            ? (Math.max(0, pdfSearchActiveIndex) + 1) % matches.length
            : (Math.max(0, pdfSearchActiveIndex) - 1 + matches.length) % matches.length;
        const match = matches[nextIndex];

        setPdfSearchMatches(matches);
        setPdfSearchActiveIndex(nextIndex);
        setPdfSearchMatchQuery(query);
        setPdfPageNumber(match?.page ?? 1);
        setStatusMessage(
          `PDF match ${nextIndex + 1} of ${matches.length} on page ${match?.page ?? 1}`
        );
      });
    },
    [
      pdfSearchActiveIndex,
      pdfSearchMatches,
      pdfSearchMatchQuery,
      pdfSearchQuery,
      runProjectOperation
    ]
  );

  const setProjectMainFile = useCallback(
    (path: string) => {
      void runProjectOperation(async () => {
        if (currentProject === undefined) {
          return;
        }

        const result = await desktopApi.project.setMainFile({
          projectRoot: currentProject.rootPath,
          path
        });
        setProjectResult(result);
        setProjectState({ recentProjects: result.recentProjects });
        setStatusMessage(`Set ${path} as main file`);
      });
    },
    [currentProject, runProjectOperation]
  );

  const setTreeFileAsMain = useCallback(
    (path: string) => {
      if (!path.toLowerCase().endsWith(".tex")) {
        return;
      }

      setProjectMainFile(path);
    },
    [setProjectMainFile]
  );

  const createEntry = useCallback(
    (kind: "directory" | "file") => {
      void runProjectOperation(async () => {
        if (currentProject === undefined) {
          return;
        }

        const name = window.prompt(
          kind === "file" ? "New file name" : "New folder name",
          kind === "file" ? "untitled.tex" : "sections"
        );

        if (name === null || name.trim().length === 0) {
          return;
        }

        const parentPath = selectedProjectDirectoryPath;
        const result = await desktopApi.project.createEntry({
          projectRoot: currentProject.rootPath,
          parentPath,
          name: name.trim(),
          kind
        });
        const createdPath = joinProjectPath(parentPath, name.trim());

        if (kind === "directory") {
          setSelectedProjectDirectoryPath(createdPath);
          setSelectedProjectEntryPath(createdPath);
          setProjectResult(result);
          setProjectState({ recentProjects: result.recentProjects });
          setStatusMessage(`Created ${createdPath}`);
        } else {
          await applyProjectResult(result, createdPath);
        }
      });
    },
    [
      applyProjectResult,
      currentProject,
      runProjectOperation,
      selectedProjectDirectoryPath
    ]
  );

  const renameActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      const newName = window.prompt(
        "Rename selected entry",
        getBaseName(selectedProjectEntryPath)
      );
      if (newName === null || newName.trim().length === 0) {
        return;
      }

      const renamedPath = getSiblingProjectPath(
        selectedProjectEntryPath,
        newName.trim()
      );
      const result = await desktopApi.project.renameEntry({
        projectRoot: currentProject.rootPath,
        path: selectedProjectEntryPath,
        newName: newName.trim()
      });
      setSelectedProjectEntryPath(renamedPath);
      setSelectedProjectDirectoryPath(getProjectDirectoryPath(renamedPath));

      if (isEditableTextPath(renamedPath)) {
        await applyProjectResult(result, renamedPath);
      } else {
        setProjectResult(result);
        setProjectState({ recentProjects: result.recentProjects });
        setStatusMessage(`Renamed ${renamedPath}`);
      }
    });
  }, [
    applyProjectResult,
    currentProject,
    runProjectOperation,
    selectedProjectEntryPath
  ]);

  const moveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      const newPath = window.prompt("Move selected entry to", selectedProjectEntryPath);
      if (newPath === null || newPath.trim().length === 0) {
        return;
      }

      const normalizedPath = newPath.trim();
      const result = await desktopApi.project.moveEntry({
        projectRoot: currentProject.rootPath,
        path: selectedProjectEntryPath,
        newPath: normalizedPath
      });
      setSelectedProjectEntryPath(normalizedPath);
      setSelectedProjectDirectoryPath(getProjectDirectoryPath(normalizedPath));

      if (isEditableTextPath(normalizedPath)) {
        await applyProjectResult(result, normalizedPath);
      } else {
        setProjectResult(result);
        setProjectState({ recentProjects: result.recentProjects });
        setStatusMessage(`Moved ${normalizedPath}`);
      }
    });
  }, [
    applyProjectResult,
    currentProject,
    runProjectOperation,
    selectedProjectEntryPath
  ]);

  const searchProjectForQuery = useCallback(
    async (
      query: string,
      projectFiles: readonly ProjectFileTreeNode[] = editableProjectFiles
    ) => {
      if (currentProject === undefined) {
        return 0;
      }

      const filesToSearch = projectFiles.slice(0, 250);
      const results = (
        await Promise.all(
          filesToSearch.map(async (file) => {
            const snapshot = await desktopApi.files.read({
              projectRoot: currentProject.rootPath,
              path: file.path
            });
            return searchFileContents(snapshot.path, snapshot.contents, query, 8);
          })
        )
      ).flat();

      setProjectSearchResults(results.slice(0, 200));
      setActiveBottomTab("Search");
      return results.length;
    },
    [currentProject, editableProjectFiles]
  );

  const deleteActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      if (!window.confirm(`Delete ${selectedProjectEntryPath}?`)) {
        return;
      }

      const result = await desktopApi.project.deleteEntry({
        projectRoot: currentProject.rootPath,
        path: selectedProjectEntryPath
      });
      const deletedPath = result.deletedEntry.deletedPath;
      const searchQuery = deletedPath.replace(/\.tex$/u, "");
      setOpenFiles((files) => removeOpenFile(files, selectedProjectEntryPath));
      setActiveFilePath((path) => (path === selectedProjectEntryPath ? null : path));
      setSelectedProjectEntryPath(null);
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setProjectSearchQuery(searchQuery);

      const referenceCount = await searchProjectForQuery(
        searchQuery,
        getEditableProjectFiles(result.tree)
      );
      setStatusMessage(
        `Deleted ${deletedPath}; backup saved to ${result.deletedEntry.backupPath}; found ${referenceCount} references`
      );
    });
  }, [
    currentProject,
    runProjectOperation,
    searchProjectForQuery,
    selectedProjectEntryPath
  ]);

  const closeFile = useCallback(
    (path: string) => {
      const file = openFiles.find((candidate) => candidate.path === path);

      if (
        file !== undefined &&
        file.contents !== file.savedContents &&
        !window.confirm(`Discard unsaved changes in ${path}?`)
      ) {
        return;
      }

      const remainingFiles = removeOpenFile(openFiles, path);
      setOpenFiles(remainingFiles);
      setActiveFilePath((currentPath) =>
        currentPath === path ? (remainingFiles.at(-1)?.path ?? null) : currentPath
      );
    },
    [openFiles]
  );

  const updateActiveFileContents = useCallback(
    (contents: string) => {
      if (activeFile === null) {
        return;
      }

      setOpenFiles((files) =>
        replaceOpenFile(files, {
          ...activeFile,
          contents
        })
      );
      if (pdfArtifactData !== null) {
        setPdfStale(true);
        setPdfStaleReason("unsaved");
      }
    },
    [activeFile, pdfArtifactData]
  );

  const jumpToFileLine = useCallback(
    (path: string, line: number) => {
      void runProjectOperation(async () => {
        await readProjectFile(path, line);
      });
    },
    [readProjectFile, runProjectOperation]
  );

  const explainChangeSetHunk = useCallback(
    (filePath: string, hunkContents: string) => {
      setAgentMode("suggest");
      setAgentSelectedText(hunkContents);
      setActiveAgentSelectionContext(null);
      startAgentTask({
        mode: "suggest",
        activeFilePath: filePath,
        selectedText: hunkContents,
        prompt:
          "Explain this proposed change hunk using the current source and any attached diagnostic context. Do not apply new edits."
      });
    },
    [startAgentTask]
  );

  const jumpSourceToPdf = useCallback(() => {
    void runProjectOperation(async () => {
      if (
        currentProject === undefined ||
        activeFile === null ||
        pdfArtifactData === null
      ) {
        setSyncTexMessage("Compile with SyncTeX before jumping.");
        return;
      }

      if (pdfStale) {
        setSyncTexMessage("Recompile before SyncTeX; PDF is stale.");
        return;
      }

      const position = editorRef.current?.getPosition();
      const result = await desktopApi.synctex.forward({
        projectRoot: currentProject.rootPath,
        sourceFilePath: activeFile.path,
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
        pdfPath: pdfArtifactData.pdfPath
      });

      if (!result.available || result.page === undefined) {
        setSyncTexMessage(result.message ?? "No SyncTeX PDF target found.");
        return;
      }

      setPdfPageNumber(result.page);
      setSyncTexTarget({
        page: result.page,
        ...(result.x === undefined ? {} : { x: result.x }),
        ...(result.y === undefined ? {} : { y: result.y })
      });
      setSyncTexMessage(`Jumped to PDF page ${result.page}`);
    });
  }, [activeFile, currentProject, pdfArtifactData, pdfStale, runProjectOperation]);

  const jumpPdfToSource = useCallback(
    (page: number, x: number, y: number) => {
      void runProjectOperation(async () => {
        if (currentProject === undefined || pdfArtifactData === null) {
          setSyncTexMessage("Compile with SyncTeX before jumping.");
          return;
        }

        if (pdfStale) {
          setSyncTexMessage("Recompile before SyncTeX; PDF is stale.");
          return;
        }

        const result = await desktopApi.synctex.reverse({
          projectRoot: currentProject.rootPath,
          pdfPath: pdfArtifactData.pdfPath,
          page,
          x,
          y
        });

        if (
          !result.available ||
          result.sourceFilePath === undefined ||
          result.line === undefined
        ) {
          setSyncTexMessage(result.message ?? "No SyncTeX source target found.");
          return;
        }

        setSyncTexMessage(`Jumped to ${result.sourceFilePath}:${result.line}`);
        jumpToFileLine(result.sourceFilePath, result.line);
      });
    },
    [currentProject, jumpToFileLine, pdfArtifactData, pdfStale, runProjectOperation]
  );

  const runProjectSearch = useCallback(() => {
    void runProjectOperation(async () => {
      const resultCount = await searchProjectForQuery(projectSearchQuery);
      setStatusMessage(`Found ${resultCount} search results`);
    });
  }, [projectSearchQuery, runProjectOperation, searchProjectForQuery]);

  const openSearchResult = useCallback(
    (result: ProjectSearchResult) => {
      jumpToFileLine(result.path, result.line);
      setActiveSidebarTab("files");
    },
    [jumpToFileLine]
  );

  const runReferenceSearch = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      const results = await desktopApi.references.search({
        projectRoot: currentProject.rootPath,
        query: referenceSearchQuery
      });
      setReferenceSearchResults(results);
      setActiveBottomTab("References");
      setReferenceMessage(`Found ${results.length} matching references`);
    });
  }, [currentProject, referenceSearchQuery, runProjectOperation]);

  const keepUnusedReference = useCallback((entry: BibliographyEntry) => {
    setReferenceMessage(`Kept ${entry.key} in ${entry.filePath}`);
  }, []);

  const removeUnusedReference = useCallback(
    (entry: BibliographyEntry) => {
      void runProjectOperation(async () => {
        if (currentProject === undefined) {
          return;
        }

        const openEntryFile = openFiles.find((file) => file.path === entry.filePath);

        if (
          openEntryFile !== undefined &&
          openEntryFile.contents !== openEntryFile.savedContents
        ) {
          setReferenceMessage(
            `Save or discard changes in ${entry.filePath} before removing ${entry.key}.`
          );
          return;
        }

        if (
          !window.confirm(
            `Remove unused bibliography entry ${entry.key} from ${entry.filePath} and compile?`
          )
        ) {
          return;
        }

        const result = await desktopApi.references.removeUnused({
          projectRoot: currentProject.rootPath,
          filePath: entry.filePath,
          key: entry.key
        });

        appWrittenProjectPathsRef.current.add(entry.filePath);
        setReferenceAnalysis(result.analysis);
        setReferenceSearchResults((results) =>
          results.filter(
            (candidate) =>
              candidate.filePath !== result.removedEntry.filePath ||
              candidate.key !== result.removedEntry.key
          )
        );
        updateMonacoCitationCompletions(
          currentProject.rootPath,
          result.analysis.entries
        );

        if (openEntryFile !== undefined) {
          const snapshot = await readProjectFileForRoot(
            currentProject.rootPath,
            entry.filePath
          );
          setOpenFiles((files) =>
            replaceOpenFile(files, {
              ...snapshot,
              savedContents: snapshot.contents,
              stale: false
            })
          );
        }

        setReferenceMessage(
          `Removed unused reference ${result.removedEntry.key}; compiling project.`
        );
        runBuild();
      });
    },
    [currentProject, openFiles, runBuild, runProjectOperation]
  );

  const insertCitation = useCallback(
    (key: string) => {
      const editor = editorRef.current;

      if (editor === null || activeFile === null || !activeFile.path.endsWith(".tex")) {
        setReferenceMessage("Open a .tex file before inserting a citation.");
        return;
      }

      const selection = editor.getSelection();
      const position = editor.getPosition();

      if (selection === null || position === null) {
        return;
      }

      const text = createCitationCommand({
        key,
        sources: outlineSources
      });
      editor.executeEdits("insert-citation", [
        {
          range: selection,
          text,
          forceMoveMarkers: true
        }
      ]);
      setOpenFiles((files) =>
        replaceOpenFile(files, {
          ...activeFile,
          contents:
            editor.getModel()?.getValue() ??
            insertTextAtLineColumn({
              contents: activeFile.contents,
              lineNumber: position.lineNumber,
              column: position.column,
              text
            })
        })
      );
      setReferenceMessage(`Inserted citation ${key}`);
    },
    [activeFile, outlineSources]
  );

  const repairMissingCitation = useCallback(
    (citationKey: string) => {
      const candidates = referenceAnalysis.entries
        .slice(0, 25)
        .map((entry) =>
          [
            entry.key,
            entry.title === undefined ? "" : `title=${entry.title}`,
            entry.author === undefined ? "" : `author=${entry.author}`,
            entry.year === undefined ? "" : `year=${entry.year}`
          ]
            .filter((part) => part.length > 0)
            .join(" | ")
        )
        .join("\n");

      setAgentPrompt(
        [
          `Fix the missing citation key ${citationKey}.`,
          "Use only the local bibliography context below.",
          "If a likely local reference exists, replace the missing key with that key.",
          "If no likely local reference exists, ask for source details instead of inventing a source.",
          "",
          "Local bibliography entries:",
          candidates.length === 0 ? "No bibliography entries found." : candidates
        ].join("\n")
      );
      setAgentMode("apply-with-review");
      setAgentSelectedText(null);
      setActiveAgentSelectionContext(null);
      setActiveBottomTab("References");
      agentComposerRef.current?.focus();
    },
    [referenceAnalysis.entries]
  );

  const attachReferenceEntryToAgent = useCallback((entry: BibliographyEntry) => {
    setAgentMode("suggest");
    setAgentPrompt(createReferenceEntryAgentPrompt(entry));
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setActiveBottomTab("References");
    setReferenceMessage(`Attached ${entry.key} to the agent prompt`);
    agentComposerRef.current?.focus();
  }, []);

  const suggestCitationsWithAgent = useCallback(() => {
    const candidates = referenceAnalysis.entries
      .slice(0, 40)
      .map((entry) =>
        [
          entry.key,
          entry.title === undefined ? "" : `title=${entry.title}`,
          entry.author === undefined ? "" : `author=${entry.author}`,
          entry.year === undefined ? "" : `year=${entry.year}`
        ]
          .filter((part) => part.length > 0)
          .join(" | ")
      )
      .join("\n");

    setAgentPrompt(
      [
        "Suggest where citations should be added in the active LaTeX file.",
        "Use only the local bibliography entries below.",
        "Suggest only local citation candidates. Do not invent new sources.",
        "",
        "Local bibliography entries:",
        candidates.length === 0 ? "No bibliography entries found." : candidates
      ].join("\n")
    );
    setAgentMode("suggest");
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setActiveBottomTab("References");
    agentComposerRef.current?.focus();
  }, [referenceAnalysis.entries]);

  useEffect(() => {
    return desktopApi.project.onChanged((event) => {
      if (currentProject?.rootPath !== event.projectRoot) {
        return;
      }

      void runProjectOperation(async () => {
        const result = await desktopApi.project.refresh(event.projectRoot);
        setProjectResult(result);
        setProjectState({ recentProjects: result.recentProjects });

        const changedPaths = new Set(event.paths.map(normalizeProjectPath));
        const staleCandidatePaths = event.paths.filter((path) => {
          const normalizedPath = normalizeProjectPath(path);

          if (appWrittenProjectPathsRef.current.has(normalizedPath)) {
            appWrittenProjectPathsRef.current.delete(normalizedPath);
            return false;
          }

          return true;
        });
        if (
          pdfArtifactData !== null &&
          (event.paths.length === 0 ||
            (staleCandidatePaths.length > 0 &&
              shouldMarkPdfStaleForProjectChange(staleCandidatePaths)))
        ) {
          setPdfStale(true);
          setPdfStaleReason("external");
        }

        const refreshedFiles = await Promise.all(
          openFiles.map(async (file) => {
            if (!changedPaths.has(file.path)) {
              return file;
            }

            if (file.contents !== file.savedContents) {
              return { ...file, stale: true };
            }

            const snapshot = await readProjectFileForRoot(event.projectRoot, file.path);
            return {
              ...snapshot,
              savedContents: snapshot.contents,
              stale: false
            };
          })
        );
        setOpenFiles(refreshedFiles);
      });
    });
  }, [currentProject, openFiles, pdfArtifactData, runProjectOperation]);

  useEffect(() => {
    if (currentProject === undefined) {
      return;
    }

    const saveTimer = window.setTimeout(() => {
      void desktopApi.editor.saveProjectState({
        projectRoot: currentProject.rootPath,
        openFilePaths: openFiles.map((file) => file.path),
        ...(activeFilePath === null ? {} : { activeFilePath })
      });
    }, 180);

    return () => window.clearTimeout(saveTimer);
  }, [activeFilePath, currentProject, openFiles]);

  useEffect(() => {
    if (pendingRevealLine === null || editorRef.current === null) {
      return;
    }

    editorRef.current.revealLineInCenter(pendingRevealLine);
    editorRef.current.setPosition({ lineNumber: pendingRevealLine, column: 1 });
    editorRef.current.focus();
    setPendingRevealLine(null);
  }, [activeFilePath, pendingRevealLine]);

  useEffect(() => {
    pdfCanvasRefs.current.clear();

    if (pdfArtifactData === null) {
      pdfDocumentRef.current = null;
      setPdfPageCount(0);
      return;
    }

    setPdfPageCount(0);
    let cancelled = false;
    void pdfjsLib
      .getDocument({ url: pdfArtifactData.dataUrl })
      .promise.then((document) => {
        if (cancelled) {
          return;
        }

        pdfDocumentRef.current = document;
        setPdfPageCount(document.numPages);
        setPdfPageNumber(1);
      });

    return () => {
      cancelled = true;
    };
  }, [pdfArtifactData]);

  useEffect(() => {
    setPdfSearchMatches([]);
    setPdfSearchActiveIndex(-1);
    setPdfSearchMatchQuery("");
  }, [pdfArtifactData, pdfSearchQuery]);

  useEffect(() => {
    const document = pdfDocumentRef.current;

    if (document === null || pdfPageCount === 0) {
      return;
    }

    let cancelled = false;
    const renderPages = async () => {
      for (let pageNumber = 1; pageNumber <= pdfPageCount; pageNumber += 1) {
        if (cancelled) {
          return;
        }

        const canvas = pdfCanvasRefs.current.get(pageNumber);
        if (canvas !== undefined) {
          await renderPdfPage(document, canvas, pageNumber, pdfScale);
        }
      }
    };
    void renderPages();

    return () => {
      cancelled = true;
    };
  }, [pdfPageCount, pdfScale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;

      if (commandKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (commandKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (commandKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpenOpen(true);
      }

      if (commandKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        focusMonacoFind(editorRef.current);
      }

      if (commandKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openProject();
      }

      if (commandKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) {
          saveAllFiles();
        } else {
          saveActiveFile();
        }
      }

      if (commandKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openInlineSelectionPrompt(undefined);
      }

      if (commandKey && event.key === "Enter") {
        event.preventDefault();
        runBuild();
      }

      if (commandKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openInlineSelectionPrompt, openProject, runBuild, saveActiveFile, saveAllFiles]);

  const filteredCommands = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();

    if (query.length === 0) {
      return commandDefinitions;
    }

    return commandDefinitions.filter((command) =>
      `${command.title} ${command.group}`.toLowerCase().includes(query)
    );
  }, [commandQuery]);

  const workspaceStyle = {
    "--sidebar-width": `${layout.sidebarWidth}px`
  } as CSSProperties & Record<"--sidebar-width", string>;

  const workbenchStyle = {
    "--pdf-width": `${layout.pdfWidth}px`,
    "--agent-width": `${layout.agentWidth}px`,
    "--bottom-height": bottomPanelOpen ? `${layout.bottomPanelHeight}px` : "0px",
    "--bottom-split-size": bottomPanelOpen ? "6px" : "0px"
  } as CSSProperties &
    Record<
      "--pdf-width" | "--agent-width" | "--bottom-height" | "--bottom-split-size",
      string
    >;

  const appShellClassName = [
    "app-shell",
    `density-${appSettings.appearance.density}`,
    `accent-${appSettings.appearance.accent}`,
    appSettings.appearance.highContrastLight ? "high-contrast-light" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const constrainLayoutToContentWidth = useCallback((nextLayout: WorkbenchLayout) => {
    const contentWidth = contentRowRef.current?.clientWidth;
    if (contentWidth === undefined) {
      return clampPaneSizes(nextLayout);
    }

    return constrainWorkbenchLayoutToContentWidth(nextLayout, contentWidth);
  }, []);

  useLayoutEffect(() => {
    if (!layoutLoaded) {
      return;
    }

    const applyContentWidthConstraints = () => {
      setLayout((currentLayout) => {
        const constrainedLayout = constrainLayoutToContentWidth(currentLayout);

        return constrainedLayout.sidebarWidth === currentLayout.sidebarWidth &&
          constrainedLayout.pdfWidth === currentLayout.pdfWidth &&
          constrainedLayout.agentWidth === currentLayout.agentWidth &&
          constrainedLayout.bottomPanelHeight === currentLayout.bottomPanelHeight
          ? currentLayout
          : constrainedLayout;
      });
    };

    applyContentWidthConstraints();
    window.addEventListener("resize", applyContentWidthConstraints);

    return () => window.removeEventListener("resize", applyContentWidthConstraints);
  }, [constrainLayoutToContentWidth, layoutLoaded]);

  const startResize = useCallback(
    (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      let previousX = event.clientX;
      let previousY = event.clientY;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = {
          x: moveEvent.clientX - previousX,
          y: moveEvent.clientY - previousY
        };
        previousX = moveEvent.clientX;
        previousY = moveEvent.clientY;

        setLayout((currentLayout) => {
          const nextLayout = resizeWorkbenchPane(target, currentLayout, delta);
          return constrainLayoutToContentWidth(nextLayout);
        });
        scheduleEditorLayout();
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [constrainLayoutToContentWidth, scheduleEditorLayout]
  );

  const resizeWithKeyboard = useCallback(
    (target: ResizeTarget, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 24 : 12;
      const keyDeltas: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step }
      };
      const delta = keyDeltas[event.key];

      if (delta === undefined) {
        return;
      }

      event.preventDefault();
      setLayout((currentLayout) =>
        constrainLayoutToContentWidth(resizeWorkbenchPane(target, currentLayout, delta))
      );
      scheduleEditorLayout();
    },
    [constrainLayoutToContentWidth, scheduleEditorLayout]
  );

  const runCommand = useCallback(
    (commandId: CommandId) => {
      switch (commandId) {
        case "open-settings":
          setSettingsOpen(true);
          break;
        case "toggle-problems":
          setBottomPanelOpen((isOpen) => !isOpen);
          break;
        case "focus-agent":
          agentComposerRef.current?.focus();
          break;
        case "fix-top-diagnostic": {
          const topDiagnostic = buildResult?.diagnostics[0];
          if (topDiagnostic === undefined) {
            setStatusMessage("No diagnostic is available to send to the agent.");
            setActiveBottomTab("Problems");
            break;
          }
          startDiagnosticAgentFix(topDiagnostic);
          break;
        }
        case "quick-open":
          setQuickOpenOpen(true);
          break;
        case "save-file":
          saveActiveFile();
          break;
        case "save-all":
          saveAllFiles();
          break;
        case "find-in-file":
          focusMonacoFind(editorRef.current);
          break;
        case "project-search":
          setActiveSidebarTab("search");
          break;
        case "open-project":
          openProject();
          break;
        case "compile-project":
          runBuild();
          break;
      }

      setCommandPaletteOpen(false);
      setCommandQuery("");
    },
    [
      buildResult,
      openProject,
      runBuild,
      saveActiveFile,
      saveAllFiles,
      startDiagnosticAgentFix
    ]
  );

  return (
    <div className={appShellClassName}>
      <header className="titlebar">
        <div className="brand">
          <img className="brand-logo" src={zeroleafMarkUrl} alt="" aria-hidden="true" />
          <div>
            <strong>ZeroLeaf</strong>
            <span>{appInfo?.isPackaged ? "Release" : "Developer Build"}</span>
          </div>
        </div>

        <div className="titlebar-center" role="search">
          <button
            className="command-trigger"
            type="button"
            aria-label="Open command palette"
            title="Open command palette"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <Search aria-hidden="true" size={16} />
            <span>Command Palette</span>
          </button>
        </div>

        <nav className="titlebar-actions" aria-label="Application actions">
          <IconButton
            label={bottomPanelOpen ? "Hide terminal" : "Show terminal"}
            onClick={() => setBottomPanelOpen((isOpen) => !isOpen)}
          >
            <Terminal size={17} />
          </IconButton>
          <IconButton label="Open project" onClick={openProject}>
            <FolderOpen size={17} />
          </IconButton>
          <IconButton
            label="Compile project"
            disabled={
              currentProject?.mainFilePath === undefined ||
              buildRunning ||
              compileUnavailable
            }
            onClick={runBuild}
          >
            <Play size={17} />
          </IconButton>
        </nav>
      </header>

      <div className="workspace" style={workspaceStyle}>
        <ActivityRail
          activeTab={activeSidebarTab}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectTab={setActiveSidebarTab}
        />
        {activeSidebarTab === "files" && (
          <ProjectSidebar
            activeFilePath={activeFile?.path}
            mainFilePath={currentProject?.mainFilePath}
            project={currentProject}
            recentProjects={projectState.recentProjects}
            selectedDirectoryPath={selectedProjectDirectoryPath}
            selectedEntryPath={selectedProjectEntryPath}
            submissionCheckResult={submissionCheckResult}
            tree={projectResult?.tree ?? []}
            onAskAgentSubmissionChecklist={askAgentForSubmissionChecklist}
            onAskAgentNumberingMismatch={askAgentForFigureNumberingMismatch}
            onCreateEntry={createEntry}
            onDeleteActiveFile={deleteActiveFile}
            onExportSourceArchive={exportSourceArchive}
            onMoveActiveFile={moveActiveFile}
            onCloseProject={closeProject}
            onOpenProject={openProject}
            onOpenRecentProject={openRecentProject}
            onRefreshProject={refreshProjectTree}
            onRenameActiveFile={renameActiveFile}
            onRunSubmissionCheck={runSubmissionCheck}
            onSelectDirectory={selectProjectDirectory}
            onSelectFile={selectFile}
            onSetMainFile={setTreeFileAsMain}
          />
        )}
        {activeSidebarTab === "search" && (
          <SidebarPanel title="Search" subtitle="Project files">
            <ProjectSearchPanel
              query={projectSearchQuery}
              results={projectSearchResults}
              onQueryChange={setProjectSearchQuery}
              onRunSearch={runProjectSearch}
              onSelectResult={openSearchResult}
            />
          </SidebarPanel>
        )}
        {activeSidebarTab === "templates" && (
          <TemplateSidebar
            projectName={templateProjectName}
            projectTemplates={projectTemplates}
            selectedTemplateId={selectedTemplateId}
            onCreateFromTemplate={createProjectFromSelectedTemplate}
            onImportSourceZip={importSourceZip}
            onOpenProject={openProject}
            onProjectNameChange={setTemplateProjectName}
            onTemplateChange={changeSelectedTemplate}
          />
        )}
        <PaneResizer
          label="Resize project sidebar"
          orientation="vertical"
          onPointerDown={(event) => startResize("sidebar", event)}
          onKeyDown={(event) => resizeWithKeyboard("sidebar", event)}
        />

        <main
          className="workbench"
          aria-label="Editor workbench"
          style={workbenchStyle}
        >
          {inlineSelectionPrompt.open ? (
            <SelectionPromptPopover
              action={inlineSelectionPrompt.action}
              left={inlineSelectionPrompt.left}
              mode={agentMode}
              promptRef={inlineSelectionPromptRef}
              onActionSubmit={submitSelectionPromptAction}
              onClose={closeInlineSelectionPrompt}
              onPromptChange={(prompt) =>
                setInlineSelectionPrompt((promptState) =>
                  promptState.open
                    ? {
                        ...promptState,
                        prompt
                      }
                    : promptState
                )
              }
              onSubmit={runInlineSelectionPrompt}
              prompt={inlineSelectionPrompt.prompt}
              selectedText={inlineSelectionPrompt.selectedText}
              top={inlineSelectionPrompt.top}
            />
          ) : null}
          <section
            className="content-row"
            aria-label="Main editor layout"
            ref={contentRowRef}
          >
            <EditorPane
              activeFile={activeFile}
              activeFilePath={activeFilePath}
              dirty={activeFileDirty}
              dirtyFileCount={dirtyFiles.length}
              editorSettings={appSettings.editor}
              mainFilePath={currentProject?.mainFilePath}
              openFiles={openFiles}
              onActiveFileChange={setActiveFilePath}
              onCloseFile={closeFile}
              onContentsChange={updateActiveFileContents}
              onFind={() => focusMonacoFind(editorRef.current)}
              onMount={(editor) => {
                editorRef.current = editor;
                editorResizeObserverRef.current?.disconnect();
                editorResizeObserverRef.current = new ResizeObserver(() => {
                  scheduleEditorLayout();
                });
                editorResizeObserverRef.current.observe(getMonacoLayoutElement(editor));
                scheduleEditorLayout();
                installE2EEditorHooks(editor);
                selectionChangeSubscriptionRef.current?.dispose();
                editorSelectionPointerListenersRef.current?.dispose();
                editorSelectionPointerDownRef.current = false;
                editorSelectionPendingAfterPointerUpRef.current = false;

                const editorNode = editor.getDomNode();
                if (editorNode !== null) {
                  const onEditorPointerDown = () => {
                    editorSelectionPointerDownRef.current = true;
                    editorSelectionPendingAfterPointerUpRef.current = false;
                    clearSelectionPromptAutoOpenTimer();
                  };
                  const onEditorPointerUp = () => {
                    const shouldOpenAfterPointerUp =
                      editorSelectionPendingAfterPointerUpRef.current;
                    editorSelectionPointerDownRef.current = false;
                    editorSelectionPendingAfterPointerUpRef.current = false;

                    if (shouldOpenAfterPointerUp) {
                      scheduleSelectionPromptAutoOpen();
                    }
                  };

                  editorNode.addEventListener("pointerdown", onEditorPointerDown);
                  window.addEventListener("pointerup", onEditorPointerUp, true);
                  window.addEventListener("pointercancel", onEditorPointerUp, true);
                  editorSelectionPointerListenersRef.current = {
                    dispose: () => {
                      editorNode.removeEventListener(
                        "pointerdown",
                        onEditorPointerDown
                      );
                      window.removeEventListener("pointerup", onEditorPointerUp, true);
                      window.removeEventListener(
                        "pointercancel",
                        onEditorPointerUp,
                        true
                      );
                    }
                  };
                } else {
                  editorSelectionPointerListenersRef.current = null;
                }

                selectionChangeSubscriptionRef.current =
                  editor.onDidChangeCursorSelection(() => {
                    if (editorSelectionPointerDownRef.current) {
                      editorSelectionPendingAfterPointerUpRef.current = true;
                      clearSelectionPromptAutoOpenTimer();
                      return;
                    }

                    scheduleSelectionPromptAutoOpen();
                  });
                editor.addAction({
                  id: "latex-agent.ask-selection",
                  label: "Ask Agent About Selection",
                  contextMenuGroupId: "navigation",
                  contextMenuOrder: 1.5,
                  run: () => {
                    openInlineSelectionPrompt();
                  }
                });
              }}
              onRunBuild={runBuild}
              onSourceToPdf={jumpSourceToPdf}
              onSave={saveActiveFile}
              onSaveAll={saveAllFiles}
              onStopBuild={stopBuild}
              selectedCompiler={selectedCompiler}
              syncTexMessage={syncTexMessage}
              compileUnavailable={compileUnavailable}
              buildRunning={buildRunning}
              onCompilerChange={updateSelectedCompiler}
            />
            <PaneResizer
              label="Resize PDF preview"
              orientation="vertical"
              onPointerDown={(event) => startResize("pdf", event)}
              onKeyDown={(event) => resizeWithKeyboard("pdf", event)}
            />
            <PdfPane
              artifact={pdfArtifactData}
              buildRunning={buildRunning}
              canvasRefs={pdfCanvasRefs}
              pageCount={pdfPageCount}
              pageNumber={pdfPageNumber}
              projectRoot={currentProject?.rootPath}
              searchQuery={pdfSearchQuery}
              scale={pdfScale}
              stale={pdfStale}
              staleReason={pdfStaleReason}
              onDownload={exportCurrentPdf}
              onFitWidth={() => setPdfScale(1.2)}
              onNextPage={() =>
                setPdfPageNumber((page) => Math.min(pdfPageCount, page + 1))
              }
              onPreviousPage={() => setPdfPageNumber((page) => Math.max(1, page - 1))}
              onRunSearch={runPdfSearch}
              onSearchQueryChange={setPdfSearchQuery}
              onSearchNext={() => stepPdfSearch("next")}
              onSearchPrevious={() => stepPdfSearch("previous")}
              onCanvasClick={jumpPdfToSource}
              onSourceToPdf={jumpSourceToPdf}
              onZoomIn={() => setPdfScale((scale) => Math.min(2.5, scale + 0.1))}
              onZoomOut={() => setPdfScale((scale) => Math.max(0.6, scale - 0.1))}
              searchActiveIndex={pdfSearchActiveIndex}
              searchMatchCount={pdfSearchMatches.length}
              syncTexTarget={syncTexTarget}
            />
            <PaneResizer
              label="Resize agent panel"
              orientation="vertical"
              onPointerDown={(event) => startResize("agent", event)}
              onKeyDown={(event) => resizeWithKeyboard("agent", event)}
            />
            <AgentPane
              composerRef={agentComposerRef}
              events={agentEvents}
              liveStatus={agentLiveStatus}
              mode={agentMode}
              providerAuthStatus={agentAuthStatuses[agentProviderId]}
              providerId={agentProviderId}
              prompt={agentPrompt}
              running={agentRunning}
              selectedText={agentSelectedText}
              onAllowApproval={(sessionId, approvalId, toolName) =>
                respondAgentApproval(sessionId, approvalId, toolName, "allowed")
              }
              onCancel={() => {
                if (agentSessionId !== null) {
                  void desktopApi.agent.cancel(agentSessionId);
                }
                setAgentLiveStatus({
                  detail: "The current provider request was cancelled locally.",
                  title: "Agent run cancelled",
                  tone: "warning"
                });
                setAgentRunning(false);
              }}
              onClearHistory={clearAgentHistory}
              onModeChange={updateAgentMode}
              onPromptChange={setAgentPrompt}
              onProviderChange={updateAgentProviderId}
              onSelectionAction={openInlineSelectionPrompt}
              onDenyApproval={(sessionId, approvalId, toolName) =>
                respondAgentApproval(sessionId, approvalId, toolName, "denied")
              }
              onStart={() => startAgentTask()}
            />
          </section>

          {bottomPanelOpen ? (
            <>
              <PaneResizer
                label="Resize bottom panel"
                orientation="horizontal"
                onPointerDown={(event) => startResize("bottom", event)}
                onKeyDown={(event) => resizeWithKeyboard("bottom", event)}
              />
              <BottomPanel
                activeTab={activeBottomTab}
                activeFile={activeFile}
                activeFileDirty={activeFileDirty}
                auditEvents={auditEvents}
                buildResult={buildResult}
                buildRunning={buildRunning}
                changeSetVerifications={changeSetVerifications}
                acceptedHunkIndexesByChangeSet={acceptedHunkIndexesByChangeSet}
                historyChangeSets={historyChangeSets}
                historyMessage={historyMessage}
                onExplainChangeSetHunk={explainChangeSetHunk}
                outline={projectOutline}
                projectSearchQuery={projectSearchQuery}
                projectSearchResults={projectSearchResults}
                referenceAnalysis={referenceAnalysis}
                referenceMessage={referenceMessage}
                referenceSearchQuery={referenceSearchQuery}
                referenceSearchResults={referenceSearchResults}
                selectedChangeSetId={selectedChangeSetId}
                submissionCheckResult={submissionCheckResult}
                onActiveTabChange={setActiveBottomTab}
                onApplyChangeSet={applyChangeSet}
                onAttachReferenceEntry={attachReferenceEntryToAgent}
                onCreateChangeSet={createActiveFileChangeSet}
                onInsertCitation={insertCitation}
                onKeepUnusedReference={keepUnusedReference}
                onJumpToOutlineItem={(item) => jumpToFileLine(item.path, item.line)}
                onProjectSearchQueryChange={setProjectSearchQuery}
                onReferenceSearchQueryChange={setReferenceSearchQuery}
                onRefreshReferences={() => {
                  void runProjectOperation(refreshReferences);
                }}
                onRejectChangeSet={rejectChangeSet}
                onSetChangeSetHunkAccepted={setChangeSetHunkAccepted}
                onRemoveUnusedReference={removeUnusedReference}
                onRepairMissingCitation={repairMissingCitation}
                onRollbackChangeSet={rollbackChangeSet}
                onRunReferenceSearch={runReferenceSearch}
                onRunProjectSearch={runProjectSearch}
                onSelectChangeSet={setSelectedChangeSetId}
                onFixDiagnostic={startDiagnosticAgentFix}
                onSelectDiagnostic={(diagnostic) => {
                  if (
                    diagnostic.filePath !== undefined &&
                    diagnostic.line !== undefined
                  ) {
                    jumpToFileLine(diagnostic.filePath, diagnostic.line);
                  }
                }}
                onSelectReferenceEntry={(entry) =>
                  jumpToFileLine(entry.filePath, entry.line)
                }
                onSelectReferenceCitation={(citation) =>
                  jumpToFileLine(citation.filePath, citation.line)
                }
                onSelectSearchResult={(result) =>
                  jumpToFileLine(result.path, result.line)
                }
                onSnapshotActiveFile={snapshotActiveFile}
                onSuggestCitations={suggestCitationsWithAgent}
              />
            </>
          ) : null}
        </main>
      </div>

      <footer className="statusbar" aria-label="Application status">
        <span>{projectError ?? statusMessage}</span>
        <span>{appInfo?.appVersion ?? "dev"}</span>
      </footer>

      <CommandPalette
        commands={filteredCommands}
        open={commandPaletteOpen}
        query={commandQuery}
        onClose={() => setCommandPaletteOpen(false)}
        onQueryChange={setCommandQuery}
        onRunCommand={runCommand}
      />

      <QuickOpenDialog
        files={editableProjectFiles}
        open={quickOpenOpen}
        onClose={() => setQuickOpenOpen(false)}
        onOpenFile={(path) => {
          setQuickOpenOpen(false);
          selectFile(path);
        }}
      />

      <SettingsDialog
        activeTab={activeSettingsTab}
        agentAuthRefreshRunning={agentAuthRefreshRunning}
        agentAuthStatuses={agentAuthStatuses}
        agentMode={agentMode}
        agentProviderId={agentProviderId}
        appSettings={appSettings}
        keybindingQuery={keybindingQuery}
        open={settingsOpen}
        privacySummary={privacySummary}
        onActiveTabChange={setActiveSettingsTab}
        onClearLocalHistory={clearLocalHistory}
        onClose={() => setSettingsOpen(false)}
        onKeybindingQueryChange={setKeybindingQuery}
        onOpenProviderSetupTerminal={(providerId, action) => {
          void openProviderSetupTerminal(providerId, action);
        }}
        onOpenUpdateDownload={(url) => {
          void openUpdateDownload(url);
        }}
        onInstallUpdate={(url) => {
          void installUpdate(url);
        }}
        onCheckForUpdates={() => {
          void checkForAppUpdates();
        }}
        onRefreshPrivacySummary={() => {
          void refreshPrivacySummary();
        }}
        onRefreshAgentAuthStatuses={() => {
          void refreshAgentAuthStatuses();
        }}
        onSettingsChange={updateAppSettings}
        onSetAgentMode={updateAgentMode}
        onSetAgentProviderId={updateAgentProviderId}
        onSetCompiler={updateSelectedCompiler}
        updateCheckResult={updateCheckResult}
        updateCheckRunning={updateCheckRunning}
        updateInstallRunning={updateInstallRunning}
      />
    </div>
  );
}

function ActivityRail({
  activeTab,
  onOpenSettings,
  onSelectTab
}: {
  readonly activeTab: SidebarTab;
  readonly onOpenSettings: () => void;
  readonly onSelectTab: (tab: SidebarTab) => void;
}) {
  return (
    <aside className="activity-rail" aria-label="Primary navigation">
      <IconButton
        label="Files"
        pressed={activeTab === "files"}
        onClick={() => onSelectTab("files")}
      >
        <FileText size={18} />
      </IconButton>
      <IconButton
        label="Search"
        pressed={activeTab === "search"}
        onClick={() => onSelectTab("search")}
      >
        <Search size={18} />
      </IconButton>
      <IconButton
        label="Templates"
        pressed={activeTab === "templates"}
        onClick={() => onSelectTab("templates")}
      >
        <Plus size={18} />
      </IconButton>
      <div className="activity-rail-spacer" aria-hidden="true" />
      <IconButton label="Open settings" onClick={onOpenSettings}>
        <Settings size={18} />
      </IconButton>
    </aside>
  );
}

function SidebarPanel({
  children,
  subtitle,
  title
}: {
  readonly children: ReactNode;
  readonly subtitle: string;
  readonly title: string;
}) {
  return (
    <aside className="project-sidebar sidebar-tool-panel" aria-label={title}>
      <div className="panel-header">
        <div>
          <span className="eyebrow">{subtitle}</span>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="sidebar-tool-content">{children}</div>
    </aside>
  );
}

function TemplateSidebar({
  projectName,
  projectTemplates,
  selectedTemplateId,
  onCreateFromTemplate,
  onImportSourceZip,
  onOpenProject,
  onProjectNameChange,
  onTemplateChange
}: {
  readonly projectName: string;
  readonly projectTemplates: readonly ProjectTemplate[];
  readonly selectedTemplateId: ProjectTemplateId;
  readonly onCreateFromTemplate: () => void;
  readonly onImportSourceZip: () => void;
  readonly onOpenProject: () => void;
  readonly onProjectNameChange: (projectName: string) => void;
  readonly onTemplateChange: (templateId: ProjectTemplateId) => void;
}) {
  const selectedTemplate = projectTemplates.find(
    (template) => template.id === selectedTemplateId
  );

  return (
    <SidebarPanel title="Templates" subtitle="Project starters">
      <div className="template-picker sidebar-template-picker">
        <div className="template-picker__header">
          <span className="eyebrow">Template</span>
          <p>Create your paper from a ready-made starter.</p>
        </div>
        <select
          className="compact-select"
          aria-label="Project template"
          value={selectedTemplateId}
          onChange={(event) =>
            onTemplateChange(event.target.value as ProjectTemplateId)
          }
        >
          {projectTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <p className="template-picker__description">
          {selectedTemplate?.description ?? "Choose a built-in template."}
        </p>
        <label className="template-picker__field">
          <span className="eyebrow">Project name</span>
          <input
            aria-label="Template project name"
            value={projectName}
            spellCheck={false}
            onChange={(event) => onProjectNameChange(event.target.value)}
          />
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={projectName.trim().length === 0}
          onClick={onCreateFromTemplate}
        >
          <Plus aria-hidden="true" size={15} />
          Create Project
        </button>
      </div>
      <div className="sidebar-template-actions">
        <button className="text-button" type="button" onClick={onOpenProject}>
          <FolderOpen aria-hidden="true" size={15} />
          Open Folder
        </button>
        <button className="text-button" type="button" onClick={onImportSourceZip}>
          <FolderOpen aria-hidden="true" size={15} />
          Import ZIP
        </button>
      </div>
    </SidebarPanel>
  );
}

function ProjectSidebar({
  activeFilePath,
  mainFilePath,
  selectedDirectoryPath,
  selectedEntryPath,
  submissionCheckResult,
  onAskAgentSubmissionChecklist,
  onAskAgentNumberingMismatch,
  onCreateEntry,
  onDeleteActiveFile,
  onExportSourceArchive,
  onMoveActiveFile,
  onCloseProject,
  onOpenProject,
  onOpenRecentProject,
  onRefreshProject,
  onRenameActiveFile,
  onRunSubmissionCheck,
  onSelectDirectory,
  onSelectFile,
  onSetMainFile,
  project,
  recentProjects,
  tree
}: {
  readonly activeFilePath: string | undefined;
  readonly mainFilePath: string | undefined;
  readonly selectedDirectoryPath: string;
  readonly selectedEntryPath: string | null;
  readonly submissionCheckResult: SubmissionCheckResult | null;
  readonly onAskAgentSubmissionChecklist: () => void;
  readonly onAskAgentNumberingMismatch: () => void;
  readonly onCreateEntry: (kind: "directory" | "file") => void;
  readonly onDeleteActiveFile: () => void;
  readonly onExportSourceArchive: () => void;
  readonly onMoveActiveFile: () => void;
  readonly onCloseProject: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly onRefreshProject: () => void;
  readonly onRenameActiveFile: () => void;
  readonly onRunSubmissionCheck: () => void;
  readonly onSelectDirectory: (path: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSetMainFile: (path: string) => void;
  readonly project: ProjectOpenResult["project"] | undefined;
  readonly recentProjects: readonly RecentProject[];
  readonly tree: readonly ProjectFileTreeNode[];
}) {
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    setCollapsedDirectoryPaths(new Set());
  }, [project?.rootPath]);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirectoryPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);

      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }

      return nextPaths;
    });
  }, []);

  return (
    <aside className="project-sidebar" aria-label="Project files">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Project</span>
          <h2>{project?.displayName ?? "No Project"}</h2>
        </div>
        <IconButton label="Open project" onClick={onOpenProject}>
          <FolderOpen size={16} />
        </IconButton>
        {project !== undefined && (
          <IconButton label="Close project" onClick={onCloseProject}>
            <X size={16} />
          </IconButton>
        )}
      </div>

      {project === undefined ? (
        <RecentProjects
          recentProjects={recentProjects}
          onOpenProject={onOpenProject}
          onOpenRecentProject={onOpenRecentProject}
        />
      ) : (
        <>
          <div className="file-actions" aria-label="File actions">
            <IconButton label="New file" onClick={() => onCreateEntry("file")}>
              <Plus size={15} />
            </IconButton>
            <IconButton label="New folder" onClick={() => onCreateEntry("directory")}>
              <FolderPlus size={15} />
            </IconButton>
            <IconButton
              label="Rename selected entry"
              onClick={onRenameActiveFile}
              disabled={selectedEntryPath === null}
            >
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label="Move selected entry"
              onClick={onMoveActiveFile}
              disabled={selectedEntryPath === null}
            >
              <ChevronRight size={15} />
            </IconButton>
            <IconButton
              label="Delete selected entry"
              onClick={onDeleteActiveFile}
              disabled={selectedEntryPath === null}
            >
              <Trash2 size={15} />
            </IconButton>
            <IconButton label="Refresh project" onClick={onRefreshProject}>
              <RefreshCw size={15} />
            </IconButton>
            <span className="file-action-target" title={selectedDirectoryPath}>
              {selectedDirectoryPath}
            </span>
            <span className="toolbar-divider" aria-hidden="true" />
            <IconButton label="Export source ZIP" onClick={onExportSourceArchive}>
              <Save size={15} />
            </IconButton>
            <IconButton label="Check submission bundle" onClick={onRunSubmissionCheck}>
              <Check size={15} />
            </IconButton>
            <IconButton
              label="Agent final PDF formatting review"
              onClick={onAskAgentSubmissionChecklist}
            >
              <Sparkles size={15} />
            </IconButton>
            <IconButton
              label="Agent figure numbering mismatch"
              onClick={onAskAgentNumberingMismatch}
            >
              <TriangleAlert size={15} />
            </IconButton>
          </div>
          {submissionCheckResult !== null && (
            <div className="submission-summary">
              <strong>Submission</strong>
              <span>
                {
                  submissionCheckResult.items.filter(
                    (item) => item.severity === "error"
                  ).length
                }{" "}
                errors ·{" "}
                {
                  submissionCheckResult.items.filter(
                    (item) => item.severity === "warning"
                  ).length
                }{" "}
                warnings
              </span>
            </div>
          )}
          <nav className="file-tree" aria-label="File tree">
            {tree.length === 0 ? (
              <p className="empty-state">This project has no visible files.</p>
            ) : (
              tree.map((node) => (
                <FileTreeNode
                  activeFilePath={activeFilePath}
                  depth={0}
                  key={node.path}
                  mainFilePath={mainFilePath}
                  node={node}
                  collapsedDirectoryPaths={collapsedDirectoryPaths}
                  selectedDirectoryPath={selectedDirectoryPath}
                  selectedEntryPath={selectedEntryPath}
                  onToggleDirectory={toggleDirectory}
                  onSelectDirectory={onSelectDirectory}
                  onSelectFile={onSelectFile}
                  onSetMainFile={onSetMainFile}
                />
              ))
            )}
          </nav>
        </>
      )}
    </aside>
  );
}

function RecentProjects({
  onOpenProject,
  onOpenRecentProject,
  recentProjects
}: {
  readonly onOpenProject: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly recentProjects: readonly RecentProject[];
}) {
  return (
    <div className="recent-projects">
      <section className="recent-header">
        <span className="eyebrow">Workspace</span>
        <h3>No project open</h3>
        <p>Open an existing project, import a ZIP archive, or start from a template.</p>
      </section>

      <div className="recent-toolbar">
        <button
          className="primary-button recent-open-folder"
          type="button"
          onClick={onOpenProject}
        >
          <FolderOpen aria-hidden="true" size={15} />
          Open Folder
        </button>
      </div>

      <div className="recent-list" aria-label="Recent projects">
        <span className="eyebrow">Recent</span>
        {recentProjects.length === 0 ? (
          <p className="empty-state">No recent projects yet. Open a folder to start.</p>
        ) : (
          recentProjects.map((project) => (
            <button
              className="recent-row"
              key={project.rootPath}
              type="button"
              onClick={() => onOpenRecentProject(project.rootPath)}
            >
              <span className="recent-row__title">{project.displayName}</span>
              <span className="recent-row__path">{project.rootPath}</span>
              <span className="recent-row__meta">
                {formatRecentProjectDetails(project)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function FileTreeNode({
  activeFilePath,
  collapsedDirectoryPaths,
  depth,
  mainFilePath,
  node,
  selectedDirectoryPath,
  selectedEntryPath,
  onToggleDirectory,
  onSelectDirectory,
  onSelectFile,
  onSetMainFile
}: {
  readonly activeFilePath: string | undefined;
  readonly collapsedDirectoryPaths: ReadonlySet<string>;
  readonly depth: number;
  readonly mainFilePath: string | undefined;
  readonly node: ProjectFileTreeNode;
  readonly selectedDirectoryPath: string;
  readonly selectedEntryPath: string | null;
  readonly onToggleDirectory: (path: string) => void;
  readonly onSelectDirectory: (path: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSetMainFile: (path: string) => void;
}) {
  const isFolder = node.kind === "directory";
  const isCollapsed = isFolder && collapsedDirectoryPaths.has(node.path);
  const hasChildren = isFolder && (node.children?.length ?? 0) > 0;
  const isTexFile = !isFolder && node.path.toLowerCase().endsWith(".tex");
  const isMainFile = isTexFile && mainFilePath === node.path;
  const isSelectedEntry = selectedEntryPath === node.path;

  return (
    <>
      <div className="file-row-wrapper">
        <button
          className={`file-row${
            activeFilePath === node.path || isSelectedEntry ? " active" : ""
          }`}
          aria-expanded={isFolder ? !isCollapsed : undefined}
          style={{ paddingLeft: `${12 + depth * 18}px` }}
          type="button"
          onClick={() => {
            if (isFolder) {
              onSelectDirectory(node.path);
              if (hasChildren) {
                onToggleDirectory(node.path);
              }
            } else {
              onSelectFile(node.path);
            }
          }}
        >
          {isFolder ? (
            <>
              <ChevronRight
                aria-hidden="true"
                className={`file-row__chevron${isCollapsed ? "" : " expanded"}`}
                size={13}
              />
              <FolderOpen aria-hidden="true" size={15} />
            </>
          ) : (
            <>
              <span className="file-row__chevron-placeholder" aria-hidden="true" />
              <FileText aria-hidden="true" size={15} />
            </>
          )}
          <span className="file-row__name">{node.name}</span>
          {isMainFile ? <span className="file-row__badge">Main</span> : null}
        </button>
        {isTexFile && !isMainFile ? (
          <button
            className="file-row__main-action"
            type="button"
            aria-label={`Set ${node.path} as main file`}
            title={`Set ${node.path} as main file`}
            onClick={() => onSetMainFile(node.path)}
          >
            <Check aria-hidden="true" size={13} />
          </button>
        ) : null}
      </div>
      {isCollapsed
        ? null
        : node.children?.map((child) => (
            <FileTreeNode
              activeFilePath={activeFilePath}
              collapsedDirectoryPaths={collapsedDirectoryPaths}
              depth={depth + 1}
              key={child.path}
              mainFilePath={mainFilePath}
              node={child}
              selectedDirectoryPath={selectedDirectoryPath}
              selectedEntryPath={selectedEntryPath}
              onToggleDirectory={onToggleDirectory}
              onSelectDirectory={onSelectDirectory}
              onSelectFile={onSelectFile}
              onSetMainFile={onSetMainFile}
            />
          ))}
    </>
  );
}

function EditorPane({
  activeFile,
  activeFilePath,
  buildRunning,
  compileUnavailable,
  dirty,
  dirtyFileCount,
  editorSettings,
  mainFilePath,
  onCompilerChange,
  onActiveFileChange,
  onCloseFile,
  onContentsChange,
  onFind,
  onMount,
  onRunBuild,
  onSourceToPdf,
  onSave,
  onSaveAll,
  onStopBuild,
  openFiles,
  selectedCompiler,
  syncTexMessage
}: {
  readonly activeFile: EditorFileState | null;
  readonly activeFilePath: string | null;
  readonly buildRunning: boolean;
  readonly compileUnavailable: boolean;
  readonly dirty: boolean;
  readonly dirtyFileCount: number;
  readonly editorSettings: AppSettings["editor"];
  readonly mainFilePath: string | undefined;
  readonly onCompilerChange: (compiler: LatexCompiler) => void;
  readonly onActiveFileChange: (path: string) => void;
  readonly onCloseFile: (path: string) => void;
  readonly onContentsChange: (contents: string) => void;
  readonly onFind: () => void;
  readonly onMount: (editor: MonacoStandaloneEditor) => void;
  readonly onRunBuild: () => void;
  readonly onSourceToPdf: () => void;
  readonly onSave: () => void;
  readonly onSaveAll: () => void;
  readonly onStopBuild: () => void;
  readonly openFiles: readonly EditorFileState[];
  readonly selectedCompiler: LatexCompiler;
  readonly syncTexMessage: string;
}) {
  return (
    <section className="editor-pane" aria-label="Source editor">
      <div className="tab-strip" role="tablist" aria-label="Open files">
        {openFiles.length === 0 ? (
          <span className="editor-tab muted">No file</span>
        ) : (
          openFiles.map((file) => {
            const isActive = file.path === activeFilePath;
            const isDirty = file.contents !== file.savedContents;

            return (
              <button
                className={`editor-tab${isActive ? " active" : ""}`}
                key={file.path}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onActiveFileChange(file.path)}
              >
                <span>{getBaseName(file.path)}</span>
                {isDirty ? (
                  <span className="tab-dirty" aria-label="Unsaved changes" />
                ) : null}
                <span
                  className="tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${file.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseFile(file.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseFile(file.path);
                    }
                  }}
                >
                  <X aria-hidden="true" size={13} />
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="editor-toolbar" aria-label="Editor actions">
        <IconButton
          label="Save file"
          disabled={activeFile === null || !dirty}
          onClick={onSave}
        >
          <Save aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Save all files"
          disabled={dirtyFileCount === 0}
          onClick={onSaveAll}
        >
          <Save aria-hidden="true" size={15} />
        </IconButton>
        <select
          className="compact-select"
          aria-label="LaTeX compiler"
          value={selectedCompiler}
          onChange={(event) => onCompilerChange(event.target.value as LatexCompiler)}
        >
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
        <IconButton
          label="Compile project"
          disabled={mainFilePath === undefined || buildRunning || compileUnavailable}
          onClick={onRunBuild}
        >
          <Play aria-hidden="true" size={15} />
        </IconButton>
        <IconButton label="Stop Build" disabled={!buildRunning} onClick={onStopBuild}>
          <X aria-hidden="true" size={15} />
        </IconButton>
        <span className="toolbar-divider" aria-hidden="true" />
        <IconButton
          label="Source to PDF"
          disabled={activeFile === null}
          onClick={onSourceToPdf}
        >
          <ChevronRight aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Find in file"
          disabled={activeFile === null}
          onClick={onFind}
        >
          <Search aria-hidden="true" size={15} />
        </IconButton>
        <span className="editor-status-group">
          {buildRunning ? <span className="editor-state">Compiling...</span> : null}
          {activeFile?.stale === true && (
            <span className="editor-state">Changed on disk</span>
          )}
          {syncTexMessage.length > 0 ? (
            <span className="editor-state">{syncTexMessage}</span>
          ) : null}
        </span>
      </div>
      {activeFile === null ? (
        <div className="editor-empty">
          <FileText aria-hidden="true" size={24} />
          <p>Open a project file to edit it.</p>
        </div>
      ) : (
        <Editor
          beforeMount={(monaco) => configureMonaco(monaco as unknown as Monaco)}
          className="source-editor"
          height="100%"
          language={getLanguageForPath(activeFile.path)}
          options={{
            automaticLayout: true,
            fontFamily: editorSettings.fontFamily,
            fontSize: editorSettings.fontSize,
            lineHeight: editorSettings.lineHeight,
            minimap: { enabled: editorSettings.minimap },
            quickSuggestions: editorSettings.autocomplete,
            suggestOnTriggerCharacters: editorSettings.autocomplete,
            renderLineHighlight: "line",
            scrollBeyondLastLine: false,
            wordWrap: "on"
          }}
          path={activeFile.path}
          theme="latex-light"
          value={activeFile.contents}
          onChange={(value) => onContentsChange(value ?? "")}
          onMount={onMount}
        />
      )}
    </section>
  );
}

function SelectionPromptPopover({
  action,
  left,
  mode,
  promptRef,
  onActionSubmit,
  onClose,
  onPromptChange,
  onSubmit,
  prompt,
  selectedText,
  top
}: {
  readonly action: SelectionAgentAction;
  readonly left: number;
  readonly mode: AgentMode;
  readonly promptRef: RefObject<HTMLTextAreaElement | null>;
  readonly onActionSubmit: (action: SelectionAgentAction) => void;
  readonly onClose: () => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSubmit: () => void;
  readonly prompt: string;
  readonly selectedText: string;
  readonly top: number;
}) {
  const truncatedSelection =
    selectedText.length <= 120 ? selectedText : `${selectedText.slice(0, 120)}…`;

  return (
    <div
      className="selection-popover-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="selection-popover"
        role="dialog"
        aria-label="Selection agent prompt"
        style={{ left: `${left}px`, top: `${top}px` }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
      >
        <header className="selection-popover-header">
          <span className="selection-popover-title">
            <MessageSquareText aria-hidden="true" size={14} />
            AI for selected text
          </span>
          <button
            className="text-button"
            type="button"
            aria-label="Close selection agent prompt"
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>
        <small className="selection-popover-selection">
          {selectedText.length === 0 ? "No selection" : truncatedSelection}
        </small>
        <div
          className="selection-popover-actions"
          role="group"
          aria-label="Selection action"
        >
          <button
            className="text-button"
            type="button"
            onClick={() => onActionSubmit("explain")}
          >
            Explain
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onActionSubmit("rewrite")}
          >
            Rewrite
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onActionSubmit("expand-notes")}
          >
            Expand notes
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onActionSubmit("improve-academic-tone")}
          >
            Improve tone
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onActionSubmit("shorten-abstract")}
          >
            Shorten abstract
          </button>
        </div>
        <textarea
          ref={promptRef}
          aria-label="Selection agent prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.shiftKey === false) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Ask the agent to rewrite or inspect this selection..."
        />
        <span className="selection-popover-mode">
          Mode: {formatAgentModeLabel(action === "explain" ? "suggest" : mode)}
        </span>
      </section>
    </div>
  );
}

function AgentPane({
  composerRef,
  events,
  liveStatus,
  mode,
  onAllowApproval,
  onCancel,
  onClearHistory,
  onDenyApproval,
  onModeChange,
  onPromptChange,
  onProviderChange,
  onSelectionAction,
  onStart,
  prompt,
  providerAuthStatus,
  providerId,
  running,
  selectedText
}: {
  readonly composerRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly events: readonly AgentEvent[];
  readonly liveStatus: AgentLiveStatus | null;
  readonly mode: AgentMode;
  readonly onAllowApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly onCancel: () => void;
  readonly onClearHistory: () => void;
  readonly onDenyApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly onModeChange: (mode: AgentMode) => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onProviderChange: (providerId: AgentProviderId) => void;
  readonly onSelectionAction: (action: SelectionAgentAction) => void;
  readonly onStart: () => void;
  readonly prompt: string;
  readonly providerAuthStatus: AgentAuthStatus;
  readonly providerId: AgentProviderId;
  readonly running: boolean;
  readonly selectedText: string | null;
}) {
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const elapsedSeconds = useAgentElapsedSeconds(running);

  useLayoutEffect(() => {
    const composer = composerRef.current;

    if (composer === null) {
      return;
    }

    composer.style.height = "auto";
    composer.style.height = `${composer.scrollHeight}px`;
  }, [composerRef, prompt]);

  const displayEvents = prepareAgentDisplayEvents(events);
  const visibleLiveStatus =
    liveStatus ??
    ({
      detail:
        providerAuthStatus.message ??
        `${getAgentProviderLabel(providerId)} is configured for ${formatAgentModeLabel(mode)}.`,
      title:
        providerAuthStatus.state === "connected"
          ? "Ready for scoped project work"
          : providerAuthStatus.state === "error"
            ? "Provider error"
            : formatAgentAuthState(providerAuthStatus.state),
      tone:
        providerAuthStatus.state === "connected"
          ? "idle"
          : providerAuthStatus.state === "error"
            ? "danger"
            : "warning"
    } satisfies AgentLiveStatus);
  const threadItems = createAgentThreadItems(displayEvents);
  const visibleThreadItems = createVisibleAgentThreadItems(threadItems, running);
  const activeRunItemKey =
    running === false ? null : getLatestAssistantRunItemKey(visibleThreadItems);
  const conversationVersion = visibleThreadItems
    .map((item) =>
      item.type === "user"
        ? `${item.event.id}:${item.event.createdAt}:${item.event.content}`
        : `${item.sessionId}:${item.events
            .map((event) =>
              event.type === "message"
                ? `${event.id}:${event.createdAt}:${event.content}`
                : `${event.id}:${event.createdAt}`
            )
            .join(",")}`
    )
    .join("|");

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [conversationVersion]);

  return (
    <aside className="agent-pane" aria-label="AI agent">
      <div className="pane-title agent-pane-title">
        <span className="agent-title-mark" aria-hidden="true">
          <Bot size={15} />
        </span>
        <div className="agent-title-copy">
          <span>Agent</span>
          <small>{getAgentProviderLabel(providerId)}</small>
        </div>
        <span className={`agent-connection-pill ${providerAuthStatus.state}`}>
          {running ? "Working" : formatAgentAuthState(providerAuthStatus.state)}
        </span>
        <div className="agent-title-actions">
          {running && (
            <span className="agent-run-timer" title="Elapsed run time">
              <Clock aria-hidden="true" size={13} />
              {formatElapsedTime(elapsedSeconds)}
            </span>
          )}
          <IconButton disabled={!running} label="Stop agent run" onClick={onCancel}>
            <X size={15} />
          </IconButton>
          <IconButton
            disabled={visibleThreadItems.length === 0 || running}
            label="Clear agent history"
            onClick={onClearHistory}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      <div className="agent-controls">
        <label>
          Provider
          <select
            value={providerId}
            onChange={(event) =>
              onProviderChange(event.target.value as AgentProviderId)
            }
          >
            <option value="mock">Mock</option>
            <option value="openai-codex">Codex</option>
            <option value="anthropic-claude">Claude</option>
          </select>
        </label>
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) => onModeChange(event.target.value as AgentMode)}
          >
            <option value="suggest">Ask only</option>
            <option value="apply-with-review">Review changes first</option>
            <option value="autonomous-local">Auto-apply local changes</option>
          </select>
        </label>
        <p className="agent-mode-help">{getAgentModeDescription(mode)}</p>
      </div>

      {selectedText !== null && (
        <div className="selection-actions" aria-label="Selection agent actions">
          <button
            className="text-button"
            type="button"
            onClick={() => onSelectionAction("explain")}
          >
            <MessageSquareText aria-hidden="true" size={14} />
            Explain selection
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onSelectionAction("expand-notes")}
          >
            <Pencil aria-hidden="true" size={14} />
            Expand notes
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onSelectionAction("improve-academic-tone")}
          >
            <Pencil aria-hidden="true" size={14} />
            Improve academic tone
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onSelectionAction("shorten-abstract")}
          >
            <Pencil aria-hidden="true" size={14} />
            Shorten abstract
          </button>
        </div>
      )}

      <div className="agent-thread">
        {visibleThreadItems.length === 0 ? (
          <div className="agent-empty-state">
            <span className="agent-empty-icon" aria-hidden="true">
              <MessageSquareText size={18} />
            </span>
            <strong>Ask about the current paper or request a reviewed edit.</strong>
            <p>
              Live progress appears here while the agent reads, edits, and verifies.
            </p>
          </div>
        ) : (
          <div className="agent-conversation" aria-label="Agent conversation">
            {visibleThreadItems.map((item, index) => {
              const itemKey = getAgentThreadItemKey(item);

              return item.type === "user" ? (
                <AgentUserMessage event={item.event} key={itemKey} />
              ) : (
                <AgentRunCard
                  events={item.events}
                  elapsedSeconds={elapsedSeconds}
                  isActive={itemKey === activeRunItemKey}
                  key={itemKey}
                  liveStatus={visibleLiveStatus}
                  providerId={providerId}
                  requestPrompt={getAgentRunRequestPrompt(visibleThreadItems, index)}
                  workflowEvents={getAgentRunWorkflowEvents(
                    events,
                    visibleThreadItems,
                    index
                  )}
                  onAllowApproval={onAllowApproval}
                  onDenyApproval={onDenyApproval}
                />
              );
            })}
            <div ref={threadEndRef} aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="agent-composer">
        <textarea
          ref={composerRef}
          aria-label="Agent prompt"
          value={prompt}
          placeholder="Ask for a scoped edit, compile, or project inspection..."
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              !running &&
              prompt.trim().length > 0 &&
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              onStart();
            }
          }}
        />
        <div className="agent-composer-actions">
          <span>{formatAgentModeLabel(mode)}</span>
          <div className="agent-composer-buttons">
            <button
              className="primary-button"
              type="button"
              disabled={running || prompt.trim().length === 0}
              onClick={onStart}
            >
              <Sparkles aria-hidden="true" size={15} />
              Send
            </button>
            <button
              className="text-button"
              type="button"
              disabled={!running}
              onClick={onCancel}
            >
              <X aria-hidden="true" size={15} />
              Stop
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function AgentUserMessage({
  event
}: {
  readonly event: AgentEvent & { readonly type: "message"; readonly role: "user" };
}) {
  return (
    <article className="agent-message-row user">
      <span className="agent-message-avatar" aria-hidden="true">
        Y
      </span>
      <div className="agent-message-bubble user">
        <header>
          <strong>You</strong>
          <span>{formatAgentEventTimestamp(event.createdAt)}</span>
        </header>
        <AgentRichText content={event.content} />
      </div>
    </article>
  );
}

function AgentRunCard({
  elapsedSeconds,
  events,
  isActive,
  liveStatus,
  onAllowApproval,
  onDenyApproval,
  providerId,
  requestPrompt,
  workflowEvents
}: {
  readonly elapsedSeconds: number;
  readonly events: readonly AgentEvent[];
  readonly isActive: boolean;
  readonly liveStatus: AgentLiveStatus;
  readonly onAllowApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly onDenyApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly providerId: AgentProviderId;
  readonly requestPrompt: string;
  readonly workflowEvents: readonly Exclude<AgentEvent, { readonly type: "message" }>[];
}) {
  const assistantMessages = events.filter(
    (event): event is AgentEvent & { readonly type: "message" } =>
      event.type === "message" && event.role !== "user"
  );
  const cardEvents = [...events, ...workflowEvents];
  const visibleWorkflowEvents = getVisibleAgentWorkflowEvents({
    hasAssistantResponse: assistantMessages.length > 0,
    isActive,
    workflowEvents
  });
  const latestEvent = getLatestAgentEvent(cardEvents);
  const tone = getAgentRunTone(cardEvents);
  const effectiveLiveStatus = createAgentRunLiveStatus({
    elapsedSeconds,
    events: cardEvents,
    fallback: liveStatus,
    requestPrompt
  });
  const shouldShowLiveStatus = isActive || hasOpenApproval(cardEvents);

  return (
    <article className={`agent-run-card ${tone}`}>
      <header className="agent-run-header">
        <div>
          <strong>Agent</strong>
          <span>{getAgentProviderRunLabel(providerId)}</span>
        </div>
        <span>
          {formatAgentEventTimestamp(
            latestEvent?.createdAt ?? new Date().toISOString()
          )}
        </span>
      </header>

      {shouldShowLiveStatus ? (
        <AgentRunLiveStatus
          elapsedSeconds={elapsedSeconds}
          liveStatus={effectiveLiveStatus}
        />
      ) : null}

      {(assistantMessages.length > 0 || !isActive) && (
        <div className="agent-run-response">
          {assistantMessages.length === 0 ? (
            <AgentRichText
              content={`${getAgentProviderLabel(providerId)} is working on this request.`}
            />
          ) : (
            assistantMessages.map((event, index) => {
              const isLatestMessage = index === assistantMessages.length - 1;

              return (
                <div className="agent-run-message" key={event.id}>
                  {isLatestMessage ? (
                    <RevealedAgentRichText content={event.content} />
                  ) : (
                    <AgentRichText content={event.content} />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {visibleWorkflowEvents.length > 0 && (
        <div className="agent-run-steps" aria-label="Agent run metadata">
          {visibleWorkflowEvents.map((event) => (
            <AgentRunStep
              event={event}
              key={event.id}
              onAllowApproval={onAllowApproval}
              onDenyApproval={onDenyApproval}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function AgentRunLiveStatus({
  elapsedSeconds,
  liveStatus
}: {
  readonly elapsedSeconds: number;
  readonly liveStatus: AgentLiveStatus;
}) {
  return (
    <div className={`agent-run-live ${liveStatus.tone}`} aria-live="polite">
      <div>
        <span className="agent-typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <strong>{liveStatus.title}</strong>
      </div>
      <span>{formatElapsedTime(elapsedSeconds)}</span>
      <p>{liveStatus.detail}</p>
    </div>
  );
}

function AgentRunStep({
  event,
  onAllowApproval,
  onDenyApproval
}: {
  readonly event: Exclude<AgentEvent, { readonly type: "message" }>;
  readonly onAllowApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly onDenyApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
}) {
  const tone = getAgentEventTone(event);

  if (event.type === "approval") {
    return (
      <div className={`agent-run-step ${tone}`}>
        <span className="agent-run-step-dot" aria-hidden="true" />
        <div className="agent-run-step-body">
          <header>
            <strong>{formatAgentToolName(event.toolName)} approval</strong>
            <span>{formatAgentStatusLabel(event.status)}</span>
          </header>
          <p>{event.prompt}</p>
          <div className="agent-approval-actions">
            <button
              className="text-button"
              type="button"
              disabled={event.status !== "requested"}
              onClick={() =>
                onAllowApproval(event.sessionId, event.approvalId, event.toolName)
              }
            >
              <Check aria-hidden="true" size={15} />
              Allow
            </button>
            <button
              className="text-button"
              type="button"
              disabled={event.status !== "requested"}
              onClick={() =>
                onDenyApproval(event.sessionId, event.approvalId, event.toolName)
              }
            >
              <X aria-hidden="true" size={15} />
              Deny
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`agent-run-step ${tone}`}>
      <span className="agent-run-step-dot" aria-hidden="true" />
      <div className="agent-run-step-body">
        <header>
          <strong>{getAgentWorkflowEventTitle(event)}</strong>
          <span>{getAgentWorkflowEventStatus(event)}</span>
        </header>
        <p>{getAgentWorkflowEventSummary(event)}</p>
      </div>
    </div>
  );
}

function AgentRichText({ content }: { readonly content: string }) {
  const blocks = parseAgentRichTextBlocks(content);

  return (
    <div className="agent-rich-text">
      {blocks.map((block, blockIndex) => {
        if (block.type === "code-block") {
          return (
            <figure className="agent-rich-code-block" key={`block-${blockIndex}`}>
              {block.language === null ? null : (
                <figcaption>{block.language}</figcaption>
              )}
              <pre>
                <code>{block.code}</code>
              </pre>
            </figure>
          );
        }

        if (block.type === "table") {
          return (
            <div className="agent-rich-table-wrap" key={`block-${blockIndex}`}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header, cellIndex) => (
                      <th key={`block-${blockIndex}-head-${cellIndex}`}>
                        {formatAgentInlineText(
                          header,
                          `block-${blockIndex}-head-${cellIndex}`
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`block-${blockIndex}-row-${rowIndex}`}>
                      {block.headers.map((_header, cellIndex) => (
                        <td key={`block-${blockIndex}-row-${rowIndex}-${cellIndex}`}>
                          {formatAgentInlineText(
                            row[cellIndex] ?? "",
                            `block-${blockIndex}-row-${rowIndex}-${cellIndex}`
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul key={`block-${blockIndex}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`block-${blockIndex}-item-${itemIndex}`}>
                  {formatAgentInlineText(item, `block-${blockIndex}-item-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === "ordered-list") {
          return (
            <ol key={`block-${blockIndex}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`block-${blockIndex}-item-${itemIndex}`}>
                  {formatAgentInlineText(item, `block-${blockIndex}-item-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        return (
          <p key={`block-${blockIndex}`}>
            {block.lines.map((line, lineIndex) => (
              <FragmentWithBreak
                key={`block-${blockIndex}-line-${lineIndex}`}
                includeBreak={lineIndex > 0}
              >
                {formatAgentInlineText(line, `block-${blockIndex}-line-${lineIndex}`)}
              </FragmentWithBreak>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function RevealedAgentRichText({ content }: { readonly content: string }) {
  const [visibleTokenCount, setVisibleTokenCount] = useState(0);
  const tokens = useMemo(() => content.match(/\S+\s*|\s+/gu) ?? [], [content]);

  useEffect(() => {
    setVisibleTokenCount(0);

    if (tokens.length === 0) {
      return;
    }

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReducedMotion) {
      setVisibleTokenCount(tokens.length);
      return;
    }

    const interval = window.setInterval(() => {
      setVisibleTokenCount((count) => {
        const nextCount = Math.min(tokens.length, count + 1);
        if (nextCount >= tokens.length) {
          window.clearInterval(interval);
        }
        return nextCount;
      });
    }, 70);

    return () => {
      window.clearInterval(interval);
    };
  }, [tokens]);

  if (tokens.length > 0 && visibleTokenCount === 0) {
    return <AgentTypingDots />;
  }

  return <AgentRichText content={tokens.slice(0, visibleTokenCount).join("")} />;
}

function AgentTypingDots() {
  return (
    <span className="agent-typing-dots" aria-label="Agent is typing">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}

function FragmentWithBreak({
  children,
  includeBreak
}: {
  readonly children: ReactNode;
  readonly includeBreak: boolean;
}) {
  return (
    <>
      {includeBreak && <br />}
      {children}
    </>
  );
}

function BottomPanel({
  activeTab,
  activeFile,
  activeFileDirty,
  acceptedHunkIndexesByChangeSet,
  auditEvents,
  buildResult,
  buildRunning,
  changeSetVerifications,
  historyChangeSets,
  historyMessage,
  onApplyChangeSet,
  onAttachReferenceEntry,
  onCreateChangeSet,
  onExplainChangeSetHunk,
  onActiveTabChange,
  onFixDiagnostic,
  onInsertCitation,
  onKeepUnusedReference,
  onJumpToOutlineItem,
  onProjectSearchQueryChange,
  onReferenceSearchQueryChange,
  onRefreshReferences,
  onRejectChangeSet,
  onSetChangeSetHunkAccepted,
  onRemoveUnusedReference,
  onRepairMissingCitation,
  onRollbackChangeSet,
  onRunReferenceSearch,
  onRunProjectSearch,
  onSelectChangeSet,
  onSelectDiagnostic,
  onSelectReferenceCitation,
  onSelectReferenceEntry,
  onSelectSearchResult,
  onSnapshotActiveFile,
  onSuggestCitations,
  outline,
  projectSearchQuery,
  projectSearchResults,
  referenceAnalysis,
  referenceMessage,
  referenceSearchQuery,
  referenceSearchResults,
  selectedChangeSetId,
  submissionCheckResult
}: {
  readonly activeTab: BottomTab;
  readonly activeFile: EditorFileState | null;
  readonly activeFileDirty: boolean;
  readonly acceptedHunkIndexesByChangeSet: Readonly<Record<string, readonly number[]>>;
  readonly auditEvents: readonly AuditEvent[];
  readonly buildResult: BuildResult | null;
  readonly buildRunning: boolean;
  readonly changeSetVerifications: Readonly<Record<string, ChangeSetVerification>>;
  readonly onActiveTabChange: (tab: BottomTab) => void;
  readonly historyChangeSets: readonly HistoryChangeSet[];
  readonly historyMessage: string;
  readonly onApplyChangeSet: (changesetId: string) => void;
  readonly onAttachReferenceEntry: (entry: BibliographyEntry) => void;
  readonly onCreateChangeSet: () => void;
  readonly onExplainChangeSetHunk: (filePath: string, hunkContents: string) => void;
  readonly onFixDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onInsertCitation: (key: string) => void;
  readonly onKeepUnusedReference: (entry: BibliographyEntry) => void;
  readonly onJumpToOutlineItem: (item: LatexOutlineItem) => void;
  readonly onProjectSearchQueryChange: (query: string) => void;
  readonly onReferenceSearchQueryChange: (query: string) => void;
  readonly onRefreshReferences: () => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
  readonly onSetChangeSetHunkAccepted: (
    changesetId: string,
    hunkIndex: number,
    accepted: boolean
  ) => void;
  readonly onRemoveUnusedReference: (entry: BibliographyEntry) => void;
  readonly onRepairMissingCitation: (key: string) => void;
  readonly onRollbackChangeSet: (changesetId: string) => void;
  readonly onRunReferenceSearch: () => void;
  readonly onRunProjectSearch: () => void;
  readonly onSelectChangeSet: (changesetId: string) => void;
  readonly onSelectDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onSelectReferenceCitation: (citation: CitationOccurrence) => void;
  readonly onSelectReferenceEntry: (entry: BibliographyEntry) => void;
  readonly onSelectSearchResult: (result: ProjectSearchResult) => void;
  readonly onSnapshotActiveFile: () => void;
  readonly onSuggestCitations: () => void;
  readonly outline: readonly LatexOutlineItem[];
  readonly projectSearchQuery: string;
  readonly projectSearchResults: readonly ProjectSearchResult[];
  readonly referenceAnalysis: ReferenceAnalysis;
  readonly referenceMessage: string;
  readonly referenceSearchQuery: string;
  readonly referenceSearchResults: readonly ReferenceSearchResult[];
  readonly selectedChangeSetId: string | null;
  readonly submissionCheckResult: SubmissionCheckResult | null;
}) {
  const tabs: readonly BottomTab[] = [
    "Problems",
    "References",
    "Search",
    "Outline",
    "History",
    "Log",
    "Output"
  ];

  return (
    <section className="bottom-panel" aria-label="Problems and output">
      <div className="bottom-tabs" role="tablist" aria-label="Bottom panel">
        {tabs.map((tab) => (
          <button
            className={tab === activeTab ? "active" : ""}
            key={tab}
            role="tab"
            type="button"
            aria-selected={tab === activeTab}
            onClick={() => onActiveTabChange(tab)}
          >
            {tab === "Problems" ? (
              <TriangleAlert aria-hidden="true" size={15} />
            ) : tab === "Search" ? (
              <Search aria-hidden="true" size={15} />
            ) : tab === "References" ? (
              <BookOpen aria-hidden="true" size={15} />
            ) : tab === "Outline" ? (
              <BookOpen aria-hidden="true" size={15} />
            ) : tab === "History" ? (
              <RotateCcw aria-hidden="true" size={15} />
            ) : (
              <Terminal aria-hidden="true" size={15} />
            )}
            {tab}
          </button>
        ))}
      </div>
      <div className="bottom-content" role="tabpanel">
        {activeTab === "Problems" && (
          <DiagnosticsPanel
            diagnostics={buildResult?.diagnostics ?? []}
            onFixDiagnostic={onFixDiagnostic}
            onSelectDiagnostic={onSelectDiagnostic}
          />
        )}
        {activeTab === "Search" && (
          <ProjectSearchPanel
            query={projectSearchQuery}
            results={projectSearchResults}
            onQueryChange={onProjectSearchQueryChange}
            onRunSearch={onRunProjectSearch}
            onSelectResult={onSelectSearchResult}
          />
        )}
        {activeTab === "References" && (
          <ReferencePanel
            analysis={referenceAnalysis}
            message={referenceMessage}
            query={referenceSearchQuery}
            results={referenceSearchResults}
            onAttachEntry={onAttachReferenceEntry}
            onInsertCitation={onInsertCitation}
            onKeepUnusedEntry={onKeepUnusedReference}
            onQueryChange={onReferenceSearchQueryChange}
            onRefresh={onRefreshReferences}
            onRemoveUnusedEntry={onRemoveUnusedReference}
            onRepairMissingCitation={onRepairMissingCitation}
            onRunSearch={onRunReferenceSearch}
            onSelectCitation={onSelectReferenceCitation}
            onSelectEntry={onSelectReferenceEntry}
            onSuggestCitations={onSuggestCitations}
          />
        )}
        {activeTab === "Outline" && (
          <OutlinePanel outline={outline} onJumpToOutlineItem={onJumpToOutlineItem} />
        )}
        {activeTab === "History" && (
          <HistoryPanel
            activeFile={activeFile}
            activeFileDirty={activeFileDirty}
            auditEvents={auditEvents}
            buildRunning={buildRunning}
            changesets={historyChangeSets}
            changeSetVerifications={changeSetVerifications}
            acceptedHunkIndexesByChangeSet={acceptedHunkIndexesByChangeSet}
            message={historyMessage}
            selectedChangeSetId={selectedChangeSetId}
            onApplyChangeSet={onApplyChangeSet}
            onCreateChangeSet={onCreateChangeSet}
            onExplainChangeSetHunk={onExplainChangeSetHunk}
            onRejectChangeSet={onRejectChangeSet}
            onRollbackChangeSet={onRollbackChangeSet}
            onSelectChangeSet={onSelectChangeSet}
            onSetChangeSetHunkAccepted={onSetChangeSetHunkAccepted}
            onSnapshotActiveFile={onSnapshotActiveFile}
          />
        )}
        {activeTab === "Log" && <LogPanel buildResult={buildResult} />}
        {activeTab === "Output" && (
          <pre className="log-output">
            {submissionCheckResult !== null
              ? formatSubmissionCheckResult(submissionCheckResult)
              : buildResult === null
                ? "No output."
                : `${formatBuildSecurityPolicy(buildResult)}\n\n${buildResult.command.join(" ")}\n\n${buildResult.stdout}\n${buildResult.stderr}`}
          </pre>
        )}
      </div>
    </section>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onFixDiagnostic,
  onSelectDiagnostic
}: {
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly onFixDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onSelectDiagnostic: (diagnostic: LatexDiagnostic) => void;
}) {
  if (diagnostics.length === 0) {
    return <p>No diagnostics.</p>;
  }

  return (
    <div className="result-list" role="list">
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`diagnostic-row ${diagnostic.severity}`}
          key={`${diagnostic.severity}:${diagnostic.filePath ?? ""}:${diagnostic.line ?? ""}:${diagnostic.message}:${index}`}
        >
          <button
            className="diagnostic-main"
            disabled={
              diagnostic.filePath === undefined || diagnostic.line === undefined
            }
            type="button"
            onClick={() => onSelectDiagnostic(diagnostic)}
          >
            <strong>
              {diagnostic.severity}
              {diagnostic.filePath !== undefined ? ` · ${diagnostic.filePath}` : ""}
              {diagnostic.line !== undefined ? `:${diagnostic.line}` : ""}
            </strong>
            <span>{diagnostic.message}</span>
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => onFixDiagnostic(diagnostic)}
          >
            <Sparkles aria-hidden="true" size={15} />
            Fix
          </button>
        </div>
      ))}
    </div>
  );
}

function LogPanel({ buildResult }: { readonly buildResult: BuildResult | null }) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const rawLog = buildResult?.rawLog ?? "";
  const matches = useMemo(() => findLogMatches(rawLog, query), [query, rawLog]);
  const excerpt = useMemo(
    () => createLogExcerpt(rawLog, query, matches[0]?.index),
    [matches, query, rawLog]
  );
  const hasLog = rawLog.trim().length > 0;

  useEffect(() => {
    setCopied(false);
  }, [query, rawLog]);

  const copyExcerpt = useCallback(() => {
    if (excerpt.trim().length === 0 || navigator.clipboard === undefined) {
      return;
    }

    void navigator.clipboard.writeText(excerpt).then(() => {
      setCopied(true);
    });
  }, [excerpt]);

  return (
    <div className="log-panel">
      <div className="log-toolbar">
        <div className="log-search-field">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Search build log"
            disabled={!hasLog}
            placeholder="Search raw log"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="log-match-count" aria-label="Build log search matches">
          {query.trim().length === 0
            ? "No search"
            : `${matches.length} match${matches.length === 1 ? "" : "es"}`}
        </span>
        <button
          className="text-button"
          disabled={!hasLog || excerpt.trim().length === 0}
          type="button"
          onClick={copyExcerpt}
        >
          <Copy aria-hidden="true" size={14} />
          {copied ? "Copied" : "Copy excerpt"}
        </button>
      </div>
      {buildResult?.rawLogTruncated === true && (
        <p className="log-truncation-notice">
          Log truncated: showing {buildResult.rawLogBytes ?? rawLog.length} of{" "}
          {buildResult.rawLogOriginalBytes ?? "unknown"} bytes.
        </p>
      )}
      {query.trim().length > 0 && matches.length > 0 && (
        <pre className="log-excerpt" aria-label="Build log search excerpt">
          {excerpt}
        </pre>
      )}
      <pre className="log-output">{hasLog ? rawLog : "No build log."}</pre>
    </div>
  );
}

function ProjectSearchPanel({
  onQueryChange,
  onRunSearch,
  onSelectResult,
  query,
  results
}: {
  readonly onQueryChange: (query: string) => void;
  readonly onRunSearch: () => void;
  readonly onSelectResult: (result: ProjectSearchResult) => void;
  readonly query: string;
  readonly results: readonly ProjectSearchResult[];
}) {
  return (
    <div className="project-search-panel">
      <div className="search-row">
        <input
          aria-label="Search project files"
          value={query}
          placeholder="Search project"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRunSearch();
            }
          }}
        />
        <button className="text-button" type="button" onClick={onRunSearch}>
          <Search aria-hidden="true" size={15} />
          Search
        </button>
      </div>
      <div className="result-list" role="list">
        {results.length === 0 ? (
          <p>No search results.</p>
        ) : (
          results.map((result) => (
            <button
              className="result-row"
              key={`${result.path}:${result.line}:${result.preview}`}
              type="button"
              onClick={() => onSelectResult(result)}
            >
              <strong>
                {result.path}:{result.line}
              </strong>
              <span>{result.preview}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ReferencePanel({
  analysis,
  message,
  onAttachEntry,
  onInsertCitation,
  onKeepUnusedEntry,
  onQueryChange,
  onRefresh,
  onRemoveUnusedEntry,
  onRepairMissingCitation,
  onRunSearch,
  onSelectCitation,
  onSelectEntry,
  onSuggestCitations,
  query,
  results
}: {
  readonly analysis: ReferenceAnalysis;
  readonly message: string;
  readonly onAttachEntry: (entry: BibliographyEntry) => void;
  readonly onInsertCitation: (key: string) => void;
  readonly onKeepUnusedEntry: (entry: BibliographyEntry) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onRemoveUnusedEntry: (entry: BibliographyEntry) => void;
  readonly onRepairMissingCitation: (key: string) => void;
  readonly onRunSearch: () => void;
  readonly onSelectCitation: (citation: CitationOccurrence) => void;
  readonly onSelectEntry: (entry: BibliographyEntry) => void;
  readonly onSuggestCitations: () => void;
  readonly query: string;
  readonly results: readonly ReferenceSearchResult[];
}) {
  const visibleEntries = results.length > 0 ? results : analysis.entries.slice(0, 100);
  const missingCitationGroups = groupMissingCitations(analysis.missingCitations);

  return (
    <div className="reference-panel">
      <div className="reference-toolbar">
        <div>
          <strong>{message}</strong>
          <span>
            {analysis.citations.length} citations · {analysis.entries.length} entries
          </span>
        </div>
        <button className="text-button" type="button" onClick={onSuggestCitations}>
          <Sparkles aria-hidden="true" size={15} />
          Suggest
        </button>
        <button className="text-button" type="button" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" size={15} />
          Refresh
        </button>
      </div>

      <div className="search-row">
        <input
          aria-label="Search bibliography"
          value={query}
          placeholder="Search references"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRunSearch();
            }
          }}
        />
        <button className="text-button" type="button" onClick={onRunSearch}>
          <Search aria-hidden="true" size={15} />
          Search
        </button>
      </div>

      <div className="reference-grid">
        <section className="reference-section" aria-label="Bibliography entries">
          <h3>Entries</h3>
          <div className="result-list" role="list">
            {visibleEntries.length === 0 ? (
              <p>No bibliography entries found.</p>
            ) : (
              visibleEntries.map((entry) => (
                <article
                  className="reference-row"
                  key={`${entry.filePath}:${entry.key}`}
                >
                  <button type="button" onClick={() => onSelectEntry(entry)}>
                    <strong>{entry.key}</strong>
                    <span>{entry.title ?? "Untitled reference"}</span>
                    <small>
                      {[entry.author, entry.year, entry.venue]
                        .filter((value) => value !== undefined && value.length > 0)
                        .join(" · ")}
                    </small>
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onInsertCitation(entry.key)}
                  >
                    <Plus aria-hidden="true" size={15} />
                    Insert
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onAttachEntry(entry)}
                  >
                    <MessageSquareText aria-hidden="true" size={15} />
                    Ask agent
                  </button>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="reference-section" aria-label="Citation analysis">
          <h3>Missing</h3>
          <div className="result-list compact" role="list">
            {missingCitationGroups.length === 0 ? (
              <p>No missing citations.</p>
            ) : (
              missingCitationGroups.map((group) => (
                <article className="reference-row compact" key={`missing:${group.key}`}>
                  <div className="reference-row-header">
                    <strong>{group.key}</strong>
                    <span>
                      {group.occurrences.length} occurrence
                      {group.occurrences.length === 1 ? "" : "s"}
                    </span>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => onRepairMissingCitation(group.key)}
                    >
                      <Sparkles aria-hidden="true" size={15} />
                      Agent
                    </button>
                  </div>
                  <div className="reference-occurrence-list">
                    {group.occurrences.map((citation) => (
                      <button
                        key={`${citation.filePath}:${citation.line}:${citation.command}:${citation.key}`}
                        type="button"
                        onClick={() => onSelectCitation(citation)}
                      >
                        <span>
                          {citation.filePath}:{citation.line}
                        </span>
                        <small>\\{citation.command}</small>
                      </button>
                    ))}
                  </div>
                </article>
              ))
            )}
          </div>

          <h3>Unused</h3>
          <div className="result-list compact" role="list">
            {analysis.unusedEntries.length === 0 ? (
              <p>No unused references.</p>
            ) : (
              analysis.unusedEntries.slice(0, 50).map((entry) => (
                <article
                  className="reference-row compact unused-reference-row"
                  key={`${entry.filePath}:${entry.key}`}
                >
                  <button type="button" onClick={() => onSelectEntry(entry)}>
                    <strong>{entry.key}</strong>
                    <span>{entry.title ?? `${entry.filePath}:${entry.line}`}</span>
                    <small>
                      {entry.filePath}:{entry.line}
                    </small>
                  </button>
                  <div className="reference-row-actions">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => onKeepUnusedEntry(entry)}
                    >
                      <Check aria-hidden="true" size={15} />
                      Keep
                    </button>
                    <button
                      className="text-button danger"
                      type="button"
                      onClick={() => onRemoveUnusedEntry(entry)}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      Remove
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function OutlinePanel({
  onJumpToOutlineItem,
  outline
}: {
  readonly onJumpToOutlineItem: (item: LatexOutlineItem) => void;
  readonly outline: readonly LatexOutlineItem[];
}) {
  return (
    <div className="result-list" role="list">
      {outline.length === 0 ? (
        <p>No outline for the current project.</p>
      ) : (
        outline.map((item) => (
          <button
            className={`result-row outline-row ${getOutlineLevelClass(item.kind)}`}
            key={`${item.path}:${item.kind}:${item.line}:${item.title}`}
            type="button"
            onClick={() => onJumpToOutlineItem(item)}
          >
            <strong>
              {item.kind} · {item.path}:{item.line}
            </strong>
            <span>{item.title}</span>
          </button>
        ))
      )}
    </div>
  );
}

function HistoryPanel({
  activeFile,
  activeFileDirty,
  acceptedHunkIndexesByChangeSet,
  auditEvents,
  buildRunning,
  changesets,
  changeSetVerifications,
  message,
  onApplyChangeSet,
  onCreateChangeSet,
  onExplainChangeSetHunk,
  onRejectChangeSet,
  onRollbackChangeSet,
  onSelectChangeSet,
  onSetChangeSetHunkAccepted,
  onSnapshotActiveFile,
  selectedChangeSetId
}: {
  readonly activeFile: EditorFileState | null;
  readonly activeFileDirty: boolean;
  readonly acceptedHunkIndexesByChangeSet: Readonly<Record<string, readonly number[]>>;
  readonly auditEvents: readonly AuditEvent[];
  readonly buildRunning: boolean;
  readonly changesets: readonly HistoryChangeSet[];
  readonly changeSetVerifications: Readonly<Record<string, ChangeSetVerification>>;
  readonly message: string;
  readonly onApplyChangeSet: (changesetId: string) => void;
  readonly onCreateChangeSet: () => void;
  readonly onExplainChangeSetHunk: (filePath: string, hunkContents: string) => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
  readonly onRollbackChangeSet: (changesetId: string) => void;
  readonly onSelectChangeSet: (changesetId: string) => void;
  readonly onSetChangeSetHunkAccepted: (
    changesetId: string,
    hunkIndex: number,
    accepted: boolean
  ) => void;
  readonly onSnapshotActiveFile: () => void;
  readonly selectedChangeSetId: string | null;
}) {
  const selectedChangeSet =
    changesets.find((changeset) => changeset.id === selectedChangeSetId) ??
    changesets[0] ??
    null;
  const selectedVerification =
    selectedChangeSet === null
      ? undefined
      : (changeSetVerifications[selectedChangeSet.id] ??
        (selectedChangeSet.status === "proposed"
          ? {
              status: "pending" as const,
              summary:
                "Review the inline diff, then apply the patch to run compile verification."
            }
          : undefined));
  const selectedDiffHunks =
    selectedChangeSet === null ? [] : parseUnifiedDiffHunks(selectedChangeSet.patch);
  const acceptedHunkIndexes =
    selectedChangeSet === null
      ? []
      : (acceptedHunkIndexesByChangeSet[selectedChangeSet.id] ??
        selectedDiffHunks.map((hunk) => hunk.index));
  const acceptedHunkIndexSet = new Set(acceptedHunkIndexes);

  return (
    <div className="history-panel">
      <div className="history-toolbar">
        <button
          className="text-button"
          type="button"
          disabled={activeFile === null}
          onClick={onSnapshotActiveFile}
        >
          <Save aria-hidden="true" size={15} />
          Snapshot
        </button>
        <button
          className="text-button"
          type="button"
          disabled={activeFile === null || !activeFileDirty}
          onClick={onCreateChangeSet}
        >
          <FileText aria-hidden="true" size={15} />
          Review Diff
        </button>
        <span>{message}</span>
      </div>
      <div className="history-grid">
        <div className="history-list" role="list" aria-label="Changesets">
          {changesets.length === 0 ? (
            <p>No changesets yet.</p>
          ) : (
            changesets.map((changeset) => (
              <button
                className={`history-row${changeset.id === selectedChangeSet?.id ? " active" : ""}`}
                key={changeset.id}
                type="button"
                onClick={() => onSelectChangeSet(changeset.id)}
              >
                <strong>{changeset.summary}</strong>
                <span>
                  {changeset.status} · {changeset.filePath}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="history-detail">
          {selectedChangeSet === null ? (
            <p>Select a changeset to review its patch.</p>
          ) : (
            <>
              <div className="history-detail-header">
                <div>
                  <strong>{selectedChangeSet.summary}</strong>
                  <span>
                    {selectedChangeSet.status} · {selectedChangeSet.filePath}
                  </span>
                </div>
                <div className="history-actions">
                  <button
                    className="text-button"
                    type="button"
                    disabled={
                      selectedChangeSet.status !== "proposed" ||
                      buildRunning ||
                      (selectedDiffHunks.length > 1 && acceptedHunkIndexes.length === 0)
                    }
                    onClick={() => onApplyChangeSet(selectedChangeSet.id)}
                  >
                    <Check aria-hidden="true" size={15} />
                    Apply & Verify
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={selectedChangeSet.status !== "proposed"}
                    onClick={() => onRejectChangeSet(selectedChangeSet.id)}
                  >
                    <X aria-hidden="true" size={15} />
                    Reject
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={selectedChangeSet.status !== "applied"}
                    onClick={() => onRollbackChangeSet(selectedChangeSet.id)}
                  >
                    <RotateCcw aria-hidden="true" size={15} />
                    Roll Back
                  </button>
                </div>
              </div>
              {selectedVerification !== undefined && (
                <div
                  className={`changeset-verification ${selectedVerification.status}`}
                >
                  <strong>
                    Compile verification ·{" "}
                    {formatChangeSetVerificationStatus(selectedVerification.status)}
                  </strong>
                  <span>{selectedVerification.summary}</span>
                  {selectedVerification.buildJobId !== undefined && (
                    <small>Build {selectedVerification.buildJobId}</small>
                  )}
                </div>
              )}
              {selectedDiffHunks.length === 0 ? (
                <pre className="diff-output">{selectedChangeSet.patch}</pre>
              ) : (
                <div className="diff-hunk-list" aria-label="Review hunks">
                  {selectedDiffHunks.map((hunk) => {
                    const accepted = acceptedHunkIndexSet.has(hunk.index);

                    return (
                      <article
                        className={`diff-hunk ${accepted ? "accepted" : "rejected"}`}
                        key={`${selectedChangeSet.id}:${hunk.index}`}
                      >
                        <div className="diff-hunk-header">
                          <strong>Hunk {hunk.index + 1}</strong>
                          <span>{accepted ? "Accepted" : "Rejected"}</span>
                          <div className="history-actions">
                            <button
                              className="text-button"
                              type="button"
                              disabled={selectedChangeSet.status !== "proposed"}
                              onClick={() =>
                                onExplainChangeSetHunk(
                                  selectedChangeSet.filePath,
                                  hunk.contents
                                )
                              }
                            >
                              <MessageSquareText aria-hidden="true" size={15} />
                              Explain hunk {hunk.index + 1}
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              disabled={
                                selectedChangeSet.status !== "proposed" || accepted
                              }
                              onClick={() =>
                                onSetChangeSetHunkAccepted(
                                  selectedChangeSet.id,
                                  hunk.index,
                                  true
                                )
                              }
                            >
                              <Check aria-hidden="true" size={15} />
                              Accept hunk {hunk.index + 1}
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              disabled={
                                selectedChangeSet.status !== "proposed" || !accepted
                              }
                              onClick={() =>
                                onSetChangeSetHunkAccepted(
                                  selectedChangeSet.id,
                                  hunk.index,
                                  false
                                )
                              }
                            >
                              <X aria-hidden="true" size={15} />
                              Reject hunk {hunk.index + 1}
                            </button>
                          </div>
                        </div>
                        <pre className="diff-output">{hunk.contents}</pre>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="audit-list" aria-label="Audit log">
          <strong>Action Timeline</strong>
          {auditEvents.length === 0 ? (
            <p>No audit events.</p>
          ) : (
            auditEvents.slice(0, 50).map((event) => {
              const timelineEvent = formatAuditTimelineEvent(event);

              return (
                <article className={`audit-event ${timelineEvent.tone}`} key={event.id}>
                  <strong>{timelineEvent.label}</strong>
                  <span>{timelineEvent.summary}</span>
                  <small>
                    {formatAuditTimestamp(event.createdAt)}
                    {event.changesetId === undefined
                      ? ""
                      : ` · changeset ${event.changesetId.slice(0, 8)}`}
                  </small>
                </article>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function CommandPalette({
  commands,
  onClose,
  onQueryChange,
  onRunCommand,
  open,
  query
}: {
  readonly commands: readonly CommandDefinition[];
  readonly onClose: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRunCommand: (commandId: CommandId) => void;
  readonly open: boolean;
  readonly query: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCommand = commands[activeIndex];

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.max(0, Math.min(index, commands.length - 1)));
  }, [commands.length]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
            return;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) =>
              commands.length === 0 ? 0 : Math.min(commands.length - 1, index + 1)
            );
            return;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(0, index - 1));
            return;
          }

          if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
            return;
          }

          if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(commands.length === 0 ? 0 : commands.length - 1);
            return;
          }

          if (
            event.key === "Enter" &&
            activeCommand !== undefined &&
            activeCommand.disabled !== true
          ) {
            event.preventDefault();
            onRunCommand(activeCommand.id);
          }
        }}
      >
        <div className="palette-input-row">
          <CommandIcon aria-hidden="true" size={18} />
          <input
            ref={inputRef}
            aria-label="Command search"
            aria-activedescendant={
              activeCommand === undefined
                ? undefined
                : `command-option-${activeCommand.id}`
            }
            aria-controls="command-list"
            aria-expanded="true"
            aria-autocomplete="list"
            role="combobox"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search commands"
          />
          <IconButton label="Close command palette" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <h2 id="command-palette-title" className="sr-only">
          Command Palette
        </h2>
        <div className="command-list" id="command-list" role="listbox">
          {commands.length === 0 ? (
            <p>No matching commands.</p>
          ) : (
            commands.map((command, index) => (
              <button
                aria-selected={index === activeIndex}
                className={`command-row${index === activeIndex ? " active" : ""}`}
                disabled={command.disabled}
                id={`command-option-${command.id}`}
                key={command.id}
                role="option"
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onRunCommand(command.id)}
              >
                <span>
                  <strong>{command.title}</strong>
                  <small>{command.group}</small>
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function QuickOpenDialog({
  files,
  onClose,
  onOpenFile,
  open
}: {
  readonly files: readonly ProjectFileTreeNode[];
  readonly onClose: () => void;
  readonly onOpenFile: (path: string) => void;
  readonly open: boolean;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.length === 0) {
      return files.slice(0, 80);
    }

    return files
      .filter((file) => file.path.toLowerCase().includes(normalizedQuery))
      .slice(0, 80);
  }, [files, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-open-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }

          if (event.key === "Enter" && filteredFiles[0] !== undefined) {
            onOpenFile(filteredFiles[0].path);
          }
        }}
      >
        <div className="palette-input-row">
          <FileText aria-hidden="true" size={18} />
          <input
            ref={inputRef}
            aria-label="Quick open file"
            value={query}
            placeholder="Open file"
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton label="Close quick open" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <h2 id="quick-open-title" className="sr-only">
          Quick Open
        </h2>
        <div className="command-list" role="listbox">
          {filteredFiles.length === 0 ? (
            <p className="empty-state">No matching files.</p>
          ) : (
            filteredFiles.map((file) => (
              <button
                className="command-row"
                key={file.path}
                type="button"
                onClick={() => onOpenFile(file.path)}
              >
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsDialog({
  activeTab,
  agentAuthRefreshRunning,
  agentAuthStatuses,
  agentMode,
  agentProviderId,
  appSettings,
  keybindingQuery,
  onActiveTabChange,
  onClearLocalHistory,
  onCheckForUpdates,
  onClose,
  onInstallUpdate,
  onKeybindingQueryChange,
  onOpenProviderSetupTerminal,
  onOpenUpdateDownload,
  onRefreshPrivacySummary,
  onRefreshAgentAuthStatuses,
  onSetAgentMode,
  onSetAgentProviderId,
  onSetCompiler,
  onSettingsChange,
  privacySummary,
  updateCheckResult,
  updateCheckRunning,
  updateInstallRunning,
  open
}: {
  readonly activeTab: SettingsTab;
  readonly agentAuthRefreshRunning: boolean;
  readonly agentAuthStatuses: AgentAuthStatusByProvider;
  readonly agentMode: AgentMode;
  readonly agentProviderId: AgentProviderId;
  readonly appSettings: AppSettings;
  readonly keybindingQuery: string;
  readonly onActiveTabChange: (tab: SettingsTab) => void;
  readonly onClearLocalHistory: () => void;
  readonly onCheckForUpdates: () => void;
  readonly onClose: () => void;
  readonly onInstallUpdate: (url: string) => void;
  readonly onKeybindingQueryChange: (query: string) => void;
  readonly onOpenProviderSetupTerminal: (
    providerId: AgentProviderId,
    action: AgentProviderSetupAction
  ) => void;
  readonly onOpenUpdateDownload: (url: string) => void;
  readonly onRefreshPrivacySummary: () => void;
  readonly onRefreshAgentAuthStatuses: () => void;
  readonly onSetAgentMode: (mode: AgentMode) => void;
  readonly onSetAgentProviderId: (providerId: AgentProviderId) => void;
  readonly onSetCompiler: (compiler: LatexCompiler) => void;
  readonly onSettingsChange: (updater: (settings: AppSettings) => AppSettings) => void;
  readonly privacySummary: PrivacySummary | null;
  readonly updateCheckResult: AppUpdateCheckResult | null;
  readonly updateCheckRunning: boolean;
  readonly updateInstallRunning: boolean;
  readonly open: boolean;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Preferences</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {settingsTabs.map((tab) => (
              <button
                className={tab === activeTab ? "active" : ""}
                key={tab}
                type="button"
                onClick={() => onActiveTabChange(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>
          <SettingsTabPanel
            agentAuthRefreshRunning={agentAuthRefreshRunning}
            agentAuthStatuses={agentAuthStatuses}
            agentMode={agentMode}
            agentProviderId={agentProviderId}
            keybindingQuery={keybindingQuery}
            privacySummary={privacySummary}
            settings={appSettings}
            tab={activeTab}
            onClearLocalHistory={onClearLocalHistory}
            onCheckForUpdates={onCheckForUpdates}
            onInstallUpdate={onInstallUpdate}
            onKeybindingQueryChange={onKeybindingQueryChange}
            onOpenProviderSetupTerminal={onOpenProviderSetupTerminal}
            onOpenUpdateDownload={onOpenUpdateDownload}
            onRefreshPrivacySummary={onRefreshPrivacySummary}
            onRefreshAgentAuthStatuses={onRefreshAgentAuthStatuses}
            onSetAgentMode={onSetAgentMode}
            onSetAgentProviderId={onSetAgentProviderId}
            onSetCompiler={onSetCompiler}
            onSettingsChange={onSettingsChange}
            updateCheckResult={updateCheckResult}
            updateCheckRunning={updateCheckRunning}
            updateInstallRunning={updateInstallRunning}
          />
        </div>
      </section>
    </div>
  );
}

function SettingsTabPanel({
  agentAuthRefreshRunning,
  agentAuthStatuses,
  agentMode,
  agentProviderId,
  keybindingQuery,
  onClearLocalHistory,
  onCheckForUpdates,
  onInstallUpdate,
  onKeybindingQueryChange,
  onOpenProviderSetupTerminal,
  onOpenUpdateDownload,
  onRefreshPrivacySummary,
  onRefreshAgentAuthStatuses,
  onSetAgentMode,
  onSetAgentProviderId,
  onSetCompiler,
  onSettingsChange,
  privacySummary,
  settings,
  tab,
  updateCheckResult,
  updateCheckRunning,
  updateInstallRunning
}: {
  readonly agentAuthRefreshRunning: boolean;
  readonly agentAuthStatuses: AgentAuthStatusByProvider;
  readonly agentMode: AgentMode;
  readonly agentProviderId: AgentProviderId;
  readonly keybindingQuery: string;
  readonly onClearLocalHistory: () => void;
  readonly onCheckForUpdates: () => void;
  readonly onInstallUpdate: (url: string) => void;
  readonly onKeybindingQueryChange: (query: string) => void;
  readonly onOpenProviderSetupTerminal: (
    providerId: AgentProviderId,
    action: AgentProviderSetupAction
  ) => void;
  readonly onOpenUpdateDownload: (url: string) => void;
  readonly onRefreshPrivacySummary: () => void;
  readonly onRefreshAgentAuthStatuses: () => void;
  readonly onSetAgentMode: (mode: AgentMode) => void;
  readonly onSetAgentProviderId: (providerId: AgentProviderId) => void;
  readonly onSetCompiler: (compiler: LatexCompiler) => void;
  readonly onSettingsChange: (updater: (settings: AppSettings) => AppSettings) => void;
  readonly privacySummary: PrivacySummary | null;
  readonly settings: AppSettings;
  readonly tab: SettingsTab;
  readonly updateCheckResult: AppUpdateCheckResult | null;
  readonly updateCheckRunning: boolean;
  readonly updateInstallRunning: boolean;
}) {
  const filteredKeybindings = commandDefinitions.filter((command) => {
    const query = keybindingQuery.trim().toLowerCase();

    if (query.length === 0) {
      return true;
    }

    return `${command.title} ${command.group} ${command.shortcut ?? ""}`
      .toLowerCase()
      .includes(query);
  });
  const updateDownloadUrl =
    updateCheckResult?.state === "available"
      ? updateCheckResult.downloadUrl
      : undefined;
  const updateReleaseNotesUrl = updateCheckResult?.releaseNotesUrl;

  return (
    <div className="settings-panel" role="tabpanel">
      {tab === "Editor" && (
        <>
          <TextField
            label="Font family"
            value={settings.editor.fontFamily}
            onChange={(fontFamily) =>
              onSettingsChange((current) => ({
                ...current,
                editor: { ...current.editor, fontFamily }
              }))
            }
          />
          <NumberField
            label="Font size"
            max={24}
            min={11}
            value={settings.editor.fontSize}
            onChange={(fontSize) =>
              onSettingsChange((current) => ({
                ...current,
                editor: { ...current.editor, fontSize }
              }))
            }
          />
          <NumberField
            label="Line height"
            max={36}
            min={16}
            value={settings.editor.lineHeight}
            onChange={(lineHeight) =>
              onSettingsChange((current) => ({
                ...current,
                editor: { ...current.editor, lineHeight }
              }))
            }
          />
          <Toggle
            checked={settings.editor.autocomplete}
            label="Autocomplete"
            onChange={(autocomplete) =>
              onSettingsChange((current) => ({
                ...current,
                editor: { ...current.editor, autocomplete }
              }))
            }
          />
          <Toggle
            checked={settings.editor.minimap}
            label="Minimap"
            onChange={(minimap) =>
              onSettingsChange((current) => ({
                ...current,
                editor: { ...current.editor, minimap }
              }))
            }
          />
        </>
      )}
      {tab === "Compiler" && (
        <>
          <SelectField
            label="Engine"
            value={settings.compiler.compiler}
            options={[
              ["pdflatex", "pdfLaTeX"],
              ["xelatex", "XeLaTeX"],
              ["lualatex", "LuaLaTeX"]
            ]}
            onChange={(value) => onSetCompiler(value as LatexCompiler)}
          />
          <SelectField
            label="Build profile"
            value={settings.compiler.buildProfile}
            options={[
              ["synctex", "SyncTeX"],
              ["normal", "Normal"],
              ["draft", "Draft"]
            ]}
            onChange={(buildProfile) =>
              onSettingsChange((current) => ({
                ...current,
                compiler: {
                  ...current.compiler,
                  buildProfile: buildProfile as AppSettings["compiler"]["buildProfile"]
                }
              }))
            }
          />
          <TextField
            label="TeX path"
            placeholder="Use system PATH"
            value={settings.compiler.texPath}
            onChange={(texPath) =>
              onSettingsChange((current) => ({
                ...current,
                compiler: { ...current.compiler, texPath }
              }))
            }
          />
          <Toggle
            checked={settings.compiler.shellEscape}
            disabled
            label="Shell escape"
          />
          <p className="settings-note">
            Shell escape stays disabled by default. Any future shell-escape build path
            must require explicit approval, and the agent cannot enable it.
          </p>
        </>
      )}
      {tab === "AI Providers" && (
        <>
          <p className="settings-note">
            Connect an AI provider once on this computer. ZeroLeaf opens the official
            setup command in Terminal, then the provider opens your browser for login.
            This app does not request or store provider API keys.
          </p>
          {agentProviderIds.map((providerId) => (
            <ProviderSettingsRow
              authStatus={agentAuthStatuses[providerId]}
              authStatusRefreshRunning={agentAuthRefreshRunning}
              credentialStatus={settings.credentials.find(
                (credential) => credential.providerId === providerId
              )}
              key={providerId}
              onOpenProviderSetupTerminal={onOpenProviderSetupTerminal}
              onRefreshAgentAuthStatuses={onRefreshAgentAuthStatuses}
              providerId={providerId}
            />
          ))}
          <SelectField
            label="Default provider"
            value={agentProviderId}
            options={agentProviderIds.map((providerId) => [
              providerId,
              getAgentProviderLabel(providerId)
            ])}
            onChange={(value) => onSetAgentProviderId(value as AgentProviderId)}
          />
          <button
            className="text-button settings-action"
            type="button"
            disabled={agentAuthRefreshRunning}
            onClick={onRefreshAgentAuthStatuses}
          >
            <RefreshCw aria-hidden="true" size={15} />
            {agentAuthRefreshRunning
              ? "Checking provider status"
              : "Refresh provider status"}
          </button>
        </>
      )}
      {tab === "Agent Permissions" && (
        <>
          <SelectField
            label="Default mode"
            value={agentMode}
            options={[
              ["suggest", "Ask only"],
              ["apply-with-review", "Review changes first"],
              ["autonomous-local", "Auto-apply local changes"]
            ]}
            onChange={(value) => onSetAgentMode(value as AgentMode)}
          />
          <p className="settings-note mode-note">
            {getAgentModeDescription(agentMode)}
          </p>
          <p className="settings-note">
            Auto-apply local changes is advanced. It can edit files and run local
            compile inside the open project without stopping for review.
          </p>
          <Toggle
            checked={settings.agentPermissions.compileAfterPatch}
            label="Compile after patch"
            onChange={(compileAfterPatch) =>
              onSettingsChange((current) => ({
                ...current,
                agentPermissions: {
                  ...current.agentPermissions,
                  compileAfterPatch
                }
              }))
            }
          />
          <Toggle
            checked={settings.agentPermissions.requireApprovalForPatches}
            label="Require patch approval"
            onChange={(requireApprovalForPatches) =>
              onSettingsChange((current) => ({
                ...current,
                agentPermissions: {
                  ...current.agentPermissions,
                  requireApprovalForPatches
                }
              }))
            }
          />
          <SelectField
            label="Network tools"
            value={settings.agentPermissions.networkPolicy}
            options={[
              ["blocked", "Blocked"],
              ["ask", "Ask every time"]
            ]}
            onChange={(networkPolicy) =>
              onSettingsChange((current) => ({
                ...current,
                agentPermissions: {
                  ...current.agentPermissions,
                  networkPolicy:
                    networkPolicy as AppSettings["agentPermissions"]["networkPolicy"]
                }
              }))
            }
          />
          <NumberField
            label="Max turns"
            max={10}
            min={1}
            value={settings.agentPermissions.maxTurns}
            onChange={(maxTurns) =>
              onSettingsChange((current) => ({
                ...current,
                agentPermissions: { ...current.agentPermissions, maxTurns }
              }))
            }
          />
        </>
      )}
      {tab === "Appearance" && (
        <>
          <Field label="Theme" value="Light" />
          <SelectField
            label="Density"
            value={settings.appearance.density}
            options={[
              ["comfortable", "Comfortable"],
              ["compact", "Compact"]
            ]}
            onChange={(density) =>
              onSettingsChange((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  density: density as AppSettings["appearance"]["density"]
                }
              }))
            }
          />
          <SelectField
            label="Accent"
            value={settings.appearance.accent}
            options={[
              ["teal", "Teal"],
              ["blue", "Blue"],
              ["green", "Green"]
            ]}
            onChange={(accent) =>
              onSettingsChange((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  accent: accent as AppSettings["appearance"]["accent"]
                }
              }))
            }
          />
          <Toggle
            checked={settings.appearance.highContrastLight}
            label="High contrast light"
            onChange={(highContrastLight) =>
              onSettingsChange((current) => ({
                ...current,
                appearance: { ...current.appearance, highContrastLight }
              }))
            }
          />
        </>
      )}
      {tab === "Updates" && (
        <>
          <Toggle
            checked={settings.updates.checkOnStartup}
            label="Check at startup"
            onChange={(checkOnStartup) =>
              onSettingsChange((current) => ({
                ...current,
                updates: { ...current.updates, checkOnStartup }
              }))
            }
          />
          <section className="update-status-panel" aria-label="Update status">
            <div className="update-status-heading">
              <div>
                <strong>{formatUpdateStatusTitle(updateCheckResult)}</strong>
                <p>{updateCheckResult?.message ?? "No update check has run yet."}</p>
              </div>
              <span
                className={`update-status-pill ${updateCheckResult?.state ?? "idle"}`}
              >
                {formatUpdateState(updateCheckResult?.state)}
              </span>
            </div>
            <div className="update-version-grid">
              <Field
                label="Current version"
                value={updateCheckResult?.currentVersion ?? "Unknown"}
              />
              <Field
                label="Latest version"
                value={updateCheckResult?.latestVersion ?? "Unknown"}
              />
              <Field
                label="Last checked"
                value={formatUpdateCheckedAt(updateCheckResult)}
              />
            </div>
          </section>
          <div className="settings-action-row">
            <button
              className="text-button settings-action"
              type="button"
              disabled={updateCheckRunning || updateInstallRunning}
              onClick={onCheckForUpdates}
            >
              <RefreshCw aria-hidden="true" size={15} />
              {updateCheckRunning ? "Checking" : "Check for updates"}
            </button>
            {updateDownloadUrl !== undefined && (
              <button
                className="text-button settings-action"
                type="button"
                disabled={updateInstallRunning}
                onClick={() => onInstallUpdate(updateDownloadUrl)}
              >
                <Download aria-hidden="true" size={15} />
                {updateInstallRunning ? "Installing" : "Install update"}
              </button>
            )}
            {updateReleaseNotesUrl !== undefined && (
              <button
                className="text-button settings-action"
                type="button"
                onClick={() => onOpenUpdateDownload(updateReleaseNotesUrl)}
              >
                <FileText aria-hidden="true" size={15} />
                Release notes
              </button>
            )}
          </div>
          <p className="settings-note">
            Release builds read a configured release feed. When a newer macOS DMG is
            found, ZeroLeaf downloads it, quits, installs the replacement app bundle,
            and relaunches. Project files and settings are stored outside the app
            bundle.
          </p>
        </>
      )}
      {tab === "Keybindings" && (
        <>
          <TextField
            label="Search"
            placeholder="Command, group, or shortcut"
            value={keybindingQuery}
            onChange={onKeybindingQueryChange}
          />
          <div className="keybinding-list">
            {filteredKeybindings.map((command) => (
              <div className="keybinding-row" key={command.id}>
                <span>
                  <strong>{command.title}</strong>
                  <small>{command.group}</small>
                </span>
                <kbd>{command.shortcut ?? "Unassigned"}</kbd>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === "Privacy" && (
        <>
          <Toggle
            checked={settings.privacy.storeAgentTranscripts}
            label="Store agent transcripts"
            onChange={(storeAgentTranscripts) =>
              onSettingsChange((current) => ({
                ...current,
                privacy: { ...current.privacy, storeAgentTranscripts }
              }))
            }
          />
          <Toggle
            checked={settings.privacy.storeBuildLogs}
            label="Store build logs"
            onChange={(storeBuildLogs) =>
              onSettingsChange((current) => ({
                ...current,
                privacy: { ...current.privacy, storeBuildLogs }
              }))
            }
          />
          <Field
            label="Data location"
            value={privacySummary?.dataLocation ?? "Local profile"}
          />
          <div className="privacy-summary">
            <span>Projects: {privacySummary?.projectCount ?? 0}</span>
            <span>Snapshots: {privacySummary?.snapshotCount ?? 0}</span>
            <span>Changesets: {privacySummary?.changesetCount ?? 0}</span>
            <span>Audit events: {privacySummary?.auditEventCount ?? 0}</span>
            <span>Build jobs: {privacySummary?.buildJobCount ?? 0}</span>
            <span>Agent sessions: {privacySummary?.agentSessionCount ?? 0}</span>
          </div>
          <div className="settings-action-row">
            <button
              className="text-button settings-action"
              type="button"
              onClick={onRefreshPrivacySummary}
            >
              <RefreshCw aria-hidden="true" size={15} />
              Refresh privacy summary
            </button>
            <button
              className="text-button settings-action danger"
              type="button"
              onClick={onClearLocalHistory}
            >
              <Trash2 aria-hidden="true" size={15} />
              Clear local history
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProviderSettingsRow({
  authStatus,
  authStatusRefreshRunning,
  credentialStatus,
  onOpenProviderSetupTerminal,
  onRefreshAgentAuthStatuses,
  providerId
}: {
  readonly authStatus: AgentAuthStatus;
  readonly authStatusRefreshRunning: boolean;
  readonly credentialStatus: AppSettings["credentials"][number] | undefined;
  readonly onOpenProviderSetupTerminal: (
    providerId: AgentProviderId,
    action: AgentProviderSetupAction
  ) => void;
  readonly onRefreshAgentAuthStatuses: () => void;
  readonly providerId: AgentProviderId;
}) {
  if (providerId === "mock") {
    return (
      <section
        className="provider-settings-row"
        aria-label={getAgentProviderLabel(providerId)}
      >
        <div>
          <strong>{getAgentProviderLabel(providerId)}</strong>
          <p>{getAgentProviderNote(providerId)}</p>
        </div>
        <span className={`provider-status-pill ${authStatus.state}`}>
          {formatAgentAuthState(authStatus.state)}
        </span>
        {authStatus.message !== undefined && <p>{authStatus.message}</p>}
      </section>
    );
  }

  const setupSteps = getProviderSetupSteps(authStatus, providerId);

  return (
    <section
      className="provider-settings-row"
      aria-label={getAgentProviderLabel(providerId)}
    >
      <div className="provider-settings-heading">
        <strong>{getAgentProviderLabel(providerId)}</strong>
        <p>{getAgentProviderNote(providerId)}</p>
      </div>
      <span className={`provider-status-pill ${authStatus.state}`}>
        {formatAgentAuthState(authStatus.state)}
      </span>
      {authStatus.message !== undefined && <p>{authStatus.message}</p>}
      {credentialStatus !== undefined && <p>{credentialStatus.message}</p>}
      <ol className="provider-setup-steps">
        {setupSteps.map((step) => (
          <li className={step.state} key={step.id}>
            <span className="provider-step-index" aria-hidden="true">
              {step.index}
            </span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
              {step.action !== undefined && (
                <button
                  className="text-button settings-action"
                  type="button"
                  disabled={step.state === "complete"}
                  onClick={() =>
                    onOpenProviderSetupTerminal(providerId, step.action ?? "install")
                  }
                >
                  <Terminal aria-hidden="true" size={15} />
                  {step.actionLabel}
                </button>
              )}
              {step.id === "refresh" && (
                <button
                  className="text-button settings-action"
                  type="button"
                  disabled={authStatusRefreshRunning}
                  onClick={onRefreshAgentAuthStatuses}
                >
                  <RefreshCw aria-hidden="true" size={15} />
                  {authStatusRefreshRunning ? "Checking" : "Refresh status"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatUpdateStatusTitle(result: AppUpdateCheckResult | null): string {
  switch (result?.state) {
    case "available":
      return "Update available";
    case "current":
      return "Up to date";
    case "not-configured":
      return "Update checks not configured";
    case "error":
      return "Update check failed";
    default:
      return "Update status";
  }
}

function formatUpdateState(state: AppUpdateCheckResult["state"] | undefined): string {
  switch (state) {
    case "available":
      return "Available";
    case "current":
      return "Current";
    case "not-configured":
      return "Setup needed";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function formatUpdateCheckedAt(result: AppUpdateCheckResult | null): string {
  if (result === null) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(result.checkedAt));
}

function getProviderSetupSteps(
  authStatus: AgentAuthStatus,
  providerId: Exclude<AgentProviderId, "mock">
): readonly {
  readonly id: "install" | "login" | "refresh";
  readonly index: number;
  readonly title: string;
  readonly detail: string;
  readonly state: "complete" | "current" | "pending";
  readonly action?: AgentProviderSetupAction;
  readonly actionLabel?: string;
}[] {
  const installed =
    authStatus.state === "connected" || authStatus.state === "needs-auth";
  const connected = authStatus.state === "connected";
  const providerName = getAgentProviderLabel(providerId);
  const loginDetail =
    providerId === "openai-codex"
      ? "Sign in with ChatGPT in the browser to use an eligible Plus, Pro, Business, Edu, or Enterprise subscription."
      : "Sign in with the Claude account that includes Claude Code access, such as Pro, Max, Team, Enterprise, or Console.";

  return [
    {
      id: "install",
      index: 1,
      title: `Install ${providerName}`,
      detail: "Open Terminal and run the official installer for this provider.",
      state: installed ? "complete" : "current",
      action: "install",
      actionLabel: installed ? "Installed" : "Install"
    },
    {
      id: "login",
      index: 2,
      title: "Log in with your subscription",
      detail: loginDetail,
      state: connected ? "complete" : installed ? "current" : "pending",
      action: "login",
      actionLabel: connected ? "Connected" : "Log in"
    },
    {
      id: "refresh",
      index: 3,
      title: "Confirm connection",
      detail:
        "Refresh after the browser login finishes so ZeroLeaf can use this provider.",
      state: connected ? "complete" : "pending"
    }
  ];
}

function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <input value={value} readOnly />
    </label>
  );
}

function TextField({
  label,
  onChange,
  placeholder,
  value
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <input
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  max,
  min,
  onChange,
  value
}: {
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
  readonly value: string;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({
  checked = false,
  disabled = false,
  onChange,
  label
}: {
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
        readOnly={onChange === undefined}
        type="checkbox"
        onChange={(event) => onChange?.(event.target.checked)}
      />
    </label>
  );
}

function PaneResizer({
  label,
  onKeyDown,
  onPointerDown,
  orientation
}: {
  readonly label: string;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly orientation: "horizontal" | "vertical";
}) {
  return (
    <div
      className={`pane-resizer ${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      title={label}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}

let monacoConfigured = false;
let latexCompletionState = createLatexCompletionState();

function configureMonaco(monaco: Monaco) {
  if (monacoConfigured) {
    return;
  }

  monacoConfigured = true;
  monaco.languages.register({ id: "latex" });
  monaco.languages.register({ id: "bibtex" });
  monaco.editor.defineTheme("latex-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "235b5f", fontStyle: "bold" },
      { token: "comment", foreground: "65747b" },
      { token: "string", foreground: "7a4f1b" }
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#17252a",
      "editor.lineHighlightBackground": "#eef5f3",
      "editorCursor.foreground": "#2f6f73",
      "editorLineNumber.foreground": "#8a9aa2"
    }
  });

  monaco.languages.setMonarchTokensProvider("latex", {
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [/\\[a-zA-Z@]+/, "keyword"],
        [/\{[^}]*\}/, "string"]
      ]
    }
  });

  const completionProvider: Parameters<
    typeof monaco.languages.registerCompletionItemProvider
  >[1] = {
    triggerCharacters: ["\\", "{", ","],
    provideCompletionItems: (
      _model: MonacoEditorApi.ITextModel,
      position: IPosition
    ) => {
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - 1),
        endColumn: position.column
      };

      const citationSuggestions = latexCompletionState.citations.map((entry) => ({
        label: entry.key,
        kind: monaco.languages.CompletionItemKind.Reference,
        insertText: entry.key,
        detail: entry.title ?? entry.author ?? "Citation",
        documentation: [
          entry.title ?? entry.key,
          entry.author === undefined ? "" : `Author: ${entry.author}`,
          entry.year === undefined ? "" : `Year: ${entry.year}`,
          entry.venue === undefined ? "" : `Venue: ${entry.venue}`
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
        range
      }));
      const labelSuggestions = latexCompletionState.labels.map((entry) => ({
        label: entry.key,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: entry.key,
        detail: `${entry.path}:${entry.line}`,
        documentation: `Label ${entry.key}`,
        range
      }));

      return {
        suggestions: [
          ...latexSnippets.map((snippet) => ({
            label: snippet.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: snippet.insertText,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: snippet.documentation,
            range
          })),
          ...citationSuggestions,
          ...labelSuggestions
        ]
      };
    }
  };

  monaco.languages.registerCompletionItemProvider("latex", completionProvider);
}

function setMonacoCompletionProject(projectRoot: string) {
  latexCompletionState = startLatexCompletionProject(latexCompletionState, projectRoot);
}

function clearMonacoProjectCompletions() {
  latexCompletionState = clearLatexCompletionProject(latexCompletionState);
}

function updateMonacoCitationCompletions(
  projectRoot: string,
  entries: readonly BibliographyEntry[]
) {
  latexCompletionState = updateLatexCompletionCitations(
    latexCompletionState,
    projectRoot,
    entries
  );
}

function updateMonacoLabelCompletions(
  projectRoot: string | null,
  labels: ReturnType<typeof getLatexLabelReferences>
) {
  if (projectRoot === null) {
    clearMonacoProjectCompletions();
    return;
  }

  latexCompletionState = updateLatexCompletionLabels(
    latexCompletionState,
    projectRoot,
    labels
  );
}

function focusMonacoFind(editor: MonacoStandaloneEditor | null) {
  void editor?.getAction("actions.find")?.run();
}

function getMonacoLayoutElement(editor: MonacoStandaloneEditor) {
  const container = editor.getContainerDomNode();

  return container.parentElement ?? container;
}

function layoutMonacoEditorToContainer(editor: MonacoStandaloneEditor | null) {
  if (editor === null) {
    return;
  }

  const rect = getMonacoLayoutElement(editor).getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);

  if (width <= 0 || height <= 0) {
    return;
  }

  editor.layout({ width, height });
}

function installE2EEditorHooks(editor: MonacoStandaloneEditor) {
  const targetWindow = window as unknown as {
    __latexAgentE2E?: {
      setEditorPosition: (
        path: string,
        line: number,
        column: number
      ) => { readonly ok: boolean; readonly line?: number; readonly column?: number };
      getEditorPosition: (path: string) => {
        readonly ok: boolean;
        readonly line?: number;
        readonly column?: number;
        readonly lineText?: string;
      };
    };
  };

  targetWindow.__latexAgentE2E = {
    setEditorPosition: (path, line, column) => {
      const model = editor.getModel();
      const uri = model?.uri.toString() ?? "";
      const activePath = path.split("/").at(-1) ?? path;

      if (model === null || (!uri.includes(path) && !uri.endsWith(activePath))) {
        return { ok: false };
      }

      const safeLine = Math.min(Math.max(1, line), model.getLineCount());
      const safeColumn = Math.min(
        Math.max(1, column),
        model.getLineMaxColumn(safeLine)
      );
      editor.revealLineInCenter(safeLine);
      editor.setPosition({ lineNumber: safeLine, column: safeColumn });
      editor.focus();

      return { ok: true, line: safeLine, column: safeColumn };
    },
    getEditorPosition: (path) => {
      const model = editor.getModel();
      const uri = model?.uri.toString() ?? "";
      const activePath = path.split("/").at(-1) ?? path;
      const position = editor.getPosition();

      if (
        model === null ||
        position === null ||
        (!uri.includes(path) && !uri.endsWith(activePath))
      ) {
        return { ok: false };
      }

      return {
        ok: true,
        line: position.lineNumber,
        column: position.column,
        lineText: model.getLineContent(position.lineNumber)
      };
    }
  };
}

function getOutlineLevelClass(kind: LatexOutlineItem["kind"]) {
  if (kind === "part" || kind === "chapter") {
    return "level-1";
  }

  if (kind === "section") {
    return "level-2";
  }

  if (kind === "subsection") {
    return "level-3";
  }

  return "level-4";
}

async function renderPdfPage(
  document: PDFDocumentProxy,
  canvas: HTMLCanvasElement,
  pageNumber: number,
  scale: number
) {
  const page: PDFPageProxy = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const context = canvas.getContext("2d");

  if (context === null) {
    return;
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({
    canvas,
    canvasContext: context,
    viewport
  }).promise;
}

function createInitialAgentAuthStatuses(): AgentAuthStatusByProvider {
  return {
    mock: {
      providerId: "mock",
      state: "connected",
      message: "Mock provider is available locally."
    },
    "openai-codex": {
      providerId: "openai-codex",
      state: "disconnected",
      message: "Checking installed Codex CLI status."
    },
    "anthropic-claude": {
      providerId: "anthropic-claude",
      state: "disconnected",
      message: "Claude provider is not connected yet."
    }
  };
}

function readStoredAgentProvider(fallback: AgentProviderId): AgentProviderId {
  try {
    const storedProvider = window.localStorage.getItem(agentProviderStorageKey);
    return agentProviderIds.includes(storedProvider as AgentProviderId)
      ? (storedProvider as AgentProviderId)
      : fallback;
  } catch {
    return fallback;
  }
}

function createAgentSelectionContext(
  editor: MonacoStandaloneEditor,
  selection: MonacoApi.Selection
): AgentSelectionContext | null {
  const model = editor.getModel();

  if (model === null || selection.isEmpty()) {
    return null;
  }

  return createSelectionContextFromText({
    contents: model.getValue(),
    selection: {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn
    }
  });
}

function getSelectionAgentDefaultPrompt(action: SelectionAgentAction): string {
  switch (action) {
    case "explain":
      return "Explain the selected text using the containing paragraph as context.";
    case "expand-notes":
      return "Expand the selected rough notes into polished academic prose.";
    case "improve-academic-tone":
      return "Improve the academic tone of the selected text.";
    case "shorten-abstract":
      return "Shorten the selected abstract while preserving required contribution statements.";
    case "rewrite":
      return "Rewrite the selected text while preserving the meaning and LaTeX structure.";
  }
}

function writeStoredAgentProvider(providerId: AgentProviderId) {
  try {
    window.localStorage.setItem(agentProviderStorageKey, providerId);
  } catch {
    // Local storage may be unavailable in restricted browser contexts.
  }
}

function readStoredAgentHistory(): readonly AgentEvent[] {
  try {
    const rawHistory = window.localStorage.getItem(agentHistoryStorageKey);
    if (rawHistory === null) {
      return [];
    }

    const parsed = JSON.parse(rawHistory) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStoredAgentMessageEvent).slice(-24);
  } catch {
    return [];
  }
}

function writeStoredAgentHistory(events: readonly AgentEvent[]) {
  try {
    const messageEvents = events
      .filter((event) => event.type === "message")
      .filter((event) => !isOperationalAgentStatusMessage(event.content))
      .slice(-24);

    if (messageEvents.length === 0) {
      window.localStorage.removeItem(agentHistoryStorageKey);
      return;
    }

    window.localStorage.setItem(agentHistoryStorageKey, JSON.stringify(messageEvents));
  } catch {
    // Local storage is an enhancement only; the agent must still work without it.
  }
}

function isStoredAgentMessageEvent(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AgentEvent>;
  return (
    candidate.type === "message" &&
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.createdAt === "string" &&
    (candidate.role === "user" ||
      candidate.role === "assistant" ||
      candidate.role === "system") &&
    typeof candidate.content === "string"
  );
}

function useAgentElapsedSeconds(running: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [running]);

  return elapsedSeconds;
}

function getAgentProviderLabel(providerId: AgentProviderId): string {
  switch (providerId) {
    case "mock":
      return "Mock";
    case "openai-codex":
      return "Codex";
    case "anthropic-claude":
      return "Claude";
  }
}

function getAgentProviderRunLabel(providerId: AgentProviderId): string {
  switch (providerId) {
    case "mock":
      return "via local_mock";
    case "openai-codex":
      return "via codex_cli";
    case "anthropic-claude":
      return "via claude_cli";
  }
}

function getAgentProviderNote(providerId: AgentProviderId): string {
  switch (providerId) {
    case "mock":
      return "Local deterministic provider for workflow testing.";
    case "openai-codex":
      return "Uses the installed Codex CLI for planning, then routes edits and builds through ZeroLeaf tools.";
    case "anthropic-claude":
      return "Uses the installed Claude Code CLI, then proposes reviewable patches.";
  }
}

function formatAgentAuthState(state: AgentAuthStatus["state"]): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "needs-auth":
      return "Needs login";
    case "error":
      return "Error";
  }
}

function formatAgentModeLabel(mode: AgentMode): string {
  switch (mode) {
    case "apply-with-review":
      return "Review changes first";
    case "suggest":
      return "Ask only";
    case "read-only":
      return "Ask only";
    case "autonomous-local":
      return "Auto-apply local changes";
  }
}

function getAgentModeDescription(mode: AgentMode): string {
  switch (mode) {
    case "suggest":
    case "read-only":
      return "The agent can answer questions and prepare suggested edits, but it will not change files.";
    case "apply-with-review":
      return "The agent can prepare changes, then waits for you to review and approve before files are changed.";
    case "autonomous-local":
      return "The agent can edit files and run local compile inside the open project without stopping for review.";
  }
}

function formatAgentToolName(toolName: AgentToolName): string {
  return String(toolName)
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatAgentEventTimestamp(createdAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(createdAt));
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatAgentStatusLabel(status: string): string {
  return status
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseNoProjectAgentCommand(prompt: string): NoProjectAgentCommand | undefined {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length === 0) {
    return undefined;
  }

  const lowerPrompt = normalizedPrompt.toLowerCase();
  const isCreateProjectIntent =
    /\b(create|start|make|set up|setup)\b/u.test(lowerPrompt) &&
    /\b(project|paper|manuscript)\b/u.test(lowerPrompt);

  if (!isCreateProjectIntent) {
    return undefined;
  }

  const namePatterns = [
    /\bname(?:d)?\s+(?:it\s+)?["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\bcalled\s+["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\btitled\s+["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\bproject\s+["']?([^"'\n\r]+?)["']?\s*$/iu
  ];
  const matchedName = namePatterns
    .map((pattern) => normalizedPrompt.match(pattern)?.[1])
    .find((candidate): candidate is string => candidate !== undefined);
  const projectName = sanitizeNoProjectAgentProjectName(matchedName ?? "paper");

  if (projectName.length === 0) {
    return undefined;
  }

  return {
    kind: "create-project",
    projectName,
    templateId: inferProjectTemplateId(lowerPrompt)
  };
}

function parseExternalTemplateAgentCommand(
  prompt: string,
  events: readonly AgentEvent[]
): ExternalTemplateAgentCommand | undefined {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length === 0) {
    return undefined;
  }

  const lowerPrompt = normalizedPrompt.toLowerCase();
  const isCreateProjectIntent =
    /\b(create|start|make|set up|setup)\b/u.test(lowerPrompt) &&
    /\b(project|paper|manuscript)\b/u.test(lowerPrompt);

  if (!isCreateProjectIntent) {
    return undefined;
  }

  const recentContext = getRecentAgentAssistantContext(events);
  const isIeeeTemplateRequest =
    (/\bieee\b/u.test(lowerPrompt) &&
      /\b(template|systems journal)\b/u.test(lowerPrompt)) ||
    (/\b(that|this|the)\s+template\b/u.test(lowerPrompt) &&
      /\bieee\b/u.test(recentContext) &&
      /\b(template|systems journal)\b/u.test(recentContext));

  if (!isIeeeTemplateRequest) {
    return undefined;
  }

  return {
    kind: "create-external-template-project",
    projectName: inferExternalTemplateProjectName(normalizedPrompt),
    templateId: "ieee-systems-journal"
  };
}

function getRecentAgentAssistantContext(events: readonly AgentEvent[]): string {
  return events
    .filter(
      (event): event is AgentEvent & { readonly type: "message" } =>
        event.type === "message" && event.role === "assistant"
    )
    .slice(-4)
    .map((event) => event.content)
    .join("\n")
    .toLowerCase();
}

function inferExternalTemplateProjectName(prompt: string): string {
  const matchedName = [
    /\bname(?:d)?\s+(?:it\s+)?["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\bcalled\s+["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\btitled\s+["']?([^"'\n\r]+?)["']?\s*$/iu
  ]
    .map((pattern) => prompt.match(pattern)?.[1])
    .find((candidate): candidate is string => candidate !== undefined);

  return sanitizeNoProjectAgentProjectName(
    matchedName ?? "ieee-systems-journal-template"
  );
}

function sanitizeNoProjectAgentProjectName(projectName: string): string {
  return projectName
    .trim()
    .replace(/[.?!,;:]+$/u, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim();
}

function inferProjectTemplateId(prompt: string): ProjectTemplateId {
  if (/\b(thesis|dissertation)\b/u.test(prompt)) {
    return "thesis";
  }

  if (/\b(report|technical report)\b/u.test(prompt)) {
    return "report";
  }

  if (/\b(beamer|slides|presentation)\b/u.test(prompt)) {
    return "beamer";
  }

  if (/\b(cv|resume|résumé)\b/u.test(prompt)) {
    return "cv";
  }

  return "article";
}

function getDefaultProjectNameForTemplate(
  projectTemplates: readonly ProjectTemplate[],
  templateId: ProjectTemplateId
): string {
  const templateName =
    projectTemplates.find((template) => template.id === templateId)?.name ?? templateId;

  return templateName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function buildAgentMessageEvent({
  content,
  role,
  sessionId
}: {
  readonly content: string;
  readonly role: "assistant" | "user";
  readonly sessionId: string;
}): AgentEvent {
  return {
    content,
    createdAt: new Date().toISOString(),
    id: `${sessionId}-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    sessionId,
    type: "message"
  };
}

function buildAgentCompletionSummaryEvent(
  result: AgentSessionResult,
  options: { readonly decision?: "allowed" | "denied" } = {}
): AgentEvent | undefined {
  const content = createAgentCompletionSummary(result, options);

  if (content === undefined) {
    return undefined;
  }

  const lastEventId = result.events.at(-1)?.id ?? result.status;

  return {
    content,
    createdAt: new Date().toISOString(),
    id: `${result.sessionId}-completion-summary-${lastEventId}`,
    role: "assistant",
    sessionId: result.sessionId,
    type: "message"
  };
}

function createAgentCompletionSummary(
  result: AgentSessionResult,
  options: { readonly decision?: "allowed" | "denied" }
): string | undefined {
  if (result.status === "running") {
    return undefined;
  }

  if (options.decision === "denied") {
    return "I recorded the denial and left the project files unchanged.";
  }

  if (result.status === "failed") {
    return "I could not complete the request. Check the event timeline for the failure details.";
  }

  if (result.status === "cancelled") {
    return "I stopped the run before completing the request.";
  }

  const changesets = getAgentResultChangeSets(result);
  const deletedEntries = result.deleteEntries ?? [];
  const movedEntries = result.moveEntries ?? [];
  const changedFiles = formatChangedFileList(changesets, deletedEntries, movedEntries);
  const didCompile = result.buildResult !== undefined;
  const buildSummary =
    result.buildResult === undefined
      ? undefined
      : `The build ${result.buildResult.status} with ${formatDiagnosticCount(
          result.buildResult.diagnostics.length
        )}.`;

  if (result.status === "awaiting-approval") {
    if (deletedEntries.length > 0) {
      return `I prepared ${deletedEntries.length} project ${deletedEntries.length === 1 ? "deletion" : "deletions"}${changedFiles}. No files were changed yet.`;
    }

    if (changesets.length > 0) {
      const patchWord = changesets.length === 1 ? "patch" : "patches";
      return `I prepared ${changesets.length} reviewable ${patchWord}${changedFiles}. No files were changed yet.`;
    }

    return "I paused for approval before making any project changes.";
  }

  if (changesets.length > 0) {
    const appliedCount = changesets.filter(
      (changeset) => changeset.status === "applied"
    ).length;
    const action =
      appliedCount > 0 || options.decision === "allowed" ? "applied" : "prepared";
    const patchWord = changesets.length === 1 ? "patch" : "patches";
    const compilePhrase = didCompile ? " and ran compile verification" : "";
    return [
      `I ${action} ${changesets.length} ${patchWord}${changedFiles}${compilePhrase}.`,
      buildSummary
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");
  }

  if (movedEntries.length > 0) {
    return `I moved ${movedEntries.length} project ${movedEntries.length === 1 ? "entry" : "entries"}${changedFiles}.`;
  }

  if (deletedEntries.length > 0) {
    const compilePhrase = didCompile ? " and ran compile verification" : "";
    return [
      `I deleted ${deletedEntries.length} project ${deletedEntries.length === 1 ? "entry" : "entries"}${changedFiles}${compilePhrase}.`,
      buildSummary
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");
  }

  if (didCompile) {
    return `I compiled the project. ${buildSummary ?? ""} No files were changed.`;
  }

  return undefined;
}

function getAgentResultChangeSets(
  result: AgentSessionResult
): readonly HistoryChangeSet[] {
  if ((result.changesets?.length ?? 0) > 0) {
    return result.changesets ?? [];
  }

  return result.changeset === undefined ? [] : [result.changeset];
}

function formatChangedFileList(
  changesets: readonly HistoryChangeSet[],
  deletedEntries: readonly { readonly path: string }[],
  movedEntries: readonly { readonly fromPath: string; readonly toPath: string }[]
): string {
  const paths = [
    ...changesets.map((changeset) => changeset.filePath),
    ...deletedEntries.map((entry) => entry.path),
    ...movedEntries.flatMap((entry) => [entry.fromPath, entry.toPath])
  ];
  const uniquePaths = [...new Set(paths)];

  if (uniquePaths.length === 0) {
    return "";
  }

  if (uniquePaths.length === 1) {
    return ` in ${uniquePaths[0]}`;
  }

  if (uniquePaths.length <= 3) {
    return ` across ${uniquePaths.join(", ")}`;
  }

  return ` across ${uniquePaths.length} files`;
}

function formatDiagnosticCount(count: number): string {
  return `${count} diagnostic${count === 1 ? "" : "s"}`;
}

function createAgentThreadItems(
  events: readonly AgentEvent[]
): readonly AgentThreadItem[] {
  const items: AgentThreadItem[] = [];

  for (const event of events) {
    if (isUserAgentMessage(event)) {
      items.push({ type: "user", event });
      continue;
    }

    const latestItem = items.at(-1);

    if (latestItem?.type === "assistant-run") {
      items[items.length - 1] = {
        ...latestItem,
        events: [...latestItem.events, event]
      };
      continue;
    }

    items.push({
      type: "assistant-run",
      sessionId: event.sessionId,
      createdAt: event.createdAt,
      events: [event]
    });
  }

  return items;
}

function createVisibleAgentThreadItems(
  items: readonly AgentThreadItem[],
  running: boolean
): readonly AgentThreadItem[] {
  if (!running) {
    return items;
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.type !== "user") {
      continue;
    }

    if (items[index + 1]?.type === "assistant-run") {
      return items;
    }

    return [
      ...items.slice(0, index + 1),
      {
        type: "assistant-run",
        sessionId: item.event.sessionId,
        createdAt: item.event.createdAt,
        events: []
      },
      ...items.slice(index + 1)
    ];
  }

  return items;
}

function getAgentThreadItemKey(item: AgentThreadItem): string {
  if (item.type === "user") {
    return `user:${item.event.id}`;
  }

  const firstEvent = item.events[0];
  return `assistant-run:${item.sessionId}:${item.createdAt}:${firstEvent?.id ?? "pending"}`;
}

function getLatestAssistantRunItemKey(
  items: readonly AgentThreadItem[]
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.type === "assistant-run") {
      return getAgentThreadItemKey(item);
    }
  }

  return null;
}

function getAgentRunRequestPrompt(
  items: readonly AgentThreadItem[],
  assistantRunIndex: number
): string {
  for (let index = assistantRunIndex - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.type === "user") {
      return item.event.content;
    }
  }

  return "";
}

function getAgentRunWorkflowEvents(
  events: readonly AgentEvent[],
  items: readonly AgentThreadItem[],
  assistantRunIndex: number
): readonly Exclude<AgentEvent, { readonly type: "message" }>[] {
  const item = items[assistantRunIndex];
  if (item?.type !== "assistant-run") {
    return [];
  }

  const previousUser = findPreviousUserThreadItem(items, assistantRunIndex);
  const nextUser = findNextUserThreadItem(items, assistantRunIndex);
  const startTime = Date.parse(previousUser?.event.createdAt ?? item.createdAt);
  const endTime =
    nextUser === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(nextUser.event.createdAt);

  return compactAgentWorkflowEvents(
    events.filter(
      (event): event is Exclude<AgentEvent, { readonly type: "message" }> =>
        event.sessionId === item.sessionId &&
        isAgentWorkflowEvent(event) &&
        !isHiddenAgentWorkflowEvent(event) &&
        isAgentEventInRunWindow(event, startTime, endTime)
    )
  );
}

function findPreviousUserThreadItem(
  items: readonly AgentThreadItem[],
  startIndex: number
): (AgentThreadItem & { readonly type: "user" }) | undefined {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.type === "user") {
      return item;
    }
  }

  return undefined;
}

function findNextUserThreadItem(
  items: readonly AgentThreadItem[],
  startIndex: number
): (AgentThreadItem & { readonly type: "user" }) | undefined {
  for (let index = startIndex + 1; index < items.length; index += 1) {
    const item = items[index];

    if (item?.type === "user") {
      return item;
    }
  }

  return undefined;
}

function isAgentEventInRunWindow(
  event: AgentEvent,
  startTime: number,
  endTime: number
): boolean {
  const eventTime = Date.parse(event.createdAt);

  if (!Number.isFinite(eventTime)) {
    return true;
  }

  return eventTime >= startTime && eventTime < endTime;
}

function isHiddenAgentWorkflowEvent(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): boolean {
  return event.type === "tool-call";
}

function compactAgentWorkflowEvents(
  events: readonly Exclude<AgentEvent, { readonly type: "message" }>[]
): readonly Exclude<AgentEvent, { readonly type: "message" }>[] {
  const compacted: Exclude<AgentEvent, { readonly type: "message" }>[] = [];
  const eventIndexByKey = new Map<string, number>();

  for (const event of events) {
    const key = getAgentWorkflowCompactionKey(event);
    const existingIndex = eventIndexByKey.get(key);

    if (existingIndex === undefined) {
      eventIndexByKey.set(key, compacted.length);
      compacted.push(event);
    } else {
      compacted[existingIndex] = event;
    }
  }

  return compacted.slice(-8);
}

function getAgentWorkflowCompactionKey(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): string {
  if (event.type === "tool-call") {
    return `${event.type}:${event.toolName}:${normalizeAgentWorkflowSummary(event.summary)}`;
  }

  if (event.type === "verification") {
    return `${event.type}:${event.buildJobId ?? "compile"}`;
  }

  if (event.type === "patch") {
    return `${event.type}:${event.changesetId}:${event.filePath}`;
  }

  if (event.type === "approval") {
    return `${event.type}:${event.approvalId}`;
  }

  return `${event.type}:${event.message}`;
}

function normalizeAgentWorkflowSummary(summary: string): string {
  return summary
    .replace(/^Read\s+.+$/u, "Read project file")
    .replace(/\s+/gu, " ")
    .trim();
}

function getLatestAgentEvent(events: readonly AgentEvent[]): AgentEvent | undefined {
  return events.reduce<AgentEvent | undefined>((latestEvent, event) => {
    if (latestEvent === undefined) {
      return event;
    }

    return Date.parse(event.createdAt) >= Date.parse(latestEvent.createdAt)
      ? event
      : latestEvent;
  }, undefined);
}

function isUserAgentMessage(
  event: AgentEvent
): event is AgentEvent & { readonly type: "message"; readonly role: "user" } {
  return event.type === "message" && event.role === "user";
}

function isAgentWorkflowEvent(
  event: AgentEvent
): event is Exclude<AgentEvent, { readonly type: "message" }> {
  return event.type !== "message";
}

function getAgentRunTone(events: readonly AgentEvent[]): AgentEventTone {
  if (events.some((event) => event.type === "error")) {
    return "danger";
  }

  if (
    events.some(
      (event) =>
        (event.type === "tool-call" && event.status === "failed") ||
        (event.type === "verification" && event.status === "failed")
    )
  ) {
    return "danger";
  }

  if (
    events.some(
      (event) =>
        (event.type === "approval" && event.status === "requested") ||
        (event.type === "patch" &&
          (event.status === "rejected" || event.status === "reverted"))
    )
  ) {
    return "warning";
  }

  if (
    events.some(
      (event) =>
        (event.type === "tool-call" && event.status === "running") ||
        (event.type === "verification" &&
          (event.status === "pending" || event.status === "running"))
    )
  ) {
    return "running";
  }

  if (
    events.some(
      (event) =>
        (event.type === "tool-call" && event.status === "succeeded") ||
        (event.type === "verification" && event.status === "passed") ||
        (event.type === "patch" && event.status === "applied")
    )
  ) {
    return "success";
  }

  return "neutral";
}

function getAgentWorkflowEventTitle(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): string {
  if (event.type === "tool-call") {
    return formatAgentToolName(event.toolName);
  }

  if (event.type === "patch") {
    return "Patch";
  }

  if (event.type === "verification") {
    return "Verification";
  }

  return "Error";
}

function getAgentWorkflowEventStatus(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): string {
  if (event.type === "error") {
    return event.recoverable ? "Recoverable" : "Stopped";
  }

  return formatAgentStatusLabel(event.status);
}

function getAgentWorkflowEventSummary(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): string {
  if (event.type === "tool-call") {
    return event.summary;
  }

  if (event.type === "patch") {
    return `${event.summary} (${event.filePath})`;
  }

  if (event.type === "verification") {
    return event.summary;
  }

  if (event.type === "approval") {
    return event.prompt;
  }

  return event.message;
}

function getVisibleAgentWorkflowEvents({
  hasAssistantResponse,
  isActive,
  workflowEvents
}: {
  readonly hasAssistantResponse: boolean;
  readonly isActive: boolean;
  readonly workflowEvents: readonly Exclude<AgentEvent, { readonly type: "message" }>[];
}): readonly Exclude<AgentEvent, { readonly type: "message" }>[] {
  if (isActive || !hasAssistantResponse) {
    return workflowEvents;
  }

  return workflowEvents.filter(isAgentWorkflowEventStillActionable);
}

function isAgentWorkflowEventStillActionable(
  event: Exclude<AgentEvent, { readonly type: "message" }>
): boolean {
  if (event.type === "approval") {
    return event.status === "requested";
  }

  if (event.type === "verification") {
    return event.status === "failed";
  }

  if (event.type === "patch") {
    return (
      event.status === "failed" ||
      event.status === "rejected" ||
      event.status === "reverted"
    );
  }

  return event.type === "error";
}

function parseAgentRichTextBlocks(content: string): readonly AgentRichTextBlock[] {
  const blocks: AgentRichTextBlock[] = [];
  let paragraphLines: string[] = [];
  let listType: "ordered-list" | "unordered-list" | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push({
      lines: paragraphLines,
      type: "paragraph"
    });
    paragraphLines = [];
  };

  const flushList = () => {
    if (listType === null || listItems.length === 0) {
      return;
    }

    blocks.push({
      items: listItems,
      type: listType
    });
    listItems = [];
    listType = null;
  };

  const lines = content.replace(/\r\n/gu, "\n").split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? "";
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const codeFence = parseMarkdownCodeFence(trimmedLine);
    if (codeFence !== null) {
      flushParagraph();
      flushList();

      const codeLines: string[] = [];
      lineIndex += 1;

      while (lineIndex < lines.length) {
        const codeLine = lines[lineIndex] ?? "";

        if (isMarkdownCodeFenceClose(codeLine.trim(), codeFence.fence)) {
          break;
        }

        codeLines.push(codeLine);
        lineIndex += 1;
      }

      blocks.push({
        code: codeLines.join("\n"),
        language: codeFence.language,
        type: "code-block"
      });
      continue;
    }

    const nextLine = lines[lineIndex + 1]?.trim() ?? "";
    if (isMarkdownTableRow(trimmedLine) && isMarkdownTableDelimiter(nextLine)) {
      flushParagraph();
      flushList();

      const headers = parseMarkdownTableRow(trimmedLine);
      const rows: string[][] = [];
      lineIndex += 2;

      while (lineIndex < lines.length) {
        const rowLine = lines[lineIndex]?.trim() ?? "";

        if (!isMarkdownTableRow(rowLine)) {
          lineIndex -= 1;
          break;
        }

        rows.push(parseMarkdownTableRow(rowLine));
        lineIndex += 1;
      }

      blocks.push({
        headers,
        rows,
        type: "table"
      });
      continue;
    }

    const unorderedListItem = trimmedLine.match(/^[-*•]\s+(.+)$/u);
    const orderedListItem = trimmedLine.match(/^\d+[.)]\s+(.+)$/u);
    const nextListType =
      unorderedListItem !== null
        ? "unordered-list"
        : orderedListItem !== null
          ? "ordered-list"
          : null;

    if (nextListType !== null) {
      flushParagraph();

      if (listType !== null && listType !== nextListType) {
        flushList();
      }

      listType = nextListType;
      listItems.push((unorderedListItem ?? orderedListItem)?.[1] ?? trimmedLine);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    return [
      {
        lines: [content],
        type: "paragraph"
      }
    ];
  }

  return blocks;
}

function parseMarkdownCodeFence(
  line: string
): { readonly fence: string; readonly language: string | null } | null {
  const match = line.match(/^(`{3,}|~{3,})\s*([^`~]*)$/u);

  if (match === null) {
    return null;
  }

  const language = match[2]?.trim().toLowerCase() ?? "";

  return {
    fence: match[1] ?? "```",
    language:
      language.length === 0 ||
      language === "text" ||
      language === "txt" ||
      language === "plain" ||
      language === "plaintext"
        ? null
        : language
  };
}

function isMarkdownCodeFenceClose(line: string, openingFence: string): boolean {
  const fenceCharacter = openingFence[0];
  const minimumLength = openingFence.length;

  if (fenceCharacter === "`") {
    return /^`+\s*$/u.test(line) && line.trim().length >= minimumLength;
  }

  if (fenceCharacter === "~") {
    return /^~+\s*$/u.test(line) && line.trim().length >= minimumLength;
  }

  return false;
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && parseMarkdownTableRow(line).length > 1;
}

function isMarkdownTableDelimiter(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/u.test(line);
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmedLine = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmedLine.split("|").map((cell) => cell.trim());
}

function formatAgentInlineText(text: string, keyPrefix: string): readonly ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern =
    /(\[[^\]]+?\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|\*\*[^*]+?\*\*|__[^_]+?__|==[^=]+?==|`[^`]+?`)/gu;
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(inlinePattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }

    const key = `${keyPrefix}-inline-${tokenIndex}`;

    if (token.startsWith("[")) {
      const linkMatch = token.match(
        /^\[([^\]]+?)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)$/u
      );
      nodes.push(
        linkMatch === null ? (
          token
        ) : (
          <a href={linkMatch[2]} key={key} rel="noreferrer" target="_blank">
            {linkMatch[1]}
          </a>
        )
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("==")) {
      nodes.push(<mark key={key}>{token.slice(2, -2)}</mark>);
    } else {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    }

    lastIndex = index + token.length;
    tokenIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function getAgentEventTone(event: AgentEvent): AgentEventTone {
  if (event.type === "tool-call") {
    if (event.status === "failed" || event.status === "blocked") {
      return "danger";
    }

    return event.status === "succeeded" ? "success" : "running";
  }

  if (event.type === "patch") {
    if (event.status === "failed") {
      return "danger";
    }

    return event.status === "rejected" || event.status === "reverted"
      ? "warning"
      : "success";
  }

  if (event.type === "approval") {
    if (event.status === "requested") {
      return "warning";
    }

    return event.status === "denied" ? "danger" : "success";
  }

  if (event.type === "verification") {
    if (event.status === "failed") {
      return "danger";
    }

    return event.status === "passed" ? "success" : "running";
  }

  if (event.type === "error") {
    return "danger";
  }

  return "neutral";
}

function createStartingAgentLiveStatus(
  prompt: string,
  providerLabel: string
): AgentLiveStatus {
  if (isExternalResearchPrompt(prompt)) {
    return {
      detail:
        "Checking the request, current project context, and whether external source access is required.",
      title: "Understanding request",
      tone: "running"
    };
  }

  return {
    detail: "Preparing scoped project context and safety policy.",
    title: `${providerLabel} is starting`,
    tone: "running"
  };
}

function createAwaitingApprovalLiveStatus(
  toolName: AgentToolName | undefined
): AgentLiveStatus {
  if (toolName === "network-fetch") {
    return {
      detail:
        "Web access is required before the agent can search official sources or verify a current template.",
      title: "Network approval required",
      tone: "warning"
    };
  }

  if (toolName === "delete-entry") {
    return {
      detail: "Review the requested project deletion before removing the entry.",
      title: "Delete approval required",
      tone: "warning"
    };
  }

  return {
    detail: "Review the patch in History, then allow or deny the requested action.",
    title: "Waiting for patch review",
    tone: "warning"
  };
}

function createAgentRunLiveStatus({
  elapsedSeconds,
  events,
  fallback,
  requestPrompt
}: {
  readonly elapsedSeconds: number;
  readonly events: readonly AgentEvent[];
  readonly fallback: AgentLiveStatus;
  readonly requestPrompt: string;
}): AgentLiveStatus {
  const requestedApproval = findOpenApprovalEvent(events);

  if (requestedApproval !== undefined) {
    return createAwaitingApprovalLiveStatus(requestedApproval.toolName);
  }

  const latestNetworkFetch = findLastAgentEvent(
    events,
    (event): event is AgentToolCallEvent =>
      event.type === "tool-call" && event.toolName === "network-fetch"
  );

  if (latestNetworkFetch !== undefined) {
    if (latestNetworkFetch.status === "running") {
      return {
        detail:
          "Searching the approved web source, with priority on official publisher resources.",
        title: "Searching official sources",
        tone: "running"
      };
    }

    if (latestNetworkFetch.status === "succeeded") {
      return {
        detail:
          "Checking source authority, publication context, and template version before using it.",
        title: "Verifying source",
        tone: "running"
      };
    }

    return {
      detail: latestNetworkFetch.summary,
      title: "Network fetch failed",
      tone: "danger"
    };
  }

  if (!isExternalResearchPrompt(requestPrompt)) {
    return fallback;
  }

  const latestToolCall = findLastAgentEvent(
    events,
    (event): event is AgentToolCallEvent => event.type === "tool-call"
  );

  if (
    latestToolCall?.toolName === "read-file" ||
    latestToolCall === undefined ||
    elapsedSeconds < 4
  ) {
    return {
      detail:
        "Checking the request, current project context, and whether external source access is required.",
      title: "Understanding request",
      tone: "running"
    };
  }

  if (isTemplateResearchPrompt(requestPrompt) && elapsedSeconds < 16) {
    return {
      detail:
        "Reviewing template requirements and expected files before comparing them with the project.",
      title: "Inspecting template",
      tone: "running"
    };
  }

  if (isTemplateResearchPrompt(requestPrompt) && elapsedSeconds < 28) {
    return {
      detail:
        "Comparing the expected template structure with the current manuscript setup.",
      title: "Comparing with project",
      tone: "running"
    };
  }

  return {
    detail:
      "Preparing a source-aware answer and keeping project files unchanged unless a reviewable action is requested.",
    title: "Preparing recommendation",
    tone: "running"
  };
}

function hasOpenApproval(events: readonly AgentEvent[]): boolean {
  return findOpenApprovalEvent(events) !== undefined;
}

function findOpenApprovalEvent(
  events: readonly AgentEvent[]
): (AgentEvent & { readonly type: "approval" }) | undefined {
  const approvalEventsById = new Map<
    string,
    AgentEvent & { readonly type: "approval" }
  >();

  for (const event of events) {
    if (event.type === "approval") {
      approvalEventsById.set(event.approvalId, event);
    }
  }

  return [...approvalEventsById.values()]
    .reverse()
    .find((event) => event.status === "requested");
}

function getRequestedApprovalToolName(
  events: readonly AgentEvent[]
): AgentToolName | undefined {
  return findOpenApprovalEvent(events)?.toolName;
}

function getResolvedApprovalToolName(
  events: readonly AgentEvent[]
): AgentToolName | undefined {
  return findLastAgentEvent(
    events,
    (event): event is AgentEvent & { readonly type: "approval" } =>
      event.type === "approval"
  )?.toolName;
}

function findLastAgentEvent<TEvent extends AgentEvent>(
  events: readonly AgentEvent[],
  predicate: (event: AgentEvent) => event is TEvent
): TEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event !== undefined && predicate(event)) {
      return event;
    }
  }

  return undefined;
}

function isExternalResearchPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("web search") ||
    normalized.includes("search web") ||
    normalized.includes("search online") ||
    normalized.includes("look it up online") ||
    normalized.includes("look online") ||
    normalized.includes("download from") ||
    normalized.includes("web content") ||
    /https?:\/\/[^\s`'"]+/iu.test(prompt) ||
    /\b10\.\d{4,9}\/[^\s]+/iu.test(prompt) ||
    isLikelyLatestExternalPrompt(normalized)
  );
}

function isLikelyLatestExternalPrompt(normalizedPrompt: string): boolean {
  return (
    /\blatest\b/u.test(normalizedPrompt) &&
    /\b(template|package|version|journal|publisher|guidelines?|instructions?|class file|cls|style file|bst|online|web)\b/u.test(
      normalizedPrompt
    )
  );
}

function isTemplateResearchPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("template") ||
    normalized.includes("class file") ||
    normalized.includes("style file") ||
    normalized.includes(".cls") ||
    normalized.includes(".bst")
  );
}

function createAgentLiveStatusFromEvent(
  event: AgentEvent
): AgentLiveStatus | undefined {
  if (event.type === "tool-call") {
    return createAgentToolLiveStatus(event);
  }

  if (event.type === "approval" && event.status === "requested") {
    return createAwaitingApprovalLiveStatus(event.toolName);
  }

  if (event.type === "verification") {
    return {
      detail: event.summary,
      title: `Verification ${event.status}`,
      tone:
        event.status === "failed"
          ? "danger"
          : event.status === "passed"
            ? "success"
            : "running"
    };
  }

  if (event.type === "error") {
    return {
      detail: event.message,
      title: "Agent error",
      tone: "danger"
    };
  }

  return undefined;
}

function createAgentToolLiveStatus(event: AgentToolCallEvent): AgentLiveStatus {
  const tone =
    event.status === "failed" || event.status === "blocked" ? "danger" : "running";

  if (event.toolName === "codex-exec" || event.toolName === "claude-code") {
    return {
      detail: formatAgentModelExecutionDetail(event.summary),
      title: formatAgentModelExecutionTitle(event.summary, event.status),
      tone
    };
  }

  return {
    detail: event.summary,
    title: formatAgentToolLiveTitle(event.toolName, event.status),
    tone
  };
}

function formatAgentToolLiveTitle(
  toolName: AgentToolName,
  status: AgentToolCallEvent["status"]
): string {
  if (toolName === "read-file") {
    return status === "running" ? "Reading project file" : "Project file read";
  }

  if (toolName === "search-project") {
    return status === "running" ? "Searching project" : "Project search complete";
  }

  if (toolName === "capture-pdf-preview") {
    if (status === "failed" || status === "blocked") {
      return "PDF preview capture unavailable";
    }

    return status === "running" ? "Capturing PDF preview" : "PDF preview captured";
  }

  if (toolName === "run-compile") {
    if (status === "failed" || status === "blocked") {
      return "Compile failed";
    }

    return status === "running" ? "Compiling LaTeX" : "Compile finished";
  }

  if (toolName === "propose-patch") {
    return status === "running" ? "Preparing patch" : "Patch ready";
  }

  if (toolName === "apply-patch") {
    return status === "running" ? "Applying patch" : "Patch applied";
  }

  if (toolName === "move-entry") {
    return status === "running" ? "Moving project entry" : "Project entry moved";
  }

  if (toolName === "delete-entry") {
    return status === "running" ? "Deleting project entry" : "Project entry deleted";
  }

  if (toolName === "set-main-file") {
    return status === "running" ? "Setting main file" : "Main file set";
  }

  if (toolName === "reject-patch") {
    return status === "running" ? "Rejecting patch" : "Patch rejected";
  }

  if (toolName === "network-fetch") {
    if (status === "failed" || status === "blocked") {
      return "Network fetch failed";
    }

    return status === "running" ? "Searching official sources" : "Source fetched";
  }

  return `${formatAgentToolName(toolName)} ${formatAgentStatusLabel(status)}`;
}

function formatAgentModelExecutionTitle(
  summary: string,
  status: AgentToolCallEvent["status"]
): string {
  if (status === "failed" || status === "blocked") {
    return "Analysis failed";
  }

  if (status === "succeeded") {
    return "Analysis complete";
  }

  const normalizedSummary = summary.toLowerCase();

  if (normalizedSummary.includes("compile failed")) {
    return "Repairing compile error";
  }

  if (
    normalizedSummary.includes("concrete change") ||
    normalizedSummary.includes("tool action")
  ) {
    return "Planning project action";
  }

  if (
    normalizedSummary.includes("overbroad") ||
    normalizedSummary.includes("complete minimal patch")
  ) {
    return "Checking patch safety";
  }

  if (normalizedSummary.includes("retry")) {
    return "Retrying analysis";
  }

  return "Analyzing project";
}

function formatAgentModelExecutionDetail(summary: string): string {
  const elapsedText = /\(([^()]+ elapsed)\)/u.exec(summary)?.[1];

  if (summary.toLowerCase().includes("compile failed")) {
    return "The agent is reading the compile log and preparing a safe LaTeX repair.";
  }

  if (
    summary.toLowerCase().includes("concrete change") ||
    summary.toLowerCase().includes("tool action")
  ) {
    return "The agent is turning the analysis into a reviewable project action.";
  }

  if (
    summary.toLowerCase().includes("overbroad") ||
    summary.toLowerCase().includes("complete minimal patch")
  ) {
    return "The agent is asking for a smaller patch before changing project files.";
  }

  if (summary.toLowerCase().includes("retry")) {
    return "The agent is retrying with a narrower project-scoped prompt.";
  }

  return elapsedText === undefined
    ? "The agent is reading project context and planning the response."
    : `The agent is reading project context and planning the response (${elapsedText}).`;
}

function prepareAgentDisplayEvents(
  events: readonly AgentEvent[]
): readonly AgentEvent[] {
  return mergeAgentThreadEvents(
    events.filter((event) => {
      if (event.type === "tool-call" || event.type === "verification") {
        return false;
      }

      if (event.type !== "message") {
        return true;
      }

      return !isOperationalAgentStatusMessage(event.content);
    })
  );
}

function mergeAgentThreadEvents(events: readonly AgentEvent[]): readonly AgentEvent[] {
  const mergedEvents: AgentEvent[] = [];
  const eventIndexById = new Map<string, number>();

  for (const event of events) {
    const existingIndex = eventIndexById.get(event.id);

    if (existingIndex === undefined) {
      eventIndexById.set(event.id, mergedEvents.length);
      mergedEvents.push(event);
      continue;
    }

    mergedEvents[existingIndex] = event;
  }

  return mergedEvents;
}

function isOperationalAgentStatusMessage(content: string): boolean {
  return (
    content.startsWith("I will inspect the scoped project context") ||
    content.startsWith("I will ask the installed Codex CLI")
  );
}

function agentSetMainFile(events: readonly AgentEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "tool-call" &&
      event.toolName === "set-main-file" &&
      event.status === "succeeded"
  );
}

function formatChangeSetVerificationStatus(
  status: ChangeSetVerificationStatus
): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}

type AuditTimelineEvent = {
  readonly label: string;
  readonly summary: string;
  readonly tone: "neutral" | "success" | "warning" | "danger";
};

type UnifiedDiffHunk = {
  readonly index: number;
  readonly header: string;
  readonly contents: string;
};

function parseUnifiedDiffHunks(patch: string): readonly UnifiedDiffHunk[] {
  const lines = patch.split("\n");
  const hunks: UnifiedDiffHunk[] = [];
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHeader !== null) {
        hunks.push({
          index: hunks.length,
          header: currentHeader,
          contents: [currentHeader, ...currentLines].join("\n")
        });
      }

      currentHeader = line;
      currentLines = [];
      continue;
    }

    if (currentHeader !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeader !== null) {
    hunks.push({
      index: hunks.length,
      header: currentHeader,
      contents: [currentHeader, ...currentLines].join("\n")
    });
  }

  return hunks;
}

function formatAuditTimelineEvent(event: AuditEvent): AuditTimelineEvent {
  if (event.eventType === "agent.session.started") {
    return {
      label: "Agent session",
      summary: event.message,
      tone: "neutral"
    };
  }

  if (event.eventType === "agent.tool.started") {
    return {
      label: "Tool call started",
      summary: event.message,
      tone: "neutral"
    };
  }

  if (event.eventType === "agent.tool.failed") {
    return {
      label: "Tool call failed",
      summary: event.message,
      tone: "danger"
    };
  }

  if (event.eventType === "agent.tool.blocked") {
    return {
      label: "Tool call blocked",
      summary: event.message,
      tone: "warning"
    };
  }

  if (event.eventType === "agent.tool-call") {
    return {
      label: "Tool call",
      summary: event.message,
      tone: event.message.includes("failed:") ? "danger" : "neutral"
    };
  }

  if (event.eventType === "agent.approval") {
    return {
      label: "Approval",
      summary: event.message,
      tone: event.message.includes("denied:") ? "warning" : "success"
    };
  }

  if (event.eventType === "agent.patch") {
    return {
      label: "Changed file",
      summary: event.message,
      tone: "success"
    };
  }

  if (event.eventType === "agent.verification") {
    return {
      label: "Build result",
      summary: event.message,
      tone: event.message.startsWith("passed:") ? "success" : "danger"
    };
  }

  if (event.eventType === "agent.error") {
    return {
      label: "Agent error",
      summary: event.message,
      tone: "danger"
    };
  }

  if (event.eventType.startsWith("changeset.")) {
    return {
      label: "Changeset",
      summary: event.message,
      tone: event.eventType.endsWith(".rejected") ? "warning" : "success"
    };
  }

  if (event.eventType === "snapshot.created") {
    return {
      label: "Snapshot",
      summary: event.message,
      tone: "neutral"
    };
  }

  return {
    label: event.eventType,
    summary: event.message,
    tone: "neutral"
  };
}

function formatAuditTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function findLogMatches(
  rawLog: string,
  query: string
): readonly { readonly index: number }[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const normalizedLog = rawLog.toLowerCase();
  const matches: { readonly index: number }[] = [];
  let searchIndex = 0;

  while (matches.length < 500) {
    const index = normalizedLog.indexOf(normalizedQuery, searchIndex);

    if (index === -1) {
      return matches;
    }

    matches.push({ index });
    searchIndex = index + normalizedQuery.length;
  }

  return matches;
}

function createLogExcerpt(
  rawLog: string,
  query: string,
  matchIndex: number | undefined
): string {
  if (rawLog.trim().length === 0) {
    return "";
  }

  if (query.trim().length === 0 || matchIndex === undefined) {
    return rawLog.length <= 4_000 ? rawLog : `${rawLog.slice(0, 4_000)}\n...`;
  }

  const start = findLineBoundaryBefore(rawLog, Math.max(0, matchIndex - 1_500));
  const end = findLineBoundaryAfter(
    rawLog,
    Math.min(rawLog.length, matchIndex + query.trim().length + 1_500)
  );
  const prefix = start > 0 ? "...\n" : "";
  const suffix = end < rawLog.length ? "\n..." : "";

  return `${prefix}${rawLog.slice(start, end)}${suffix}`;
}

function findLineBoundaryBefore(value: string, index: number): number {
  const boundary = value.lastIndexOf("\n", index);
  return boundary === -1 ? 0 : boundary + 1;
}

function findLineBoundaryAfter(value: string, index: number): number {
  const boundary = value.indexOf("\n", index);
  return boundary === -1 ? value.length : boundary;
}

function formatSubmissionCheckResult(result: SubmissionCheckResult): string {
  return [
    `Submission check · ${new Date(result.checkedAt).toLocaleString()}`,
    "",
    ...result.items.map(
      (item) =>
        `${item.severity.toUpperCase()}: ${item.message}${
          item.filePath === undefined ? "" : `\n  ${item.filePath}`
        }`
    )
  ].join("\n");
}

function getPdfTextItemString(item: unknown): string {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return "";
  }

  const candidate = item as { readonly str?: unknown };
  return typeof candidate.str === "string" ? candidate.str : "";
}

async function collectPdfSearchMatches(
  document: PDFDocumentProxy,
  query: string
): Promise<readonly PdfSearchMatch[]> {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const matches: PdfSearchMatch[] = [];

  for (let page = 1; page <= document.numPages; page += 1) {
    const pdfPage = await document.getPage(page);
    const textContent = await pdfPage.getTextContent();
    const pageText = textContent.items.map(getPdfTextItemString).join(" ");
    const normalizedPageText = pageText.toLowerCase();
    let searchFromIndex = 0;
    let matchIndex = normalizedPageText.indexOf(normalizedQuery, searchFromIndex);

    while (matchIndex !== -1) {
      matches.push({
        page,
        matchIndex
      });
      searchFromIndex = matchIndex + normalizedQuery.length;
      matchIndex = normalizedPageText.indexOf(normalizedQuery, searchFromIndex);
    }
  }

  return matches;
}

async function readProjectFileForRoot(projectRoot: string, path: string) {
  return desktopApi.files.read({
    projectRoot,
    path
  });
}

function upsertOpenFile(
  files: readonly EditorFileState[],
  nextFile: EditorFileState
): readonly EditorFileState[] {
  return files.some((file) => file.path === nextFile.path)
    ? replaceOpenFile(files, nextFile)
    : [...files, nextFile];
}

function replaceOpenFile(
  files: readonly EditorFileState[],
  nextFile: EditorFileState
): readonly EditorFileState[] {
  return files.map((file) => (file.path === nextFile.path ? nextFile : file));
}

function removeOpenFile(
  files: readonly EditorFileState[],
  path: string
): readonly EditorFileState[] {
  return files.filter((file) => file.path !== path);
}

function getBaseName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function normalizeProjectPath(path: string) {
  return path.split("\\").join("/").replace(/^\.\//u, "");
}

function getSiblingProjectPath(path: string, newName: string) {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return [...segments, newName].join("/");
}

function getProjectDirectoryPath(path: string | null | undefined) {
  if (path === null || path === undefined) {
    return ".";
  }

  const segments = path.split("/").filter(Boolean);
  segments.pop();

  return segments.length === 0 ? "." : segments.join("/");
}

function joinProjectPath(parentPath: string, name: string) {
  return parentPath === "." ? name : `${parentPath}/${name}`;
}

function getToolchainSetupIssue(
  toolchainStatus: LatexToolchainStatus,
  selectedCompiler: LatexCompiler
): string | undefined {
  if (!toolchainStatus.latexmkAvailable) {
    return "latexmk is missing. Install a LaTeX distribution, then restart the app or add your LaTeX bin directory to PATH.";
  }

  if (toolchainStatus.availableCompilers.length === 0) {
    return "No supported LaTeX compiler was found. Install a LaTeX distribution, then restart the app or add your LaTeX bin directory to PATH.";
  }

  if (!toolchainStatus.availableCompilers.includes(selectedCompiler)) {
    return `${formatCompilerLabel(selectedCompiler)} is not available. Set one of: ${toolchainStatus.availableCompilers.map(formatCompilerLabel).join(", ")}.`;
  }

  return undefined;
}

function formatCompilerLabel(compiler: LatexCompiler): string {
  switch (compiler) {
    case "pdflatex":
      return "pdfLaTeX";
    case "xelatex":
      return "XeLaTeX";
    case "lualatex":
      return "LuaLaTeX";
  }
}

function createSetupFailureBuildResult(
  jobId: string,
  compiler: LatexCompiler,
  message: string
): BuildResult {
  const timestamp = new Date().toISOString();

  return {
    jobId,
    status: "failed",
    compiler,
    command: ["latexmk"],
    securityPolicy: createDefaultBuildSecurityPolicy(),
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    diagnostics: [
      {
        severity: "error",
        message
      }
    ],
    rawLog: message,
    stdout: "",
    stderr: message
  };
}

function createDefaultBuildSecurityPolicy(): BuildResult["securityPolicy"] {
  return {
    shellEscape: {
      enabled: false,
      commandFlag: "-no-shell-escape",
      approvalRequiredToEnable: true,
      agentMayEnable: false,
      message:
        "Shell escape is disabled for LaTeX builds. Enabling it requires an explicit user approval path and cannot be changed by the agent."
    }
  };
}

function formatBuildSecurityPolicy(buildResult: BuildResult): string {
  const { shellEscape } = buildResult.securityPolicy;

  return [
    `Shell escape: disabled (${shellEscape.commandFlag})`,
    `Agent may enable shell escape: ${shellEscape.agentMayEnable ? "yes" : "no"}`,
    shellEscape.message
  ].join("\n");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Project operation failed.";
}

function formatRecentProjectDetails(project: RecentProject) {
  const openedAt = new Date(project.lastOpenedAt);
  const openedLabel = Number.isNaN(openedAt.getTime())
    ? "Last opened unknown"
    : `Last opened ${openedAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
      })}`;
  const mainFileLabel = project.mainFilePath === undefined ? "" : project.mainFilePath;

  return [mainFileLabel, openedLabel].filter(Boolean).join(" · ");
}
