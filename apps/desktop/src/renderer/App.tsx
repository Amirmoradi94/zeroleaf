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
  AgentImageAttachment,
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
  HistoryChangeSet,
  LatexCompiler,
  LatexDiagnostic,
  LatexToolchainStatus,
  OnlyOfficeStatus,
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
  SharedProjectActivitySummary,
  SharedProjectAuditEventSummary,
  SharedProjectAgentChangeSetSummary,
  SharedProjectAgentRunSummary,
  SharedProjectBuildArtifactDetails,
  SharedProjectBuildArtifactSummary,
  SharedProjectCommentSummary,
  SharedProjectConnection,
  SharedProjectDocumentTextOperation,
  SharedProjectFileRevisionDetails,
  SharedProjectFileRevisionSummary,
  SharedProjectMemberSummary,
  SharedProjectPresenceSummary,
  SharedProjectRealtimeEvent,
  SharedProjectRole,
  SharedProjectSessionSummary,
  SharedProjectSummary,
  SubmissionCheckResult,
  WordBlockOperation,
  WordDocumentBlock,
  WordDocumentModel,
  WordChangeSet,
  WordChangeSetApplyResult,
  WorkbenchLayout
} from "@latex-agent/ipc-contracts";
import {
  ArrowUp,
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
  ImagePlus,
  MessageSquareText,
  PanelBottom,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Share2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X
} from "lucide-react";

import {
  commandDefinitions,
  type CommandDefinition,
  type CommandId
} from "./commands.js";
import { IconButton } from "./components/IconButton.js";
import { OnlyOfficeWordEditorPane } from "./components/OnlyOfficeWordEditorPane.js";
import { PdfPane } from "./components/PdfPane.js";
import { desktopApi } from "./desktopApi.js";
import zeroleafMarkUrl from "./assets/zeroleaf-mark.png";
import {
  parseNoProjectAgentCommand,
  type NoProjectAgentCommand
} from "./noProjectAgentCommand.js";
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
  "Word",
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
  "anthropic-claude",
  "openrouter-design"
] as const satisfies readonly AgentProviderId[];
const agentProviderStorageKey = "zeroleaf-agent-provider";
const maxAgentImageAttachments = 4;
const maxAgentImageAttachmentBytes = 6 * 1024 * 1024;
const agentImageInputAccept =
  "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif";

const emptyReferenceAnalysis: ReferenceAnalysis = {
  entries: [],
  citations: [],
  missingCitations: [],
  unusedEntries: []
};

type EditorFileState = ProjectFileSnapshot & {
  readonly documentKind: "text" | "word";
  readonly savedContents: string;
  readonly stale: boolean;
  readonly wordBlocks?: readonly WordDocumentBlock[];
  readonly savedWordBlocks?: readonly WordDocumentBlock[];
  readonly wordWarnings?: readonly string[];
};

type SavedEditorFile = {
  readonly file: EditorFileState;
  readonly changeset?: HistoryChangeSet;
};

type OnlyOfficeWordFileState = {
  readonly dirty: boolean;
  readonly sessionId?: string;
};

type ActiveSharedProject = {
  readonly id: string;
  readonly localCachePath: string;
  readonly role: SharedProjectRole;
  readonly compiler?: LatexCompiler;
};

type SharedDocumentPendingOperation = {
  readonly id: string;
  readonly operations: readonly SharedProjectDocumentTextOperation[];
  readonly contents: string;
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
  const [activeSharedProject, setActiveSharedProject] =
    useState<ActiveSharedProject | null>(null);
  const [openFiles, setOpenFiles] = useState<readonly EditorFileState[]>([]);
  const [outlineFiles, setOutlineFiles] = useState<readonly LatexOutlineSource[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [onlyOfficeWordFileStates, setOnlyOfficeWordFileStates] = useState<
    Readonly<Record<string, OnlyOfficeWordFileState>>
  >({});
  const [onlyOfficeWordReloadVersions, setOnlyOfficeWordReloadVersions] = useState<
    Readonly<Record<string, number>>
  >({});
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
  const [sharedConnection, setSharedConnection] = useState<SharedProjectConnection>({
    connected: false
  });
  const [sharedSessions, setSharedSessions] = useState<
    readonly SharedProjectSessionSummary[]
  >([]);
  const [sharedProjects, setSharedProjects] = useState<readonly SharedProjectSummary[]>(
    []
  );
  const [sharedBuildArtifacts, setSharedBuildArtifacts] = useState<
    readonly SharedProjectBuildArtifactSummary[]
  >([]);
  const [sharedFileRevisions, setSharedFileRevisions] = useState<
    readonly SharedProjectFileRevisionSummary[]
  >([]);
  const [selectedSharedFileRevision, setSelectedSharedFileRevision] =
    useState<SharedProjectFileRevisionDetails | null>(null);
  const [sharedComments, setSharedComments] = useState<
    readonly SharedProjectCommentSummary[]
  >([]);
  const [sharedCommentDraft, setSharedCommentDraft] = useState("");
  const [sharedActivity, setSharedActivity] = useState<
    readonly SharedProjectActivitySummary[]
  >([]);
  const [sharedAuditEvents, setSharedAuditEvents] = useState<
    readonly SharedProjectAuditEventSummary[]
  >([]);
  const [sharedMembers, setSharedMembers] = useState<
    readonly SharedProjectMemberSummary[]
  >([]);
  const [sharedAgentChangeSets, setSharedAgentChangeSets] = useState<
    readonly SharedProjectAgentChangeSetSummary[]
  >([]);
  const [sharedAgentRuns, setSharedAgentRuns] = useState<
    readonly SharedProjectAgentRunSummary[]
  >([]);
  const [sharedAgentRunIdsBySessionId, setSharedAgentRunIdsBySessionId] = useState<
    Readonly<Record<string, string>>
  >({});
  const [sharedAgentRunIdsByLocalChangeSetId, setSharedAgentRunIdsByLocalChangeSetId] =
    useState<Readonly<Record<string, string>>>({});
  const [sharedPresence, setSharedPresence] = useState<
    readonly SharedProjectPresenceSummary[]
  >([]);
  const [sharedServerUrl, setSharedServerUrl] = useState("http://127.0.0.1:3768");
  const [sharedEmail, setSharedEmail] = useState("");
  const [sharedName, setSharedName] = useState("");
  const [sharedProjectName, setSharedProjectName] = useState("shared-paper");
  const [sharedInviteEmail, setSharedInviteEmail] = useState("");
  const [sharedInviteRole, setSharedInviteRole] =
    useState<Exclude<SharedProjectRole, "owner">>("editor");
  const [sharedInvitationId, setSharedInvitationId] = useState("");
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedStatus, setSharedStatus] = useState("Connect to a shared server.");
  const [sharedDocumentSyncStatus, setSharedDocumentSyncStatus] = useState(
    "Shared editor sync idle."
  );
  const [sharedDocumentConflictPaths, setSharedDocumentConflictPaths] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [sharedDocumentOperationFailedPaths, setSharedDocumentOperationFailedPaths] =
    useState<ReadonlySet<string>>(() => new Set());
  const [sharedDocumentPendingOperations, setSharedDocumentPendingOperations] =
    useState<Readonly<Record<string, readonly SharedDocumentPendingOperation[]>>>({});
  const [sharedDocumentUpdateCursors, setSharedDocumentUpdateCursors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [sharedRealtimeActivityVersion, setSharedRealtimeActivityVersion] = useState(0);
  const [sharedRealtimeAgentVersion, setSharedRealtimeAgentVersion] = useState(0);
  const [sharedRealtimeBuildVersion, setSharedRealtimeBuildVersion] = useState(0);
  const [sharedRealtimeCommentVersion, setSharedRealtimeCommentVersion] = useState(0);
  const [sharedRealtimeMemberVersion, setSharedRealtimeMemberVersion] = useState(0);
  const [sharedRealtimeDocumentVersions, setSharedRealtimeDocumentVersions] = useState<
    Readonly<Record<string, number>>
  >({});
  const [sharedRealtimeTreeVersion, setSharedRealtimeTreeVersion] = useState(0);
  const [sharedAgentChangeSetIdsByLocalId, setSharedAgentChangeSetIdsByLocalId] =
    useState<Readonly<Record<string, string>>>({});
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
  const [shareModalOpen, setShareModalOpen] = useState(false);
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
  const [wordChangeSets, setWordChangeSets] = useState<readonly WordChangeSet[]>([]);
  const [acceptedHunkIndexesByChangeSet, setAcceptedHunkIndexesByChangeSet] = useState<
    Readonly<Record<string, readonly number[]>>
  >({});
  const [changeSetVerifications, setChangeSetVerifications] = useState<
    Readonly<Record<string, ChangeSetVerification>>
  >({});
  const [auditEvents, setAuditEvents] = useState<readonly AuditEvent[]>([]);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [selectedWordChangeSetId, setSelectedWordChangeSetId] = useState<string | null>(
    null
  );
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
  const [agentImageAttachments, setAgentImageAttachments] = useState<
    readonly AgentImageAttachment[]
  >([]);
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
  const [agentEvents, setAgentEvents] = useState<readonly AgentEvent[]>([]);
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
  const sharedPresenceDecorationsRef = useRef<ReturnType<
    MonacoStandaloneEditor["createDecorationsCollection"]
  > | null>(null);
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
  const sharedRemoteEditPathsRef = useRef<Set<string>>(new Set());
  const sharedProjectCanEdit =
    activeSharedProject === null || activeSharedProject.role !== "viewer";

  useEffect(() => {
    setSharedDocumentConflictPaths((paths) => (paths.size === 0 ? paths : new Set()));
    setSharedDocumentOperationFailedPaths((paths) =>
      paths.size === 0 ? paths : new Set()
    );
    setSharedDocumentPendingOperations((operations) =>
      Object.keys(operations).length === 0 ? operations : {}
    );
    setSharedDocumentUpdateCursors((cursors) =>
      Object.keys(cursors).length === 0 ? cursors : {}
    );
    setSharedAgentChangeSetIdsByLocalId((idsByLocalId) =>
      Object.keys(idsByLocalId).length === 0 ? idsByLocalId : {}
    );
    setSharedAgentRunIdsBySessionId((idsBySessionId) =>
      Object.keys(idsBySessionId).length === 0 ? idsBySessionId : {}
    );
  }, [activeSharedProject?.id]);

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
      sharedPresenceDecorationsRef.current?.clear();
      sharedPresenceDecorationsRef.current = null;
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

  useLayoutEffect(() => {
    const contentRow = contentRowRef.current;

    if (contentRow === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const contentRowResizeObserver = new ResizeObserver(() => {
      scheduleEditorLayout();
    });
    contentRowResizeObserver.observe(contentRow);

    return () => contentRowResizeObserver.disconnect();
  }, [scheduleEditorLayout]);

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
    void desktopApi.shared.getConnection().then((connection) => {
      setSharedConnection(connection);
      if (connection.baseUrl !== undefined) {
        setSharedServerUrl(connection.baseUrl);
      }
      if (connection.user !== undefined) {
        setSharedEmail(connection.user.email);
        setSharedName(connection.user.name);
      }
      if (connection.connected) {
        void desktopApi.shared.listProjects().then(setSharedProjects);
        void desktopApi.shared.listSessions().then(setSharedSessions);
      }
    });
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
    if (activeSharedProject === null || !sharedConnection.connected) {
      return;
    }

    let cancelled = false;
    const projectId = activeSharedProject.id;
    const unsubscribe = desktopApi.shared.onRealtimeEvent(
      (event: SharedProjectRealtimeEvent) => {
        if (event.projectId !== projectId) {
          return;
        }

        switch (event.type) {
          case "presence.updated":
            setSharedPresence((presence) =>
              upsertSharedPresence(presence, event.presence)
            );
            break;
          case "document.updated":
            setSharedRealtimeDocumentVersions((versions) => ({
              ...versions,
              [event.path]: (versions[event.path] ?? 0) + 1
            }));
            break;
          case "file.updated":
          case "tree.updated":
            setSharedRealtimeTreeVersion((version) => version + 1);
            break;
          case "members.updated":
            setSharedRealtimeMemberVersion((version) => version + 1);
            setSharedRealtimeActivityVersion((version) => version + 1);
            break;
          case "comments.updated":
            setSharedRealtimeCommentVersion((version) => version + 1);
            setSharedRealtimeActivityVersion((version) => version + 1);
            break;
          case "build-artifact.created":
            setSharedRealtimeBuildVersion((version) => version + 1);
            setSharedRealtimeActivityVersion((version) => version + 1);
            break;
          case "agent.run.updated":
          case "agent.changeset.updated":
            setSharedRealtimeAgentVersion((version) => version + 1);
            setSharedRealtimeActivityVersion((version) => version + 1);
            break;
          case "error":
            setSharedStatus(`Shared realtime unavailable: ${event.message}`);
            break;
        }
      }
    );

    void desktopApi.shared
      .startRealtime(projectId)
      .then(() => {
        if (!cancelled) {
          setSharedStatus("Shared realtime connected.");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSharedStatus(`Shared realtime unavailable: ${getErrorMessage(error)}`);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
      void desktopApi.shared.stopRealtime(projectId);
    };
  }, [activeSharedProject, sharedConnection.connected, sharedRealtimeBuildVersion]);

  useEffect(() => {
    if (!sharedConnection.connected) {
      setSharedSessions([]);
      return;
    }

    let cancelled = false;

    void desktopApi.shared
      .listProjects()
      .then((projects) => {
        if (cancelled) {
          return;
        }

        setSharedProjects(projects);
        setActiveSharedProject((current) => {
          if (current === null) {
            return current;
          }

          const refreshedProject = projects.find(
            (project) => project.id === current.id
          );
          if (refreshedProject === undefined) {
            return null;
          }

          if (refreshedProject.compiler !== undefined) {
            setSelectedCompiler(refreshedProject.compiler);
          }

          return {
            ...current,
            role: refreshedProject.role,
            ...(refreshedProject.compiler === undefined
              ? {}
              : { compiler: refreshedProject.compiler })
          };
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setSharedStatus(`Shared projects unavailable: ${getErrorMessage(error)}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    sharedConnection.connected,
    sharedRealtimeMemberVersion,
    sharedRealtimeTreeVersion
  ]);

  useEffect(() => {
    if (!sharedConnection.connected) {
      setSharedSessions([]);
      return;
    }

    let cancelled = false;

    const refreshSessions = async () => {
      try {
        const sessions = await desktopApi.shared.listSessions();
        if (!cancelled) {
          setSharedSessions(sessions);
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(`Shared sessions unavailable: ${getErrorMessage(error)}`);
        }
      }
    };

    void refreshSessions();
    const interval = window.setInterval(() => {
      void refreshSessions();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sharedConnection.connected]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedPresence([]);
      return;
    }

    let cancelled = false;
    const refreshPresence = async () => {
      try {
        await desktopApi.shared.updatePresence({
          projectId: activeSharedProject.id,
          ...(activeFilePath === null ? {} : { filePath: activeFilePath })
        });
        const presence = await desktopApi.shared.listPresence(activeSharedProject.id);

        if (!cancelled) {
          setSharedPresence(presence);
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(getErrorMessage(error));
        }
      }
    };

    void refreshPresence();
    const presenceRefreshInterval = window.setInterval(() => {
      void refreshPresence();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(presenceRefreshInterval);
    };
  }, [activeFilePath, activeSharedProject, sharedConnection.connected]);

  useEffect(() => {
    if (
      activeSharedProject === null ||
      !sharedConnection.connected ||
      activeFilePath === null
    ) {
      return;
    }

    const editor = editorRef.current;
    if (editor === null) {
      return;
    }

    let cursorPublishTimer: number | undefined;
    const publishCursorPresence = () => {
      const position = editor.getPosition();
      if (position === null) {
        return;
      }

      if (cursorPublishTimer !== undefined) {
        window.clearTimeout(cursorPublishTimer);
      }

      cursorPublishTimer = window.setTimeout(() => {
        cursorPublishTimer = undefined;
        void desktopApi.shared
          .updatePresence({
            projectId: activeSharedProject.id,
            filePath: activeFilePath,
            cursorLine: position.lineNumber,
            cursorColumn: position.column
          })
          .catch((error) => {
            setSharedStatus(`Shared cursor unavailable: ${getErrorMessage(error)}`);
          });
      }, 250);
    };

    publishCursorPresence();
    const cursorSubscription = editor.onDidChangeCursorPosition(() => {
      publishCursorPresence();
    });

    return () => {
      cursorSubscription.dispose();
      if (cursorPublishTimer !== undefined) {
        window.clearTimeout(cursorPublishTimer);
      }
    };
  }, [activeFilePath, activeSharedProject, sharedConnection.connected]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) {
      return;
    }

    if (
      activeSharedProject === null ||
      activeFilePath === null ||
      !sharedConnection.connected
    ) {
      sharedPresenceDecorationsRef.current?.clear();
      return;
    }

    const model = editor.getModel();
    if (model === null) {
      sharedPresenceDecorationsRef.current?.clear();
      return;
    }

    sharedPresenceDecorationsRef.current ??= editor.createDecorationsCollection();
    sharedPresenceDecorationsRef.current.set(
      createSharedPresenceCursorDecorations({
        activeFilePath,
        currentUserId: sharedConnection.user?.id,
        model,
        presence: sharedPresence
      })
    );
  }, [
    activeFilePath,
    activeSharedProject,
    sharedConnection.connected,
    sharedConnection.user?.id,
    sharedPresence
  ]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedBuildArtifacts([]);
      return;
    }

    let cancelled = false;

    void desktopApi.shared
      .listBuildArtifacts(activeSharedProject.id)
      .then((artifacts) => {
        if (!cancelled) {
          setSharedBuildArtifacts(artifacts.slice(0, 5));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSharedStatus(
            `Shared build history unavailable: ${getErrorMessage(error)}`
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSharedProject, sharedConnection.connected, sharedRealtimeActivityVersion]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedActivity([]);
      return;
    }

    let cancelled = false;
    const refreshActivity = async () => {
      try {
        const activity = await desktopApi.shared.listActivity(activeSharedProject.id);

        if (!cancelled) {
          setSharedActivity(activity.slice(0, 6));
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(`Shared activity unavailable: ${getErrorMessage(error)}`);
        }
      }
    };

    void refreshActivity();
    const activityRefreshInterval = window.setInterval(() => {
      void refreshActivity();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(activityRefreshInterval);
    };
  }, [
    activeSharedProject,
    sharedConnection.connected,
    sharedRealtimeActivityVersion,
    sharedRealtimeAgentVersion
  ]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedComments([]);
      return;
    }

    let cancelled = false;
    const refreshComments = async () => {
      try {
        const comments = await desktopApi.shared.listComments(activeSharedProject.id);

        if (!cancelled) {
          setSharedComments(comments.slice(0, 12));
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(`Shared comments unavailable: ${getErrorMessage(error)}`);
        }
      }
    };

    void refreshComments();
    const commentsRefreshInterval = window.setInterval(() => {
      void refreshComments();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(commentsRefreshInterval);
    };
  }, [activeSharedProject, sharedConnection.connected, sharedRealtimeCommentVersion]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedMembers([]);
      return;
    }

    let cancelled = false;
    const refreshMembers = async () => {
      try {
        const members = await desktopApi.shared.listMembers(activeSharedProject.id);

        if (!cancelled) {
          setSharedMembers(members);
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(`Shared members unavailable: ${getErrorMessage(error)}`);
        }
      }
    };

    void refreshMembers();
    const memberRefreshInterval = window.setInterval(() => {
      void refreshMembers();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(memberRefreshInterval);
    };
  }, [activeSharedProject, sharedConnection.connected, sharedRealtimeMemberVersion]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedAgentChangeSets([]);
      setSharedAgentRuns([]);
      setSharedAuditEvents([]);
      return;
    }

    let cancelled = false;
    const refreshSharedAgentRuns = async () => {
      try {
        const [agentRuns, changesets, auditEvents] = await Promise.all([
          desktopApi.shared.listAgentRuns(activeSharedProject.id),
          desktopApi.shared.listAgentChangeSets(activeSharedProject.id),
          desktopApi.shared.listAuditEvents(activeSharedProject.id)
        ]);

        if (!cancelled) {
          setSharedAgentRuns(agentRuns.slice(0, 5));
          setSharedAgentChangeSets(changesets.slice(0, 5));
          setSharedAuditEvents(auditEvents.slice(0, 5));
        }
      } catch (error) {
        if (!cancelled) {
          setSharedStatus(`Shared agent runs unavailable: ${getErrorMessage(error)}`);
        }
      }
    };

    void refreshSharedAgentRuns();
    const sharedAgentRunsRefreshInterval = window.setInterval(() => {
      void refreshSharedAgentRuns();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(sharedAgentRunsRefreshInterval);
    };
  }, [activeSharedProject, sharedConnection.connected]);

  useEffect(() => {
    if (
      activeSharedProject === null ||
      !sharedConnection.connected ||
      !sharedProjectCanEdit
    ) {
      return;
    }

    const pendingEntries = Object.entries(sharedDocumentPendingOperations).filter(
      ([, operations]) => operations.length > 0
    );
    if (pendingEntries.length === 0) {
      return;
    }

    const replayTimer = window.setTimeout(() => {
      void (async () => {
        for (const [path, operations] of pendingEntries) {
          if (sharedDocumentConflictPaths.has(path)) {
            continue;
          }

          const pendingOperation = operations[0];
          if (pendingOperation === undefined) {
            continue;
          }

          setSharedDocumentSyncStatus(
            `Replaying ${operations.length} queued shared ${operations.length === 1 ? "operation" : "operations"} for ${path}...`
          );

          try {
            const result = await desktopApi.shared.applyDocumentTextOperations({
              projectId: activeSharedProject.id,
              path,
              operations: pendingOperation.operations,
              clientOperationId: pendingOperation.id
            });
            if (result.lastUpdateId !== undefined) {
              setSharedDocumentUpdateCursors((cursors) =>
                cursors[result.path] === result.lastUpdateId
                  ? cursors
                  : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
              );
            }
            appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
            setOpenFiles((files) =>
              files.map((candidate) => {
                if (
                  candidate.path !== result.path ||
                  candidate.documentKind !== "text"
                ) {
                  return candidate;
                }

                return {
                  ...candidate,
                  contents:
                    candidate.contents === pendingOperation.contents
                      ? result.contents
                      : candidate.contents,
                  savedContents: result.contents,
                  mtimeMs: result.mtimeMs,
                  stale: false
                };
              })
            );
            let remainingCount = 0;
            setSharedDocumentPendingOperations((currentOperations) => {
              const currentPathOperations = currentOperations[result.path] ?? [];
              if (currentPathOperations[0]?.id !== pendingOperation.id) {
                remainingCount = currentPathOperations.length;
                return currentOperations;
              }

              const remainingOperations = currentPathOperations.slice(1);
              remainingCount = remainingOperations.length;
              if (remainingOperations.length > 0) {
                return {
                  ...currentOperations,
                  [result.path]: remainingOperations
                };
              }

              const { [result.path]: _syncedOperations, ...nextOperations } =
                currentOperations;
              return nextOperations;
            });
            if (remainingCount === 0) {
              setSharedDocumentOperationFailedPaths((paths) => {
                if (!paths.has(result.path)) {
                  return paths;
                }

                const nextPaths = new Set(paths);
                nextPaths.delete(result.path);
                return nextPaths;
              });
            }
            setSharedDocumentSyncStatus(
              remainingCount === 0
                ? `Synced queued shared operations for ${result.path}.`
                : `Synced one queued shared operation for ${result.path}; ${remainingCount} pending.`
            );
          } catch (error) {
            setSharedDocumentOperationFailedPaths((paths) =>
              paths.has(path) ? paths : new Set(paths).add(path)
            );
            setSharedDocumentSyncStatus(
              `Queued shared operation retry failed: ${getErrorMessage(error)}`
            );
            break;
          }
        }
      })();
    }, 1_500);

    return () => window.clearTimeout(replayTimer);
  }, [
    activeSharedProject,
    sharedConnection.connected,
    sharedDocumentConflictPaths,
    sharedDocumentPendingOperations,
    sharedProjectCanEdit
  ]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      setSharedDocumentSyncStatus("Shared editor sync idle.");
      setSharedDocumentConflictPaths((paths) => (paths.size === 0 ? paths : new Set()));
      setSharedDocumentOperationFailedPaths((paths) =>
        paths.size === 0 ? paths : new Set()
      );
      setSharedDocumentPendingOperations((operations) =>
        Object.keys(operations).length === 0 ? operations : {}
      );
      setSharedDocumentUpdateCursors((cursors) =>
        Object.keys(cursors).length === 0 ? cursors : {}
      );
      return;
    }

    const file =
      activeFilePath === null
        ? undefined
        : openFiles.find((candidate) => candidate.path === activeFilePath);

    if (
      file === undefined ||
      file.documentKind !== "text" ||
      file.contents === file.savedContents
    ) {
      return;
    }

    if (sharedDocumentConflictPaths.has(file.path)) {
      setSharedDocumentSyncStatus(`Resolve remote changes for ${file.path}.`);
      return;
    }

    const pendingOperations = sharedDocumentPendingOperations[file.path] ?? [];
    if (pendingOperations.length > 0) {
      setSharedDocumentSyncStatus(
        `${pendingOperations.length} queued shared ${pendingOperations.length === 1 ? "operation" : "operations"} pending for ${file.path}.`
      );
      return;
    }

    if (!sharedDocumentOperationFailedPaths.has(file.path)) {
      setSharedDocumentSyncStatus(`Waiting for shared operation ack for ${file.path}.`);
      return;
    }

    const syncTimer = window.setTimeout(() => {
      void (async () => {
        setSharedDocumentSyncStatus(
          `Shared operation fallback syncing ${file.path}...`
        );
        try {
          const result = await desktopApi.shared.syncDocumentContents({
            projectId: activeSharedProject.id,
            path: file.path,
            contents: file.contents
          });
          if (result.lastUpdateId !== undefined) {
            setSharedDocumentUpdateCursors((cursors) =>
              cursors[result.path] === result.lastUpdateId
                ? cursors
                : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
            );
          }
          appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
          setOpenFiles((files) =>
            files.map((candidate) => {
              if (candidate.path !== result.path || candidate.documentKind !== "text") {
                return candidate;
              }

              return {
                ...candidate,
                contents:
                  candidate.contents === file.contents
                    ? result.contents
                    : candidate.contents,
                savedContents: result.contents,
                mtimeMs: result.mtimeMs,
                stale: false
              };
            })
          );
          setSharedDocumentOperationFailedPaths((paths) => {
            if (!paths.has(result.path)) {
              return paths;
            }

            const nextPaths = new Set(paths);
            nextPaths.delete(result.path);
            return nextPaths;
          });
          setSharedDocumentSyncStatus(`Synced ${result.path}.`);
        } catch (error) {
          setSharedDocumentConflictPaths((paths) =>
            paths.has(file.path) ? paths : new Set(paths).add(file.path)
          );
          setSharedDocumentSyncStatus(
            `Shared sync failed for ${file.path}; resolve remote changes before saving. ${getErrorMessage(error)}`
          );
        }
      })();
    }, 700);

    return () => window.clearTimeout(syncTimer);
  }, [
    activeFilePath,
    activeSharedProject,
    openFiles,
    sharedConnection.connected,
    sharedDocumentConflictPaths,
    sharedDocumentOperationFailedPaths,
    sharedDocumentPendingOperations
  ]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      return;
    }

    const file =
      activeFilePath === null
        ? undefined
        : openFiles.find((candidate) => candidate.path === activeFilePath);

    if (file === undefined || file.documentKind !== "text") {
      return;
    }

    let pullCancelled = false;
    let pullInFlight = false;
    const pullSharedDocumentUpdates = () => {
      if (pullCancelled || pullInFlight) {
        return;
      }

      pullInFlight = true;
      void (async () => {
        const afterUpdateId = sharedDocumentUpdateCursors[file.path];
        try {
          const result = await desktopApi.shared.pullDocumentContents({
            projectId: activeSharedProject.id,
            path: file.path,
            ...(afterUpdateId === undefined ? {} : { afterUpdateId })
          });
          if (pullCancelled) {
            return;
          }

          if (result.lastUpdateId !== undefined) {
            setSharedDocumentUpdateCursors((cursors) =>
              cursors[result.path] === result.lastUpdateId
                ? cursors
                : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
            );
          }

          if (result.remoteUpdateCount === 0) {
            return;
          }

          if (result.contents === file.savedContents) {
            return;
          }

          appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
          const conflictDetected = file.contents !== file.savedContents;
          const remoteTextOperations = result.remoteTextOperations ?? [];
          if (
            !conflictDetected &&
            activeFilePath === result.path &&
            editorRef.current !== null &&
            remoteTextOperations.length > 0
          ) {
            sharedRemoteEditPathsRef.current.add(result.path);
            try {
              applySharedRemoteTextOperationsToEditor(
                editorRef.current,
                remoteTextOperations
              );
            } finally {
              sharedRemoteEditPathsRef.current.delete(result.path);
            }
          }
          setOpenFiles((files) =>
            files.map((candidate) => {
              if (candidate.path !== result.path || candidate.documentKind !== "text") {
                return candidate;
              }

              const hasLocalEdits = candidate.contents !== candidate.savedContents;
              return {
                ...candidate,
                contents: hasLocalEdits ? candidate.contents : result.contents,
                savedContents: result.contents,
                mtimeMs: result.mtimeMs,
                stale: hasLocalEdits
              };
            })
          );
          if (conflictDetected) {
            setSharedDocumentConflictPaths((paths) => {
              const nextPaths = new Set(paths);
              nextPaths.add(result.path);
              return nextPaths;
            });
          }
          setSharedDocumentSyncStatus(
            file.contents === file.savedContents
              ? `Pulled ${result.path}.`
              : `Remote changes available for ${result.path}.`
          );
        } catch (error) {
          if (pullCancelled) {
            return;
          }

          setSharedDocumentSyncStatus(`Shared pull failed: ${getErrorMessage(error)}`);
        } finally {
          pullInFlight = false;
        }
      })();
    };

    const sharedRemotePullInterval = window.setInterval(
      pullSharedDocumentUpdates,
      2_500
    );
    pullSharedDocumentUpdates();

    return () => {
      pullCancelled = true;
      window.clearInterval(sharedRemotePullInterval);
    };
  }, [
    activeFilePath,
    activeSharedProject,
    openFiles,
    sharedConnection.connected,
    sharedDocumentUpdateCursors,
    sharedRealtimeDocumentVersions
  ]);

  useEffect(() => {
    if (activeSharedProject === null || !sharedConnection.connected) {
      return;
    }

    const openSharedTextFiles = openFiles.filter(
      (file) =>
        file.documentKind === "text" &&
        file.path !== activeFilePath &&
        !sharedDocumentConflictPaths.has(file.path) &&
        (sharedDocumentPendingOperations[file.path] ?? []).length === 0
    );

    if (openSharedTextFiles.length === 0) {
      return;
    }

    let backgroundPullCancelled = false;
    let backgroundPullInFlight = false;
    const pullBackgroundSharedDocumentUpdates = () => {
      if (backgroundPullCancelled || backgroundPullInFlight) {
        return;
      }

      backgroundPullInFlight = true;
      void (async () => {
        try {
          for (const file of openSharedTextFiles) {
            if (backgroundPullCancelled) {
              return;
            }

            const afterUpdateId = sharedDocumentUpdateCursors[file.path];
            const result = await desktopApi.shared.pullDocumentContents({
              projectId: activeSharedProject.id,
              path: file.path,
              ...(afterUpdateId === undefined ? {} : { afterUpdateId })
            });

            if (backgroundPullCancelled) {
              return;
            }

            if (result.lastUpdateId !== undefined) {
              setSharedDocumentUpdateCursors((cursors) =>
                cursors[result.path] === result.lastUpdateId
                  ? cursors
                  : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
              );
            }

            if (
              result.remoteUpdateCount === 0 ||
              result.contents === file.savedContents
            ) {
              continue;
            }

            appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
            const conflictDetected = file.contents !== file.savedContents;
            setOpenFiles((files) =>
              files.map((candidate) => {
                if (
                  candidate.path !== result.path ||
                  candidate.documentKind !== "text"
                ) {
                  return candidate;
                }

                const hasLocalEdits = candidate.contents !== candidate.savedContents;
                return {
                  ...candidate,
                  contents: hasLocalEdits ? candidate.contents : result.contents,
                  savedContents: result.contents,
                  mtimeMs: result.mtimeMs,
                  stale: hasLocalEdits
                };
              })
            );

            if (conflictDetected) {
              setSharedDocumentConflictPaths((paths) => {
                const nextPaths = new Set(paths);
                nextPaths.add(result.path);
                return nextPaths;
              });
            }

            setSharedDocumentSyncStatus(
              conflictDetected
                ? `Remote changes available for ${result.path}.`
                : `Pulled background shared update for ${result.path}.`
            );
          }
        } catch (error) {
          if (!backgroundPullCancelled) {
            setSharedDocumentSyncStatus(
              `Shared background pull failed: ${getErrorMessage(error)}`
            );
          }
        } finally {
          backgroundPullInFlight = false;
        }
      })();
    };

    const sharedBackgroundPullInterval = window.setInterval(
      pullBackgroundSharedDocumentUpdates,
      6_000
    );
    pullBackgroundSharedDocumentUpdates();

    return () => {
      backgroundPullCancelled = true;
      window.clearInterval(sharedBackgroundPullInterval);
    };
  }, [
    activeFilePath,
    activeSharedProject,
    openFiles,
    sharedConnection.connected,
    sharedDocumentConflictPaths,
    sharedDocumentPendingOperations,
    sharedDocumentUpdateCursors,
    sharedRealtimeDocumentVersions
  ]);

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

  const attachAgentImages = useCallback(
    (files: readonly File[]) => {
      void (async () => {
        const remainingSlots = maxAgentImageAttachments - agentImageAttachments.length;

        if (remainingSlots <= 0) {
          setStatusMessage(
            `Remove an attached image before adding another. Limit: ${maxAgentImageAttachments}.`
          );
          return;
        }

        const selectedFiles = files.slice(0, remainingSlots);
        const validFiles = selectedFiles.filter(isSupportedAgentImageFile);
        const oversizedFiles = validFiles.filter(
          (file) => file.size > maxAgentImageAttachmentBytes
        );
        const readableFiles = validFiles.filter(
          (file) => file.size <= maxAgentImageAttachmentBytes
        );

        if (readableFiles.length === 0) {
          setStatusMessage(
            oversizedFiles.length > 0
              ? `Images must be ${formatBytes(maxAgentImageAttachmentBytes)} or smaller.`
              : "Drop or upload PNG, JPEG, WebP, GIF, HEIC, or HEIF images."
          );
          return;
        }

        const attachments = await Promise.all(
          readableFiles.map(readAgentImageAttachment)
        );

        setAgentImageAttachments((currentAttachments) => [
          ...currentAttachments,
          ...attachments
        ]);

        const rejectedCount = files.length - readableFiles.length;
        setStatusMessage(
          rejectedCount === 0
            ? `Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"} for the agent.`
            : `Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"}; ${rejectedCount} file${rejectedCount === 1 ? "" : "s"} skipped.`
        );
      })().catch((error) => {
        setStatusMessage(`Could not attach image: ${getErrorMessage(error)}`);
      });
    },
    [agentImageAttachments.length]
  );

  const removeAgentImageAttachment = useCallback((attachmentId: string) => {
    setAgentImageAttachments((attachments) =>
      attachments.filter((attachment) => attachment.id !== attachmentId)
    );
  }, []);

  const refreshPrivacySummary = useCallback(async () => {
    setPrivacySummary(await desktopApi.settings.getPrivacySummary());
  }, []);

  const clearLocalHistory = useCallback(() => {
    void desktopApi.settings.clearLocalHistory().then((summary) => {
      setPrivacySummary(summary);
      setHistoryChangeSets([]);
      setWordChangeSets([]);
      setAcceptedHunkIndexesByChangeSet({});
      setChangeSetVerifications({});
      setAuditEvents([]);
      setSelectedChangeSetId(null);
      setSelectedWordChangeSetId(null);
      setHistoryMessage("Local history cleared.");
    });
  }, []);
  const activeFile =
    activeFilePath === null
      ? null
      : (openFiles.find((file) => file.path === activeFilePath) ?? null);
  const isFileDirty = useCallback(
    (file: EditorFileState) =>
      !sharedProjectCanEdit
        ? false
        : file.documentKind === "word"
          ? (onlyOfficeWordFileStates[file.path]?.dirty ?? false)
          : file.contents !== file.savedContents,
    [onlyOfficeWordFileStates, sharedProjectCanEdit]
  );
  const activeFileDirty = activeFile !== null && isFileDirty(activeFile);
  const activeSharedDocumentConflict =
    activeFile !== null &&
    activeFile.documentKind === "text" &&
    sharedDocumentConflictPaths.has(activeFile.path);
  const dirtyFiles = openFiles.filter(
    (file) =>
      sharedProjectCanEdit &&
      file.documentKind === "text" &&
      file.contents !== file.savedContents
  );
  const dirtyWordFileCount = openFiles.filter(
    (file) =>
      sharedProjectCanEdit &&
      file.documentKind === "word" &&
      (onlyOfficeWordFileStates[file.path]?.dirty ?? false)
  ).length;
  const dirtyOnlyOfficeWordPath = openFiles.find(
    (file) =>
      sharedProjectCanEdit &&
      file.documentKind === "word" &&
      (onlyOfficeWordFileStates[file.path]?.dirty ?? false)
  )?.path;
  const dirtyFileCount = dirtyFiles.length + dirtyWordFileCount;
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
    void (async () => {
      if (buildRunning) {
        setStatusMessage("Stop the active compile before closing the project.");
        return;
      }

      if (dirtyFileCount > 0) {
        const confirmed = await confirmAction({
          message: "Close project and discard unsaved changes?",
          detail: `${dirtyFileCount} unsaved file${dirtyFileCount === 1 ? "" : "s"} will be lost.`,
          confirmLabel: "Discard and close",
          destructive: true
        });
        if (!confirmed) {
          return;
        }
      }

    setProjectResult(null);
    setActiveSharedProject(null);
    setOpenFiles([]);
    setOnlyOfficeWordFileStates({});
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
    setWordChangeSets([]);
    setAcceptedHunkIndexesByChangeSet({});
    setChangeSetVerifications({});
    setAuditEvents([]);
    setSelectedChangeSetId(null);
    setSelectedWordChangeSetId(null);
    setHistoryMessage("No history action yet.");
    setAgentEvents([]);
    setAgentSelectedText(null);
    setActiveAgentSelectionContext(null);
    setAgentImageAttachments([]);
    setAgentSessionId(null);
    setAgentSessionProjectRoot(null);
    setAgentSessionProviderId(null);
    setStatusMessage("Project closed");
    })();
  }, [buildRunning, dirtyFileCount, toolchainStatus]);

  const readProjectFile = useCallback(
    async (path: string, revealLine?: number) => {
      if (currentProject === undefined) {
        return;
      }

      const snapshot = await readProjectFileForRoot(currentProject.rootPath, path);
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
        setWordChangeSets([]);
        setSelectedWordChangeSetId(null);
        setAgentEvents([]);
        setAgentSelectedText(null);
        setActiveAgentSelectionContext(null);
        setAgentImageAttachments([]);
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

  const updateProjectCompiler = useCallback(
    (compiler: LatexCompiler) => {
      const sharedProject = activeSharedProject;
      setSelectedCompiler(compiler);
      updateAppSettings((settings) => ({
        ...settings,
        compiler: {
          ...settings.compiler,
          compiler
        }
      }));

      if (sharedProject === null) {
        return;
      }

      if (sharedProject.role === "viewer") {
        setStatusMessage(
          "Shared viewers can compile locally, but cannot change project settings."
        );
        return;
      }

      void runProjectOperation(async () => {
        const updated = await desktopApi.shared.updateProjectSettings({
          projectId: sharedProject.id,
          compiler
        });
        setSharedProjects((projects) =>
          projects.map((project) =>
            project.id === updated.id ? { ...project, ...updated } : project
          )
        );
        setActiveSharedProject((current) =>
          current === null || current.id !== updated.id
            ? current
            : { ...current, compiler: updated.compiler ?? compiler }
        );
        setSharedStatus(`Set shared compiler to ${formatCompilerLabel(compiler)}.`);
      });
    },
    [activeSharedProject, runProjectOperation, updateAppSettings]
  );

  const refreshSharedFileRevisions = useCallback(async () => {
    const sharedProject = activeSharedProject;
    const filePath = activeFilePath;

    if (sharedProject === null || !sharedConnection.connected || filePath === null) {
      setSharedFileRevisions([]);
      return;
    }

    try {
      const revisions = await desktopApi.shared.listFileRevisions({
        projectId: sharedProject.id,
        path: filePath
      });
      setSharedFileRevisions(revisions.slice(0, 5));
    } catch (error) {
      setSharedFileRevisions([]);
      setSharedStatus(
        `Could not load shared revisions for ${filePath}: ${getErrorMessage(error)}`
      );
    }
  }, [activeFilePath, activeSharedProject, sharedConnection.connected]);

  useEffect(() => {
    void refreshSharedFileRevisions();
  }, [refreshSharedFileRevisions, sharedRealtimeDocumentVersions]);

  useEffect(() => {
    setSelectedSharedFileRevision(null);
  }, [activeFilePath, activeSharedProject?.id]);

  const refreshHistory = useCallback(async () => {
    if (currentProject === undefined) {
      setHistoryChangeSets([]);
      setAcceptedHunkIndexesByChangeSet({});
      setAuditEvents([]);
      setSelectedChangeSetId(null);
      setWordChangeSets([]);
      setSelectedWordChangeSetId(null);
      return;
    }

    const [changeSets, persistedWordChangeSets, events] = await Promise.all([
      desktopApi.history.listChangeSets({ projectRoot: currentProject.rootPath }),
      desktopApi.history.listWordChangeSets({ projectRoot: currentProject.rootPath }),
      desktopApi.history.listAuditEvents({ projectRoot: currentProject.rootPath })
    ]);
    setHistoryChangeSets(changeSets);
    setWordChangeSets(persistedWordChangeSets);
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
    setSelectedWordChangeSetId((selectedId) => {
      if (
        selectedId !== null &&
        persistedWordChangeSets.some((changeSet) => changeSet.id === selectedId)
      ) {
        return selectedId;
      }

      return persistedWordChangeSets[0]?.id ?? null;
    });
  }, [currentProject]);

  const rememberWordChangeSets = useCallback(
    async (changesets: readonly WordChangeSet[]) => {
      if (changesets.length === 0) {
        return;
      }

      const persistedChangeSets = await Promise.all(
        changesets.map((changeset) =>
          desktopApi.history.createWordChangeSet({ changeset })
        )
      );

      setWordChangeSets((currentChangeSets) =>
        persistedChangeSets.reduce(
          (nextChangeSets, changeset) =>
            replaceWordChangeSet(nextChangeSets, changeset),
          currentChangeSets
        )
      );
      setSelectedWordChangeSetId(persistedChangeSets.at(-1)?.id ?? null);
      setBottomPanelOpen(true);
      setActiveBottomTab("History");
    },
    []
  );

  const reloadOnlyOfficeWordDocument = useCallback((filePath: string) => {
    setOnlyOfficeWordReloadVersions((versions) => ({
      ...versions,
      [filePath]: (versions[filePath] ?? 0) + 1
    }));
  }, []);

  const applyWordChangeSetsDirectly = useCallback(
    async (changesets: readonly WordChangeSet[], sourceLabel = "Agent") => {
      if (changesets.length === 0) {
        return [];
      }

      const appliedResults: WordChangeSetApplyResult[] = [];
      for (const changeset of changesets) {
        if (onlyOfficeWordFileStates[changeset.filePath]?.dirty === true) {
          throw new Error(
            `Save or sync ${changeset.filePath} in ONLYOFFICE before applying the Word edit.`
          );
        }

        const result = await desktopApi.word.applyChangeSet({ changeset });
        appliedResults.push(result);
        setWordChangeSets((currentChangeSets) =>
          replaceWordChangeSet(currentChangeSets, result.changeset)
        );
        setSelectedWordChangeSetId(result.changeset.id);
        setOpenFiles((files) =>
          upsertOpenFile(files, createEditorFileStateFromWordDocument(result.document))
        );
        setActiveFilePath(result.document.path);
        setSelectedProjectEntryPath(result.document.path);
        setSelectedProjectDirectoryPath(getProjectDirectoryPath(result.document.path));
        appWrittenProjectPathsRef.current.add(
          normalizeProjectPath(result.document.path)
        );
        reloadOnlyOfficeWordDocument(result.document.path);
      }

      const lastResult = appliedResults.at(-1);
      if (lastResult !== undefined) {
        setHistoryMessage(
          appliedResults.length === 1
            ? `${sourceLabel} applied ${lastResult.changeset.summary}; Word document verified.`
            : `${sourceLabel} applied ${appliedResults.length} Word edits; documents verified.`
        );
      }

      await refreshHistory();
      return appliedResults;
    },
    [onlyOfficeWordFileStates, refreshHistory, reloadOnlyOfficeWordDocument]
  );

  const handleAgentWordChangeSets = useCallback(
    async (
      changesets: readonly WordChangeSet[],
      options: {
        readonly autoApply: boolean;
        readonly proposedLabel?: string;
        readonly appliedLabel?: string;
      }
    ) => {
      if (changesets.length === 0) {
        return { applied: false, count: 0 };
      }

      if (options.autoApply) {
        const appliedResults = await applyWordChangeSetsDirectly(
          changesets,
          options.appliedLabel ?? "Agent"
        );
        return { applied: appliedResults.length > 0, count: appliedResults.length };
      }

      await rememberWordChangeSets(changesets);
      setHistoryMessage(
        changesets.length === 1
          ? `${options.proposedLabel ?? "Agent proposed"} ${changesets[0]!.summary}`
          : `${options.proposedLabel ?? "Agent proposed"} ${changesets.length} Word changes`
      );
      return { applied: false, count: changesets.length };
    },
    [applyWordChangeSetsDirectly, rememberWordChangeSets]
  );

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
        setActiveSharedProject(null);
        await applyProjectResult(result);
      }
    });
  }, [applyProjectResult, runProjectOperation]);

  const openRecentProject = useCallback(
    (rootPath: string) => {
      void runProjectOperation(async () => {
        setActiveSharedProject(null);
        await applyProjectResult(await desktopApi.project.openRecent(rootPath));
      });
    },
    [applyProjectResult, runProjectOperation]
  );

  const clearRecentProjects = useCallback(() => {
    void runProjectOperation(async () => {
      const result = await desktopApi.project.clearRecent();
      setProjectState(result);
      setStatusMessage("Cleared recent projects.");
    });
  }, [runProjectOperation]);

  const removeRecentProject = useCallback(
    (rootPath: string) => {
      void runProjectOperation(async () => {
        const result = await desktopApi.project.removeRecent(rootPath);
        setProjectState(result);
        setStatusMessage("Removed project from recent.");
      });
    },
    [runProjectOperation]
  );

  const refreshSharedProjects = useCallback(() => {
    void runProjectOperation(async () => {
      if (!sharedConnection.connected) {
        setSharedStatus("Sign in before refreshing shared projects.");
        return;
      }

      setSharedBusy(true);
      try {
        const projects = await desktopApi.shared.listProjects();
        setSharedProjects(projects);
        setSharedStatus(
          projects.length === 1
            ? "Loaded 1 shared project."
            : `Loaded ${projects.length} shared projects.`
        );
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation, sharedConnection.connected]);

  const signInToSharedProjects = useCallback(() => {
    void runProjectOperation(async () => {
      const baseUrl = sharedServerUrl.trim();
      const email = sharedEmail.trim();
      const name = sharedName.trim();

      if (baseUrl.length === 0 || email.length === 0) {
        setSharedStatus("Enter a server URL and email.");
        return;
      }

      setSharedBusy(true);
      try {
        const connection = await desktopApi.shared.signIn(
          name.length === 0 ? { baseUrl, email } : { baseUrl, email, name }
        );
        const [projects, sessions] = await Promise.all([
          desktopApi.shared.listProjects(),
          desktopApi.shared.listSessions()
        ]);
        setSharedConnection(connection);
        setSharedProjects(projects);
        setSharedSessions(sessions);
        setSharedStatus(
          connection.user === undefined
            ? "Signed in to shared projects."
            : `Signed in as ${connection.user.email}.`
        );
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation, sharedEmail, sharedName, sharedServerUrl]);

  const signOutFromSharedProjects = useCallback(() => {
    void runProjectOperation(async () => {
      setSharedBusy(true);
      try {
        const connection = await desktopApi.shared.signOut();
        setSharedConnection(connection);
        setSharedProjects([]);
        setSharedSessions([]);
        setSharedMembers([]);
        setSharedPresence([]);
        setSharedBuildArtifacts([]);
        setSharedActivity([]);
        setSharedAuditEvents([]);
        setSharedAgentRuns([]);
        setSharedAgentChangeSets([]);
        setSharedAgentRunIdsBySessionId({});
        setSharedAgentRunIdsByLocalChangeSetId({});
        setSharedAgentChangeSetIdsByLocalId({});
        setSharedDocumentConflictPaths(new Set());
        setSharedDocumentOperationFailedPaths(new Set());
        setSharedDocumentPendingOperations({});
        setSharedDocumentUpdateCursors({});
        setSharedRealtimeDocumentVersions({});
        setSharedDocumentSyncStatus("Shared editor sync idle.");
        setActiveSharedProject(null);
        setSharedStatus("Signed out of shared projects.");
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation]);

  const revokeSharedSession = useCallback(
    (sessionId: string) => {
      void runProjectOperation(async () => {
        if (!sharedConnection.connected) {
          setSharedStatus("Sign in before managing sessions.");
          return;
        }

        setSharedBusy(true);
        try {
          const result = await desktopApi.shared.revokeSession({ sessionId });
          const sessions = await desktopApi.shared.listSessions();
          setSharedSessions(sessions);
          setSharedStatus(
            result.revoked
              ? `Revoked ${formatSharedSessionLabel({ id: sessionId })}.`
              : "Shared session was already inactive."
          );
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [runProjectOperation, sharedConnection.connected]
  );

  const createSharedProject = useCallback(() => {
    void runProjectOperation(async () => {
      const name = sharedProjectName.trim();

      if (!sharedConnection.connected) {
        setSharedStatus("Sign in before creating a shared project.");
        return;
      }

      if (name.length === 0) {
        setSharedStatus("Enter a shared project name.");
        return;
      }

      setSharedBusy(true);
      try {
        const project = await desktopApi.shared.createProject({
          name,
          files: [
            {
              path: "main.tex",
              contents:
                "\\documentclass{article}\n\\begin{document}\nShared ZeroLeaf project.\n\\end{document}\n"
            }
          ]
        });
        const projects = await desktopApi.shared.listProjects();
        setSharedProjects(projects);
        setSharedProjectName("");
        setSharedStatus(`Created ${project.name}.`);
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation, sharedConnection.connected, sharedProjectName]);

  const createSharedProjectFromLocalProject = useCallback(() => {
    void runProjectOperation(async () => {
      const currentProject = projectResult?.project;
      const name = sharedProjectName.trim();

      if (!sharedConnection.connected) {
        setSharedStatus("Sign in before sharing a local project.");
        return;
      }

      if (currentProject === undefined) {
        setSharedStatus("Open a local project before sharing it.");
        return;
      }

      if (activeSharedProject !== null) {
        setSharedStatus("This project is already shared.");
        return;
      }

      if (name.length === 0) {
        setSharedStatus("Enter a shared project name.");
        return;
      }

      setSharedBusy(true);
      try {
        const created = await desktopApi.shared.createFromLocalProject({
          projectRoot: currentProject.rootPath,
          name
        });
        const [projects, opened] = await Promise.all([
          desktopApi.shared.listProjects(),
          desktopApi.shared.openProject(created.project.id)
        ]);
        setSharedProjects(projects);
        setSharedProjectName("");
        setActiveSharedProject({
          id: opened.sharedProjectId,
          localCachePath: opened.localCachePath,
          role: opened.role,
          ...(opened.compiler === undefined ? {} : { compiler: opened.compiler })
        });
        if (opened.compiler !== undefined) {
          setSelectedCompiler(opened.compiler);
        }
        await applyProjectResult(opened, opened.project.mainFilePath);
        setProjectState({ recentProjects: opened.recentProjects });
        setSharedStatus(
          `Shared ${created.importedFileCount} files from ${currentProject.displayName}${
            created.skippedFilePaths.length === 0
              ? "."
              : `; skipped ${created.skippedFilePaths.length} binary or unsupported files.`
          }`
        );
      } finally {
        setSharedBusy(false);
      }
    });
  }, [
    activeSharedProject,
    applyProjectResult,
    projectResult?.project,
    runProjectOperation,
    sharedConnection.connected,
    sharedProjectName
  ]);

  const createSharedProjectFromSourceZip = useCallback(() => {
    void runProjectOperation(async () => {
      const name = sharedProjectName.trim();

      if (!sharedConnection.connected) {
        setSharedStatus("Sign in before importing a shared ZIP.");
        return;
      }

      setSharedBusy(true);
      try {
        const created = await desktopApi.shared.createFromSourceZip(
          name.length === 0 ? {} : { name }
        );
        if (created === undefined) {
          setSharedStatus("Shared ZIP import cancelled.");
          return;
        }
        const projects = await desktopApi.shared.listProjects();
        setSharedProjects(projects);
        setSharedProjectName("");
        setSharedStatus(
          `Imported ${created.importedFileCount} files into ${created.project.name}${
            created.skippedFilePaths.length === 0
              ? "."
              : `; skipped ${created.skippedFilePaths.length} unsupported files.`
          }`
        );
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation, sharedConnection.connected, sharedProjectName]);

  const openSharedProject = useCallback(
    (projectId: string) => {
      void runProjectOperation(async () => {
        setSharedBusy(true);
        try {
          const result = await desktopApi.shared.openProject(projectId);
          setActiveSharedProject({
            id: result.sharedProjectId,
            localCachePath: result.localCachePath,
            role: result.role,
            ...(result.compiler === undefined ? {} : { compiler: result.compiler })
          });
          if (result.compiler !== undefined) {
            setSelectedCompiler(result.compiler);
          }
          await applyProjectResult(result, result.project.mainFilePath);
          setProjectState({ recentProjects: result.recentProjects });
          setSharedStatus(`Opened ${result.project.displayName} from shared cache.`);
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [applyProjectResult, runProjectOperation]
  );

  const deleteSharedProject = useCallback(
    (project: SharedProjectSummary) => {
      void runProjectOperation(async () => {
        if (project.role !== "owner") {
          setSharedStatus("Only owners can delete shared projects.");
          return;
        }

        const confirmed = await confirmAction({
          message: `Delete shared project "${project.name}"?`,
          detail:
            "This can't be undone. All collaborators will lose access immediately.",
          confirmLabel: "Delete project",
          destructive: true
        });
        if (!confirmed) {
          return;
        }

        setSharedBusy(true);
        try {
          const deletedProject = await desktopApi.shared.deleteProject({
            projectId: project.id
          });
          setSharedProjects((projects) =>
            projects.filter((candidate) => candidate.id !== project.id)
          );
          if (activeSharedProject?.id === project.id) {
            setActiveSharedProject(null);
          }
          setSharedStatus(`Deleted shared project ${deletedProject.name}.`);
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [activeSharedProject?.id, runProjectOperation]
  );

  const exportSharedProjectSourceZip = useCallback(
    (project: SharedProjectSummary) => {
      void runProjectOperation(async () => {
        if (project.role !== "owner") {
          setSharedStatus("Only owners can export shared projects.");
          return;
        }

        setSharedBusy(true);
        try {
          const result = await desktopApi.shared.exportSourceZip({
            projectId: project.id
          });
          setSharedStatus(
            result === undefined
              ? "Shared source export cancelled."
              : `Exported ${result.fileCount} shared source files.`
          );
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [runProjectOperation]
  );

  const inviteToActiveSharedProject = useCallback(() => {
    void runProjectOperation(async () => {
      const email = sharedInviteEmail.trim();

      if (activeSharedProject === null) {
        setSharedStatus("Open a shared project before inviting collaborators.");
        return;
      }

      if (activeSharedProject.role !== "owner") {
        setSharedStatus("Only shared project owners can invite collaborators.");
        return;
      }

      if (email.length === 0) {
        setSharedStatus("Enter an email address to invite.");
        return;
      }

      setSharedBusy(true);
      try {
        const invitation = await desktopApi.shared.invite({
          projectId: activeSharedProject.id,
          email,
          role: sharedInviteRole
        });
        setSharedInviteEmail("");
        setSharedStatus(`Invited ${invitation.email} as ${invitation.role}.`);
      } finally {
        setSharedBusy(false);
      }
    });
  }, [activeSharedProject, runProjectOperation, sharedInviteEmail, sharedInviteRole]);

  const updateSharedMemberRole = useCallback(
    (userId: string, role: Exclude<SharedProjectRole, "owner">) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null) {
          setSharedStatus("Open a shared project before managing collaborators.");
          return;
        }

        if (activeSharedProject.role !== "owner") {
          setSharedStatus("Only shared project owners can manage collaborators.");
          return;
        }

        setSharedBusy(true);
        try {
          const member = await desktopApi.shared.updateMemberRole({
            projectId: activeSharedProject.id,
            userId,
            role
          });
          const members = await desktopApi.shared.listMembers(activeSharedProject.id);
          setSharedMembers(members);
          setSharedStatus(
            `Updated ${member.email ?? member.userId} to ${formatSharedProjectRole(
              member.role
            )}.`
          );
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [activeSharedProject, runProjectOperation]
  );

  const transferSharedOwnership = useCallback(
    (member: SharedProjectMemberSummary) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null) {
          setSharedStatus("Open a shared project before managing collaborators.");
          return;
        }

        if (activeSharedProject.role !== "owner") {
          setSharedStatus("Only shared project owners can transfer ownership.");
          return;
        }

        const memberLabel = member.email ?? member.name ?? member.userId;
        const confirmed = await confirmAction({
          message: `Transfer ownership to ${memberLabel}?`,
          detail: "You will become an editor on this project.",
          confirmLabel: "Transfer ownership"
        });
        if (!confirmed) {
          return;
        }

        setSharedBusy(true);
        try {
          const members = await desktopApi.shared.transferOwnership({
            projectId: activeSharedProject.id,
            userId: member.userId
          });
          const projects = await desktopApi.shared.listProjects();
          const nextActiveRole =
            projects.find((project) => project.id === activeSharedProject.id)?.role ??
            "editor";

          setSharedMembers(members);
          setSharedProjects(projects);
          setActiveSharedProject({
            ...activeSharedProject,
            role: nextActiveRole
          });
          setSharedStatus(`Transferred ownership to ${memberLabel}.`);
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [activeSharedProject, runProjectOperation]
  );

  const removeSharedMember = useCallback(
    (userId: string) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null) {
          setSharedStatus("Open a shared project before managing collaborators.");
          return;
        }

        if (activeSharedProject.role !== "owner") {
          setSharedStatus("Only shared project owners can manage collaborators.");
          return;
        }

        setSharedBusy(true);
        try {
          const member = await desktopApi.shared.removeMember({
            projectId: activeSharedProject.id,
            userId
          });
          const members = await desktopApi.shared.listMembers(activeSharedProject.id);
          setSharedMembers(members);
          setSharedPresence((presence) =>
            presence.filter((entry) => entry.userId !== userId)
          );
          setSharedStatus(`Removed ${member.email ?? member.userId}.`);
        } finally {
          setSharedBusy(false);
        }
      });
    },
    [activeSharedProject, runProjectOperation]
  );

  const acceptSharedInvitation = useCallback(() => {
    void runProjectOperation(async () => {
      const invitationId = sharedInvitationId.trim();

      if (!sharedConnection.connected) {
        setSharedStatus("Sign in before accepting an invitation.");
        return;
      }

      if (invitationId.length === 0) {
        setSharedStatus("Enter an invitation id.");
        return;
      }

      setSharedBusy(true);
      try {
        await desktopApi.shared.acceptInvitation({ invitationId });
        const projects = await desktopApi.shared.listProjects();
        setSharedProjects(projects);
        setSharedInvitationId("");
        setSharedStatus("Invitation accepted.");
      } finally {
        setSharedBusy(false);
      }
    });
  }, [runProjectOperation, sharedConnection.connected, sharedInvitationId]);

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

  useEffect(() => {
    if (
      activeSharedProject === null ||
      currentProject === undefined ||
      sharedRealtimeTreeVersion === 0
    ) {
      return;
    }

    refreshProjectTree();
  }, [
    activeSharedProject,
    currentProject,
    refreshProjectTree,
    sharedRealtimeTreeVersion
  ]);

  const importSourceZip = useCallback(() => {
    void runProjectOperation(async () => {
      const result = await desktopApi.lifecycle.importSourceZip();
      if (result !== undefined) {
        setActiveSharedProject(null);
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
        setActiveSharedProject(null);
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
      const authStatus = agentAuthStatuses[agentProviderId];
      const providerLabel = getAgentProviderLabel(agentProviderId);

      if (authStatus.state !== "connected") {
        setStatusMessage(
          `${providerLabel} is ${formatAgentAuthState(authStatus.state)}. Check AI Providers settings.`
        );
        return;
      }

      setAgentRunning(true);
      setAgentLiveStatus({
        detail: `Choose a destination folder for ${command.projectName}.`,
        title: "Preparing agent project",
        tone: "running"
      });
      setStatusMessage(`Creating ${command.projectName}...`);

      try {
        const projectResult = await desktopApi.lifecycle.createForAgent({
          projectName: command.projectName
        });

        if (projectResult === undefined) {
          setAgentLiveStatus({
            detail: "No folder was selected.",
            title: "Project creation cancelled",
            tone: "warning"
          });
          setStatusMessage("Project creation cancelled.");
          return;
        }

        setActiveSharedProject(null);
        await applyProjectResult(projectResult);
        let seededWordDocument: WordDocumentModel | undefined;
        if (command.documentKind === "word") {
          const wordPath = command.wordPath ?? "document.docx";
          await desktopApi.word.save({
            projectRoot: projectResult.project.rootPath,
            path: wordPath,
            blocks: []
          });
          seededWordDocument = await desktopApi.word.read({
            projectRoot: projectResult.project.rootPath,
            path: wordPath
          });
          const wordFile = createEditorFileStateFromWordDocument(seededWordDocument);
          setOpenFiles((files) => upsertOpenFile(files, wordFile));
          setActiveFilePath(wordFile.path);
          setSelectedProjectEntryPath(wordFile.path);
          setSelectedProjectDirectoryPath(getProjectDirectoryPath(wordFile.path));
          setStatusMessage(`Created ${wordFile.path}`);
        }
        setAgentLiveStatus({
          detail:
            command.documentKind === "word"
              ? "Passing the project request to the agent with the blank Word document open."
              : "Passing the project request to the agent with a scoped empty project root.",
          title: `${providerLabel} is setting up the project`,
          tone: "running"
        });
        setAgentEvents([]);

        const agentResult = await desktopApi.agent.start({
          providerId: agentProviderId,
          mode: "apply-with-review",
          projectRoot: projectResult.project.rootPath,
          maxTurns: appSettings.agentPermissions.maxTurns,
          prompt,
          ...(seededWordDocument === undefined
            ? {}
            : {
                activeFilePath: seededWordDocument.path,
                activeDocument: {
                  kind: "word" as const,
                  path: seededWordDocument.path,
                  plainText: seededWordDocument.plainText,
                  blocks: seededWordDocument.blocks,
                  warnings: seededWordDocument.warnings
                }
              }),
          compiler: selectedCompiler
        });

        setAgentSessionId(agentResult.sessionId);
        setAgentSessionProjectRoot(projectResult.project.rootPath);
        setAgentSessionProviderId(agentProviderId);
        const displayResultEvents = prepareAgentDisplayEvents(agentResult.events);
        const summaryEvent = buildAgentCompletionSummaryEvent(agentResult, {
          wordChangesAutoApply: agentMode === "autonomous-local"
        });
        setAgentEvents(
          mergeAgentThreadEvents([
            ...displayResultEvents,
            ...(summaryEvent === undefined ? [] : [summaryEvent])
          ])
        );

        const proposedChangeSets = agentResult.changesets ?? [];
        const proposedChangeSet = agentResult.changeset;
        if (proposedChangeSet !== undefined) {
          setSelectedChangeSetId(proposedChangeSet.id);
          setHistoryMessage(
            proposedChangeSets.length > 1
              ? `Agent proposed ${proposedChangeSets.length} project setup changes`
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
                    "Review the generated project files, then approve the patch to run compile verification."
                }
              ])
            )
          }));
          setActiveBottomTab("History");
          const [changeSets, auditLog] = await Promise.all([
            desktopApi.history.listChangeSets({
              projectRoot: projectResult.project.rootPath
            }),
            desktopApi.history.listAuditEvents({
              projectRoot: projectResult.project.rootPath
            })
          ]);
          setHistoryChangeSets(changeSets);
          setAuditEvents(auditLog);
        }

        const proposedWordChangeSets = getAgentResultWordChangeSets(agentResult);
        await handleAgentWordChangeSets(proposedWordChangeSets, {
          autoApply: agentMode === "autonomous-local",
          appliedLabel: "Agent",
          proposedLabel: "Agent proposed"
        });

        const agentBuildResult = agentResult.buildResult;
        if (agentBuildResult !== undefined) {
          setBuildResult(agentBuildResult);
          setActiveBottomTab("Log");
          if (agentBuildResult.status !== "succeeded") {
            setBottomPanelOpen(true);
          }
        }

        const approvalToolName = getRequestedApprovalToolName(agentResult.events);
        const refreshedProject = await desktopApi.project.refresh(
          projectResult.project.rootPath
        );
        setProjectResult(refreshedProject);
        setProjectState({ recentProjects: refreshedProject.recentProjects });
        setAgentLiveStatus({
          detail:
            agentResult.status === "awaiting-approval"
              ? "Review the generated files in History before applying them."
              : "The agent response is ready in the transcript.",
          title:
            agentResult.status === "awaiting-approval"
              ? createAwaitingApprovalLiveStatus(approvalToolName).title
              : `${providerLabel} completed project setup`,
          tone: agentResult.status === "failed" ? "danger" : "success"
        });
        setStatusMessage(
          agentResult.status === "awaiting-approval"
            ? `${providerLabel} is waiting for patch approval.`
            : `${providerLabel} completed.`
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        setAgentLiveStatus({
          detail: errorMessage,
          title: "Agent project setup failed",
          tone: "danger"
        });
        setStatusMessage("Agent project setup failed.");
      } finally {
        setAgentRunning(false);
      }
    },
    [
      agentAuthStatuses,
      agentProviderId,
      appSettings.agentPermissions.maxTurns,
      applyProjectResult,
      agentMode,
      handleAgentWordChangeSets,
      selectedCompiler
    ]
  );

  const exportCurrentPdf = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || pdfArtifactData === null) {
        return;
      }

      if (
        pdfStale &&
        !(await confirmAction({
          message: "Export the last successful PDF anyway?",
          detail: `The current PDF preview is stale (${formatPdfStaleReason(
            pdfStaleReason
          ).toLowerCase()}).`,
          confirmLabel: "Export anyway"
        }))
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

  const clearSharedDocumentConflictState = useCallback((path: string) => {
    setSharedDocumentConflictPaths((paths) => {
      if (!paths.has(path)) {
        return paths;
      }

      const nextPaths = new Set(paths);
      nextPaths.delete(path);
      return nextPaths;
    });
    setSharedDocumentOperationFailedPaths((paths) => {
      if (!paths.has(path)) {
        return paths;
      }

      const nextPaths = new Set(paths);
      nextPaths.delete(path);
      return nextPaths;
    });
    setSharedDocumentPendingOperations((operations) => {
      if (operations[path] === undefined) {
        return operations;
      }

      const { [path]: _clearedOperations, ...nextOperations } = operations;
      return nextOperations;
    });
  }, []);

  const saveEditorFileWithLocalHistory = useCallback(
    async (file: EditorFileState): Promise<SavedEditorFile> => {
      if (currentProject === undefined) {
        throw new Error("Open a project before saving.");
      }

      if (!sharedProjectCanEdit) {
        throw new Error(
          "Shared viewers can read and compile this project, but cannot edit it."
        );
      }

      const editorContents =
        file.documentKind === "text" && file.path === activeFilePath
          ? (editorRef.current?.getValue() ?? file.contents)
          : file.contents;
      const fileToSave = {
        ...file,
        contents: editorContents
      };

      if (fileToSave.documentKind === "word") {
        throw new Error("Word documents are saved through ONLYOFFICE.");
      }

      const activeSharedSaveProject =
        activeSharedProject?.localCachePath === currentProject.rootPath
          ? activeSharedProject
          : null;
      let savedContents = fileToSave.contents;
      let result: { readonly mtimeMs: number };
      try {
        if (activeSharedSaveProject !== null) {
          const pendingOperations =
            sharedDocumentPendingOperations[fileToSave.path] ?? [];
          if (pendingOperations.length > 0) {
            throw new Error(
              "Wait for queued shared operations to finish before saving."
            );
          }
          if (sharedDocumentConflictPaths.has(fileToSave.path)) {
            throw new Error("Resolve the shared document conflict before saving.");
          }

          const operations = createSharedTextOperations(
            file.savedContents,
            fileToSave.contents
          );
          if (operations.length === 0) {
            result = { mtimeMs: file.mtimeMs };
          } else {
            const sharedResult = await desktopApi.shared.applyDocumentTextOperations({
              projectId: activeSharedSaveProject.id,
              path: fileToSave.path,
              operations,
              clientOperationId: crypto.randomUUID()
            });
            if (sharedResult.lastUpdateId !== undefined) {
              setSharedDocumentUpdateCursors((cursors) =>
                cursors[sharedResult.path] === sharedResult.lastUpdateId
                  ? cursors
                  : {
                      ...cursors,
                      [sharedResult.path]: sharedResult.lastUpdateId ?? ""
                    }
              );
            }
            clearSharedDocumentConflictState(sharedResult.path);
            savedContents = sharedResult.contents;
            result = { mtimeMs: sharedResult.mtimeMs };
          }
        } else {
          result = await desktopApi.files.write({
            projectRoot: currentProject.rootPath,
            path: fileToSave.path,
            contents: fileToSave.contents
          });
        }
      } catch (error) {
        throw new Error(`Could not save ${file.path}: ${getErrorMessage(error)}`);
      }

      const savedFile = {
        ...fileToSave,
        contents: savedContents,
        savedContents,
        mtimeMs: result.mtimeMs,
        stale: false
      };

      if (savedContents === file.savedContents) {
        return { file: savedFile };
      }

      try {
        const changeset = await desktopApi.history.createAppliedChangeSet({
          projectRoot: currentProject.rootPath,
          filePath: file.path,
          beforeContents: file.savedContents,
          afterContents: savedContents,
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
    [
      activeFilePath,
      activeSharedProject,
      clearSharedDocumentConflictState,
      currentProject,
      sharedDocumentConflictPaths,
      sharedDocumentPendingOperations,
      sharedProjectCanEdit
    ]
  );

  const saveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      if (!sharedProjectCanEdit) {
        setStatusMessage(
          "Shared viewers can read and compile this project, but cannot save edits."
        );
        return;
      }

      if (activeFile.documentKind === "word") {
        const sessionId = onlyOfficeWordFileStates[activeFile.path]?.sessionId;
        if (sessionId === undefined) {
          setStatusMessage("ONLYOFFICE session is not ready for this Word document.");
          return;
        }

        const result = await desktopApi.onlyOffice.forceSave({ sessionId });
        setStatusMessage(result.message);
        if (result.requested) {
          setOnlyOfficeWordFileStates((states) => ({
            ...states,
            [activeFile.path]: {
              ...states[activeFile.path],
              sessionId,
              dirty: false
            }
          }));
          appWrittenProjectPathsRef.current.add(normalizeProjectPath(activeFile.path));
        }
        return;
      }

      const saved = await saveEditorFileWithLocalHistory(activeFile);

      setOpenFiles((files) => replaceOpenFile(files, saved.file));
      setSharedDocumentConflictPaths((paths) => {
        if (!paths.has(activeFile.path)) {
          return paths;
        }

        const nextPaths = new Set(paths);
        nextPaths.delete(activeFile.path);
        return nextPaths;
      });
      setSharedDocumentOperationFailedPaths((paths) => {
        if (!paths.has(activeFile.path)) {
          return paths;
        }

        const nextPaths = new Set(paths);
        nextPaths.delete(activeFile.path);
        return nextPaths;
      });
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
    onlyOfficeWordFileStates,
    pdfArtifactData,
    pdfStale,
    refreshHistory,
    refreshReferences,
    rememberManualSaveChangeSets,
    runProjectOperation,
    saveEditorFileWithLocalHistory,
    sharedProjectCanEdit
  ]);

  const acceptSharedRemoteDocumentChanges = useCallback(() => {
    if (
      activeFile === null ||
      activeFile.documentKind !== "text" ||
      !sharedDocumentConflictPaths.has(activeFile.path)
    ) {
      return;
    }

    const acceptedFile = {
      ...activeFile,
      contents: activeFile.savedContents,
      stale: false
    };
    setOpenFiles((files) => replaceOpenFile(files, acceptedFile));
    clearSharedDocumentConflictState(activeFile.path);
    if (pdfArtifactData !== null) {
      setPdfStale(true);
      setPdfStaleReason("saved");
    }
    setSharedDocumentSyncStatus(`Accepted remote changes for ${activeFile.path}.`);
  }, [
    activeFile,
    clearSharedDocumentConflictState,
    pdfArtifactData,
    sharedDocumentConflictPaths
  ]);

  const keepLocalSharedDocumentChanges = useCallback(() => {
    void runProjectOperation(async () => {
      if (
        activeSharedProject === null ||
        activeFile === null ||
        activeFile.documentKind !== "text" ||
        !sharedDocumentConflictPaths.has(activeFile.path)
      ) {
        return;
      }

      if (!sharedProjectCanEdit) {
        setSharedDocumentSyncStatus(
          `Shared viewers can read ${activeFile.path}, but cannot publish local conflict changes.`
        );
        return;
      }

      const localContents =
        activeFile.path === activeFilePath
          ? (editorRef.current?.getValue() ?? activeFile.contents)
          : activeFile.contents;

      setSharedDocumentSyncStatus(`Publishing local changes for ${activeFile.path}...`);
      const result = await desktopApi.shared.syncDocumentContents({
        projectId: activeSharedProject.id,
        path: activeFile.path,
        contents: localContents
      });
      if (result.lastUpdateId !== undefined) {
        setSharedDocumentUpdateCursors((cursors) =>
          cursors[result.path] === result.lastUpdateId
            ? cursors
            : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
        );
      }
      appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
      setOpenFiles((files) =>
        files.map((candidate) => {
          if (candidate.path !== result.path || candidate.documentKind !== "text") {
            return candidate;
          }

          return {
            ...candidate,
            contents: result.contents,
            savedContents: result.contents,
            mtimeMs: result.mtimeMs,
            stale: false
          };
        })
      );
      clearSharedDocumentConflictState(result.path);
      if (pdfArtifactData !== null) {
        setPdfStale(true);
        setPdfStaleReason("saved");
      }
      setSharedDocumentSyncStatus(`Published local changes for ${result.path}.`);
      await refreshReferences();
    });
  }, [
    activeFile,
    activeFilePath,
    activeSharedProject,
    clearSharedDocumentConflictState,
    pdfArtifactData,
    refreshReferences,
    runProjectOperation,
    sharedDocumentConflictPaths,
    sharedProjectCanEdit
  ]);

  const saveDirtyFiles = useCallback(async () => {
    if (currentProject === undefined || dirtyFiles.length === 0) {
      return 0;
    }

    if (!sharedProjectCanEdit) {
      setStatusMessage(
        "Shared viewers can read and compile this project, but cannot save edits."
      );
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
    saveEditorFileWithLocalHistory,
    sharedProjectCanEdit
  ]);

  const exportSourceArchive = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      await saveDirtyFiles();
      const exportChoice = await desktopApi.app.showMessageDialog({
        message: "Export the project source as a ZIP",
        detail: "Choose whether to include generated build artifacts and cache files.",
        buttons: ["Include build artifacts", "Source only", "Cancel"],
        defaultId: 1,
        cancelId: 2
      });

      if (exportChoice.buttonIndex === 2) {
        setStatusMessage("Export cancelled.");
        return;
      }

      const includeBuildArtifacts = exportChoice.buttonIndex === 0;
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
        if (dirtyWordFileCount > 0) {
          setStatusMessage(
            "Word documents are saved from the active ONLYOFFICE editor."
          );
        }
        return;
      }

      setStatusMessage(
        dirtyWordFileCount > 0
          ? `Saved ${savedCount} text files; Word documents stay in ONLYOFFICE.`
          : `Saved ${savedCount} files`
      );
    });
  }, [dirtyWordFileCount, runProjectOperation, saveDirtyFiles]);

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
    async (
      changeset: HistoryChangeSet,
      operation: "apply" | "rollback" = "apply",
      sharedAgentRunIdOverride?: string
    ) => {
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

        const sharedAgentRunId =
          sharedAgentRunIdOverride ??
          (operation === "apply"
            ? sharedAgentRunIdsByLocalChangeSetId[changeset.id]
            : undefined);
        if (
          activeSharedProject !== null &&
          sharedConnection.connected &&
          activeSharedProject.role !== "viewer" &&
          sharedAgentRunId !== undefined
        ) {
          try {
            const artifact = await desktopApi.shared.publishBuildArtifact({
              projectId: activeSharedProject.id,
              projectRoot: currentProject.rootPath,
              mainFilePath: currentProject.mainFilePath,
              buildResult: result
            });
            const updatedRun = await desktopApi.shared.attachAgentRunBuildArtifact({
              projectId: activeSharedProject.id,
              agentRunId: sharedAgentRunId,
              artifactId: artifact.id
            });
            setSharedBuildArtifacts((artifacts) =>
              [
                artifact,
                ...artifacts.filter((candidate) => candidate.id !== artifact.id)
              ].slice(0, 5)
            );
            setSharedAgentRuns((runs) =>
              [
                updatedRun,
                ...runs.filter((candidate) => candidate.id !== updatedRun.id)
              ].slice(0, 5)
            );
            const [activity, auditEvents] = await Promise.all([
              desktopApi.shared.listActivity(activeSharedProject.id),
              desktopApi.shared.listAuditEvents(activeSharedProject.id)
            ]);
            setSharedActivity(activity.slice(0, 6));
            setSharedAuditEvents(auditEvents.slice(0, 6));
            setSharedStatus("Attached shared compile verification to agent run.");
          } catch (error) {
            setSharedStatus(
              `Could not attach shared compile verification: ${getErrorMessage(error)}`
            );
          }
        }
      } finally {
        setActiveBuildJobId(null);
        setBuildRunning(false);
      }
    },
    [
      activeSharedProject,
      appSettings.agentPermissions.compileAfterPatch,
      currentProject,
      pdfArtifactData,
      pdfStale,
      pdfStaleReason,
      refreshToolchainStatus,
      showErrorInTerminal,
      saveDirtyFiles,
      selectedCompiler,
      sharedAgentRunIdsByLocalChangeSetId,
      sharedConnection.connected,
      toolchainStatus
    ]
  );

  const updateSharedAgentChangeSetStatus = useCallback(
    async (
      localChangeSetId: string,
      status: "applied" | "rejected"
    ): Promise<string | undefined> => {
      if (
        activeSharedProject === null ||
        !sharedConnection.connected ||
        activeSharedProject.role === "viewer"
      ) {
        return undefined;
      }

      const sharedChangeSetId = sharedAgentChangeSetIdsByLocalId[localChangeSetId];
      if (sharedChangeSetId === undefined) {
        return undefined;
      }

      try {
        let sharedAgentRunId: string;
        if (status === "applied") {
          const applied = await desktopApi.shared.applyAgentChangeSet({
            projectId: activeSharedProject.id,
            changesetId: sharedChangeSetId
          });
          appWrittenProjectPathsRef.current.add(
            normalizeProjectPath(applied.fileRevision.path)
          );
          setOpenFiles((files) =>
            files.map((file) =>
              file.path === applied.fileRevision.path && file.documentKind === "text"
                ? {
                    ...file,
                    contents: applied.fileRevision.contents,
                    savedContents: applied.fileRevision.contents,
                    mtimeMs: applied.fileRevision.mtimeMs,
                    stale: false
                  }
                : file
            )
          );
          clearSharedDocumentConflictState(applied.fileRevision.path);
          setSharedAgentRunIdsByLocalChangeSetId((idsByChangeSetId) => ({
            ...idsByChangeSetId,
            [localChangeSetId]: applied.changeset.agentRunId
          }));
          sharedAgentRunId = applied.changeset.agentRunId;
        } else {
          const rejected = await desktopApi.shared.rejectAgentChangeSet({
            projectId: activeSharedProject.id,
            changesetId: sharedChangeSetId
          });
          setSharedAgentRunIdsByLocalChangeSetId((idsByChangeSetId) => ({
            ...idsByChangeSetId,
            [localChangeSetId]: rejected.agentRunId
          }));
          sharedAgentRunId = rejected.agentRunId;
        }
        const activity = await desktopApi.shared.listActivity(activeSharedProject.id);
        const agentRuns = await desktopApi.shared.listAgentRuns(activeSharedProject.id);
        const changesets = await desktopApi.shared.listAgentChangeSets(
          activeSharedProject.id
        );
        setSharedActivity(activity.slice(0, 6));
        setSharedAgentRuns(agentRuns.slice(0, 5));
        setSharedAgentChangeSets(changesets.slice(0, 5));
        return sharedAgentRunId;
      } catch (error) {
        setSharedStatus(
          `Could not mark shared changeset ${status}: ${getErrorMessage(error)}`
        );
        return undefined;
      }
    },
    [
      activeSharedProject,
      clearSharedDocumentConflictState,
      sharedAgentChangeSetIdsByLocalId,
      sharedConnection.connected
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
        const sharedAgentRunId = await updateSharedAgentChangeSetStatus(
          changeset.id,
          "applied"
        );
        await verifyChangeSet(changeset, "apply", sharedAgentRunId);
      });
    },
    [
      acceptedHunkIndexesByChangeSet,
      historyChangeSets,
      readProjectFile,
      refreshHistory,
      runProjectOperation,
      updateSharedAgentChangeSetStatus,
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
        await updateSharedAgentChangeSetStatus(changeset.id, "rejected");
      });
    },
    [refreshHistory, runProjectOperation, updateSharedAgentChangeSetStatus]
  );

  const applyWordChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const changeset = wordChangeSets.find(
          (candidate) => candidate.id === changesetId
        );

        if (changeset === undefined) {
          setHistoryMessage("Select a Word changeset before applying.");
          return;
        }

        if (onlyOfficeWordFileStates[changeset.filePath]?.dirty === true) {
          setHistoryMessage(
            "Save or sync the open ONLYOFFICE document before applying this Word edit."
          );
          return;
        }

        const result = await desktopApi.word.applyChangeSet({ changeset });
        setWordChangeSets((currentChangeSets) =>
          replaceWordChangeSet(currentChangeSets, result.changeset)
        );
        setSelectedWordChangeSetId(result.changeset.id);
        setHistoryMessage(
          `Applied ${result.changeset.summary}; Word document verified.`
        );
        setOpenFiles((files) =>
          upsertOpenFile(files, createEditorFileStateFromWordDocument(result.document))
        );
        setActiveFilePath(result.document.path);
        setSelectedProjectEntryPath(result.document.path);
        setSelectedProjectDirectoryPath(getProjectDirectoryPath(result.document.path));
        appWrittenProjectPathsRef.current.add(
          normalizeProjectPath(result.document.path)
        );
        await refreshHistory();
      });
    },
    [onlyOfficeWordFileStates, refreshHistory, runProjectOperation, wordChangeSets]
  );

  const rejectWordChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const rejected = await desktopApi.history.rejectWordChangeSet(changesetId);
        setWordChangeSets((currentChangeSets) =>
          replaceWordChangeSet(currentChangeSets, rejected)
        );
        setSelectedWordChangeSetId(rejected.id);
        setHistoryMessage(`Rejected ${rejected.summary}`);
        await refreshHistory();
      });
    },
    [refreshHistory, runProjectOperation]
  );

  const rollbackWordChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const result = await desktopApi.word.rollbackChangeSet({ changesetId });
        setWordChangeSets((currentChangeSets) =>
          replaceWordChangeSet(currentChangeSets, result.changeset)
        );
        setSelectedWordChangeSetId(result.changeset.id);
        setHistoryMessage(
          `Rolled back ${result.changeset.summary}; Word document verified.`
        );
        setOpenFiles((files) =>
          upsertOpenFile(files, createEditorFileStateFromWordDocument(result.document))
        );
        setActiveFilePath(result.document.path);
        setSelectedProjectEntryPath(result.document.path);
        setSelectedProjectDirectoryPath(getProjectDirectoryPath(result.document.path));
        appWrittenProjectPathsRef.current.add(
          normalizeProjectPath(result.document.path)
        );
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

  const publishSharedBuildArtifact = useCallback(
    async (
      result: BuildResult,
      sourceRevisionId?: string
    ): Promise<SharedProjectBuildArtifactSummary | undefined> => {
      if (
        activeSharedProject === null ||
        !sharedConnection.connected ||
        activeSharedProject.role === "viewer" ||
        currentProject?.mainFilePath === undefined
      ) {
        return undefined;
      }

      try {
        const artifact = await desktopApi.shared.publishBuildArtifact({
          projectId: activeSharedProject.id,
          projectRoot: currentProject.rootPath,
          mainFilePath: currentProject.mainFilePath,
          ...(sourceRevisionId === undefined ? {} : { sourceRevisionId }),
          buildResult: result
        });
        setSharedBuildArtifacts((artifacts) =>
          [
            artifact,
            ...artifacts.filter((candidate) => candidate.id !== artifact.id)
          ].slice(0, 5)
        );
        setSharedStatus(
          `Published local ${artifact.status} compile to shared history.`
        );
        return artifact;
      } catch (error) {
        setSharedStatus(`Could not publish shared compile: ${getErrorMessage(error)}`);
        return undefined;
      }
    },
    [activeSharedProject, currentProject, sharedConnection.connected]
  );

  const inspectSharedBuildArtifact = useCallback(
    (artifactId: string) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null || !sharedConnection.connected) {
          setSharedStatus("Open a shared project before inspecting compile history.");
          return;
        }

        const artifact = await desktopApi.shared.getBuildArtifact(
          activeSharedProject.id,
          artifactId
        );
        const result = createBuildResultFromSharedArtifact(artifact, selectedCompiler);

        setBuildResult(result);
        setActiveBottomTab("Log");
        setBottomPanelOpen(true);
        setStatusMessage(
          `Opened shared ${artifact.status} ${artifact.compiler} compile from ${formatSharedArtifactCreatedAt(artifact)}.`
        );

        if (artifact.pdfBase64 !== undefined && artifact.pdfByteLength !== undefined) {
          setPdfArtifactData({
            pdfPath: `shared-build-artifact:${artifact.id}.pdf`,
            updatedAt: artifact.createdAt,
            byteLength: artifact.pdfByteLength,
            dataUrl: `data:application/pdf;base64,${artifact.pdfBase64}`
          });
          setPdfStale(false);
          setPdfStaleReason(null);
          setPdfPageNumber(1);
          setSyncTexMessage("SyncTeX unavailable for shared compile artifact");
        }
      });
    },
    [
      activeSharedProject,
      runProjectOperation,
      selectedCompiler,
      sharedConnection.connected
    ]
  );

  const inspectSharedFileRevision = useCallback(
    (revisionId: string) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null || !sharedConnection.connected) {
          setSharedStatus("Open a shared project before inspecting file revisions.");
          return;
        }

        const revision = await desktopApi.shared.getFileRevisionDetails({
          projectId: activeSharedProject.id,
          revisionId
        });
        setSelectedSharedFileRevision(revision);
        setSharedStatus(
          `Opened revision ${formatSharedRevisionLabel(revision.id)} for ${revision.path}.`
        );
      });
    },
    [activeSharedProject, runProjectOperation, sharedConnection.connected]
  );

  const restoreSharedFileRevision = useCallback(
    (revisionId: string) => {
      void runProjectOperation(async () => {
        if (
          activeSharedProject === null ||
          !sharedConnection.connected ||
          activeSharedProject.role === "viewer"
        ) {
          setSharedStatus("Shared revision restore requires Editor access.");
          return;
        }

        const restored = await desktopApi.shared.restoreFileRevision({
          projectId: activeSharedProject.id,
          revisionId
        });
        appWrittenProjectPathsRef.current.add(normalizeProjectPath(restored.path));
        setOpenFiles((files) =>
          files.map((file) =>
            file.path === restored.path && file.documentKind === "text"
              ? {
                  ...file,
                  contents: restored.contents,
                  savedContents: restored.contents,
                  mtimeMs: restored.mtimeMs,
                  stale: false
                }
              : file
          )
        );
        clearSharedDocumentConflictState(restored.path);
        await readProjectFile(restored.path);
        await refreshSharedFileRevisions();
        const activity = await desktopApi.shared.listActivity(activeSharedProject.id);
        setSharedActivity(activity.slice(0, 6));
        setSelectedSharedFileRevision(null);
        setSharedStatus(
          `Restored ${restored.path} as revision ${formatSharedRevisionLabel(restored.revisionId)}.`
        );
      });
    },
    [
      activeSharedProject,
      clearSharedDocumentConflictState,
      readProjectFile,
      refreshSharedFileRevisions,
      runProjectOperation,
      sharedConnection.connected
    ]
  );

  const createSharedComment = useCallback(() => {
    void runProjectOperation(async () => {
      const body = sharedCommentDraft.trim();

      if (activeSharedProject === null || !sharedConnection.connected) {
        setSharedStatus("Open a shared project before commenting.");
        return;
      }

      if (body.length === 0) {
        setSharedStatus("Write a comment before posting.");
        return;
      }

      const comment = await desktopApi.shared.createComment({
        projectId: activeSharedProject.id,
        body,
        ...(activeFilePath === null ? {} : { filePath: activeFilePath })
      });
      const [comments, activity] = await Promise.all([
        desktopApi.shared.listComments(activeSharedProject.id),
        desktopApi.shared.listActivity(activeSharedProject.id)
      ]);
      setSharedComments(comments.slice(0, 12));
      setSharedActivity(activity.slice(0, 6));
      setSharedCommentDraft("");
      setSharedStatus(
        comment.filePath === undefined
          ? "Posted project comment."
          : `Posted comment on ${comment.filePath}.`
      );
    });
  }, [
    activeFilePath,
    activeSharedProject,
    runProjectOperation,
    sharedCommentDraft,
    sharedConnection.connected
  ]);

  const resolveSharedComment = useCallback(
    (commentId: string) => {
      void runProjectOperation(async () => {
        if (activeSharedProject === null || !sharedConnection.connected) {
          setSharedStatus("Open a shared project before resolving comments.");
          return;
        }

        const comment = await desktopApi.shared.resolveComment({
          projectId: activeSharedProject.id,
          commentId
        });
        const [comments, activity] = await Promise.all([
          desktopApi.shared.listComments(activeSharedProject.id),
          desktopApi.shared.listActivity(activeSharedProject.id)
        ]);
        setSharedComments(comments.slice(0, 12));
        setSharedActivity(activity.slice(0, 6));
        setSharedStatus(`Resolved comment ${formatSharedRevisionLabel(comment.id)}.`);
      });
    },
    [activeSharedProject, runProjectOperation, sharedConnection.connected]
  );

  const publishSharedAgentRun = useCallback(
    async (
      result: AgentSessionResult,
      prompt: string,
      mode: AgentMode,
      buildArtifactIds: readonly string[] = [],
      existingAgentRunId?: string
    ) => {
      if (
        activeSharedProject === null ||
        !sharedConnection.connected ||
        activeSharedProject.role === "viewer"
      ) {
        return undefined;
      }

      try {
        const published = await desktopApi.shared.publishAgentRun({
          projectId: activeSharedProject.id,
          ...(existingAgentRunId === undefined
            ? {}
            : { agentRunId: existingAgentRunId }),
          providerId: result.providerId,
          mode,
          prompt,
          status: toSharedProjectAgentRunStatus(result.status),
          changesetIds: getAgentResultChangeSets(result).map(
            (changeset) => changeset.id
          ),
          ...(buildArtifactIds.length === 0 ? {} : { buildArtifactIds })
        });
        setSharedAgentRunIdsBySessionId((idsBySessionId) => ({
          ...idsBySessionId,
          [result.sessionId]: published.agentRun.id
        }));
        if (published.changesets.length > 0) {
          setSharedAgentChangeSetIdsByLocalId((currentIds) => ({
            ...currentIds,
            ...Object.fromEntries(
              published.changesets.map((changeset) => [
                changeset.localChangeSetId,
                changeset.id
              ])
            )
          }));
          setSharedAgentRunIdsByLocalChangeSetId((currentIds) => ({
            ...currentIds,
            ...Object.fromEntries(
              published.changesets.map((changeset) => [
                changeset.localChangeSetId,
                published.agentRun.id
              ])
            )
          }));
        }
        const activity = await desktopApi.shared.listActivity(activeSharedProject.id);
        const agentRuns = await desktopApi.shared.listAgentRuns(activeSharedProject.id);
        const changesets = await desktopApi.shared.listAgentChangeSets(
          activeSharedProject.id
        );
        setSharedActivity(activity.slice(0, 6));
        setSharedAgentRuns(agentRuns.slice(0, 5));
        setSharedAgentChangeSets(changesets.slice(0, 5));
        return published;
      } catch (error) {
        setSharedStatus(
          `Could not publish shared agent run: ${getErrorMessage(error)}`
        );
        return undefined;
      }
    },
    [activeSharedProject, sharedConnection.connected]
  );

  const applySharedAgentChangeSetFromPanel = useCallback(
    (changeset: SharedProjectAgentChangeSetSummary) => {
      void runProjectOperation(async () => {
        if (
          activeSharedProject === null ||
          !sharedConnection.connected ||
          activeSharedProject.role === "viewer"
        ) {
          setSharedStatus("Shared agent changesets require Editor access.");
          return;
        }

        if (currentProject?.mainFilePath === undefined) {
          setSharedStatus(
            "Choose a main .tex file before applying a shared agent changeset."
          );
          return;
        }

        const applied = await desktopApi.shared.applyAgentChangeSet({
          projectId: activeSharedProject.id,
          changesetId: changeset.id
        });
        appWrittenProjectPathsRef.current.add(
          normalizeProjectPath(applied.fileRevision.path)
        );
        setOpenFiles((files) =>
          files.map((file) =>
            file.path === applied.fileRevision.path && file.documentKind === "text"
              ? {
                  ...file,
                  contents: applied.fileRevision.contents,
                  savedContents: applied.fileRevision.contents,
                  mtimeMs: applied.fileRevision.mtimeMs,
                  stale: false
                }
              : file
          )
        );
        clearSharedDocumentConflictState(applied.fileRevision.path);
        await readProjectFile(applied.fileRevision.path);

        const [activity, agentRuns, changesets] = await Promise.all([
          desktopApi.shared.listActivity(activeSharedProject.id),
          desktopApi.shared.listAgentRuns(activeSharedProject.id),
          desktopApi.shared.listAgentChangeSets(activeSharedProject.id)
        ]);
        setSharedActivity(activity.slice(0, 6));
        setSharedAgentRuns(agentRuns.slice(0, 5));
        setSharedAgentChangeSets(changesets.slice(0, 5));
        setSharedStatus(`Applied shared agent changeset for ${changeset.filePath}.`);

        if (!appSettings.agentPermissions.compileAfterPatch) {
          setSharedStatus(
            "Applied shared agent changeset; compile-after-patch is disabled."
          );
          return;
        }

        const jobId = crypto.randomUUID();
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
          setBottomPanelOpen(true);
          setSharedStatus(setupIssue);
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
        setStatusMessage("Compiling shared agent changeset...");

        try {
          const result = await desktopApi.build.run({
            jobId,
            projectRoot: currentProject.rootPath,
            mainFilePath: currentProject.mainFilePath,
            compiler: selectedCompiler
          });
          setBuildResult(result);

          const artifact = await desktopApi.shared.publishBuildArtifact({
            projectId: activeSharedProject.id,
            projectRoot: currentProject.rootPath,
            mainFilePath: currentProject.mainFilePath,
            buildResult: result
          });
          const updatedRun = await desktopApi.shared.attachAgentRunBuildArtifact({
            projectId: activeSharedProject.id,
            agentRunId: applied.changeset.agentRunId,
            artifactId: artifact.id
          });
          setSharedBuildArtifacts((artifacts) =>
            [
              artifact,
              ...artifacts.filter((candidate) => candidate.id !== artifact.id)
            ].slice(0, 5)
          );
          setSharedAgentRuns((runs) =>
            [
              updatedRun,
              ...runs.filter((candidate) => candidate.id !== updatedRun.id)
            ].slice(0, 5)
          );
          const [nextActivity, auditEvents] = await Promise.all([
            desktopApi.shared.listActivity(activeSharedProject.id),
            desktopApi.shared.listAuditEvents(activeSharedProject.id)
          ]);
          setSharedActivity(nextActivity.slice(0, 6));
          setSharedAuditEvents(auditEvents.slice(0, 6));
          setSharedStatus(
            `Applied and compiled shared agent changeset for ${changeset.filePath}.`
          );

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
        } finally {
          setActiveBuildJobId(null);
          setBuildRunning(false);
        }
      });
    },
    [
      activeSharedProject,
      appSettings.agentPermissions.compileAfterPatch,
      clearSharedDocumentConflictState,
      currentProject,
      pdfArtifactData,
      pdfStale,
      pdfStaleReason,
      readProjectFile,
      refreshToolchainStatus,
      runProjectOperation,
      saveDirtyFiles,
      selectedCompiler,
      sharedConnection.connected,
      showErrorInTerminal,
      toolchainStatus
    ]
  );

  const rejectSharedAgentChangeSetFromPanel = useCallback(
    (changeset: SharedProjectAgentChangeSetSummary) => {
      void runProjectOperation(async () => {
        if (
          activeSharedProject === null ||
          !sharedConnection.connected ||
          activeSharedProject.role === "viewer"
        ) {
          setSharedStatus("Shared agent changesets require Editor access.");
          return;
        }

        await desktopApi.shared.rejectAgentChangeSet({
          projectId: activeSharedProject.id,
          changesetId: changeset.id
        });
        const [activity, agentRuns, changesets, auditEvents] = await Promise.all([
          desktopApi.shared.listActivity(activeSharedProject.id),
          desktopApi.shared.listAgentRuns(activeSharedProject.id),
          desktopApi.shared.listAgentChangeSets(activeSharedProject.id),
          desktopApi.shared.listAuditEvents(activeSharedProject.id)
        ]);
        setSharedActivity(activity.slice(0, 6));
        setSharedAgentRuns(agentRuns.slice(0, 5));
        setSharedAgentChangeSets(changesets.slice(0, 5));
        setSharedAuditEvents(auditEvents.slice(0, 6));
        setSharedStatus(`Rejected shared agent changeset for ${changeset.filePath}.`);
      });
    },
    [activeSharedProject, runProjectOperation, sharedConnection.connected]
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
      const sharedBuildSourceRevisionId =
        activeSharedProject === null ||
        !sharedConnection.connected ||
        activeSharedProject.role === "viewer"
          ? undefined
          : await desktopApi.shared
              .getFileRevision({
                projectId: activeSharedProject.id,
                path: currentProject.mainFilePath
              })
              .then((revision) => revision.revisionId)
              .catch((error: unknown) => {
                setSharedStatus(
                  `Could not capture shared source revision before compile: ${getErrorMessage(error)}`
                );
                return undefined;
              });
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
        await publishSharedBuildArtifact(result, sharedBuildSourceRevisionId);
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
    activeSharedProject,
    pdfArtifactData,
    pdfStale,
    pdfStaleReason,
    publishSharedBuildArtifact,
    showErrorInTerminal,
    refreshToolchainStatus,
    runProjectOperation,
    saveDirtyFiles,
    selectedCompiler,
    sharedConnection.connected,
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
        const composerImageAttachments =
          options?.prompt === undefined ? agentImageAttachments : [];
        const rawPrompt = options?.prompt?.trim() ?? agentPrompt.trim();
        const prompt =
          rawPrompt.length > 0
            ? rawPrompt
            : composerImageAttachments.length > 0
              ? "Inspect the attached image in the current LaTeX project context and respond."
              : "";
        const transcriptPrompt = formatAgentPromptForTranscript(
          prompt,
          composerImageAttachments
        );

        if (prompt.length === 0) {
          setStatusMessage("Enter an agent prompt first.");
          return;
        }

        if (currentProject === undefined) {
          const noProjectCommand = parseNoProjectAgentCommand(prompt);

          if (noProjectCommand?.kind === "create-project") {
            await runNoProjectAgentCommand(prompt, noProjectCommand);
            if (options?.prompt === undefined) {
              setAgentPrompt("");
              setAgentImageAttachments([]);
            }
            return;
          }

          const sessionId = `agent-session-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const userEvent = buildAgentMessageEvent({
            content: transcriptPrompt,
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
            setAgentImageAttachments([]);
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
        const requestedAgentMode = options?.mode ?? agentMode;
        const effectiveAgentMode = getEffectiveSharedAgentMode(
          requestedAgentMode,
          activeSharedProject
        );
        const sharedViewerAgentModeRestricted =
          requestedAgentMode !== effectiveAgentMode &&
          activeSharedProject?.role === "viewer";
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

        if (dirtyOnlyOfficeWordPath !== undefined) {
          const message = `Save or sync ${dirtyOnlyOfficeWordPath} in ONLYOFFICE before asking the agent to inspect or edit it.`;
          setStatusMessage(message);
          setAgentLiveStatus({
            detail: message,
            title: "Word document has unsaved changes",
            tone: "warning"
          });
          return;
        }

        setAgentRunning(true);
        setAgentLiveStatus(
          createStartingAgentLiveStatus(transcriptPrompt, providerLabel)
        );
        if (selectionContext !== undefined) {
          setActiveAgentSelectionContext(selectionContext);
        }
        setAgentEvents((events) => [...events, buildUserEvent(transcriptPrompt)]);
        if (options?.prompt === undefined) {
          setAgentPrompt("");
          setAgentImageAttachments([]);
        }
        setStatusMessage(
          sharedViewerAgentModeRestricted
            ? `${providerLabel} is preparing a read-only request because shared viewers cannot propose or apply project edits.`
            : `${providerLabel} is preparing the request...`
        );

        let sharedAgentRunIdForRequest: string | undefined;
        if (
          activeSharedProject !== null &&
          sharedConnection.connected &&
          activeSharedProject.role !== "viewer"
        ) {
          try {
            const published = await desktopApi.shared.publishAgentRun({
              projectId: activeSharedProject.id,
              providerId: agentProviderId,
              mode: effectiveAgentMode,
              prompt,
              status: "running",
              changesetIds: []
            });
            sharedAgentRunIdForRequest = published.agentRun.id;
            setSharedAgentRunIdsBySessionId((idsBySessionId) => ({
              ...idsBySessionId,
              [requestSessionId]: published.agentRun.id
            }));
            setSharedAgentRuns((runs) =>
              [
                published.agentRun,
                ...runs.filter((candidate) => candidate.id !== published.agentRun.id)
              ].slice(0, 5)
            );
            const activity = await desktopApi.shared.listActivity(
              activeSharedProject.id
            );
            setSharedActivity(activity.slice(0, 6));
            setSharedStatus("Published running shared agent run.");
          } catch (error) {
            setSharedStatus(
              `Could not publish running shared agent run: ${getErrorMessage(error)}`
            );
          }
        }

        try {
          const activeDocument =
            activeFile === null
              ? undefined
              : activeFile.documentKind === "word"
                ? {
                    kind: "word" as const,
                    path: activeFile.path,
                    plainText: activeFile.contents,
                    blocks: activeFile.wordBlocks ?? [],
                    warnings: activeFile.wordWarnings ?? []
                  }
                : {
                    kind: "text" as const,
                    path: activeFile.path,
                    contents: activeFile.contents
                  };
          const result = await desktopApi.agent.start({
            providerId: agentProviderId,
            mode: effectiveAgentMode,
            projectRoot: currentProject.rootPath,
            ...(activeSharedProject === null
              ? {}
              : {
                  projectContext: {
                    backend: "shared" as const,
                    sharedProjectId: activeSharedProject.id,
                    localCachePath: activeSharedProject.localCachePath,
                    role: activeSharedProject.role
                  }
                }),
            maxTurns: appSettings.agentPermissions.maxTurns,
            ...(continuationSessionId === undefined
              ? {}
              : { sessionId: continuationSessionId }),
            prompt,
            ...(activeFile === null ? {} : { activeFilePath: activeFile.path }),
            ...(activeDocument === undefined ? {} : { activeDocument }),
            ...(options?.activeFilePath === undefined
              ? {}
              : { activeFilePath: options.activeFilePath }),
            ...(selectedText === undefined ? {} : { selectedText }),
            ...(selectionContext === undefined ? {} : { selectionContext }),
            ...(composerImageAttachments.length === 0
              ? {}
              : { imageAttachments: composerImageAttachments }),
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
          if (sharedAgentRunIdForRequest !== undefined) {
            setSharedAgentRunIdsBySessionId((idsBySessionId) => ({
              ...idsBySessionId,
              [requestSessionId]: sharedAgentRunIdForRequest,
              [result.sessionId]: sharedAgentRunIdForRequest
            }));
          }
          const displayResultEvents = prepareAgentDisplayEvents(result.events).filter(
            (event) =>
              event.type !== "message" ||
              event.role !== "user" ||
              event.content !== prompt
          );
          const summaryEvent = buildAgentCompletionSummaryEvent(result, {
            wordChangesAutoApply: effectiveAgentMode === "autonomous-local"
          });
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

          const proposedWordChangeSets = getAgentResultWordChangeSets(result);
          const wordChangeOutcome = await handleAgentWordChangeSets(
            proposedWordChangeSets,
            {
              autoApply: effectiveAgentMode === "autonomous-local",
              appliedLabel: "Agent",
              proposedLabel: "Agent proposed"
            }
          );

          if (agentSetMainFile(result.events)) {
            const refreshedProject = await desktopApi.project.refresh(
              currentProject.rootPath
            );
            setProjectResult(refreshedProject);
            setProjectState({ recentProjects: refreshedProject.recentProjects });
          }

          const agentBuildResult = result.buildResult;
          let sharedAgentBuildArtifactId: string | undefined;
          if (agentBuildResult !== undefined) {
            setBuildResult(agentBuildResult);
            const sharedBuildArtifact =
              await publishSharedBuildArtifact(agentBuildResult);
            sharedAgentBuildArtifactId = sharedBuildArtifact?.id;
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
          await publishSharedAgentRun(
            result,
            prompt,
            effectiveAgentMode,
            sharedAgentBuildArtifactId === undefined
              ? []
              : [sharedAgentBuildArtifactId],
            sharedAgentRunIdForRequest
          );

          const approvalToolName = getRequestedApprovalToolName(result.events);
          setStatusMessage(
            result.status === "failed"
              ? `${providerLabel} could not complete the task — see the agent panel for details.`
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
                      proposedChangeSet === undefined && !wordChangeOutcome.applied
                        ? "The response is ready in the transcript."
                        : wordChangeOutcome.applied
                          ? "Word document changes were applied and ONLYOFFICE was refreshed."
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
          setStatusMessage(
            `${providerLabel} could not complete the task — see the agent panel for details.`
          );
          setAgentLiveStatus({
            detail: errorMessage,
            title: `${providerLabel} stopped with an error`,
            tone: "danger"
          });
          if (
            sharedAgentRunIdForRequest !== undefined &&
            activeSharedProject !== null &&
            sharedConnection.connected
          ) {
            try {
              const updatedRun = await desktopApi.shared.updateAgentRunStatus({
                projectId: activeSharedProject.id,
                agentRunId: sharedAgentRunIdForRequest,
                status: "failed"
              });
              setSharedAgentRuns((runs) =>
                [
                  updatedRun,
                  ...runs.filter((candidate) => candidate.id !== updatedRun.id)
                ].slice(0, 5)
              );
              const [activity, auditEvents] = await Promise.all([
                desktopApi.shared.listActivity(activeSharedProject.id),
                desktopApi.shared.listAuditEvents(activeSharedProject.id)
              ]);
              setSharedActivity(activity.slice(0, 6));
              setSharedAuditEvents(auditEvents.slice(0, 6));
            } catch (sharedError) {
              setSharedStatus(
                `Could not mark shared agent run failed: ${getErrorMessage(sharedError)}`
              );
            }
          }
          throw error;
        } finally {
          setAgentRunning(false);
        }
      });
    },
    [
      activeFile,
      agentAuthStatuses,
      agentImageAttachments,
      agentMode,
      agentPrompt,
      agentProviderId,
      agentSessionId,
      agentSessionProjectRoot,
      agentSessionProviderId,
      agentSelectedText,
      activeAgentSelectionContext,
      activeSharedProject,
      currentProject,
      dirtyOnlyOfficeWordPath,
      pdfArtifactData,
      pdfStale,
      publishSharedBuildArtifact,
      publishSharedAgentRun,
      refreshHistory,
      handleAgentWordChangeSets,
      runProjectOperation,
      runNoProjectAgentCommand,
      selectedCompiler,
      sharedConnection.connected
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
          decision,
          wordChangesAutoApply: decision === "allowed"
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
        let resolvedSharedAgentRunId: string | undefined;
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
            if (currentProject !== undefined) {
              const refreshedProject = await desktopApi.project.refresh(
                currentProject.rootPath
              );
              setProjectResult(refreshedProject);
              setProjectState({ recentProjects: refreshedProject.recentProjects });
            }
          }
          resolvedSharedAgentRunId = await updateSharedAgentChangeSetStatus(
            approvedChangeSet.id,
            decision === "allowed" ? "applied" : "rejected"
          );
        }

        const approvedWordChangeSets = getAgentResultWordChangeSets(result);
        const approvedWordOutcome = await handleAgentWordChangeSets(
          approvedWordChangeSets,
          {
            autoApply: decision === "allowed",
            appliedLabel: "Agent",
            proposedLabel: decision === "allowed" ? "Reviewed" : "Rejected"
          }
        );

        const approvalBuildResult = result.buildResult;
        if (approvalBuildResult !== undefined) {
          setBuildResult(approvalBuildResult);
          const sharedApprovalBuildArtifact =
            await publishSharedBuildArtifact(approvalBuildResult);
          const sharedAgentRunId =
            resolvedSharedAgentRunId ?? sharedAgentRunIdsBySessionId[sessionId];
          if (
            activeSharedProject !== null &&
            sharedConnection.connected &&
            sharedApprovalBuildArtifact !== undefined &&
            sharedAgentRunId !== undefined
          ) {
            try {
              const updatedRun = await desktopApi.shared.attachAgentRunBuildArtifact({
                projectId: activeSharedProject.id,
                agentRunId: sharedAgentRunId,
                artifactId: sharedApprovalBuildArtifact.id
              });
              setSharedAgentRuns((runs) =>
                [
                  updatedRun,
                  ...runs.filter((candidate) => candidate.id !== updatedRun.id)
                ].slice(0, 5)
              );
              const [activity, auditEvents] = await Promise.all([
                desktopApi.shared.listActivity(activeSharedProject.id),
                desktopApi.shared.listAuditEvents(activeSharedProject.id)
              ]);
              setSharedActivity(activity.slice(0, 6));
              setSharedAuditEvents(auditEvents.slice(0, 6));
              setSharedStatus("Attached approval compile to shared agent run.");
            } catch (error) {
              setSharedStatus(
                `Could not attach approval compile to shared agent run: ${getErrorMessage(error)}`
              );
            }
          }
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
              : approvedWordOutcome.applied
                ? "Agent Word edit applied."
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
                : approvedWordOutcome.applied
                  ? "Word document changes were applied and ONLYOFFICE was refreshed."
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
    [
      currentProject,
      activeSharedProject,
      handleAgentWordChangeSets,
      publishSharedBuildArtifact,
      readProjectFile,
      refreshHistory,
      runProjectOperation,
      sharedAgentRunIdsBySessionId,
      sharedConnection.connected,
      updateSharedAgentChangeSetStatus
    ]
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
      if (!sharedProjectCanEdit) {
        setStatusMessage(
          "Shared viewers can read and compile this project, but cannot change project files."
        );
        return;
      }

      if (!path.toLowerCase().endsWith(".tex")) {
        return;
      }

      setProjectMainFile(path);
    },
    [setProjectMainFile, sharedProjectCanEdit]
  );

  const createEntry = useCallback(
    (kind: "directory" | "file") => {
      void runProjectOperation(async () => {
        if (currentProject === undefined) {
          return;
        }

        if (!sharedProjectCanEdit) {
          setStatusMessage(
            "Shared viewers can read and compile this project, but cannot create files."
          );
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
      selectedProjectDirectoryPath,
      sharedProjectCanEdit
    ]
  );

  const renameActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      if (!sharedProjectCanEdit) {
        setStatusMessage(
          "Shared viewers can read and compile this project, but cannot rename files."
        );
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
    selectedProjectEntryPath,
    sharedProjectCanEdit
  ]);

  const moveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      if (!sharedProjectCanEdit) {
        setStatusMessage(
          "Shared viewers can read and compile this project, but cannot move files."
        );
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
    selectedProjectEntryPath,
    sharedProjectCanEdit
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
            const snapshot = await readProjectFileForRoot(
              currentProject.rootPath,
              file.path
            );
            return searchFileContents(snapshot.path, snapshot.contents, query, 8);
          })
        )
      ).flat();

      setProjectSearchResults(results.slice(0, 200));
      setActiveSidebarTab("search");
      return results.length;
    },
    [currentProject, editableProjectFiles]
  );

  const deleteActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || selectedProjectEntryPath === null) {
        return;
      }

      if (!sharedProjectCanEdit) {
        setStatusMessage(
          "Shared viewers can read and compile this project, but cannot delete files."
        );
        return;
      }

      const confirmedDelete = await confirmAction({
        message: `Delete "${selectedProjectEntryPath}"?`,
        detail: "A backup will be kept in the project's local history.",
        confirmLabel: "Delete file",
        destructive: true
      });
      if (!confirmedDelete) {
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
    selectedProjectEntryPath,
    sharedProjectCanEdit
  ]);

  const closeFile = useCallback(
    (path: string) => {
      void (async () => {
        const file = openFiles.find((candidate) => candidate.path === path);

        if (file !== undefined && isFileDirty(file)) {
          const confirmed = await confirmAction({
            message: `Discard unsaved changes in "${path}"?`,
            detail: "These changes will be lost.",
            confirmLabel: "Discard changes",
            destructive: true
          });
          if (!confirmed) {
            return;
          }
        }

        const remainingFiles = removeOpenFile(openFiles, path);
        setOpenFiles(remainingFiles);
        setOnlyOfficeWordFileStates((states) => {
          const { [path]: _removed, ...remainingStates } = states;
          return remainingStates;
        });
        setActiveFilePath((currentPath) =>
          currentPath === path ? (remainingFiles.at(-1)?.path ?? null) : currentPath
        );
      })();
    },
    [isFileDirty, openFiles]
  );

  const updateActiveFileContents = useCallback(
    (contents: string, changes: readonly MonacoEditorApi.IModelContentChange[]) => {
      if (activeFile === null) {
        return;
      }
      const filePath = activeFile.path;
      const applyingSharedRemoteEdit = sharedRemoteEditPathsRef.current.has(filePath);

      if (!applyingSharedRemoteEdit && !sharedProjectCanEdit) {
        setSharedDocumentSyncStatus(
          `Shared viewers can read and compile ${filePath}, but cannot edit it.`
        );
        return;
      }

      setOpenFiles((files) =>
        replaceOpenFile(files, {
          ...activeFile,
          contents
        })
      );
      if (applyingSharedRemoteEdit) {
        return;
      }

      if (pdfArtifactData !== null) {
        setPdfStale(true);
        setPdfStaleReason("unsaved");
      }

      if (
        activeSharedProject !== null &&
        activeFile.documentKind === "text" &&
        !sharedDocumentConflictPaths.has(filePath)
      ) {
        if (changes.length === 0) {
          setSharedDocumentOperationFailedPaths((paths) =>
            paths.has(filePath) ? paths : new Set(paths).add(filePath)
          );
          setSharedDocumentSyncStatus(
            `Shared operation fallback queued for ${filePath}.`
          );
          return;
        }

        const operations = changes.map((change) => ({
          rangeOffset: change.rangeOffset,
          rangeLength: change.rangeLength,
          text: change.text
        }));
        const pendingOperation: SharedDocumentPendingOperation = {
          id: crypto.randomUUID(),
          operations,
          contents
        };
        const pendingOperations = sharedDocumentPendingOperations[filePath] ?? [];
        if (!sharedConnection.connected || pendingOperations.length > 0) {
          setSharedDocumentPendingOperations((currentOperations) => ({
            ...currentOperations,
            [filePath]: [...(currentOperations[filePath] ?? []), pendingOperation]
          }));
          setSharedDocumentOperationFailedPaths((paths) =>
            paths.has(filePath) ? paths : new Set(paths).add(filePath)
          );
          setSharedDocumentSyncStatus(
            `Queued shared operation for ${filePath}; waiting to reconnect.`
          );
          return;
        }

        void (async () => {
          try {
            const result = await desktopApi.shared.applyDocumentTextOperations({
              projectId: activeSharedProject.id,
              path: filePath,
              operations,
              clientOperationId: pendingOperation.id
            });
            if (result.lastUpdateId !== undefined) {
              setSharedDocumentUpdateCursors((cursors) =>
                cursors[result.path] === result.lastUpdateId
                  ? cursors
                  : { ...cursors, [result.path]: result.lastUpdateId ?? "" }
              );
            }
            appWrittenProjectPathsRef.current.add(normalizeProjectPath(result.path));
            setOpenFiles((files) =>
              files.map((candidate) => {
                if (
                  candidate.path !== result.path ||
                  candidate.documentKind !== "text"
                ) {
                  return candidate;
                }

                return {
                  ...candidate,
                  contents:
                    candidate.contents === contents
                      ? result.contents
                      : candidate.contents,
                  savedContents: result.contents,
                  mtimeMs: result.mtimeMs,
                  stale: false
                };
              })
            );
            setSharedDocumentOperationFailedPaths((paths) => {
              if (!paths.has(result.path)) {
                return paths;
              }

              const nextPaths = new Set(paths);
              nextPaths.delete(result.path);
              return nextPaths;
            });
            setSharedDocumentSyncStatus(`Synced ${result.path}.`);
          } catch (error) {
            setSharedDocumentPendingOperations((currentOperations) => ({
              ...currentOperations,
              [filePath]: [...(currentOperations[filePath] ?? []), pendingOperation]
            }));
            setSharedDocumentOperationFailedPaths((paths) =>
              paths.has(filePath) ? paths : new Set(paths).add(filePath)
            );
            setSharedDocumentSyncStatus(
              `Shared text operation failed: ${getErrorMessage(error)}`
            );
          }
        })();
      }
    },
    [
      activeFile,
      activeSharedProject,
      pdfArtifactData,
      sharedConnection.connected,
      sharedDocumentConflictPaths,
      sharedDocumentPendingOperations,
      sharedProjectCanEdit
    ]
  );

  const handleOnlyOfficeDirtyStateChange = useCallback(
    (filePath: string, dirty: boolean) => {
      setOnlyOfficeWordFileStates((states) => ({
        ...states,
        [filePath]: {
          ...states[filePath],
          dirty
        }
      }));
    },
    []
  );

  const handleOnlyOfficeSessionStateChange = useCallback(
    (filePath: string, sessionId: string | null) => {
      setOnlyOfficeWordFileStates((states) => {
        const currentState = states[filePath];
        if (sessionId === null) {
          if (currentState === undefined) {
            return states;
          }

          const { sessionId: _removedSessionId, ...remainingState } = currentState;
          return {
            ...states,
            [filePath]: remainingState
          };
        }

        return {
          ...states,
          [filePath]: {
            ...currentState,
            dirty: currentState?.dirty ?? false,
            sessionId
          }
        };
      });
    },
    []
  );

  const handleOnlyOfficeExportPdf = useCallback(
    async (filePath: string, sessionId: string) => {
      if (currentProject === undefined) {
        throw new Error("Open a project before converting Word documents to PDF.");
      }

      setStatusMessage("Converting Word document to PDF...");
      const result = await desktopApi.onlyOffice.exportPdf({ sessionId });
      appWrittenProjectPathsRef.current.add(
        getProjectRelativePath(currentProject.rootPath, result.pdfPath)
      );
      const artifactData = await desktopApi.pdf.readArtifact({
        projectRoot: currentProject.rootPath,
        pdfPath: result.pdfPath
      });
      setPdfArtifactData(artifactData);
      setPdfStale(false);
      setPdfStaleReason(null);
      setPdfPageNumber(1);
      setSyncTexMessage("SyncTeX unavailable for Word PDF");
      setOnlyOfficeWordFileStates((states) => ({
        ...states,
        [filePath]: {
          ...states[filePath],
          dirty: false,
          sessionId
        }
      }));
      setStatusMessage(result.message);
    },
    [currentProject]
  );

  const openWordSettings = useCallback(() => {
    setActiveSettingsTab("Word");
    setSettingsOpen(true);
  }, []);

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

        const confirmedRemoval = await confirmAction({
          message: `Remove unused bibliography entry "${entry.key}"?`,
          detail: `This will edit ${entry.filePath} and recompile the project.`,
          confirmLabel: "Remove and compile"
        });
        if (!confirmedRemoval) {
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
            label={bottomPanelOpen ? "Hide panels" : "Show panels"}
            onClick={() => setBottomPanelOpen((isOpen) => !isOpen)}
          >
            <PanelBottom size={17} />
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
          canShare={currentProject !== undefined}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenShareModal={() => setShareModalOpen(true)}
          onSelectTab={setActiveSidebarTab}
        />
        {activeSidebarTab === "files" && (
          <ProjectSidebar
            activeFilePath={activeFile?.path}
            activeSharedProject={activeSharedProject}
            mainFilePath={currentProject?.mainFilePath}
            project={currentProject}
            recentProjects={projectState.recentProjects}
            selectedDirectoryPath={selectedProjectDirectoryPath}
            selectedEntryPath={selectedProjectEntryPath}
            sharedBusy={sharedBusy}
            sharedActivity={sharedActivity}
            sharedAuditEvents={sharedAuditEvents}
            sharedAgentChangeSets={sharedAgentChangeSets}
            sharedAgentRuns={sharedAgentRuns}
            sharedBuildArtifacts={sharedBuildArtifacts}
            sharedCommentDraft={sharedCommentDraft}
            sharedComments={sharedComments}
            sharedFileRevisions={sharedFileRevisions}
            selectedSharedFileRevision={selectedSharedFileRevision}
            submissionCheckResult={submissionCheckResult}
            tree={projectResult?.tree ?? []}
            onApplySharedAgentChangeSet={applySharedAgentChangeSetFromPanel}
            onAskAgentSubmissionChecklist={askAgentForSubmissionChecklist}
            onAskAgentNumberingMismatch={askAgentForFigureNumberingMismatch}
            onCreateEntry={createEntry}
            onCreateSharedComment={createSharedComment}
            onDeleteActiveFile={deleteActiveFile}
            onExportSourceArchive={exportSourceArchive}
            onInspectSharedBuildArtifact={inspectSharedBuildArtifact}
            onInspectSharedFileRevision={inspectSharedFileRevision}
            onMoveActiveFile={moveActiveFile}
            onCloseProject={closeProject}
            onOpenProject={openProject}
            onOpenRecentProject={openRecentProject}
            onClearRecentProjects={clearRecentProjects}
            onRemoveRecentProject={removeRecentProject}
            onRefreshProject={refreshProjectTree}
            onRejectSharedAgentChangeSet={rejectSharedAgentChangeSetFromPanel}
            onRestoreSharedFileRevision={restoreSharedFileRevision}
            onRenameActiveFile={renameActiveFile}
            onRunSubmissionCheck={runSubmissionCheck}
            onSelectDirectory={selectProjectDirectory}
            onSelectFile={selectFile}
            onSetMainFile={setTreeFileAsMain}
            onResolveSharedComment={resolveSharedComment}
            onSharedCommentDraftChange={setSharedCommentDraft}
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
              dirtyFileCount={dirtyFileCount}
              editorSettings={appSettings.editor}
              mainFilePath={currentProject?.mainFilePath}
              openFiles={openFiles}
              projectRoot={currentProject?.rootPath}
              isFileDirty={isFileDirty}
              canEditProject={sharedProjectCanEdit}
              onActiveFileChange={setActiveFilePath}
              onCloseFile={closeFile}
              onContentsChange={updateActiveFileContents}
              onFind={() => focusMonacoFind(editorRef.current)}
              onAcceptSharedRemoteChanges={acceptSharedRemoteDocumentChanges}
              onKeepLocalSharedChanges={keepLocalSharedDocumentChanges}
              onOnlyOfficeDirtyStateChange={handleOnlyOfficeDirtyStateChange}
              onOnlyOfficeExportPdf={handleOnlyOfficeExportPdf}
              onlyOfficeWordReloadVersions={onlyOfficeWordReloadVersions}
              onOnlyOfficeSessionStateChange={handleOnlyOfficeSessionStateChange}
              onOpenWordSettings={openWordSettings}
              onStatusMessage={setStatusMessage}
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
              sharedCurrentUserId={sharedConnection.user?.id}
              syncTexMessage={syncTexMessage}
              sharedPresence={sharedPresence}
              compileUnavailable={compileUnavailable}
              buildRunning={buildRunning}
              onCompilerChange={updateProjectCompiler}
              sharedDocumentConflict={activeSharedDocumentConflict}
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
              imageAttachments={agentImageAttachments}
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
              onAttachImages={attachAgentImages}
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
              onRemoveImageAttachment={removeAgentImageAttachment}
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
                selectedWordChangeSetId={selectedWordChangeSetId}
                wordChangeSets={wordChangeSets}
                onExplainChangeSetHunk={explainChangeSetHunk}
                outline={projectOutline}
                referenceAnalysis={referenceAnalysis}
                referenceMessage={referenceMessage}
                referenceSearchQuery={referenceSearchQuery}
                referenceSearchResults={referenceSearchResults}
                selectedChangeSetId={selectedChangeSetId}
                submissionCheckResult={submissionCheckResult}
                onActiveTabChange={setActiveBottomTab}
                onClose={() => setBottomPanelOpen(false)}
                onApplyChangeSet={applyChangeSet}
                onApplyWordChangeSet={applyWordChangeSet}
                onAttachReferenceEntry={attachReferenceEntryToAgent}
                onCreateChangeSet={createActiveFileChangeSet}
                onInsertCitation={insertCitation}
                onKeepUnusedReference={keepUnusedReference}
                onJumpToOutlineItem={(item) => jumpToFileLine(item.path, item.line)}
                onReferenceSearchQueryChange={setReferenceSearchQuery}
                onRefreshReferences={() => {
                  void runProjectOperation(refreshReferences);
                }}
                onRejectChangeSet={rejectChangeSet}
                onRejectWordChangeSet={rejectWordChangeSet}
                onSetChangeSetHunkAccepted={setChangeSetHunkAccepted}
                onRemoveUnusedReference={removeUnusedReference}
                onRepairMissingCitation={repairMissingCitation}
                onRollbackChangeSet={rollbackChangeSet}
                onRollbackWordChangeSet={rollbackWordChangeSet}
                onRunReferenceSearch={runReferenceSearch}
                onSelectChangeSet={(changesetId) => {
                  setSelectedChangeSetId(changesetId);
                  setSelectedWordChangeSetId(null);
                }}
                onSelectWordChangeSet={setSelectedWordChangeSetId}
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

      <ShareDialog
        activeSharedProject={activeSharedProject}
        hasProject={currentProject !== undefined}
        open={shareModalOpen}
        sharedBusy={sharedBusy}
        sharedConnection={sharedConnection}
        sharedDocumentSyncStatus={sharedDocumentSyncStatus}
        sharedEmail={sharedEmail}
        sharedInvitationId={sharedInvitationId}
        sharedInviteEmail={sharedInviteEmail}
        sharedInviteRole={sharedInviteRole}
        sharedMembers={sharedMembers}
        sharedName={sharedName}
        sharedPresence={sharedPresence}
        sharedProjectName={sharedProjectName}
        sharedProjects={sharedProjects}
        sharedServerUrl={sharedServerUrl}
        sharedSessions={sharedSessions}
        sharedStatus={sharedStatus}
        onClose={() => setShareModalOpen(false)}
        onSharedAcceptInvitation={acceptSharedInvitation}
        onSharedCreateFromLocalProject={createSharedProjectFromLocalProject}
        onSharedCreateFromSourceZip={createSharedProjectFromSourceZip}
        onSharedCreateProject={createSharedProject}
        onSharedDeleteProject={deleteSharedProject}
        onSharedEmailChange={setSharedEmail}
        onSharedExportSourceZip={exportSharedProjectSourceZip}
        onSharedInvitationIdChange={setSharedInvitationId}
        onSharedInviteEmailChange={setSharedInviteEmail}
        onSharedInviteRoleChange={setSharedInviteRole}
        onSharedInviteToActiveProject={inviteToActiveSharedProject}
        onSharedMemberRoleChange={updateSharedMemberRole}
        onSharedMemberRemove={removeSharedMember}
        onSharedNameChange={setSharedName}
        onSharedOpenProject={openSharedProject}
        onSharedOwnershipTransfer={transferSharedOwnership}
        onSharedProjectNameChange={setSharedProjectName}
        onSharedRefreshProjects={refreshSharedProjects}
        onSharedServerUrlChange={setSharedServerUrl}
        onSharedSessionRevoke={revokeSharedSession}
        onSharedSignIn={signInToSharedProjects}
        onSharedSignOut={signOutFromSharedProjects}
      />
    </div>
  );
}

function ActivityRail({
  activeTab,
  canShare,
  onOpenSettings,
  onOpenShareModal,
  onSelectTab
}: {
  readonly activeTab: SidebarTab;
  readonly canShare: boolean;
  readonly onOpenSettings: () => void;
  readonly onOpenShareModal: () => void;
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
      <IconButton
        label="Share project"
        disabled={!canShare}
        onClick={onOpenShareModal}
      >
        <Share2 size={18} />
      </IconButton>
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
  activeSharedProject,
  mainFilePath,
  selectedDirectoryPath,
  selectedEntryPath,
  selectedSharedFileRevision,
  submissionCheckResult,
  onApplySharedAgentChangeSet,
  onAskAgentSubmissionChecklist,
  onAskAgentNumberingMismatch,
  onCreateEntry,
  onCreateSharedComment,
  onDeleteActiveFile,
  onExportSourceArchive,
  onInspectSharedBuildArtifact,
  onInspectSharedFileRevision,
  onMoveActiveFile,
  onCloseProject,
  onOpenProject,
  onOpenRecentProject,
  onClearRecentProjects,
  onRemoveRecentProject,
  onRefreshProject,
  onRejectSharedAgentChangeSet,
  onRestoreSharedFileRevision,
  onRenameActiveFile,
  onRunSubmissionCheck,
  onSelectDirectory,
  onSelectFile,
  onSetMainFile,
  onResolveSharedComment,
  onSharedCommentDraftChange,
  project,
  recentProjects,
  sharedBusy,
  sharedActivity,
  sharedAuditEvents,
  sharedAgentChangeSets,
  sharedAgentRuns,
  sharedBuildArtifacts,
  sharedCommentDraft,
  sharedComments,
  sharedFileRevisions,
  tree
}: {
  readonly activeFilePath: string | undefined;
  readonly activeSharedProject: ActiveSharedProject | null;
  readonly mainFilePath: string | undefined;
  readonly selectedDirectoryPath: string;
  readonly selectedEntryPath: string | null;
  readonly selectedSharedFileRevision: SharedProjectFileRevisionDetails | null;
  readonly submissionCheckResult: SubmissionCheckResult | null;
  readonly onApplySharedAgentChangeSet: (
    changeset: SharedProjectAgentChangeSetSummary
  ) => void;
  readonly onAskAgentSubmissionChecklist: () => void;
  readonly onAskAgentNumberingMismatch: () => void;
  readonly onCreateEntry: (kind: "directory" | "file") => void;
  readonly onCreateSharedComment: () => void;
  readonly onDeleteActiveFile: () => void;
  readonly onExportSourceArchive: () => void;
  readonly onInspectSharedBuildArtifact: (artifactId: string) => void;
  readonly onInspectSharedFileRevision: (revisionId: string) => void;
  readonly onMoveActiveFile: () => void;
  readonly onCloseProject: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly onClearRecentProjects: () => void;
  readonly onRemoveRecentProject: (rootPath: string) => void;
  readonly onRefreshProject: () => void;
  readonly onRejectSharedAgentChangeSet: (
    changeset: SharedProjectAgentChangeSetSummary
  ) => void;
  readonly onRestoreSharedFileRevision: (revisionId: string) => void;
  readonly onRenameActiveFile: () => void;
  readonly onRunSubmissionCheck: () => void;
  readonly onSelectDirectory: (path: string) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSetMainFile: (path: string) => void;
  readonly onResolveSharedComment: (commentId: string) => void;
  readonly onSharedCommentDraftChange: (draft: string) => void;
  readonly project: ProjectOpenResult["project"] | undefined;
  readonly recentProjects: readonly RecentProject[];
  readonly sharedBusy: boolean;
  readonly sharedActivity: readonly SharedProjectActivitySummary[];
  readonly sharedAuditEvents: readonly SharedProjectAuditEventSummary[];
  readonly sharedAgentChangeSets: readonly SharedProjectAgentChangeSetSummary[];
  readonly sharedAgentRuns: readonly SharedProjectAgentRunSummary[];
  readonly sharedBuildArtifacts: readonly SharedProjectBuildArtifactSummary[];
  readonly sharedCommentDraft: string;
  readonly sharedComments: readonly SharedProjectCommentSummary[];
  readonly sharedFileRevisions: readonly SharedProjectFileRevisionSummary[];
  readonly tree: readonly ProjectFileTreeNode[];
}) {
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectedSharedAgentChangeSetId, setSelectedSharedAgentChangeSetId] = useState<
    string | null
  >(null);

  useEffect(() => {
    setCollapsedDirectoryPaths(new Set());
  }, [project?.rootPath]);

  useEffect(() => {
    setSelectedSharedAgentChangeSetId(null);
  }, [activeSharedProject?.id]);

  useEffect(() => {
    if (
      selectedSharedAgentChangeSetId !== null &&
      !sharedAgentChangeSets.some(
        (changeset) => changeset.id === selectedSharedAgentChangeSetId
      )
    ) {
      setSelectedSharedAgentChangeSetId(null);
    }
  }, [selectedSharedAgentChangeSetId, sharedAgentChangeSets]);

  const sharedProjectCanEdit =
    activeSharedProject === null || activeSharedProject.role !== "viewer";

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
          onOpenRecentProject={onOpenRecentProject}
          onClearRecentProjects={onClearRecentProjects}
          onRemoveRecentProject={onRemoveRecentProject}
        />
      ) : (
        <>
          <div className="file-actions" aria-label="File actions">
            <IconButton
              label="New file"
              disabled={!sharedProjectCanEdit}
              onClick={() => onCreateEntry("file")}
            >
              <Plus size={15} />
            </IconButton>
            <IconButton
              label="New folder"
              disabled={!sharedProjectCanEdit}
              onClick={() => onCreateEntry("directory")}
            >
              <FolderPlus size={15} />
            </IconButton>
            <IconButton
              label="Rename selected entry"
              onClick={onRenameActiveFile}
              disabled={!sharedProjectCanEdit || selectedEntryPath === null}
            >
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label="Move selected entry"
              onClick={onMoveActiveFile}
              disabled={!sharedProjectCanEdit || selectedEntryPath === null}
            >
              <ChevronRight size={15} />
            </IconButton>
            <IconButton
              label="Delete selected entry"
              onClick={onDeleteActiveFile}
              disabled={!sharedProjectCanEdit || selectedEntryPath === null}
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
                  canEditProject={sharedProjectCanEdit}
                />
              ))
            )}
          </nav>
          {activeSharedProject !== null && (
            <>
              <div className="shared-presence" aria-label="Shared comments">
                <span className="eyebrow">Comments</span>
                <label className="template-picker__field">
                  <span className="eyebrow">
                    {activeFilePath === undefined
                      ? "Project comment"
                      : `Comment on ${activeFilePath}`}
                  </span>
                  <textarea
                    rows={3}
                    value={sharedCommentDraft}
                    disabled={sharedBusy || activeSharedProject === null}
                    onChange={(event) => onSharedCommentDraftChange(event.target.value)}
                  />
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={
                    sharedBusy ||
                    activeSharedProject === null ||
                    sharedCommentDraft.trim().length === 0
                  }
                  onClick={onCreateSharedComment}
                >
                  <Plus aria-hidden="true" size={14} />
                  Comment
                </button>
                {sharedComments.length === 0 ? (
                  <p className="empty-state">Select text and leave a comment to start a discussion here.</p>
                ) : (
                  sharedComments.map((comment) => (
                    <div className="shared-presence__row" key={comment.id}>
                      <span>{formatSharedCommentTitle(comment)}</span>
                      <span>
                        {formatSharedCommentDetails(comment)}
                        {comment.resolved ? null : (
                          <button
                            className="inline-text-button"
                            type="button"
                            disabled={sharedBusy}
                            onClick={() => onResolveSharedComment(comment.id)}
                          >
                            Resolve
                          </button>
                        )}
                      </span>
                      <pre className="shared-agent-changeset-preview">
                        {comment.body}
                      </pre>
                    </div>
                  ))
                )}
              </div>
              <div className="shared-presence" aria-label="Shared file revisions">
                <span className="eyebrow">File revisions</span>
                {activeFilePath === null ? (
                  <p className="empty-state">Open a shared file to see revisions.</p>
                ) : sharedFileRevisions.length === 0 ? (
                  <p className="empty-state">Revisions appear here after you save changes to this shared file.</p>
                ) : (
                  sharedFileRevisions.map((revision) => (
                    <div className="shared-presence__row" key={revision.id}>
                      <span>{formatSharedRevisionLabel(revision.id)}</span>
                      <span>
                        {formatSharedFileRevisionDetails(revision)}
                        <button
                          className="inline-text-button"
                          type="button"
                          onClick={() => onInspectSharedFileRevision(revision.id)}
                        >
                          Inspect
                        </button>
                        <button
                          className="inline-text-button"
                          type="button"
                          disabled={sharedBusy || !sharedProjectCanEdit}
                          onClick={() => onRestoreSharedFileRevision(revision.id)}
                        >
                          Restore
                        </button>
                      </span>
                    </div>
                  ))
                )}
                {selectedSharedFileRevision === null ? null : (
                  <pre className="shared-agent-changeset-preview">
                    {formatSharedFileRevisionPreview(selectedSharedFileRevision)}
                  </pre>
                )}
              </div>
              <div className="shared-presence" aria-label="Shared compile history">
                <span className="eyebrow">Recent local compiles</span>
                {sharedBuildArtifacts.length === 0 ? (
                  <p className="empty-state">Compile history appears here after you compile this shared project.</p>
                ) : (
                  sharedBuildArtifacts.map((artifact) => (
                    <div className="shared-presence__row" key={artifact.id}>
                      <span>
                        {artifact.compiler} {artifact.status}
                      </span>
                      <span>
                        {formatSharedBuildArtifactDetails(artifact)}
                        <button
                          className="inline-text-button"
                          type="button"
                          onClick={() => onInspectSharedBuildArtifact(artifact.id)}
                        >
                          Inspect
                        </button>
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="shared-presence" aria-label="Shared agent runs">
                <span className="eyebrow">Agent runs</span>
                {sharedAgentRuns.length === 0 ? (
                  <p className="empty-state">Runs appear here after you ask the agent to do something.</p>
                ) : (
                  sharedAgentRuns.map((agentRun) => (
                    <div className="shared-presence__row" key={agentRun.id}>
                      <span>{formatSharedAgentRunTitle(agentRun)}</span>
                      <span>
                        {formatSharedAgentRunDetails(agentRun)}
                        {agentRun.changesetIds.map((changesetId, index) => (
                          <button
                            className="inline-text-button"
                            disabled={
                              !sharedAgentChangeSets.some(
                                (changeset) => changeset.id === changesetId
                              )
                            }
                            key={changesetId}
                            type="button"
                            onClick={() =>
                              setSelectedSharedAgentChangeSetId(changesetId)
                            }
                          >
                            {formatSharedAgentChangeSetLinkLabel(
                              index,
                              agentRun.changesetIds.length
                            )}
                          </button>
                        ))}
                        {agentRun.buildArtifactIds.map((artifactId, index) => (
                          <button
                            className="inline-text-button"
                            key={artifactId}
                            type="button"
                            onClick={() => onInspectSharedBuildArtifact(artifactId)}
                          >
                            {formatSharedAgentRunBuildArtifactLabel(
                              index,
                              agentRun.buildArtifactIds.length
                            )}
                          </button>
                        ))}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="shared-presence" aria-label="Shared agent changesets">
                <span className="eyebrow">Agent changesets</span>
                {sharedAgentChangeSets.length === 0 ? (
                  <p className="empty-state">Changesets appear here after the agent proposes an edit.</p>
                ) : (
                  sharedAgentChangeSets.map((changeset) => {
                    const isSelected = changeset.id === selectedSharedAgentChangeSetId;

                    return (
                      <div
                        aria-current={isSelected ? "true" : undefined}
                        className={`shared-presence__row${isSelected ? " shared-presence__row--selected" : ""}`}
                        key={changeset.id}
                      >
                        <span>{formatSharedAgentChangeSetTitle(changeset)}</span>
                        <span>
                          {formatSharedAgentChangeSetDetails(changeset)}
                          {changeset.status === "proposed" ? (
                            <>
                              <button
                                className="inline-text-button"
                                type="button"
                                disabled={sharedBusy || !sharedProjectCanEdit}
                                onClick={() => onApplySharedAgentChangeSet(changeset)}
                              >
                                Apply
                              </button>
                              <button
                                className="inline-text-button"
                                type="button"
                                disabled={sharedBusy || !sharedProjectCanEdit}
                                onClick={() => onRejectSharedAgentChangeSet(changeset)}
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </span>
                        <pre className="shared-agent-changeset-preview">
                          {changeset.patchPreview}
                        </pre>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="shared-presence" aria-label="Shared agent audit">
                <span className="eyebrow">Agent audit</span>
                {sharedAuditEvents.length === 0 ? (
                  <p className="empty-state">Entries appear here as agent actions are approved or rejected.</p>
                ) : (
                  sharedAuditEvents.map((event) => (
                    <div className="shared-presence__row" key={event.id}>
                      <span>{formatSharedAgentAuditTitle(event)}</span>
                      <span>
                        {formatSharedAgentAuditDetails(event)}
                        {event.changesetId === undefined ? null : (
                          <button
                            className="inline-text-button"
                            disabled={
                              !sharedAgentChangeSets.some(
                                (changeset) => changeset.id === event.changesetId
                              )
                            }
                            type="button"
                            onClick={() =>
                              event.changesetId === undefined
                                ? undefined
                                : setSelectedSharedAgentChangeSetId(event.changesetId)
                            }
                          >
                            Show changeset
                          </button>
                        )}
                        {(event.buildArtifactIds ?? []).map((artifactId, index) => (
                          <button
                            className="inline-text-button"
                            key={artifactId}
                            type="button"
                            onClick={() => onInspectSharedBuildArtifact(artifactId)}
                          >
                            {formatSharedAgentRunBuildArtifactLabel(
                              index,
                              event.buildArtifactIds?.length ?? 0
                            )}
                          </button>
                        ))}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="shared-presence" aria-label="Shared activity">
                <span className="eyebrow">Shared activity</span>
                {sharedActivity.length === 0 ? (
                  <p className="empty-state">This fills in as collaborators make changes to the project.</p>
                ) : (
                  sharedActivity.map((activity) => (
                    <div className="shared-presence__row" key={activity.id}>
                      <span>{formatSharedActivityTitle(activity)}</span>
                      <span>{formatSharedActivityDetails(activity)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function RecentProjects({
  onClearRecentProjects,
  onOpenRecentProject,
  onRemoveRecentProject,
  recentProjects
}: {
  readonly onClearRecentProjects: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly onRemoveRecentProject: (rootPath: string) => void;
  readonly recentProjects: readonly RecentProject[];
}) {
  return (
    <div className="recent-projects">
      <section className="recent-header">
        <span className="eyebrow">Workspace</span>
        <h3>No project open</h3>
        <p>Open an existing project, import a ZIP archive, or start from a template.</p>
      </section>

      <div className="recent-list" aria-label="Recent projects">
        <div className="recent-list__header">
          <span className="eyebrow">Recent</span>
          <IconButton
            label="Clear recent projects"
            disabled={recentProjects.length === 0}
            onClick={onClearRecentProjects}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
        {recentProjects.length === 0 ? (
          <p className="empty-state">No recent projects yet. Open a folder to start.</p>
        ) : (
          recentProjects.map((project) => (
            <div className="recent-project-row" key={project.rootPath}>
              <button
                className="recent-row"
                type="button"
                onClick={() => onOpenRecentProject(project.rootPath)}
              >
                <span className="recent-row__title">{project.displayName}</span>
                <span className="recent-row__path">{project.rootPath}</span>
                <span className="recent-row__meta">
                  {formatRecentProjectDetails(project)}
                </span>
              </button>
              <IconButton
                label={`Remove ${project.displayName} from recent projects`}
                onClick={() => onRemoveRecentProject(project.rootPath)}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ShareDialog({
  activeSharedProject,
  hasProject,
  onClose,
  onSharedAcceptInvitation,
  onSharedCreateFromLocalProject,
  onSharedCreateFromSourceZip,
  onSharedCreateProject,
  onSharedDeleteProject,
  onSharedEmailChange,
  onSharedExportSourceZip,
  onSharedInvitationIdChange,
  onSharedInviteEmailChange,
  onSharedInviteRoleChange,
  onSharedInviteToActiveProject,
  onSharedMemberRoleChange,
  onSharedMemberRemove,
  onSharedNameChange,
  onSharedOpenProject,
  onSharedOwnershipTransfer,
  onSharedProjectNameChange,
  onSharedRefreshProjects,
  onSharedServerUrlChange,
  onSharedSessionRevoke,
  onSharedSignIn,
  onSharedSignOut,
  open,
  sharedBusy,
  sharedConnection,
  sharedDocumentSyncStatus,
  sharedEmail,
  sharedInvitationId,
  sharedInviteEmail,
  sharedInviteRole,
  sharedMembers,
  sharedName,
  sharedPresence,
  sharedProjectName,
  sharedProjects,
  sharedServerUrl,
  sharedSessions,
  sharedStatus
}: {
  readonly activeSharedProject: ActiveSharedProject | null;
  readonly hasProject: boolean;
  readonly onClose: () => void;
  readonly onSharedAcceptInvitation: () => void;
  readonly onSharedCreateFromLocalProject: () => void;
  readonly onSharedCreateFromSourceZip: () => void;
  readonly onSharedCreateProject: () => void;
  readonly onSharedDeleteProject: (project: SharedProjectSummary) => void;
  readonly onSharedEmailChange: (email: string) => void;
  readonly onSharedExportSourceZip: (project: SharedProjectSummary) => void;
  readonly onSharedInvitationIdChange: (invitationId: string) => void;
  readonly onSharedInviteEmailChange: (email: string) => void;
  readonly onSharedInviteRoleChange: (
    role: Exclude<SharedProjectRole, "owner">
  ) => void;
  readonly onSharedInviteToActiveProject: () => void;
  readonly onSharedMemberRoleChange: (
    userId: string,
    role: Exclude<SharedProjectRole, "owner">
  ) => void;
  readonly onSharedMemberRemove: (userId: string) => void;
  readonly onSharedNameChange: (name: string) => void;
  readonly onSharedOpenProject: (projectId: string) => void;
  readonly onSharedOwnershipTransfer: (member: SharedProjectMemberSummary) => void;
  readonly onSharedProjectNameChange: (name: string) => void;
  readonly onSharedRefreshProjects: () => void;
  readonly onSharedServerUrlChange: (serverUrl: string) => void;
  readonly onSharedSessionRevoke: (sessionId: string) => void;
  readonly onSharedSignIn: () => void;
  readonly onSharedSignOut: () => void;
  readonly open: boolean;
  readonly sharedBusy: boolean;
  readonly sharedConnection: SharedProjectConnection;
  readonly sharedDocumentSyncStatus: string;
  readonly sharedEmail: string;
  readonly sharedInvitationId: string;
  readonly sharedInviteEmail: string;
  readonly sharedInviteRole: Exclude<SharedProjectRole, "owner">;
  readonly sharedMembers: readonly SharedProjectMemberSummary[];
  readonly sharedName: string;
  readonly sharedPresence: readonly SharedProjectPresenceSummary[];
  readonly sharedProjectName: string;
  readonly sharedProjects: readonly SharedProjectSummary[];
  readonly sharedServerUrl: string;
  readonly sharedSessions: readonly SharedProjectSessionSummary[];
  readonly sharedStatus: string;
}) {
  const sharedProjectCanInvite = activeSharedProject?.role === "owner";
  const sharedConnectionLabel =
    sharedConnection.connected && sharedConnection.user !== undefined
      ? sharedConnection.user.email
      : "Not connected";
  const initialFocusRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => initialFocusRef.current?.focus(), 0);
    }
  }, [open, hasProject]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="settings-dialog share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Collaboration</span>
            <h2 id="share-dialog-title">
              {hasProject ? "Share project" : "Shared Projects"}
            </h2>
          </div>
          <IconButton label="Close share dialog" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>

        <div className="settings-body share-dialog__body">
          {!hasProject && (
            <section className="shared-projects" aria-label="Shared projects">
              <div className="recent-list__header">
                <div>
                  <span className="eyebrow">Shared Projects</span>
                  <strong>{sharedConnectionLabel}</strong>
                </div>
                <IconButton
                  label="Refresh shared projects"
                  disabled={!sharedConnection.connected || sharedBusy}
                  onClick={onSharedRefreshProjects}
                >
                  <RefreshCw size={14} />
                </IconButton>
              </div>

              <div className="shared-projects__fields">
                <label className="template-picker__field">
                  <span className="eyebrow">Server URL</span>
                  <input
                    ref={initialFocusRef}
                    type="url"
                    value={sharedServerUrl}
                    disabled={sharedBusy}
                    onChange={(event) => onSharedServerUrlChange(event.target.value)}
                  />
                </label>
                <label className="template-picker__field">
                  <span className="eyebrow">Email</span>
                  <input
                    type="email"
                    value={sharedEmail}
                    disabled={sharedBusy}
                    onChange={(event) => onSharedEmailChange(event.target.value)}
                  />
                </label>
                <label className="template-picker__field">
                  <span className="eyebrow">Name</span>
                  <input
                    type="text"
                    value={sharedName}
                    disabled={sharedBusy}
                    onChange={(event) => onSharedNameChange(event.target.value)}
                  />
                </label>
              </div>

              <button
                className="primary-button"
                type="button"
                disabled={sharedBusy}
                onClick={onSharedSignIn}
              >
                <Check aria-hidden="true" size={15} />
                Sign In
              </button>

              {sharedConnection.connected && (
                <button
                  className="text-button"
                  type="button"
                  disabled={sharedBusy}
                  onClick={onSharedSignOut}
                >
                  <X aria-hidden="true" size={14} />
                  Sign Out
                </button>
              )}

              {sharedConnection.connected && (
                <div className="shared-presence" aria-label="Shared sessions">
                  <span className="eyebrow">Sessions</span>
                  {sharedSessions.length === 0 ? (
                    <p className="empty-state">Devices currently signed in to your shared account are listed here.</p>
                  ) : (
                    sharedSessions.map((session) => (
                      <div className="shared-presence__row" key={session.id}>
                        <span>{formatSharedSessionLabel(session)}</span>
                        <span>{formatSharedSessionDetails(session)}</span>
                        {!session.current && (
                          <button
                            className="inline-text-button"
                            type="button"
                            disabled={sharedBusy}
                            onClick={() => onSharedSessionRevoke(session.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {sharedConnection.connected && (
                <div className="shared-projects__create">
                  <label className="template-picker__field">
                    <span className="eyebrow">Project name</span>
                    <input
                      type="text"
                      value={sharedProjectName}
                      disabled={sharedBusy}
                      onChange={(event) => onSharedProjectNameChange(event.target.value)}
                    />
                  </label>
                  <button
                    className="text-button"
                    type="button"
                    disabled={sharedBusy}
                    onClick={onSharedCreateProject}
                  >
                    <Plus aria-hidden="true" size={14} />
                    Create
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={sharedBusy}
                    onClick={onSharedCreateFromSourceZip}
                  >
                    <FolderOpen aria-hidden="true" size={14} />
                    Import ZIP
                  </button>
                </div>
              )}

              {sharedConnection.connected && (
                <div className="shared-projects__create">
                  <label className="template-picker__field">
                    <span className="eyebrow">Invitation id</span>
                    <input
                      type="text"
                      value={sharedInvitationId}
                      disabled={sharedBusy}
                      onChange={(event) => onSharedInvitationIdChange(event.target.value)}
                    />
                  </label>
                  <button
                    className="text-button"
                    type="button"
                    disabled={sharedBusy}
                    onClick={onSharedAcceptInvitation}
                  >
                    <Check aria-hidden="true" size={14} />
                    Accept
                  </button>
                </div>
              )}

              <p className="shared-projects__status">{sharedStatus}</p>

              {sharedConnection.connected && (
                <div className="recent-list" aria-label="Shared project list">
                  {sharedProjects.length === 0 ? (
                    <p className="empty-state">Create a project above to start collaborating with others.</p>
                  ) : (
                    sharedProjects.map((project) => (
                      <div className="shared-project-row" key={project.id}>
                        <button
                          className="recent-row shared-project-row__open"
                          type="button"
                          disabled={sharedBusy}
                          onClick={() => onSharedOpenProject(project.id)}
                        >
                          <span className="recent-row__title">{project.name}</span>
                          <span className="recent-row__path">{project.id}</span>
                          <span className="recent-row__meta">
                            {formatSharedProjectRole(project.role)} ·{" "}
                            {formatSharedProjectDetails(project)}
                          </span>
                        </button>
                        <IconButton
                          label={
                            project.role === "owner"
                              ? `Export shared source ZIP for ${project.name}`
                              : "Only owners can export shared projects"
                          }
                          disabled={sharedBusy || project.role !== "owner"}
                          onClick={() => onSharedExportSourceZip(project)}
                        >
                          <Download size={14} />
                        </IconButton>
                        <IconButton
                          label={
                            project.role === "owner"
                              ? `Delete shared project ${project.name}`
                              : "Only owners can delete shared projects"
                          }
                          disabled={sharedBusy || project.role !== "owner"}
                          onClick={() => onSharedDeleteProject(project)}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          )}

          {hasProject && activeSharedProject !== null && (
            <div className="shared-projects shared-projects--active">
              <div>
                <span className="eyebrow">Share</span>
                <strong>{activeSharedProject.id}</strong>
                <span className="project-origin-badge">
                  {formatSharedProjectRole(activeSharedProject.role)}
                </span>
                <span className="shared-projects__status">
                  {activeSharedProject.role === "viewer"
                    ? "Read-only shared project. Local compile remains available."
                    : sharedDocumentSyncStatus}
                </span>
                <IconButton
                  label="Sign out of shared projects"
                  disabled={sharedBusy}
                  onClick={onSharedSignOut}
                >
                  <X size={14} />
                </IconButton>
              </div>
              <div className="shared-projects__create">
                <label className="template-picker__field">
                  <span className="eyebrow">Collaborator email</span>
                  <input
                    ref={initialFocusRef}
                    type="email"
                    value={sharedInviteEmail}
                    disabled={sharedBusy || !sharedProjectCanInvite}
                    onChange={(event) => onSharedInviteEmailChange(event.target.value)}
                  />
                </label>
                <select
                  className="compact-select"
                  aria-label="Collaborator role"
                  value={sharedInviteRole}
                  disabled={sharedBusy || !sharedProjectCanInvite}
                  onChange={(event) =>
                    onSharedInviteRoleChange(
                      event.target.value === "viewer" ? "viewer" : "editor"
                    )
                  }
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                className="text-button"
                type="button"
                disabled={sharedBusy || !sharedProjectCanInvite}
                onClick={onSharedInviteToActiveProject}
              >
                <Plus aria-hidden="true" size={14} />
                Invite
              </button>
              <div className="shared-presence" aria-label="Shared members">
                <span className="eyebrow">Members</span>
                {sharedMembers.length === 0 ? (
                  <p className="empty-state">Members appear once you invite collaborators to this shared project.</p>
                ) : (
                  sharedMembers.map((member) => (
                    <div className="shared-presence__row" key={member.userId}>
                      <span>{member.name ?? member.email ?? member.userId}</span>
                      <span className="shared-member-controls">
                        {sharedProjectCanInvite && member.role !== "owner" ? (
                          <>
                            <select
                              className="compact-select shared-member-role-select"
                              aria-label={`Role for ${member.email ?? member.userId}`}
                              value={member.role}
                              disabled={sharedBusy}
                              onChange={(event) =>
                                onSharedMemberRoleChange(
                                  member.userId,
                                  event.target.value === "viewer" ? "viewer" : "editor"
                                )
                              }
                            >
                              <option value="editor">Editor</option>
                              <option value="viewer">Viewer</option>
                            </select>
                            <button
                              className="inline-text-button"
                              type="button"
                              disabled={sharedBusy}
                              onClick={() => onSharedOwnershipTransfer(member)}
                            >
                              Transfer ownership
                            </button>
                            <button
                              className="inline-text-button"
                              type="button"
                              disabled={sharedBusy}
                              onClick={() => onSharedMemberRemove(member.userId)}
                            >
                              Remove
                            </button>
                          </>
                        ) : (
                          formatSharedProjectRole(member.role)
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="shared-presence" aria-label="Active shared collaborators">
                <span className="eyebrow">Active now</span>
                {sharedPresence.length === 0 ? (
                  <p className="empty-state">Collaborators currently viewing or editing this project show up here.</p>
                ) : (
                  sharedPresence.map((presence) => (
                    <div className="shared-presence__row" key={presence.userId}>
                      <span>{presence.displayName}</span>
                      <span>{presence.filePath ?? "Project"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {hasProject && activeSharedProject === null && (
            <div className="shared-projects shared-projects--active">
              <div>
                <span className="eyebrow">Share</span>
                <strong>Local project</strong>
                <span className="shared-projects__status">{sharedStatus}</span>
              </div>
              <div className="shared-projects__create">
                <label className="template-picker__field">
                  <span className="eyebrow">Shared name</span>
                  <input
                    ref={initialFocusRef}
                    type="text"
                    value={sharedProjectName}
                    disabled={sharedBusy}
                    onChange={(event) => onSharedProjectNameChange(event.target.value)}
                  />
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={
                    sharedBusy ||
                    !sharedConnection.connected ||
                    sharedProjectName.trim().length === 0
                  }
                  onClick={onSharedCreateFromLocalProject}
                >
                  <Plus aria-hidden="true" size={14} />
                  Share project
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function FileTreeNode({
  activeFilePath,
  canEditProject,
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
  readonly canEditProject: boolean;
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
            disabled={!canEditProject}
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
              canEditProject={canEditProject}
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
  canEditProject,
  compileUnavailable,
  dirty,
  dirtyFileCount,
  editorSettings,
  mainFilePath,
  onCompilerChange,
  onAcceptSharedRemoteChanges,
  onActiveFileChange,
  onCloseFile,
  onContentsChange,
  onFind,
  onKeepLocalSharedChanges,
  onMount,
  onOnlyOfficeDirtyStateChange,
  onOnlyOfficeExportPdf,
  onlyOfficeWordReloadVersions,
  onOnlyOfficeSessionStateChange,
  onOpenWordSettings,
  onStatusMessage,
  onRunBuild,
  onSourceToPdf,
  onSave,
  onSaveAll,
  onStopBuild,
  openFiles,
  projectRoot,
  selectedCompiler,
  sharedCurrentUserId,
  sharedDocumentConflict,
  sharedPresence,
  isFileDirty,
  syncTexMessage
}: {
  readonly activeFile: EditorFileState | null;
  readonly activeFilePath: string | null;
  readonly buildRunning: boolean;
  readonly canEditProject: boolean;
  readonly compileUnavailable: boolean;
  readonly dirty: boolean;
  readonly dirtyFileCount: number;
  readonly editorSettings: AppSettings["editor"];
  readonly mainFilePath: string | undefined;
  readonly onCompilerChange: (compiler: LatexCompiler) => void;
  readonly onAcceptSharedRemoteChanges: () => void;
  readonly onActiveFileChange: (path: string) => void;
  readonly onCloseFile: (path: string) => void;
  readonly onContentsChange: (
    contents: string,
    changes: readonly MonacoEditorApi.IModelContentChange[]
  ) => void;
  readonly onFind: () => void;
  readonly onKeepLocalSharedChanges: () => void;
  readonly onMount: (editor: MonacoStandaloneEditor) => void;
  readonly onOnlyOfficeDirtyStateChange: (filePath: string, dirty: boolean) => void;
  readonly onOnlyOfficeExportPdf: (
    filePath: string,
    sessionId: string
  ) => Promise<void>;
  readonly onlyOfficeWordReloadVersions: Readonly<Record<string, number>>;
  readonly onOnlyOfficeSessionStateChange: (
    filePath: string,
    sessionId: string | null
  ) => void;
  readonly onOpenWordSettings: () => void;
  readonly onStatusMessage: (message: string) => void;
  readonly onRunBuild: () => void;
  readonly onSourceToPdf: () => void;
  readonly onSave: () => void;
  readonly onSaveAll: () => void;
  readonly onStopBuild: () => void;
  readonly openFiles: readonly EditorFileState[];
  readonly projectRoot: string | undefined;
  readonly selectedCompiler: LatexCompiler;
  readonly sharedCurrentUserId: string | undefined;
  readonly sharedDocumentConflict: boolean;
  readonly sharedPresence: readonly SharedProjectPresenceSummary[];
  readonly isFileDirty: (file: EditorFileState) => boolean;
  readonly syncTexMessage: string;
}) {
  const isWordEditorActive = activeFile?.documentKind === "word";
  const showEditorToolbar = !isWordEditorActive;
  const activeCollaborators = getActiveSharedCollaborators({
    activeFilePath,
    currentUserId: sharedCurrentUserId,
    presence: sharedPresence
  });

  return (
    <section
      className={`editor-pane${isWordEditorActive ? " editor-pane--word" : ""}`}
      aria-label="Source editor"
    >
      <div className="tab-strip" role="tablist" aria-label="Open files">
        {openFiles.length === 0 ? (
          <span className="editor-tab muted">No file</span>
        ) : (
          openFiles.map((file) => {
            const isActive = file.path === activeFilePath;
            const isDirty = isFileDirty(file);

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
      {showEditorToolbar ? (
        <div className="editor-toolbar" aria-label="Editor actions">
          <IconButton
            label="Save file"
            disabled={!canEditProject || activeFile === null || !dirty}
            onClick={onSave}
          >
            <Save aria-hidden="true" size={15} />
          </IconButton>
          <IconButton
            label="Save all files"
            disabled={!canEditProject || dirtyFileCount === 0}
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
          {sharedDocumentConflict ? (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
              <IconButton
                label="Accept remote changes"
                disabled={activeFile === null}
                onClick={onAcceptSharedRemoteChanges}
              >
                <Download aria-hidden="true" size={15} />
              </IconButton>
              <IconButton
                label="Keep local changes"
                disabled={!canEditProject || activeFile === null}
                onClick={onKeepLocalSharedChanges}
              >
                <UploadCloud aria-hidden="true" size={15} />
              </IconButton>
            </>
          ) : null}
          <span className="editor-status-group">
            {activeCollaborators.length > 0 ? (
              <span
                className="editor-collaborators"
                aria-label="Active collaborators in this file"
              >
                {activeCollaborators.slice(0, 4).map((presence) => (
                  <span
                    className="editor-collaborator"
                    key={presence.userId}
                    title={formatSharedPresenceLocation(presence)}
                  >
                    {getInitials(presence.displayName)}
                  </span>
                ))}
                {activeCollaborators.length > 4 ? (
                  <span
                    className="editor-collaborator editor-collaborator--count"
                    title={`${activeCollaborators.length - 4} more collaborators in this file`}
                  >
                    +{activeCollaborators.length - 4}
                  </span>
                ) : null}
              </span>
            ) : null}
            {!canEditProject ? (
              <span className="editor-state">Shared read-only</span>
            ) : null}
            {sharedDocumentConflict ? (
              <span className="editor-state">Shared conflict</span>
            ) : null}
            {buildRunning ? <span className="editor-state">Compiling...</span> : null}
            {activeFile?.stale === true && (
              <span className="editor-state">Changed on disk</span>
            )}
            {syncTexMessage.length > 0 ? (
              <span className="editor-state">{syncTexMessage}</span>
            ) : null}
          </span>
        </div>
      ) : null}
      {activeFile === null ? (
        <div className="editor-empty">
          <FileText aria-hidden="true" size={24} />
          <p>Open a project file to edit it.</p>
        </div>
      ) : activeFile.documentKind === "word" ? (
        <OnlyOfficeWordEditorPane
          key={`${activeFile.path}:${onlyOfficeWordReloadVersions[activeFile.path] ?? 0}`}
          displayName={getBaseName(activeFile.path)}
          filePath={activeFile.path}
          projectRoot={projectRoot}
          onClose={() => onCloseFile(activeFile.path)}
          onDirtyStateChange={onOnlyOfficeDirtyStateChange}
          onExportPdf={onOnlyOfficeExportPdf}
          onOpenSettings={onOpenWordSettings}
          readOnly={!canEditProject}
          onSessionStateChange={onOnlyOfficeSessionStateChange}
          onStatusMessage={onStatusMessage}
        />
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
            readOnly: !canEditProject,
            readOnlyMessage: {
              value:
                "Shared viewers can read and compile this project, but cannot edit it."
            },
            scrollBeyondLastLine: false,
            wordWrap: "on"
          }}
          path={activeFile.path}
          theme="latex-light"
          value={activeFile.contents}
          onChange={(value, event) => onContentsChange(value ?? "", event.changes)}
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
  imageAttachments,
  liveStatus,
  mode,
  onAllowApproval,
  onAttachImages,
  onCancel,
  onClearHistory,
  onDenyApproval,
  onModeChange,
  onPromptChange,
  onProviderChange,
  onRemoveImageAttachment,
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
  readonly imageAttachments: readonly AgentImageAttachment[];
  readonly liveStatus: AgentLiveStatus | null;
  readonly mode: AgentMode;
  readonly onAllowApproval: (
    sessionId: string,
    approvalId: string,
    toolName: AgentToolName
  ) => void;
  readonly onAttachImages: (files: readonly File[]) => void;
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
  readonly onRemoveImageAttachment: (attachmentId: string) => void;
  readonly onSelectionAction: (action: SelectionAgentAction) => void;
  readonly onStart: () => void;
  readonly prompt: string;
  readonly providerAuthStatus: AgentAuthStatus;
  readonly providerId: AgentProviderId;
  readonly running: boolean;
  readonly selectedText: string | null;
}) {
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [composerDropActive, setComposerDropActive] = useState(false);
  const elapsedSeconds = useAgentElapsedSeconds(running);
  const canSend = !running && (prompt.trim().length > 0 || imageAttachments.length > 0);

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
            <option value="openrouter-design">OpenRouter Design</option>
          </select>
        </label>
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
            <strong>Start a conversation about your paper</strong>
            <p>
              Ask a question, request an edit, or run a compile. The agent&rsquo;s
              live progress shows up right here.
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
                  activityEvents={getAgentRunActivityEvents(
                    events,
                    visibleThreadItems,
                    index
                  )}
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

      <div
        className={`agent-composer${composerDropActive ? " drag-active" : ""}`}
        onDragEnter={(event) => {
          if (hasImageDragItems(event.dataTransfer)) {
            event.preventDefault();
            setComposerDropActive(true);
          }
        }}
        onDragOver={(event) => {
          if (hasImageDragItems(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setComposerDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setComposerDropActive(false);
          }
        }}
        onDrop={(event) => {
          if (!hasImageDragItems(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          setComposerDropActive(false);
          onAttachImages(Array.from(event.dataTransfer.files));
        }}
      >
        {imageAttachments.length > 0 && (
          <div className="agent-attachments" aria-label="Attached images">
            {imageAttachments.map((attachment) => (
              <div className="agent-attachment" key={attachment.id}>
                <img alt="" src={attachment.dataUrl} />
                <div>
                  <strong>{attachment.name}</strong>
                  <span>{formatBytes(attachment.byteLength)}</span>
                </div>
                <IconButton
                  disabled={running}
                  label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveImageAttachment(attachment.id)}
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <div className="agent-input-card">
          <textarea
            ref={composerRef}
            aria-label="Agent prompt"
            value={prompt}
            placeholder="Ask for an edit, a compile, or a question about your paper…"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (canSend && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onStart();
              }
            }}
          />
          <input
            ref={attachmentInputRef}
            aria-label="Upload image for agent"
            hidden
            multiple
            type="file"
            accept={agentImageInputAccept}
            onChange={(event) => {
              onAttachImages(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <div className="agent-input-toolbar">
            <div className="agent-input-toolbar-left">
              <IconButton
                disabled={
                  running || imageAttachments.length >= maxAgentImageAttachments
                }
                label="Attach image"
                onClick={() => attachmentInputRef.current?.click()}
              >
                <ImagePlus size={15} />
              </IconButton>
              <select
                className="agent-mode-chip"
                aria-label="Agent mode"
                value={mode}
                disabled={running}
                title={getAgentModeDescription(mode)}
                onChange={(event) => onModeChange(event.target.value as AgentMode)}
              >
                <option value="suggest">Ask only</option>
                <option value="apply-with-review">Review first</option>
                <option value="autonomous-local">Auto-apply</option>
              </select>
            </div>
            {running ? (
              <button
                className="agent-send-button stop"
                type="button"
                onClick={onCancel}
              >
                <Square aria-hidden="true" size={14} />
                Stop
              </button>
            ) : (
              <button
                className="agent-send-button"
                type="button"
                disabled={!canSend}
                onClick={onStart}
              >
                Send
                <ArrowUp aria-hidden="true" size={15} />
              </button>
            )}
          </div>
        </div>
        <p className="agent-input-hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </p>
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
  activityEvents,
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
  readonly activityEvents: readonly AgentEvent[];
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
  const statusEvents = [...events, ...activityEvents];
  const visibleWorkflowEvents = getVisibleAgentWorkflowEvents({
    hasAssistantResponse: assistantMessages.length > 0,
    isActive,
    workflowEvents
  });
  const latestEvent = getLatestAgentEvent(statusEvents);
  const tone = getAgentRunTone(statusEvents);
  const effectiveLiveStatus = createAgentRunLiveStatus({
    elapsedSeconds,
    events: statusEvents,
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
  onApplyWordChangeSet,
  onAttachReferenceEntry,
  onCreateChangeSet,
  onExplainChangeSetHunk,
  onActiveTabChange,
  onClose,
  onFixDiagnostic,
  onInsertCitation,
  onKeepUnusedReference,
  onJumpToOutlineItem,
  onReferenceSearchQueryChange,
  onRefreshReferences,
  onRejectChangeSet,
  onRejectWordChangeSet,
  onSetChangeSetHunkAccepted,
  onRemoveUnusedReference,
  onRepairMissingCitation,
  onRollbackChangeSet,
  onRollbackWordChangeSet,
  onRunReferenceSearch,
  onSelectChangeSet,
  onSelectWordChangeSet,
  onSelectDiagnostic,
  onSelectReferenceCitation,
  onSelectReferenceEntry,
  onSnapshotActiveFile,
  onSuggestCitations,
  outline,
  referenceAnalysis,
  referenceMessage,
  referenceSearchQuery,
  referenceSearchResults,
  selectedChangeSetId,
  selectedWordChangeSetId,
  submissionCheckResult,
  wordChangeSets
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
  readonly onClose: () => void;
  readonly historyChangeSets: readonly HistoryChangeSet[];
  readonly historyMessage: string;
  readonly onApplyChangeSet: (changesetId: string) => void;
  readonly onApplyWordChangeSet: (changesetId: string) => void;
  readonly onAttachReferenceEntry: (entry: BibliographyEntry) => void;
  readonly onCreateChangeSet: () => void;
  readonly onExplainChangeSetHunk: (filePath: string, hunkContents: string) => void;
  readonly onFixDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onInsertCitation: (key: string) => void;
  readonly onKeepUnusedReference: (entry: BibliographyEntry) => void;
  readonly onJumpToOutlineItem: (item: LatexOutlineItem) => void;
  readonly onReferenceSearchQueryChange: (query: string) => void;
  readonly onRefreshReferences: () => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
  readonly onRejectWordChangeSet: (changesetId: string) => void;
  readonly onSetChangeSetHunkAccepted: (
    changesetId: string,
    hunkIndex: number,
    accepted: boolean
  ) => void;
  readonly onRemoveUnusedReference: (entry: BibliographyEntry) => void;
  readonly onRepairMissingCitation: (key: string) => void;
  readonly onRollbackChangeSet: (changesetId: string) => void;
  readonly onRollbackWordChangeSet: (changesetId: string) => void;
  readonly onRunReferenceSearch: () => void;
  readonly onSelectChangeSet: (changesetId: string) => void;
  readonly onSelectWordChangeSet: (changesetId: string | null) => void;
  readonly onSelectDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onSelectReferenceCitation: (citation: CitationOccurrence) => void;
  readonly onSelectReferenceEntry: (entry: BibliographyEntry) => void;
  readonly onSnapshotActiveFile: () => void;
  readonly onSuggestCitations: () => void;
  readonly outline: readonly LatexOutlineItem[];
  readonly referenceAnalysis: ReferenceAnalysis;
  readonly referenceMessage: string;
  readonly referenceSearchQuery: string;
  readonly referenceSearchResults: readonly ReferenceSearchResult[];
  readonly selectedChangeSetId: string | null;
  readonly selectedWordChangeSetId: string | null;
  readonly submissionCheckResult: SubmissionCheckResult | null;
  readonly wordChangeSets: readonly WordChangeSet[];
}) {
  const tabs: readonly BottomTab[] = [
    "Problems",
    "References",
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
        <IconButton label="Hide panels" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="bottom-content" role="tabpanel">
        {activeTab === "Problems" && (
          <DiagnosticsPanel
            diagnostics={buildResult?.diagnostics ?? []}
            onFixDiagnostic={onFixDiagnostic}
            onSelectDiagnostic={onSelectDiagnostic}
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
            selectedWordChangeSetId={selectedWordChangeSetId}
            wordChangeSets={wordChangeSets}
            onApplyChangeSet={onApplyChangeSet}
            onApplyWordChangeSet={onApplyWordChangeSet}
            onCreateChangeSet={onCreateChangeSet}
            onExplainChangeSetHunk={onExplainChangeSetHunk}
            onRejectChangeSet={onRejectChangeSet}
            onRejectWordChangeSet={onRejectWordChangeSet}
            onRollbackChangeSet={onRollbackChangeSet}
            onRollbackWordChangeSet={onRollbackWordChangeSet}
            onSelectChangeSet={onSelectChangeSet}
            onSelectWordChangeSet={onSelectWordChangeSet}
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
              <p>Entries come from .bib files in the project.</p>
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
        <p>The outline is built from section and chapter commands in your .tex files.</p>
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
  onApplyWordChangeSet,
  onCreateChangeSet,
  onExplainChangeSetHunk,
  onRejectChangeSet,
  onRejectWordChangeSet,
  onRollbackChangeSet,
  onRollbackWordChangeSet,
  onSelectChangeSet,
  onSelectWordChangeSet,
  onSetChangeSetHunkAccepted,
  onSnapshotActiveFile,
  selectedChangeSetId,
  selectedWordChangeSetId,
  wordChangeSets
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
  readonly onApplyWordChangeSet: (changesetId: string) => void;
  readonly onCreateChangeSet: () => void;
  readonly onExplainChangeSetHunk: (filePath: string, hunkContents: string) => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
  readonly onRejectWordChangeSet: (changesetId: string) => void;
  readonly onRollbackChangeSet: (changesetId: string) => void;
  readonly onRollbackWordChangeSet: (changesetId: string) => void;
  readonly onSelectChangeSet: (changesetId: string) => void;
  readonly onSelectWordChangeSet: (changesetId: string | null) => void;
  readonly onSetChangeSetHunkAccepted: (
    changesetId: string,
    hunkIndex: number,
    accepted: boolean
  ) => void;
  readonly onSnapshotActiveFile: () => void;
  readonly selectedChangeSetId: string | null;
  readonly selectedWordChangeSetId: string | null;
  readonly wordChangeSets: readonly WordChangeSet[];
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
  const selectedWordChangeSet =
    wordChangeSets.find((changeset) => changeset.id === selectedWordChangeSetId) ??
    wordChangeSets[0] ??
    null;

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
          {changesets.length === 0 && wordChangeSets.length === 0 ? (
            <p>Changesets appear here after the agent proposes an edit you can review.</p>
          ) : null}
          {changesets.length > 0 ? (
            <>
              <span className="history-list-label">LaTeX/text patches</span>
              {changesets.map((changeset) => (
                <button
                  className={`history-row${changeset.id === selectedChangeSet?.id ? " active" : ""}`}
                  key={changeset.id}
                  type="button"
                  onClick={() => {
                    onSelectChangeSet(changeset.id);
                    onSelectWordChangeSet(null);
                  }}
                >
                  <strong>{changeset.summary}</strong>
                  <span>
                    {changeset.status} · {changeset.filePath}
                  </span>
                </button>
              ))}
            </>
          ) : null}
          {wordChangeSets.length > 0 ? (
            <>
              <span className="history-list-label">Word edits</span>
              {wordChangeSets.map((changeset) => (
                <button
                  className={`history-row${changeset.id === selectedWordChangeSet?.id ? " active" : ""}`}
                  key={changeset.id}
                  type="button"
                  onClick={() => onSelectWordChangeSet(changeset.id)}
                >
                  <strong>{changeset.summary}</strong>
                  <span>
                    {changeset.status} · {changeset.filePath}
                  </span>
                </button>
              ))}
            </>
          ) : null}
        </div>
        <div className="history-detail">
          {selectedWordChangeSet !== null ? (
            <WordChangeSetReview
              changeset={selectedWordChangeSet}
              onApply={onApplyWordChangeSet}
              onReject={onRejectWordChangeSet}
              onRollback={onRollbackWordChangeSet}
            />
          ) : selectedChangeSet === null ? (
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
            <p>Entries appear here as agent actions occur.</p>
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

function WordChangeSetReview({
  changeset,
  onApply,
  onReject,
  onRollback
}: {
  readonly changeset: WordChangeSet;
  readonly onApply: (changesetId: string) => void;
  readonly onReject: (changesetId: string) => void;
  readonly onRollback: (changesetId: string) => void;
}) {
  return (
    <>
      <div className="history-detail-header">
        <div>
          <strong>{changeset.summary}</strong>
          <span>
            {changeset.status} · {changeset.filePath}
          </span>
        </div>
        <div className="history-actions">
          <button
            className="text-button"
            type="button"
            disabled={changeset.status !== "proposed"}
            onClick={() => onApply(changeset.id)}
          >
            <Check aria-hidden="true" size={15} />
            Apply Word Edit
          </button>
          <button
            className="text-button"
            type="button"
            disabled={changeset.status !== "proposed"}
            onClick={() => onReject(changeset.id)}
          >
            <X aria-hidden="true" size={15} />
            Reject
          </button>
          <button
            className="text-button"
            type="button"
            disabled={changeset.status !== "applied"}
            onClick={() => onRollback(changeset.id)}
          >
            <RotateCcw aria-hidden="true" size={15} />
            Roll Back
          </button>
        </div>
      </div>
      <div className={`changeset-verification ${changeset.status}`}>
        <strong>Word round-trip verification</strong>
        <span>
          {changeset.status === "applied"
            ? "Saved and reopened the Word document successfully."
            : changeset.status === "reverted"
              ? "Restored the previous Word document bytes and reopened it successfully."
              : "Review paragraph-level operations before applying them to the .docx file."}
        </span>
      </div>
      <div className="word-change-list" aria-label="Word edit operations">
        {changeset.operations.map((operation, index) => (
          <article className="word-change" key={`${changeset.id}:${index}`}>
            <div className="word-change__header">
              <strong>{formatWordOperationTitle(operation.type)}</strong>
              <span>Operation {index + 1}</span>
            </div>
            <div className="word-change__body">
              <div>
                <span className="eyebrow">Before</span>
                <p>{getWordOperationBeforeText(changeset.baseBlocks, operation)}</p>
              </div>
              <div>
                <span className="eyebrow">After</span>
                <p>{getWordOperationAfterText(changeset.baseBlocks, operation)}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
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
  const [onlyOfficeStatus, setOnlyOfficeStatus] = useState<OnlyOfficeStatus | null>(
    null
  );
  const [onlyOfficeStatusRunning, setOnlyOfficeStatusRunning] = useState(false);
  const refreshOnlyOfficeStatus = useCallback(() => {
    setOnlyOfficeStatusRunning(true);
    void desktopApi.onlyOffice
      .getStatus()
      .then(setOnlyOfficeStatus)
      .catch((error) =>
        setOnlyOfficeStatus({
          configured: false,
          bridgeListening: false,
          documentServerReachable: false,
          documentServerUrl: settings.onlyOffice.documentServerUrl,
          message: getErrorMessage(error)
        })
      )
      .finally(() => setOnlyOfficeStatusRunning(false));
  }, [settings.onlyOffice.documentServerUrl]);

  useEffect(() => {
    if (tab === "Word") {
      refreshOnlyOfficeStatus();
    }
  }, [refreshOnlyOfficeStatus, settings.onlyOffice, tab]);

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
      {tab === "Word" && (
        <>
          <Toggle
            checked={settings.onlyOffice.enabled}
            label="Use ONLYOFFICE for Word documents"
            onChange={(enabled) =>
              onSettingsChange((current) => ({
                ...current,
                onlyOffice: { ...current.onlyOffice, enabled }
              }))
            }
          />
          <TextField
            label="Document Server URL"
            placeholder="e.g. https://your-onlyoffice-server.com"
            value={settings.onlyOffice.documentServerUrl}
            onChange={(documentServerUrl) =>
              onSettingsChange((current) => ({
                ...current,
                onlyOffice: { ...current.onlyOffice, documentServerUrl }
              }))
            }
          />
          <TextField
            label="Bridge callback URL"
            placeholder="Leave blank to auto-detect"
            value={settings.onlyOffice.bridgePublicBaseUrl}
            onChange={(bridgePublicBaseUrl) =>
              onSettingsChange((current) => ({
                ...current,
                onlyOffice: { ...current.onlyOffice, bridgePublicBaseUrl }
              }))
            }
          />
          <TextField
            label="JWT secret"
            placeholder="Optional"
            value={settings.onlyOffice.jwtSecret}
            onChange={(jwtSecret) =>
              onSettingsChange((current) => ({
                ...current,
                onlyOffice: { ...current.onlyOffice, jwtSecret }
              }))
            }
          />
          <p className="settings-note">
            These settings only matter if you're running your own ONLYOFFICE
            Document Server. If you're just testing locally, you can leave
            Bridge callback URL and JWT secret blank. The bridge callback URL
            is the address ZeroLeaf's local bridge tells your Document Server
            to call back on; leaving it blank lets ZeroLeaf detect it
            automatically. The JWT secret is only needed if your Document
            Server is configured to require signed requests.
          </p>
          <section className="update-status-panel" aria-label="ONLYOFFICE status">
            <div className="update-status-heading">
              <div>
                <strong>{formatOnlyOfficeStatusTitle(onlyOfficeStatus)}</strong>
                <p>{onlyOfficeStatus?.message ?? "Status has not been checked yet."}</p>
              </div>
              <span
                className={`update-status-pill ${getOnlyOfficeStatusTone(onlyOfficeStatus)}`}
              >
                {getOnlyOfficeStatusLabel(onlyOfficeStatus)}
              </span>
            </div>
            <div className="update-version-grid">
              <Field
                label="Document Server"
                value={onlyOfficeStatus?.documentServerUrl ?? "Unknown"}
              />
              <Field
                label="Bridge URL"
                value={onlyOfficeStatus?.bridgePublicBaseUrl ?? "Not listening"}
              />
              <Field
                label="Bridge port"
                value={
                  onlyOfficeStatus?.bridgePort === undefined
                    ? "Not listening"
                    : String(onlyOfficeStatus.bridgePort)
                }
              />
            </div>
          </section>
          <button
            className="text-button settings-action"
            type="button"
            disabled={onlyOfficeStatusRunning}
            onClick={refreshOnlyOfficeStatus}
          >
            <RefreshCw aria-hidden="true" size={15} />
            {onlyOfficeStatusRunning ? "Checking ONLYOFFICE" : "Check ONLYOFFICE"}
          </button>
          <p className="settings-note">
            For a local Docker Document Server, run{" "}
            <code>npm run onlyoffice:start</code>. Keep the callback URL on
            host.docker.internal so the container can reach ZeroLeaf's local bridge.
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

function formatOnlyOfficeStatusTitle(status: OnlyOfficeStatus | null): string {
  if (status === null) {
    return "ONLYOFFICE status";
  }

  if (!status.configured) {
    return "ONLYOFFICE disabled";
  }

  return status.documentServerReachable
    ? "ONLYOFFICE ready"
    : "Document Server unreachable";
}

function getOnlyOfficeStatusTone(status: OnlyOfficeStatus | null): string {
  if (status === null) {
    return "idle";
  }

  if (!status.configured) {
    return "not-configured";
  }

  return status.documentServerReachable ? "current" : "error";
}

function getOnlyOfficeStatusLabel(status: OnlyOfficeStatus | null): string {
  if (status === null) {
    return "Idle";
  }

  if (!status.configured) {
    return "Disabled";
  }

  return status.documentServerReachable ? "Ready" : "Error";
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
  if (providerId === "openrouter-design") {
    return [
      {
        id: "install",
        index: 1,
        title: "Configure OpenRouter key",
        detail:
          "Set OPENROUTER_API_KEY in the environment used to launch ZeroLeaf. The app does not store this key.",
        state: authStatus.state === "connected" ? "complete" : "current"
      },
      {
        id: "refresh",
        index: 2,
        title: "Confirm connection",
        detail:
          "Refresh after restarting ZeroLeaf with the environment variable available.",
        state: authStatus.state === "connected" ? "complete" : "pending"
      }
    ];
  }

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

function hasImageDragItems(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(
    (item) =>
      item.kind === "file" && (item.type.startsWith("image/") || item.type.length === 0)
  );
}

function isSupportedAgentImageFile(file: File): boolean {
  return file.type.startsWith("image/") || inferAgentImageMimeType(file.name) !== null;
}

function inferAgentImageMimeType(fileName: string): string | null {
  const extension = fileName.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return null;
  }
}

function readAgentImageAttachment(file: File): Promise<AgentImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }

      resolve({
        id: `agent-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || inferAgentImageMimeType(file.name) || "image/*",
        byteLength: file.size,
        dataUrl: reader.result
      });
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KB`;
  }

  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAgentPromptForTranscript(
  prompt: string,
  attachments: readonly AgentImageAttachment[]
): string {
  if (attachments.length === 0) {
    return prompt;
  }

  return [
    prompt,
    "",
    `Attached images (${attachments.length}):`,
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.byteLength)})`
    )
  ].join("\n");
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

  const layoutElement = getMonacoLayoutElement(editor);
  const rect = layoutElement.getBoundingClientRect();
  const editorPaneRect = layoutElement.closest(".editor-pane")?.getBoundingClientRect();
  const width = Math.floor(Math.min(rect.width, editorPaneRect?.width ?? rect.width));
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
      setEditorValue: (
        path: string,
        value: string
      ) => {
        readonly ok: boolean;
        readonly reason?: string;
      };
      getEditorValue: (path: string) => {
        readonly ok: boolean;
        readonly value?: string;
        readonly reason?: string;
      };
      getEditorPosition: (path: string) => {
        readonly ok: boolean;
        readonly line?: number;
        readonly column?: number;
        readonly lineText?: string;
      };
    };
  };

  targetWindow.__latexAgentE2E = {
    setEditorValue: (path, value) => {
      const model = editor.getModel();
      const uri = model?.uri.toString() ?? "";
      const activePath = path.split("/").at(-1) ?? path;

      if (model === null) {
        return { ok: false, reason: "missing model" };
      }

      if (!uri.includes(path) && !uri.endsWith(activePath)) {
        return { ok: false, reason: `active model was ${uri}` };
      }

      model.setValue(value);
      editor.focus();
      return { ok: true };
    },
    getEditorValue: (path) => {
      const model = editor.getModel();
      const uri = model?.uri.toString() ?? "";
      const activePath = path.split("/").at(-1) ?? path;

      if (model === null) {
        return { ok: false, reason: "missing model" };
      }

      if (!uri.includes(path) && !uri.endsWith(activePath)) {
        return { ok: false, reason: `active model was ${uri}` };
      }

      return { ok: true, value: model.getValue() };
    },
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
    },
    "openrouter-design": {
      providerId: "openrouter-design",
      state: "disconnected",
      message: "OpenRouter design provider is not connected yet."
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
    case "openrouter-design":
      return "OpenRouter Design";
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
    case "openrouter-design":
      return "via openrouter";
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
    case "openrouter-design":
      return "Runs structured website design workflow steps through OpenRouter with per-step model routing.";
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

function getEffectiveSharedAgentMode(
  mode: AgentMode,
  activeSharedProject: ActiveSharedProject | null
): AgentMode {
  return activeSharedProject?.role === "viewer" ? "read-only" : mode;
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
  options: {
    readonly decision?: "allowed" | "denied";
    readonly wordChangesAutoApply?: boolean;
  } = {}
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
  options: {
    readonly decision?: "allowed" | "denied";
    readonly wordChangesAutoApply?: boolean;
  }
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
  const wordChangeSets = getAgentResultWordChangeSets(result);
  const deletedEntries = result.deleteEntries ?? [];
  const movedEntries = result.moveEntries ?? [];
  const changedFiles = formatChangedFileList(
    changesets,
    deletedEntries,
    movedEntries,
    wordChangeSets
  );

  if (result.status === "completed") {
    if (wordChangeSets.length > 0) {
      if (options.wordChangesAutoApply === true) {
        return `I applied ${wordChangeSets.length} Word ${wordChangeSets.length === 1 ? "edit" : "edits"}${changedFiles} and refreshed ONLYOFFICE.`;
      }

      return `I prepared ${wordChangeSets.length} reviewable Word ${wordChangeSets.length === 1 ? "edit" : "edits"}${changedFiles}. No files were changed yet.`;
    }

    return undefined;
  }

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

function getAgentResultWordChangeSets(
  result: AgentSessionResult
): readonly WordChangeSet[] {
  if ((result.wordChangesets?.length ?? 0) > 0) {
    return result.wordChangesets ?? [];
  }

  return result.wordChangeset === undefined ? [] : [result.wordChangeset];
}

function formatChangedFileList(
  changesets: readonly HistoryChangeSet[],
  deletedEntries: readonly { readonly path: string }[],
  movedEntries: readonly { readonly fromPath: string; readonly toPath: string }[],
  wordChangeSets: readonly WordChangeSet[] = []
): string {
  const paths = [
    ...changesets.map((changeset) => changeset.filePath),
    ...wordChangeSets.map((changeset) => changeset.filePath),
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

function getAgentRunActivityEvents(
  events: readonly AgentEvent[],
  items: readonly AgentThreadItem[],
  assistantRunIndex: number
): readonly AgentEvent[] {
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

  return events.filter(
    (event) =>
      event.sessionId === item.sessionId &&
      isAgentEventInRunWindow(event, startTime, endTime)
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

  const latestOperationalStatus = findLatestOperationalLiveStatus(events);

  if (latestOperationalStatus !== undefined) {
    return latestOperationalStatus;
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

function findLatestOperationalLiveStatus(
  events: readonly AgentEvent[]
): AgentLiveStatus | undefined {
  const latestEvent = findLastAgentEvent(
    events,
    (event): event is AgentEvent =>
      event.type === "tool-call" ||
      event.type === "verification" ||
      event.type === "error"
  );

  return latestEvent === undefined
    ? undefined
    : createAgentLiveStatusFromEvent(latestEvent);
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

  if (normalizedSummary.includes("running installed codex")) {
    return "Planning with Codex";
  }

  if (normalizedSummary.includes("still analyzing")) {
    return "Codex is still working";
  }

  if (normalizedSummary.includes("running installed claude")) {
    return "Planning with Claude";
  }

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

  if (summary.startsWith("Claude is thinking:")) {
    return "Thinking";
  }

  if (summary.startsWith("Claude is drafting a response:")) {
    return "Drafting response";
  }

  if (summary.startsWith("Claude is using a tool:")) {
    return formatClaudeLiveToolTitle(
      summary.slice("Claude is using a tool:".length).trim()
    );
  }

  if (summary.startsWith("Claude progress:")) {
    return "Progress";
  }

  return "Analyzing project";
}

function formatClaudeLiveToolTitle(toolDescription: string): string {
  if (toolDescription.startsWith("Reading ")) {
    return "Reading file";
  }

  if (toolDescription.startsWith("Editing ")) {
    return "Editing file";
  }

  if (toolDescription.startsWith("Writing ")) {
    return "Writing file";
  }

  if (
    toolDescription.startsWith("Searching for ") ||
    toolDescription.startsWith("Searching project for")
  ) {
    return "Searching project";
  }

  if (toolDescription.startsWith("Listing ")) {
    return "Listing directory";
  }

  return "Using a tool";
}

function formatAgentModelExecutionDetail(summary: string): string {
  const normalizedSummary = summary.toLowerCase();
  const elapsedText = /\(([^()]+ elapsed)\)/u.exec(summary)?.[1];

  if (normalizedSummary.includes("still analyzing")) {
    return summary;
  }

  if (normalizedSummary.includes("running installed codex")) {
    return "Codex is inspecting the project and choosing whether to answer, propose a patch, or run an app action.";
  }

  if (normalizedSummary.includes("running installed claude")) {
    return "Claude is inspecting the project and choosing whether to answer or propose a patch.";
  }

  if (normalizedSummary.includes("compile failed")) {
    return "The agent is reading the compile log and preparing a safe LaTeX repair.";
  }

  if (
    normalizedSummary.includes("concrete change") ||
    normalizedSummary.includes("tool action")
  ) {
    return "The agent is turning the analysis into a reviewable project action.";
  }

  if (
    normalizedSummary.includes("overbroad") ||
    normalizedSummary.includes("complete minimal patch")
  ) {
    return "The agent is asking for a smaller patch before changing project files.";
  }

  if (normalizedSummary.includes("retry")) {
    return "The agent is retrying with a narrower project-scoped prompt.";
  }

  if (summary.startsWith("Claude is thinking:")) {
    return summary.slice("Claude is thinking:".length).trim();
  }

  if (summary.startsWith("Claude is drafting a response:")) {
    return summary.slice("Claude is drafting a response:".length).trim();
  }

  if (summary.startsWith("Claude is using a tool:")) {
    return summary.slice("Claude is using a tool:".length).trim();
  }

  if (summary.startsWith("Claude progress:")) {
    return summary.slice("Claude progress:".length).trim();
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
  if (isWordDocumentPath(path)) {
    return createEditorFileStateFromWordDocument(
      await desktopApi.word.read({
        projectRoot,
        path
      })
    );
  }

  const snapshot = await desktopApi.files.read({
    projectRoot,
    path
  });

  return {
    ...snapshot,
    documentKind: "text" as const,
    savedContents: snapshot.contents,
    stale: false
  };
}

function createEditorFileStateFromWordDocument(
  document: WordDocumentModel
): EditorFileState {
  return {
    path: document.path,
    contents: document.plainText,
    savedContents: document.plainText,
    mtimeMs: document.mtimeMs,
    stale: false,
    documentKind: "word",
    wordBlocks: document.blocks,
    savedWordBlocks: document.blocks,
    wordWarnings: document.warnings
  };
}

function isWordDocumentPath(path: string): boolean {
  return path.toLowerCase().endsWith(".docx");
}

function formatWordOperationTitle(operationType: WordBlockOperation["type"]): string {
  switch (operationType) {
    case "replace-block":
      return "Replace paragraph";
    case "insert-block-after":
      return "Insert paragraph";
    case "delete-block":
      return "Delete paragraph";
    case "move-block":
      return "Move paragraph";
    case "replace-selection":
      return "Replace selection";
  }
}

function getWordOperationBeforeText(
  blocks: readonly WordDocumentBlock[],
  operation: WordBlockOperation
): string {
  switch (operation.type) {
    case "insert-block-after":
      return "New paragraph";
    case "replace-block":
    case "delete-block":
    case "move-block":
    case "replace-selection":
      return findWordBlockText(blocks, operation.blockId);
  }
}

function getWordOperationAfterText(
  blocks: readonly WordDocumentBlock[],
  operation: WordBlockOperation
): string {
  switch (operation.type) {
    case "replace-block":
      return operation.afterText;
    case "insert-block-after":
      return operation.block.text;
    case "delete-block":
      return "Paragraph removed";
    case "move-block":
      return `Moved after ${operation.afterBlockId ?? "document start"}`;
    case "replace-selection": {
      const blockText = findWordBlockText(blocks, operation.blockId);
      return `${blockText.slice(0, operation.startOffset)}${operation.replacementText}${blockText.slice(operation.endOffset)}`;
    }
  }
}

function findWordBlockText(
  blocks: readonly WordDocumentBlock[],
  blockId: string
): string {
  return blocks.find((block) => block.id === blockId)?.text ?? "Paragraph not found";
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

function createSharedTextOperations(
  beforeContents: string,
  afterContents: string
): readonly SharedProjectDocumentTextOperation[] {
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

function applySharedRemoteTextOperationsToEditor(
  editor: MonacoStandaloneEditor,
  operations: readonly SharedProjectDocumentTextOperation[]
): boolean {
  const model = editor.getModel();
  if (model === null) {
    return false;
  }

  editor.executeEdits(
    "shared-remote",
    operations.map((operation) => {
      const start = model.getPositionAt(operation.rangeOffset);
      const end = model.getPositionAt(operation.rangeOffset + operation.rangeLength);
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column
        },
        text: operation.text,
        forceMoveMarkers: true
      };
    })
  );
  return true;
}

function createSharedPresenceCursorDecorations({
  activeFilePath,
  currentUserId,
  model,
  presence
}: {
  readonly activeFilePath: string;
  readonly currentUserId: string | undefined;
  readonly model: MonacoEditorApi.ITextModel;
  readonly presence: readonly SharedProjectPresenceSummary[];
}): MonacoEditorApi.IModelDeltaDecoration[] {
  return presence.flatMap((entry) => {
    if (
      entry.userId === currentUserId ||
      entry.filePath !== activeFilePath ||
      entry.cursorLine === undefined ||
      entry.cursorColumn === undefined
    ) {
      return [];
    }

    const position = model.validatePosition({
      lineNumber: entry.cursorLine,
      column: entry.cursorColumn
    });

    return [
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        },
        options: {
          beforeContentClassName: "shared-remote-cursor",
          hoverMessage: {
            value: `${entry.displayName} cursor`
          }
        }
      }
    ];
  });
}

function getActiveSharedCollaborators({
  activeFilePath,
  currentUserId,
  presence
}: {
  readonly activeFilePath: string | null;
  readonly currentUserId: string | undefined;
  readonly presence: readonly SharedProjectPresenceSummary[];
}): readonly SharedProjectPresenceSummary[] {
  if (activeFilePath === null) {
    return [];
  }

  return presence
    .filter(
      (entry) => entry.userId !== currentUserId && entry.filePath === activeFilePath
    )
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function getInitials(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return "?";
  }

  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function formatSharedPresenceLocation(presence: SharedProjectPresenceSummary): string {
  const location =
    presence.cursorLine === undefined || presence.cursorColumn === undefined
      ? (presence.filePath ?? "Project")
      : `${presence.filePath ?? "Project"}:${presence.cursorLine}:${presence.cursorColumn}`;

  return `${presence.displayName} · ${location}`;
}

function upsertSharedPresence(
  presence: readonly SharedProjectPresenceSummary[],
  nextPresence: SharedProjectPresenceSummary
): readonly SharedProjectPresenceSummary[] {
  const existingIndex = presence.findIndex(
    (entry) =>
      entry.projectId === nextPresence.projectId && entry.userId === nextPresence.userId
  );

  if (existingIndex === -1) {
    return [...presence, nextPresence];
  }

  return presence.map((entry, index) =>
    index === existingIndex ? nextPresence : entry
  );
}

function replaceWordChangeSet(
  changesets: readonly WordChangeSet[],
  nextChangeSet: WordChangeSet
): readonly WordChangeSet[] {
  return changesets.some((changeset) => changeset.id === nextChangeSet.id)
    ? changesets.map((changeset) =>
        changeset.id === nextChangeSet.id ? nextChangeSet : changeset
      )
    : [nextChangeSet, ...changesets];
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

function getProjectRelativePath(projectRoot: string, path: string) {
  const normalizedRoot = normalizeProjectPath(projectRoot).replace(/\/+$/u, "");
  const normalizedPath = normalizeProjectPath(path);
  const rootPrefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(rootPrefix)
    ? normalizedPath.slice(rootPrefix.length)
    : normalizedPath;
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

function createBuildResultFromSharedArtifact(
  artifact: SharedProjectBuildArtifactDetails,
  fallbackCompiler: LatexCompiler
): BuildResult {
  return {
    jobId: `shared-build-artifact:${artifact.id}`,
    status: artifact.status,
    compiler: toLatexCompiler(artifact.compiler, fallbackCompiler),
    command: ["shared-build-artifact", artifact.compiler],
    securityPolicy: createDefaultBuildSecurityPolicy(),
    startedAt: artifact.createdAt,
    finishedAt: artifact.createdAt,
    durationMs: 0,
    diagnostics: artifact.diagnostics,
    rawLog: artifact.rawLog,
    stdout: "",
    stderr: "",
    ...(artifact.pdfBase64 === undefined || artifact.pdfByteLength === undefined
      ? {}
      : {
          artifact: {
            pdfPath: `shared-build-artifact:${artifact.id}.pdf`,
            updatedAt: artifact.createdAt,
            byteLength: artifact.pdfByteLength
          }
        })
  };
}

function toLatexCompiler(
  value: string,
  fallbackCompiler: LatexCompiler
): LatexCompiler {
  return value === "pdflatex" || value === "xelatex" || value === "lualatex"
    ? value
    : fallbackCompiler;
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

async function confirmAction(options: {
  readonly message: string;
  readonly detail?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
}): Promise<boolean> {
  const cancelLabel = options.cancelLabel ?? "Cancel";
  const result = await desktopApi.app.showMessageDialog({
    message: options.message,
    buttons: [options.confirmLabel, cancelLabel],
    cancelId: 1,
    defaultId: options.destructive === true ? 1 : 0,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.destructive === undefined ? {} : { warning: options.destructive })
  });

  return result.buttonIndex === 0;
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

function formatSharedProjectDetails(project: SharedProjectSummary) {
  const updatedAt = new Date(project.updatedAt);

  if (Number.isNaN(updatedAt.getTime())) {
    return "Updated unknown";
  }

  return `Updated ${updatedAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  })}`;
}

function formatSharedSessionLabel(session: Pick<SharedProjectSessionSummary, "id">) {
  const shortId = session.id.length <= 8 ? session.id : session.id.slice(0, 8);
  return `Session ${shortId}`;
}

function formatSharedSessionDetails(session: SharedProjectSessionSummary) {
  const createdAt = new Date(session.createdAt);
  const refreshExpiresAt = new Date(session.refreshTokenExpiresAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "created unknown"
    : `created ${createdAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      })}`;
  const expiryLabel = Number.isNaN(refreshExpiresAt.getTime())
    ? "refresh expiry unknown"
    : `refresh expires ${refreshExpiresAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      })}`;

  return `${session.current ? "This desktop" : "Remote desktop"} · ${createdLabel} · ${expiryLabel}`;
}

function formatSharedBuildArtifactDetails(artifact: SharedProjectBuildArtifactSummary) {
  const createdLabel = formatSharedArtifactCreatedAt(artifact);
  const diagnosticsLabel =
    artifact.diagnosticCount === 1
      ? "1 diagnostic"
      : `${artifact.diagnosticCount} diagnostics`;
  const pdfLabel =
    artifact.pdfByteLength === undefined
      ? "no PDF"
      : `${formatBytes(artifact.pdfByteLength)} PDF`;
  const toolchainLabel =
    artifact.engineVersion === undefined && artifact.latexmkVersion === undefined
      ? "toolchain unknown"
      : [
          artifact.engineVersion === undefined
            ? undefined
            : `engine ${formatSharedToolchainVersion(artifact.engineVersion)}`,
          artifact.latexmkVersion === undefined
            ? undefined
            : `latexmk ${formatSharedToolchainVersion(artifact.latexmkVersion)}`
        ]
          .filter((part): part is string => part !== undefined)
          .join(" · ");

  return `${createdLabel} · ${diagnosticsLabel} · ${pdfLabel} · ${toolchainLabel} · desktop ${formatSharedDesktopClientLabel(
    artifact.desktopClientId
  )} · source ${formatSharedRevisionLabel(artifact.sourceRevisionId)}`;
}

function formatSharedArtifactCreatedAt(artifact: SharedProjectBuildArtifactSummary) {
  const createdAt = new Date(artifact.createdAt);

  return Number.isNaN(createdAt.getTime())
    ? "unknown"
    : createdAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

function formatSharedRevisionLabel(revisionId: string) {
  return revisionId.length <= 8 ? revisionId : revisionId.slice(0, 8);
}

function formatSharedDesktopClientLabel(desktopClientId: string) {
  return desktopClientId.length <= 16
    ? desktopClientId
    : `${desktopClientId.slice(0, 16)}...`;
}

function formatSharedToolchainVersion(version: string) {
  const firstLine = version.split(/\r?\n/u)[0]?.trim() ?? version.trim();
  return firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 45)}...`;
}

function formatSharedAgentRunTitle(agentRun: SharedProjectAgentRunSummary) {
  return `${formatSharedAgentRunStatus(agentRun.status)} · ${agentRun.providerId}`;
}

function formatSharedAgentRunDetails(agentRun: SharedProjectAgentRunSummary) {
  const updatedAt = new Date(agentRun.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? "unknown"
    : updatedAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
  const changesetLabel =
    agentRun.changesetIds.length === 1
      ? "1 changeset"
      : `${agentRun.changesetIds.length} changesets`;
  const buildArtifactLabel =
    agentRun.buildArtifactIds.length === 1
      ? "1 compile result"
      : `${agentRun.buildArtifactIds.length} compile results`;

  return `${updatedLabel} · ${agentRun.mode} · ${changesetLabel} · ${buildArtifactLabel}`;
}

function formatSharedAgentRunBuildArtifactLabel(index: number, total: number) {
  return total <= 1 ? "Inspect compile" : `Inspect compile ${index + 1}`;
}

function formatSharedAgentChangeSetLinkLabel(index: number, total: number) {
  return total <= 1 ? "Show changeset" : `Show changeset ${index + 1}`;
}

function formatSharedAgentRunStatus(status: SharedProjectAgentRunSummary["status"]) {
  switch (status) {
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "waiting-for-review":
      return "Waiting for review";
  }
}

function formatSharedAgentChangeSetTitle(
  changeset: SharedProjectAgentChangeSetSummary
) {
  return `${changeset.filePath} · ${formatSharedAgentChangeSetStatus(
    changeset.status
  )}`;
}

function formatSharedAgentChangeSetDetails(
  changeset: SharedProjectAgentChangeSetSummary
) {
  const updatedAt = new Date(changeset.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? "unknown"
    : updatedAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });

  return `${updatedLabel} · ${changeset.summary}`;
}

function formatSharedAgentChangeSetStatus(
  status: SharedProjectAgentChangeSetSummary["status"]
) {
  switch (status) {
    case "applied":
      return "Applied";
    case "failed":
      return "Failed";
    case "proposed":
      return "Proposed";
    case "rejected":
      return "Rejected";
  }
}

function formatSharedAgentAuditTitle(event: SharedProjectAuditEventSummary) {
  return formatSharedAgentAuditEventType(event.eventType);
}

function formatSharedAgentAuditDetails(event: SharedProjectAuditEventSummary) {
  const createdAt = new Date(event.createdAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "unknown"
    : createdAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
  const linkedIds = [
    event.agentRunId === undefined
      ? undefined
      : `run ${formatSharedRevisionLabel(event.agentRunId)}`,
    event.changesetId === undefined
      ? undefined
      : `changeset ${formatSharedRevisionLabel(event.changesetId)}`,
    event.buildArtifactIds === undefined || event.buildArtifactIds.length === 0
      ? undefined
      : `${event.buildArtifactIds.length} compile ${event.buildArtifactIds.length === 1 ? "artifact" : "artifacts"}`
  ].filter((part): part is string => part !== undefined);

  return [createdLabel, event.message, ...linkedIds].join(" · ");
}

function formatSharedAgentAuditEventType(eventType: string) {
  switch (eventType) {
    case "agent.changeset.applied":
      return "Agent changeset applied";
    case "agent.changeset.proposed":
      return "Agent changeset proposed";
    case "agent.changeset.rejected":
      return "Agent changeset rejected";
    case "agent.run.cancelled":
      return "Agent run cancelled";
    case "agent.run.completed":
      return "Agent run completed";
    case "agent.run.created":
      return "Agent run started";
    case "agent.run.failed":
      return "Agent run failed";
    case "agent.run.waiting-for-review":
      return "Agent run waiting for review";
    default:
      return eventType;
  }
}

function formatSharedActivityTitle(activity: SharedProjectActivitySummary) {
  switch (activity.eventType) {
    case "agent.changeset.applied":
      return "Agent changeset applied";
    case "agent.changeset.proposed":
      return "Agent changeset proposed";
    case "agent.changeset.rejected":
      return "Agent changeset rejected";
    case "agent.run.cancelled":
      return "Agent run cancelled";
    case "agent.run.completed":
      return "Agent run completed";
    case "agent.run.created":
      return "Agent run";
    case "agent.run.failed":
      return "Agent run failed";
    case "agent.run.waiting-for-review":
      return "Agent run waiting for review";
    case "build-artifact.created":
      return "Local compile uploaded";
    case "entry.deleted":
      return "Entry deleted";
    case "entry.moved":
      return "Entry moved";
    case "entry.renamed":
      return "Entry renamed";
    case "file.created":
      return "File created";
    case "file.updated":
      return "File updated";
    case "project.created":
      return "Project created";
    case "project.invitation.accepted":
      return "Invitation accepted";
    case "project.invitation.created":
      return "Invitation sent";
    default:
      return activity.eventType;
  }
}

function formatSharedActivityDetails(activity: SharedProjectActivitySummary) {
  const createdAt = new Date(activity.createdAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "unknown"
    : createdAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });

  return `${createdLabel} · ${activity.message}`;
}

function formatSharedCommentTitle(comment: SharedProjectCommentSummary) {
  const anchor =
    comment.filePath === undefined
      ? "Project"
      : comment.line === undefined
        ? comment.filePath
        : `${comment.filePath}:${comment.line}`;
  return `${comment.resolved ? "Resolved" : "Open"} · ${anchor}`;
}

function formatSharedCommentDetails(comment: SharedProjectCommentSummary) {
  const updatedAt = new Date(comment.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? "unknown"
    : updatedAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
  const authorLabel = formatSharedRevisionLabel(comment.authorUserId);

  return `${updatedLabel} · ${authorLabel}`;
}

function formatSharedFileRevisionDetails(revision: SharedProjectFileRevisionSummary) {
  const createdAt = new Date(revision.createdAt);
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? "unknown"
    : createdAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
  const encodingLabel =
    revision.contentEncoding === undefined || revision.contentEncoding === "utf8"
      ? "text"
      : "binary";

  return `${createdLabel} · ${formatBytes(revision.byteLength)} ${encodingLabel} · ${formatSharedRevisionLabel(revision.actorUserId)}`;
}

function formatSharedFileRevisionPreview(revision: SharedProjectFileRevisionDetails) {
  if (revision.contentEncoding === "base64") {
    return `${revision.path}\n${formatBytes(revision.byteLength)} binary revision ${formatSharedRevisionLabel(revision.id)}`;
  }

  const maxPreviewLength = 1_600;
  const preview =
    revision.contents.length > maxPreviewLength
      ? `${revision.contents.slice(0, maxPreviewLength)}\n...revision preview truncated...`
      : revision.contents;
  return `${revision.path} · revision ${formatSharedRevisionLabel(revision.id)}\n\n${preview}`;
}

function toSharedProjectAgentRunStatus(
  status: AgentSessionResult["status"]
): "running" | "waiting-for-review" | "completed" | "failed" | "cancelled" {
  switch (status) {
    case "awaiting-approval":
      return "waiting-for-review";
    case "cancelled":
    case "completed":
    case "failed":
    case "running":
      return status;
  }
}

function formatSharedProjectRole(role: SharedProjectRole) {
  switch (role) {
    case "owner":
      return "Owner";
    case "editor":
      return "Editor";
    case "viewer":
      return "Viewer";
  }
}
