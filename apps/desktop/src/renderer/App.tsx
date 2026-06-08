import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  AppInfo,
  AppSettings,
  BibliographyEntry,
  BuildResult,
  AuditEvent,
  CitationOccurrence,
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
  Command as CommandIcon,
  FileText,
  FolderPlus,
  FolderOpen,
  MessageSquareText,
  PanelRight,
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
import { desktopApi } from "./desktopApi.js";
import {
  getEditableProjectFiles,
  getLanguageForPath,
  parseLatexOutline,
  searchFileContents,
  type LatexOutlineItem,
  type ProjectSearchResult
} from "./editorModel.js";
import {
  initialWorkbenchLayout,
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
type AgentAuthStatusByProvider = Readonly<Record<AgentProviderId, AgentAuthStatus>>;

const agentProviderIds = [
  "mock",
  "openai-codex",
  "anthropic-claude"
] as const satisfies readonly AgentProviderId[];

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

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [layout, setLayout] = useState<WorkbenchLayout>(initialWorkbenchLayout);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [projectState, setProjectState] = useState<ProjectState>({
    recentProjects: []
  });
  const [projectResult, setProjectResult] = useState<ProjectOpenResult | null>(null);
  const [openFiles, setOpenFiles] = useState<readonly EditorFileState[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
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
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfSearchQuery, setPdfSearchQuery] = useState("");
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
  const [privacySummary, setPrivacySummary] = useState<PrivacySummary | null>(null);
  const [keybindingQuery, setKeybindingQuery] = useState("");
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTab>("Problems");
  const [commandQuery, setCommandQuery] = useState("");
  const [historyChangeSets, setHistoryChangeSets] = useState<
    readonly HistoryChangeSet[]
  >([]);
  const [auditEvents, setAuditEvents] = useState<readonly AuditEvent[]>([]);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(null);
  const [historyMessage, setHistoryMessage] = useState("No history action yet.");
  const [agentProviderId, setAgentProviderId] = useState<AgentProviderId>("mock");
  const [agentMode, setAgentMode] = useState<AgentMode>("apply-with-review");
  const [agentAuthStatuses, setAgentAuthStatuses] = useState<AgentAuthStatusByProvider>(
    () => createInitialAgentAuthStatuses()
  );
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentSelectedText, setAgentSelectedText] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<readonly AgentEvent[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const agentComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<MonacoStandaloneEditor | null>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);

  const refreshAgentAuthStatuses = useCallback(async () => {
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
      setAgentProviderId(settings.agentPermissions.defaultProviderId);
      setAgentMode(settings.agentPermissions.defaultMode);
    });
    void desktopApi.lifecycle.listTemplates().then(setProjectTemplates);
    void desktopApi.settings.getPrivacySummary().then(setPrivacySummary);
    void desktopApi.build.detectToolchain().then(setToolchainStatus);
    void refreshAgentAuthStatuses();
  }, [refreshAgentAuthStatuses]);

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
      toolchainStatus.synctexAvailable
        ? "Compile to enable SyncTeX"
        : "SyncTeX command missing"
    );
  }, [toolchainStatus]);

  const currentProject = projectResult?.project;

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
      updateAppSettings((settings) => ({
        ...settings,
        agentPermissions: {
          ...settings.agentPermissions,
          defaultProviderId: providerId
        }
      }));
    },
    [updateAppSettings]
  );

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
  const activeOutline = useMemo(
    () => (activeFile === null ? [] : parseLatexOutline(activeFile.contents)),
    [activeFile]
  );

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
      const candidatePaths = uniqueStrings([
        ...(preferredFilePath === undefined ? [] : [preferredFilePath]),
        ...(savedState.activeFilePath === undefined ? [] : [savedState.activeFilePath]),
        ...savedState.openFilePaths,
        ...(result.project.mainFilePath === undefined
          ? []
          : [result.project.mainFilePath])
      ]).filter((path) => availablePaths.has(path));

      const snapshots = await Promise.all(
        candidatePaths.map((path) =>
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
        activePath: files[0]?.path ?? null
      };
    },
    []
  );

  const applyProjectResult = useCallback(
    async (result: ProjectOpenResult, preferredFilePath?: string) => {
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setProjectError(null);
      setStatusMessage(`Opened ${result.project.displayName}`);

      const editorState = await loadProjectEditorState(result, preferredFilePath);
      setOpenFiles(editorState.files);
      setActiveFilePath(editorState.activePath);
      setPendingRevealLine(null);
    },
    [loadProjectEditorState]
  );

  const runProjectOperation = useCallback(async (operation: () => Promise<void>) => {
    try {
      setProjectError(null);
      await operation();
    } catch (error) {
      setProjectError(getErrorMessage(error));
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    if (currentProject === undefined) {
      setHistoryChangeSets([]);
      setAuditEvents([]);
      setSelectedChangeSetId(null);
      return;
    }

    const [changeSets, events] = await Promise.all([
      desktopApi.history.listChangeSets({ projectRoot: currentProject.rootPath }),
      desktopApi.history.listAuditEvents({ projectRoot: currentProject.rootPath })
    ]);
    setHistoryChangeSets(changeSets);
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
      updateMonacoCitationCompletions([]);
      return;
    }

    const analysis = await desktopApi.references.analyze({
      projectRoot: currentProject.rootPath
    });
    setReferenceAnalysis(analysis);
    setReferenceMessage(
      `${analysis.entries.length} references · ${analysis.missingCitations.length} missing · ${analysis.unusedEntries.length} unused`
    );
    updateMonacoCitationCompletions(analysis.entries);
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
      const template =
        projectTemplates.find((candidate) => candidate.id === selectedTemplateId) ??
        projectTemplates[0];
      const fallbackName =
        template?.name.toLowerCase().replace(/\s+/gu, "-") ?? "paper";
      const projectName = window.prompt("Project name", fallbackName);

      if (projectName === null || projectName.trim().length === 0) {
        return;
      }

      const result = await desktopApi.lifecycle.createFromTemplate({
        templateId: selectedTemplateId,
        projectName: projectName.trim()
      });
      if (result !== undefined) {
        await applyProjectResult(result, result.project.mainFilePath);
        setStatusMessage(`Created ${result.project.displayName}`);
      }
    });
  }, [applyProjectResult, projectTemplates, runProjectOperation, selectedTemplateId]);

  const exportCurrentPdf = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || pdfArtifactData === null) {
        return;
      }

      const result = await desktopApi.lifecycle.exportPdf({
        projectRoot: currentProject.rootPath,
        pdfPath: pdfArtifactData.pdfPath
      });

      if (result !== undefined) {
        setStatusMessage(`Exported PDF to ${getBaseName(result.destinationPath)}`);
      }
    });
  }, [currentProject, pdfArtifactData, runProjectOperation]);

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
    const items = submissionCheckResult?.items ?? [];
    const checklist = items
      .map(
        (item) =>
          `- ${item.severity}: ${item.message}${item.filePath === undefined ? "" : ` (${item.filePath})`}`
      )
      .join("\n");
    setAgentPrompt(
      [
        "Inspect this LaTeX project for submission readiness.",
        "Use local project files only.",
        "Produce an actionable checklist and propose minimal fixes for blocking issues.",
        checklist.length === 0 ? "No automated bundle check has run yet." : checklist
      ].join("\n\n")
    );
    setActiveBottomTab("Output");
    agentComposerRef.current?.focus();
  }, [submissionCheckResult]);

  useEffect(() => {
    void runProjectOperation(refreshHistory);
  }, [refreshHistory, runProjectOperation]);

  useEffect(() => {
    void runProjectOperation(refreshReferences);
  }, [refreshReferences, runProjectOperation]);

  const selectFile = useCallback(
    (path: string) => {
      void runProjectOperation(async () => {
        await readProjectFile(path);
      });
    },
    [readProjectFile, runProjectOperation]
  );

  const saveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      const result = await desktopApi.files.write({
        projectRoot: currentProject.rootPath,
        path: activeFile.path,
        contents: activeFile.contents
      });
      setOpenFiles((files) =>
        replaceOpenFile(files, {
          ...activeFile,
          savedContents: activeFile.contents,
          mtimeMs: result.mtimeMs,
          stale: false
        })
      );
      setStatusMessage(`Saved ${activeFile.path}`);
      await refreshReferences();
    });
  }, [activeFile, currentProject, refreshReferences, runProjectOperation]);

  const saveDirtyFiles = useCallback(async () => {
    if (currentProject === undefined || dirtyFiles.length === 0) {
      return 0;
    }

    const savedFiles = await Promise.all(
      dirtyFiles.map(async (file) => {
        const result = await desktopApi.files.write({
          projectRoot: currentProject.rootPath,
          path: file.path,
          contents: file.contents
        });
        return {
          ...file,
          savedContents: file.contents,
          mtimeMs: result.mtimeMs,
          stale: false
        };
      })
    );

    setOpenFiles((files) =>
      savedFiles.reduce(
        (nextFiles, savedFile) => replaceOpenFile(nextFiles, savedFile),
        files
      )
    );
    await refreshReferences();
    return savedFiles.length;
  }, [currentProject, dirtyFiles, refreshReferences]);

  const exportSourceArchive = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      await saveDirtyFiles();
      const result = await desktopApi.lifecycle.exportSourceZip({
        projectRoot: currentProject.rootPath,
        includeBuildArtifacts: false
      });

      if (result !== undefined) {
        setStatusMessage(
          `Exported ${result.fileCount} files to ${getBaseName(result.archivePath)}`
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

  const applyChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const changeset = await desktopApi.history.applyChangeSet(changesetId);
        setHistoryMessage(`Applied ${changeset.summary}`);
        await readProjectFile(changeset.filePath);
        await refreshHistory();
      });
    },
    [readProjectFile, refreshHistory, runProjectOperation]
  );

  const rejectChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const changeset = await desktopApi.history.rejectChangeSet(changesetId);
        setHistoryMessage(`Rejected ${changeset.summary}`);
        await refreshHistory();
      });
    },
    [refreshHistory, runProjectOperation]
  );

  const rollbackChangeSet = useCallback(
    (changesetId: string) => {
      void runProjectOperation(async () => {
        const changeset = await desktopApi.history.rollbackChangeSet(changesetId);
        setHistoryMessage(`Rolled back ${changeset.summary}`);
        await readProjectFile(changeset.filePath);
        await refreshHistory();
      });
    },
    [readProjectFile, refreshHistory, runProjectOperation]
  );

  const runBuild = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject?.mainFilePath === undefined) {
        setProjectError("Choose a main .tex file before compiling.");
        return;
      }

      await saveDirtyFiles();
      const jobId = crypto.randomUUID();
      setBuildRunning(true);
      setActiveBuildJobId(jobId);
      setPdfStale(false);
      setBuildResult(null);
      setPdfArtifactData(null);
      setStatusMessage("Compiling project...");

      try {
        const result = await desktopApi.build.run({
          jobId,
          projectRoot: currentProject.rootPath,
          mainFilePath: currentProject.mainFilePath,
          compiler: selectedCompiler
        });

        setBuildResult(result);
        setActiveBottomTab(result.diagnostics.length > 0 ? "Problems" : "Log");

        if (result.artifact !== undefined && result.status === "succeeded") {
          const artifactData = await desktopApi.pdf.readArtifact({
            projectRoot: currentProject.rootPath,
            pdfPath: result.artifact.pdfPath
          });
          setPdfArtifactData(artifactData);
          setPdfPageNumber(1);
          setSyncTexMessage(
            result.artifact.synctexPath === undefined
              ? "SyncTeX unavailable for this build"
              : "SyncTeX ready"
          );
          setStatusMessage(`Compiled ${currentProject.mainFilePath}`);
        } else {
          setStatusMessage(`Compile ${result.status}`);
        }
      } finally {
        setActiveBuildJobId(null);
        setBuildRunning(false);
      }
    });
  }, [currentProject, runProjectOperation, saveDirtyFiles, selectedCompiler]);

  const startAgentTask = useCallback(
    (options?: {
      readonly prompt?: string;
      readonly selectedText?: string;
      readonly diagnostic?: LatexDiagnostic;
    }) => {
      void runProjectOperation(async () => {
        if (currentProject === undefined) {
          setStatusMessage("Open a project before starting the agent.");
          return;
        }

        const prompt =
          options?.prompt?.trim() ??
          agentPrompt.trim() ??
          "Inspect the current LaTeX context and propose a safe edit.";
        const selectedText = options?.selectedText ?? agentSelectedText ?? undefined;

        if (prompt.length === 0) {
          setStatusMessage("Enter an agent prompt first.");
          return;
        }

        const authStatus = agentAuthStatuses[agentProviderId];

        if (authStatus.state !== "connected") {
          setStatusMessage(
            `${getAgentProviderLabel(agentProviderId)} is ${formatAgentAuthState(authStatus.state)}. Check AI Providers settings.`
          );
          return;
        }

        setAgentRunning(true);
        setAgentEvents([]);
        setStatusMessage(
          `${getAgentProviderLabel(agentProviderId)} is preparing a patch...`
        );

        try {
          const result = await desktopApi.agent.start({
            providerId: agentProviderId,
            mode: agentMode,
            projectRoot: currentProject.rootPath,
            prompt,
            ...(activeFile === null ? {} : { activeFilePath: activeFile.path }),
            ...(selectedText === undefined ? {} : { selectedText }),
            ...(currentProject.mainFilePath === undefined
              ? {}
              : { mainFilePath: currentProject.mainFilePath }),
            compiler: selectedCompiler,
            ...(options?.diagnostic === undefined
              ? {}
              : { diagnostic: options.diagnostic })
          });

          setAgentSessionId(result.sessionId);
          setAgentEvents(result.events);

          if (result.changeset !== undefined) {
            setSelectedChangeSetId(result.changeset.id);
            setHistoryMessage(`Agent proposed ${result.changeset.summary}`);
            setActiveBottomTab("History");
            await refreshHistory();
          }

          setStatusMessage(
            result.status === "failed"
              ? `${getAgentProviderLabel(agentProviderId)} could not complete the task.`
              : result.status === "awaiting-approval"
                ? `${getAgentProviderLabel(agentProviderId)} is waiting for patch approval.`
                : `${getAgentProviderLabel(agentProviderId)} completed.`
          );
        } finally {
          setAgentRunning(false);
        }
      });
    },
    [
      activeFile,
      agentAuthStatuses,
      agentMode,
      agentPrompt,
      agentProviderId,
      agentSelectedText,
      currentProject,
      refreshHistory,
      runProjectOperation,
      selectedCompiler
    ]
  );

  const prepareSelectionAgentTask = useCallback(() => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const selectedText =
      editor?.getModel() !== null && selection !== undefined && selection !== null
        ? editor?.getModel()?.getValueInRange(selection)
        : undefined;

    setAgentPrompt(
      selectedText !== undefined && selectedText.trim().length > 0
        ? "Rewrite the selected LaTeX text while preserving meaning."
        : "Review the active LaTeX file and suggest a safe edit."
    );
    setAgentSelectedText(
      selectedText !== undefined && selectedText.trim().length > 0 ? selectedText : null
    );
    agentComposerRef.current?.focus();
  }, []);

  const respondAgentApproval = useCallback(
    (sessionId: string, approvalId: string, decision: "allowed" | "denied") => {
      void runProjectOperation(async () => {
        const result = await desktopApi.agent.respondApproval({
          sessionId,
          approvalId,
          decision
        });

        setAgentEvents((events) => [
          ...events,
          ...result.events.filter(
            (event) => !events.some((existingEvent) => existingEvent.id === event.id)
          )
        ]);

        if (result.changeset !== undefined) {
          setHistoryMessage(
            `${decision === "allowed" ? "Applied" : "Reviewed"} ${result.changeset.summary}`
          );
          setSelectedChangeSetId(result.changeset.id);
          await readProjectFile(result.changeset.filePath);
        }

        if (result.buildResult !== undefined) {
          setBuildResult(result.buildResult);
          setActiveBottomTab(
            result.buildResult.diagnostics.length > 0 ? "Problems" : "Log"
          );

          if (
            currentProject !== undefined &&
            result.buildResult.artifact !== undefined &&
            result.buildResult.status === "succeeded"
          ) {
            const artifactData = await desktopApi.pdf.readArtifact({
              projectRoot: currentProject.rootPath,
              pdfPath: result.buildResult.artifact.pdfPath
            });
            setPdfArtifactData(artifactData);
            setPdfPageNumber(1);
          }
        }

        await refreshHistory();
        setStatusMessage(
          decision === "allowed"
            ? "Agent patch applied and verified."
            : "Agent approval denied."
        );
      });
    },
    [currentProject, readProjectFile, refreshHistory, runProjectOperation]
  );

  const stopBuild = useCallback(() => {
    if (activeBuildJobId === null) {
      return;
    }

    void desktopApi.build.stop(activeBuildJobId).then((result) => {
      if (result.stopped) {
        setStatusMessage("Stopping compile...");
      }
    });
  }, [activeBuildJobId]);

  const runPdfSearch = useCallback(() => {
    void runProjectOperation(async () => {
      const document = pdfDocumentRef.current;
      const query = pdfSearchQuery.trim().toLowerCase();

      if (document === null || query.length === 0) {
        return;
      }

      for (let page = 1; page <= document.numPages; page += 1) {
        const pdfPage = await document.getPage(page);
        const textContent = await pdfPage.getTextContent();
        const pageText = textContent.items.map(getPdfTextItemString).join(" ");

        if (pageText.toLowerCase().includes(query)) {
          setPdfPageNumber(page);
          setStatusMessage(`Found PDF match on page ${page}`);
          return;
        }
      }

      setStatusMessage("No PDF search match");
    });
  }, [pdfSearchQuery, runProjectOperation]);

  const setActiveFileAsMain = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      const result = await desktopApi.project.setMainFile({
        projectRoot: currentProject.rootPath,
        path: activeFile.path
      });
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setStatusMessage(`Set ${activeFile.path} as main file`);
    });
  }, [activeFile, currentProject, runProjectOperation]);

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

        const result = await desktopApi.project.createEntry({
          projectRoot: currentProject.rootPath,
          parentPath: ".",
          name: name.trim(),
          kind
        });
        await applyProjectResult(result, kind === "file" ? name.trim() : undefined);
      });
    },
    [applyProjectResult, currentProject, runProjectOperation]
  );

  const renameActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      const newName = window.prompt("Rename file", getBaseName(activeFile.path));
      if (newName === null || newName.trim().length === 0) {
        return;
      }

      const renamedPath = getSiblingProjectPath(activeFile.path, newName.trim());
      const result = await desktopApi.project.renameEntry({
        projectRoot: currentProject.rootPath,
        path: activeFile.path,
        newName: newName.trim()
      });
      await applyProjectResult(result, renamedPath);
    });
  }, [activeFile, applyProjectResult, currentProject, runProjectOperation]);

  const moveActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      const newPath = window.prompt("Move file to", activeFile.path);
      if (newPath === null || newPath.trim().length === 0) {
        return;
      }

      const normalizedPath = newPath.trim();
      const result = await desktopApi.project.moveEntry({
        projectRoot: currentProject.rootPath,
        path: activeFile.path,
        newPath: normalizedPath
      });
      await applyProjectResult(result, normalizedPath);
    });
  }, [activeFile, applyProjectResult, currentProject, runProjectOperation]);

  const deleteActiveFile = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined || activeFile === null) {
        return;
      }

      if (!window.confirm(`Delete ${activeFile.path}?`)) {
        return;
      }

      const result = await desktopApi.project.deleteEntry({
        projectRoot: currentProject.rootPath,
        path: activeFile.path
      });
      setOpenFiles((files) => removeOpenFile(files, activeFile.path));
      setActiveFilePath((path) => (path === activeFile.path ? null : path));
      setProjectResult(result);
      setProjectState({ recentProjects: result.recentProjects });
      setStatusMessage(`Deleted ${activeFile.path}`);
    });
  }, [activeFile, currentProject, runProjectOperation]);

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
  }, [activeFile, currentProject, pdfArtifactData, runProjectOperation]);

  const jumpPdfToSource = useCallback(
    (x: number, y: number) => {
      void runProjectOperation(async () => {
        if (currentProject === undefined || pdfArtifactData === null) {
          setSyncTexMessage("Compile with SyncTeX before jumping.");
          return;
        }

        const result = await desktopApi.synctex.reverse({
          projectRoot: currentProject.rootPath,
          pdfPath: pdfArtifactData.pdfPath,
          page: pdfPageNumber,
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
    [
      currentProject,
      jumpToFileLine,
      pdfArtifactData,
      pdfPageNumber,
      runProjectOperation
    ]
  );

  const runProjectSearch = useCallback(() => {
    void runProjectOperation(async () => {
      if (currentProject === undefined) {
        return;
      }

      const filesToSearch = editableProjectFiles.slice(0, 250);
      const results = (
        await Promise.all(
          filesToSearch.map(async (file) => {
            const snapshot = await desktopApi.files.read({
              projectRoot: currentProject.rootPath,
              path: file.path
            });
            return searchFileContents(
              snapshot.path,
              snapshot.contents,
              projectSearchQuery,
              8
            );
          })
        )
      ).flat();

      setProjectSearchResults(results.slice(0, 200));
      setActiveBottomTab("Search");
      setStatusMessage(`Found ${results.length} search results`);
    });
  }, [currentProject, editableProjectFiles, projectSearchQuery, runProjectOperation]);

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

      const text = `\\cite{${key}}`;
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
            `${activeFile.contents.slice(0, position.column - 1)}${text}${activeFile.contents.slice(position.column - 1)}`
        })
      );
      setReferenceMessage(`Inserted citation ${key}`);
    },
    [activeFile]
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
          "If no likely local reference exists, add a minimal TODO comment near the citation instead of inventing a source.",
          "",
          "Local bibliography entries:",
          candidates.length === 0 ? "No bibliography entries found." : candidates
        ].join("\n")
      );
      setAgentSelectedText(null);
      setActiveBottomTab("References");
      agentComposerRef.current?.focus();
    },
    [referenceAnalysis.entries]
  );

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
        "Propose a minimal reviewable edit. Do not invent new sources.",
        "",
        "Local bibliography entries:",
        candidates.length === 0 ? "No bibliography entries found." : candidates
      ].join("\n")
    );
    setAgentSelectedText(null);
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

        const changedPaths = new Set(event.paths);
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
  }, [currentProject, openFiles, runProjectOperation]);

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
    if (pdfArtifactData === null) {
      pdfDocumentRef.current = null;
      setPdfPageCount(0);
      return;
    }

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
    const document = pdfDocumentRef.current;
    const canvas = pdfCanvasRef.current;

    if (document === null || canvas === null || pdfPageCount === 0) {
      return;
    }

    let cancelled = false;
    void renderPdfPage(document, canvas, pdfPageNumber, pdfScale).then(() => {
      if (cancelled) {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [pdfPageCount, pdfPageNumber, pdfScale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;

      if (commandKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
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
        prepareSelectionAgentTask();
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
  }, [openProject, prepareSelectionAgentTask, runBuild, saveActiveFile, saveAllFiles]);

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
    "--bottom-height": `${layout.bottomPanelHeight}px`
  } as CSSProperties &
    Record<"--pdf-width" | "--agent-width" | "--bottom-height", string>;

  const appShellClassName = [
    "app-shell",
    `density-${appSettings.appearance.density}`,
    `accent-${appSettings.appearance.accent}`,
    appSettings.appearance.highContrastLight ? "high-contrast-light" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const startResize = useCallback(
    (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLayout = layout;

      const onPointerMove = (moveEvent: PointerEvent) => {
        setLayout(
          resizeWorkbenchPane(target, startLayout, {
            x: moveEvent.clientX - startX,
            y: moveEvent.clientY - startY
          })
        );
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [layout]
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
      setLayout(resizeWorkbenchPane(target, layout, delta));
    },
    [layout]
  );

  const runCommand = useCallback(
    (commandId: CommandId) => {
      switch (commandId) {
        case "open-settings":
          setSettingsOpen(true);
          break;
        case "toggle-problems":
          setActiveBottomTab("Problems");
          break;
        case "focus-agent":
          agentComposerRef.current?.focus();
          break;
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
          setActiveBottomTab("Search");
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
    [openProject, runBuild, saveActiveFile, saveAllFiles]
  );

  return (
    <div className={appShellClassName}>
      <header className="titlebar">
        <div className="brand">
          <FileText aria-hidden="true" size={20} />
          <div>
            <strong>AI LaTeX Editor</strong>
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
          <IconButton label="Open project" onClick={openProject}>
            <FolderOpen size={17} />
          </IconButton>
          <IconButton
            label="Compile project"
            disabled={currentProject?.mainFilePath === undefined || buildRunning}
            onClick={runBuild}
          >
            <Play size={17} />
          </IconButton>
          <IconButton label="Open settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
          </IconButton>
        </nav>
      </header>

      <div className="workspace" style={workspaceStyle}>
        <ActivityRail />
        <ProjectSidebar
          activeFilePath={activeFile?.path}
          projectTemplates={projectTemplates}
          project={currentProject}
          recentProjects={projectState.recentProjects}
          selectedTemplateId={selectedTemplateId}
          submissionCheckResult={submissionCheckResult}
          tree={projectResult?.tree ?? []}
          onAskAgentSubmissionChecklist={askAgentForSubmissionChecklist}
          onCreateEntry={createEntry}
          onCreateFromTemplate={createProjectFromSelectedTemplate}
          onDeleteActiveFile={deleteActiveFile}
          onExportSourceArchive={exportSourceArchive}
          onImportSourceZip={importSourceZip}
          onMoveActiveFile={moveActiveFile}
          onOpenProject={openProject}
          onOpenRecentProject={openRecentProject}
          onRefreshProject={refreshProjectTree}
          onRenameActiveFile={renameActiveFile}
          onRunSubmissionCheck={runSubmissionCheck}
          onSelectFile={selectFile}
          onTemplateChange={setSelectedTemplateId}
        />
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
          <section className="content-row" aria-label="Main editor layout">
            <EditorPane
              activeFile={activeFile}
              activeFilePath={activeFilePath}
              dirty={activeFileDirty}
              dirtyFileCount={dirtyFiles.length}
              editorSettings={appSettings.editor}
              mainFilePath={currentProject?.mainFilePath}
              openFiles={openFiles}
              onActiveFileChange={setActiveFilePath}
              onAskAgent={prepareSelectionAgentTask}
              onCloseFile={closeFile}
              onContentsChange={updateActiveFileContents}
              onFind={() => focusMonacoFind(editorRef.current)}
              onFormat={() => formatMonacoDocument(editorRef.current)}
              onMount={(editor) => {
                editorRef.current = editor;
                editor.addAction({
                  id: "latex-agent.ask-selection",
                  label: "Ask Agent About Selection",
                  contextMenuGroupId: "navigation",
                  contextMenuOrder: 1.5,
                  run: () => {
                    prepareSelectionAgentTask();
                  }
                });
              }}
              onReplace={() => focusMonacoReplace(editorRef.current)}
              onRunBuild={runBuild}
              onSourceToPdf={jumpSourceToPdf}
              onSave={saveActiveFile}
              onSaveAll={saveAllFiles}
              onSetMainFile={setActiveFileAsMain}
              onStopBuild={stopBuild}
              selectedCompiler={selectedCompiler}
              syncTexMessage={syncTexMessage}
              toolchainStatus={toolchainStatus}
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
              canvasRef={pdfCanvasRef}
              pageCount={pdfPageCount}
              pageNumber={pdfPageNumber}
              searchQuery={pdfSearchQuery}
              scale={pdfScale}
              stale={pdfStale}
              onDownload={exportCurrentPdf}
              onFitWidth={() => setPdfScale(1.2)}
              onNextPage={() =>
                setPdfPageNumber((page) => Math.min(pdfPageCount, page + 1))
              }
              onPreviousPage={() => setPdfPageNumber((page) => Math.max(1, page - 1))}
              onRunSearch={runPdfSearch}
              onSearchQueryChange={setPdfSearchQuery}
              onCanvasClick={jumpPdfToSource}
              onSourceToPdf={jumpSourceToPdf}
              onZoomIn={() => setPdfScale((scale) => Math.min(2.5, scale + 0.1))}
              onZoomOut={() => setPdfScale((scale) => Math.max(0.6, scale - 0.1))}
              syncTexTarget={syncTexTarget}
            />
            <PaneResizer
              label="Resize agent panel"
              orientation="vertical"
              onPointerDown={(event) => startResize("agent", event)}
              onKeyDown={(event) => resizeWithKeyboard("agent", event)}
            />
            <AgentPane
              activeFilePath={activeFile?.path}
              composerRef={agentComposerRef}
              events={agentEvents}
              mode={agentMode}
              providerAuthStatus={agentAuthStatuses[agentProviderId]}
              providerId={agentProviderId}
              prompt={agentPrompt}
              running={agentRunning}
              selectedText={agentSelectedText}
              onAllowApproval={(sessionId, approvalId) =>
                respondAgentApproval(sessionId, approvalId, "allowed")
              }
              onCancel={() => {
                if (agentSessionId !== null) {
                  void desktopApi.agent.cancel(agentSessionId);
                }
                setAgentRunning(false);
              }}
              onModeChange={updateAgentMode}
              onPromptChange={setAgentPrompt}
              onProviderChange={updateAgentProviderId}
              onDenyApproval={(sessionId, approvalId) =>
                respondAgentApproval(sessionId, approvalId, "denied")
              }
              onStart={() => startAgentTask()}
            />
          </section>

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
            historyChangeSets={historyChangeSets}
            historyMessage={historyMessage}
            outline={activeOutline}
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
            onCreateChangeSet={createActiveFileChangeSet}
            onInsertCitation={insertCitation}
            onJumpToLine={(line) => {
              if (activeFile !== null) {
                jumpToFileLine(activeFile.path, line);
              }
            }}
            onProjectSearchQueryChange={setProjectSearchQuery}
            onReferenceSearchQueryChange={setReferenceSearchQuery}
            onRefreshReferences={() => {
              void runProjectOperation(refreshReferences);
            }}
            onRejectChangeSet={rejectChangeSet}
            onRepairMissingCitation={repairMissingCitation}
            onRollbackChangeSet={rollbackChangeSet}
            onRunReferenceSearch={runReferenceSearch}
            onRunProjectSearch={runProjectSearch}
            onSelectChangeSet={setSelectedChangeSetId}
            onFixDiagnostic={(diagnostic) => {
              startAgentTask({
                prompt: `Fix this LaTeX diagnostic: ${diagnostic.message}`,
                diagnostic
              });
            }}
            onSelectDiagnostic={(diagnostic) => {
              if (diagnostic.filePath !== undefined && diagnostic.line !== undefined) {
                jumpToFileLine(diagnostic.filePath, diagnostic.line);
              }
            }}
            onSelectReferenceEntry={(entry) =>
              jumpToFileLine(entry.filePath, entry.line)
            }
            onSelectReferenceCitation={(citation) =>
              jumpToFileLine(citation.filePath, citation.line)
            }
            onSelectSearchResult={(result) => jumpToFileLine(result.path, result.line)}
            onSnapshotActiveFile={snapshotActiveFile}
            onSuggestCitations={suggestCitationsWithAgent}
          />
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
      />
    </div>
  );
}

function ActivityRail() {
  return (
    <aside className="activity-rail" aria-label="Primary navigation">
      <IconButton label="Files" pressed>
        <FileText size={18} />
      </IconButton>
      <IconButton label="Search" disabled>
        <Search size={18} />
      </IconButton>
      <IconButton label="References" disabled>
        <BookOpen size={18} />
      </IconButton>
      <IconButton label="Agent" disabled>
        <Bot size={18} />
      </IconButton>
    </aside>
  );
}

function ProjectSidebar({
  activeFilePath,
  projectTemplates,
  selectedTemplateId,
  submissionCheckResult,
  onAskAgentSubmissionChecklist,
  onCreateEntry,
  onCreateFromTemplate,
  onDeleteActiveFile,
  onExportSourceArchive,
  onImportSourceZip,
  onMoveActiveFile,
  onOpenProject,
  onOpenRecentProject,
  onRefreshProject,
  onRenameActiveFile,
  onRunSubmissionCheck,
  onSelectFile,
  onTemplateChange,
  project,
  recentProjects,
  tree
}: {
  readonly activeFilePath: string | undefined;
  readonly projectTemplates: readonly ProjectTemplate[];
  readonly selectedTemplateId: ProjectTemplateId;
  readonly submissionCheckResult: SubmissionCheckResult | null;
  readonly onAskAgentSubmissionChecklist: () => void;
  readonly onCreateEntry: (kind: "directory" | "file") => void;
  readonly onCreateFromTemplate: () => void;
  readonly onDeleteActiveFile: () => void;
  readonly onExportSourceArchive: () => void;
  readonly onImportSourceZip: () => void;
  readonly onMoveActiveFile: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly onRefreshProject: () => void;
  readonly onRenameActiveFile: () => void;
  readonly onRunSubmissionCheck: () => void;
  readonly onSelectFile: (path: string) => void;
  readonly onTemplateChange: (templateId: ProjectTemplateId) => void;
  readonly project: ProjectOpenResult["project"] | undefined;
  readonly recentProjects: readonly RecentProject[];
  readonly tree: readonly ProjectFileTreeNode[];
}) {
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
      </div>

      {project === undefined ? (
        <RecentProjects
          projectTemplates={projectTemplates}
          recentProjects={recentProjects}
          selectedTemplateId={selectedTemplateId}
          onCreateFromTemplate={onCreateFromTemplate}
          onImportSourceZip={onImportSourceZip}
          onOpenProject={onOpenProject}
          onOpenRecentProject={onOpenRecentProject}
          onTemplateChange={onTemplateChange}
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
              label="Rename active file"
              onClick={onRenameActiveFile}
              disabled={activeFilePath === undefined}
            >
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label="Move active file"
              onClick={onMoveActiveFile}
              disabled={activeFilePath === undefined}
            >
              <ChevronRight size={15} />
            </IconButton>
            <IconButton
              label="Delete active file"
              onClick={onDeleteActiveFile}
              disabled={activeFilePath === undefined}
            >
              <Trash2 size={15} />
            </IconButton>
            <IconButton label="Refresh project" onClick={onRefreshProject}>
              <RefreshCw size={15} />
            </IconButton>
            <span className="toolbar-divider" aria-hidden="true" />
            <IconButton label="Export source ZIP" onClick={onExportSourceArchive}>
              <Save size={15} />
            </IconButton>
            <IconButton label="Check submission bundle" onClick={onRunSubmissionCheck}>
              <Check size={15} />
            </IconButton>
            <IconButton
              label="Agent submission checklist"
              onClick={onAskAgentSubmissionChecklist}
            >
              <Sparkles size={15} />
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
                  node={node}
                  onSelectFile={onSelectFile}
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
  projectTemplates,
  selectedTemplateId,
  onCreateFromTemplate,
  onImportSourceZip,
  onOpenProject,
  onOpenRecentProject,
  onTemplateChange,
  recentProjects
}: {
  readonly projectTemplates: readonly ProjectTemplate[];
  readonly selectedTemplateId: ProjectTemplateId;
  readonly onCreateFromTemplate: () => void;
  readonly onImportSourceZip: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenRecentProject: (rootPath: string) => void;
  readonly onTemplateChange: (templateId: ProjectTemplateId) => void;
  readonly recentProjects: readonly RecentProject[];
}) {
  return (
    <div className="recent-projects">
      <button className="primary-button" type="button" onClick={onOpenProject}>
        <FolderOpen aria-hidden="true" size={15} />
        Open Folder
      </button>
      <button className="text-button" type="button" onClick={onImportSourceZip}>
        <FolderOpen aria-hidden="true" size={15} />
        Import ZIP
      </button>

      <div className="template-picker">
        <span className="eyebrow">Template</span>
        <select
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
        <button className="text-button" type="button" onClick={onCreateFromTemplate}>
          <Plus aria-hidden="true" size={15} />
          Create Project
        </button>
        <p>
          {projectTemplates.find((template) => template.id === selectedTemplateId)
            ?.description ?? "Choose a built-in template."}
        </p>
      </div>

      <div className="recent-list" aria-label="Recent projects">
        <span className="eyebrow">Recent</span>
        {recentProjects.length === 0 ? (
          <p className="empty-state">No recent projects.</p>
        ) : (
          recentProjects.map((project) => (
            <button
              className="recent-row"
              key={project.rootPath}
              type="button"
              onClick={() => onOpenRecentProject(project.rootPath)}
            >
              <strong>{project.displayName}</strong>
              <span>{project.rootPath}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function FileTreeNode({
  activeFilePath,
  depth,
  node,
  onSelectFile
}: {
  readonly activeFilePath: string | undefined;
  readonly depth: number;
  readonly node: ProjectFileTreeNode;
  readonly onSelectFile: (path: string) => void;
}) {
  const isFolder = node.kind === "directory";

  return (
    <>
      <button
        className={`file-row${activeFilePath === node.path ? " active" : ""}`}
        disabled={isFolder}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        type="button"
        onClick={() => onSelectFile(node.path)}
      >
        {isFolder ? (
          <FolderOpen aria-hidden="true" size={15} />
        ) : (
          <FileText aria-hidden="true" size={15} />
        )}
        <span>{node.name}</span>
      </button>
      {node.children?.map((child) => (
        <FileTreeNode
          activeFilePath={activeFilePath}
          depth={depth + 1}
          key={child.path}
          node={child}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

function EditorPane({
  activeFile,
  activeFilePath,
  buildRunning,
  dirty,
  dirtyFileCount,
  editorSettings,
  mainFilePath,
  onCompilerChange,
  onActiveFileChange,
  onAskAgent,
  onCloseFile,
  onContentsChange,
  onFind,
  onFormat,
  onMount,
  onReplace,
  onRunBuild,
  onSourceToPdf,
  onSave,
  onSaveAll,
  onSetMainFile,
  onStopBuild,
  openFiles,
  selectedCompiler,
  syncTexMessage,
  toolchainStatus
}: {
  readonly activeFile: EditorFileState | null;
  readonly activeFilePath: string | null;
  readonly buildRunning: boolean;
  readonly dirty: boolean;
  readonly dirtyFileCount: number;
  readonly editorSettings: AppSettings["editor"];
  readonly mainFilePath: string | undefined;
  readonly onCompilerChange: (compiler: LatexCompiler) => void;
  readonly onActiveFileChange: (path: string) => void;
  readonly onAskAgent: () => void;
  readonly onCloseFile: (path: string) => void;
  readonly onContentsChange: (contents: string) => void;
  readonly onFind: () => void;
  readonly onFormat: () => void;
  readonly onMount: (editor: MonacoStandaloneEditor) => void;
  readonly onReplace: () => void;
  readonly onRunBuild: () => void;
  readonly onSourceToPdf: () => void;
  readonly onSave: () => void;
  readonly onSaveAll: () => void;
  readonly onSetMainFile: () => void;
  readonly onStopBuild: () => void;
  readonly openFiles: readonly EditorFileState[];
  readonly selectedCompiler: LatexCompiler;
  readonly syncTexMessage: string;
  readonly toolchainStatus: LatexToolchainStatus | null;
}) {
  const canSetMainFile =
    activeFile !== null &&
    activeFile.path.endsWith(".tex") &&
    activeFile.path !== mainFilePath;

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
                {isDirty ? <span aria-label="Unsaved changes">*</span> : null}
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
          disabled={mainFilePath === undefined || buildRunning}
          onClick={onRunBuild}
        >
          <Play aria-hidden="true" size={15} />
        </IconButton>
        <IconButton label="Stop compile" disabled={!buildRunning} onClick={onStopBuild}>
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
        <IconButton
          label="Replace in file"
          disabled={activeFile === null}
          onClick={onReplace}
        >
          <Pencil aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Format file"
          disabled={activeFile === null}
          onClick={onFormat}
        >
          <ChevronRight aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Set active file as main"
          disabled={!canSetMainFile}
          onClick={onSetMainFile}
        >
          <FileText aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Ask agent"
          disabled={activeFile === null}
          onClick={onAskAgent}
        >
          <Sparkles aria-hidden="true" size={15} />
        </IconButton>
        <span className="editor-status-group">
          {activeFile?.stale === true && (
            <span className="editor-state">Changed on disk</span>
          )}
          {toolchainStatus?.latexmkAvailable === false && (
            <span className="editor-state">latexmk missing</span>
          )}
          <span className="editor-state">{syncTexMessage}</span>
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

function PdfPane({
  artifact,
  buildRunning,
  canvasRef,
  onCanvasClick,
  onDownload,
  onFitWidth,
  onNextPage,
  onPreviousPage,
  onRunSearch,
  onSearchQueryChange,
  onSourceToPdf,
  onZoomIn,
  onZoomOut,
  pageCount,
  pageNumber,
  searchQuery,
  scale,
  stale,
  syncTexTarget
}: {
  readonly artifact: PdfArtifactData | null;
  readonly buildRunning: boolean;
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly onCanvasClick: (x: number, y: number) => void;
  readonly onDownload: () => void;
  readonly onFitWidth: () => void;
  readonly onNextPage: () => void;
  readonly onPreviousPage: () => void;
  readonly onRunSearch: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSourceToPdf: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly pageCount: number;
  readonly pageNumber: number;
  readonly searchQuery: string;
  readonly scale: number;
  readonly stale: boolean;
  readonly syncTexTarget: {
    readonly page: number;
    readonly x?: number;
    readonly y?: number;
  } | null;
}) {
  return (
    <section className="pdf-pane" aria-label="PDF preview">
      <div className="pane-title">
        <PanelRight aria-hidden="true" size={16} />
        <span>PDF Preview</span>
        {stale && <span className="pdf-state">Stale</span>}
      </div>
      <div className="pdf-toolbar" aria-label="PDF toolbar">
        <button
          className="icon-button"
          type="button"
          aria-label="Previous page"
          title="Previous page"
          disabled={pageNumber <= 1}
          onClick={onPreviousPage}
        >
          <ChevronRight className="flip-icon" size={15} />
        </button>
        <span className="pdf-page-indicator">
          {pageCount === 0 ? "0 / 0" : `${pageNumber} / ${pageCount}`}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label="Next page"
          title="Next page"
          disabled={pageNumber >= pageCount}
          onClick={onNextPage}
        >
          <ChevronRight size={15} />
        </button>
        <IconButton label="Zoom out" onClick={onZoomOut}>
          <span className="toolbar-icon-text" aria-hidden="true">
            -
          </span>
        </IconButton>
        <span className="zoom-label">{Math.round(scale * 100)}%</span>
        <IconButton label="Zoom in" onClick={onZoomIn}>
          <span className="toolbar-icon-text" aria-hidden="true">
            +
          </span>
        </IconButton>
        <IconButton label="Fit PDF width" onClick={onFitWidth}>
          <span className="toolbar-icon-text compact" aria-hidden="true">
            Fit
          </span>
        </IconButton>
        <input
          className="pdf-search-input"
          aria-label="Search PDF"
          value={searchQuery}
          placeholder="Search PDF"
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRunSearch();
            }
          }}
        />
        <IconButton
          label="Search PDF"
          disabled={artifact === null}
          onClick={onRunSearch}
        >
          <Search aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Source to PDF"
          disabled={artifact === null}
          onClick={onSourceToPdf}
        >
          <ChevronRight aria-hidden="true" size={15} />
        </IconButton>
        <IconButton label="Save PDF" disabled={artifact === null} onClick={onDownload}>
          <Save aria-hidden="true" size={15} />
        </IconButton>
      </div>
      <div className="pdf-canvas">
        {artifact === null ? (
          <div className="pdf-empty">
            <PanelRight aria-hidden="true" size={24} />
            <p>{buildRunning ? "Compiling..." : "Compile to preview the PDF."}</p>
          </div>
        ) : (
          <div className="pdf-page-wrap">
            <canvas
              ref={canvasRef}
              className="pdf-page-canvas"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onCanvasClick(
                  (event.clientX - rect.left) / scale,
                  (event.clientY - rect.top) / scale
                );
              }}
            />
            {syncTexTarget?.page === pageNumber &&
              syncTexTarget.x !== undefined &&
              syncTexTarget.y !== undefined && (
                <span
                  className="synctex-marker"
                  style={{
                    left: `${syncTexTarget.x * scale}px`,
                    top: `${syncTexTarget.y * scale}px`
                  }}
                  aria-hidden="true"
                />
              )}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentPane({
  activeFilePath,
  composerRef,
  events,
  mode,
  onAllowApproval,
  onCancel,
  onDenyApproval,
  onModeChange,
  onPromptChange,
  onProviderChange,
  onStart,
  prompt,
  providerAuthStatus,
  providerId,
  running,
  selectedText
}: {
  readonly activeFilePath: string | undefined;
  readonly composerRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly events: readonly AgentEvent[];
  readonly mode: AgentMode;
  readonly onAllowApproval: (sessionId: string, approvalId: string) => void;
  readonly onCancel: () => void;
  readonly onDenyApproval: (sessionId: string, approvalId: string) => void;
  readonly onModeChange: (mode: AgentMode) => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onProviderChange: (providerId: AgentProviderId) => void;
  readonly onStart: () => void;
  readonly prompt: string;
  readonly providerAuthStatus: AgentAuthStatus;
  readonly providerId: AgentProviderId;
  readonly running: boolean;
  readonly selectedText: string | null;
}) {
  return (
    <aside className="agent-pane" aria-label="AI agent">
      <div className="pane-title">
        <Bot aria-hidden="true" size={16} />
        <span>Agent</span>
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
            <option value="apply-with-review">Apply with review</option>
            <option value="suggest">Suggest edits</option>
            <option value="read-only">Read-only</option>
            <option value="autonomous-local" disabled>
              Autonomous local
            </option>
          </select>
        </label>
      </div>

      <div className={`provider-status ${providerAuthStatus.state}`}>
        <span>{formatAgentAuthState(providerAuthStatus.state)}</span>
        <p>{providerAuthStatus.message ?? getAgentProviderNote(providerId)}</p>
      </div>

      <div className="context-chips" aria-label="Agent context">
        <span>{activeFilePath ?? "No file"}</span>
        {selectedText !== null && <span>Selection</span>}
        <span>Diagnostics</span>
        <span>Project root</span>
      </div>

      <div className="agent-thread">
        {events.length === 0 ? (
          <>
            <MessageSquareText aria-hidden="true" size={17} />
            <p>Waiting for a project context.</p>
          </>
        ) : (
          events.map((event) => {
            const patchEvent = events.find(
              (candidate) =>
                candidate.sessionId === event.sessionId && candidate.type === "patch"
            );

            return (
              <AgentEventCard
                event={event}
                key={event.id}
                patchChangeSetId={
                  patchEvent?.type === "patch" ? patchEvent.changesetId : undefined
                }
                onAllowApproval={onAllowApproval}
                onDenyApproval={onDenyApproval}
              />
            );
          })
        )}
      </div>

      <div className="agent-composer">
        <textarea
          ref={composerRef}
          aria-label="Agent prompt"
          value={prompt}
          placeholder="Ask for a scoped edit"
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onStart();
            }
          }}
        />
        <div className="agent-composer-actions">
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
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}

function AgentEventCard({
  event,
  onAllowApproval,
  onDenyApproval,
  patchChangeSetId
}: {
  readonly event: AgentEvent;
  readonly onAllowApproval: (sessionId: string, approvalId: string) => void;
  readonly onDenyApproval: (sessionId: string, approvalId: string) => void;
  readonly patchChangeSetId: string | undefined;
}) {
  if (event.type === "message") {
    return (
      <article className="agent-event message">
        <strong>{event.role}</strong>
        <p>{event.content}</p>
      </article>
    );
  }

  if (event.type === "tool-call") {
    return (
      <article className="agent-event tool">
        <strong>
          {event.toolName} · {event.status}
        </strong>
        <p>{event.summary}</p>
        <span>{event.risk} risk</span>
      </article>
    );
  }

  if (event.type === "patch") {
    return (
      <article className="agent-event patch">
        <strong>{event.summary}</strong>
        <p>
          {event.filePath} · {event.status}
        </p>
      </article>
    );
  }

  if (event.type === "approval") {
    return (
      <article className="agent-event approval">
        <strong>
          {event.toolName} · {event.status}
        </strong>
        <p>{event.prompt}</p>
        <div className="agent-approval-actions">
          <button
            className="text-button"
            type="button"
            disabled={event.status !== "requested" || patchChangeSetId === undefined}
            onClick={() => onAllowApproval(event.sessionId, event.approvalId)}
          >
            <Check aria-hidden="true" size={15} />
            Allow
          </button>
          <button
            className="text-button"
            type="button"
            disabled={event.status !== "requested" || patchChangeSetId === undefined}
            onClick={() => onDenyApproval(event.sessionId, event.approvalId)}
          >
            <X aria-hidden="true" size={15} />
            Deny
          </button>
        </div>
      </article>
    );
  }

  if (event.type === "verification") {
    return (
      <article className="agent-event verification">
        <strong>Verification · {event.status}</strong>
        <p>{event.summary}</p>
      </article>
    );
  }

  return (
    <article className="agent-event error">
      <strong>Error</strong>
      <p>{event.message}</p>
    </article>
  );
}

function BottomPanel({
  activeTab,
  activeFile,
  activeFileDirty,
  auditEvents,
  buildResult,
  historyChangeSets,
  historyMessage,
  onApplyChangeSet,
  onCreateChangeSet,
  onActiveTabChange,
  onFixDiagnostic,
  onInsertCitation,
  onJumpToLine,
  onProjectSearchQueryChange,
  onReferenceSearchQueryChange,
  onRefreshReferences,
  onRejectChangeSet,
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
  readonly auditEvents: readonly AuditEvent[];
  readonly buildResult: BuildResult | null;
  readonly onActiveTabChange: (tab: BottomTab) => void;
  readonly historyChangeSets: readonly HistoryChangeSet[];
  readonly historyMessage: string;
  readonly onApplyChangeSet: (changesetId: string) => void;
  readonly onCreateChangeSet: () => void;
  readonly onFixDiagnostic: (diagnostic: LatexDiagnostic) => void;
  readonly onInsertCitation: (key: string) => void;
  readonly onJumpToLine: (line: number) => void;
  readonly onProjectSearchQueryChange: (query: string) => void;
  readonly onReferenceSearchQueryChange: (query: string) => void;
  readonly onRefreshReferences: () => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
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
            onInsertCitation={onInsertCitation}
            onQueryChange={onReferenceSearchQueryChange}
            onRefresh={onRefreshReferences}
            onRepairMissingCitation={onRepairMissingCitation}
            onRunSearch={onRunReferenceSearch}
            onSelectCitation={onSelectReferenceCitation}
            onSelectEntry={onSelectReferenceEntry}
            onSuggestCitations={onSuggestCitations}
          />
        )}
        {activeTab === "Outline" && (
          <OutlinePanel outline={outline} onJumpToLine={onJumpToLine} />
        )}
        {activeTab === "History" && (
          <HistoryPanel
            activeFile={activeFile}
            activeFileDirty={activeFileDirty}
            auditEvents={auditEvents}
            changesets={historyChangeSets}
            message={historyMessage}
            selectedChangeSetId={selectedChangeSetId}
            onApplyChangeSet={onApplyChangeSet}
            onCreateChangeSet={onCreateChangeSet}
            onRejectChangeSet={onRejectChangeSet}
            onRollbackChangeSet={onRollbackChangeSet}
            onSelectChangeSet={onSelectChangeSet}
            onSnapshotActiveFile={onSnapshotActiveFile}
          />
        )}
        {activeTab === "Log" && (
          <pre className="log-output">
            {buildResult === null || buildResult.rawLog.trim() === ""
              ? "No build log."
              : buildResult.rawLog}
          </pre>
        )}
        {activeTab === "Output" && (
          <pre className="log-output">
            {submissionCheckResult !== null
              ? formatSubmissionCheckResult(submissionCheckResult)
              : buildResult === null
                ? "No output."
                : `${buildResult.command.join(" ")}\n\n${buildResult.stdout}\n${buildResult.stderr}`}
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
  onInsertCitation,
  onQueryChange,
  onRefresh,
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
  readonly onInsertCitation: (key: string) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onRepairMissingCitation: (key: string) => void;
  readonly onRunSearch: () => void;
  readonly onSelectCitation: (citation: CitationOccurrence) => void;
  readonly onSelectEntry: (entry: BibliographyEntry) => void;
  readonly onSuggestCitations: () => void;
  readonly query: string;
  readonly results: readonly ReferenceSearchResult[];
}) {
  const visibleEntries = results.length > 0 ? results : analysis.entries.slice(0, 100);

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
                </article>
              ))
            )}
          </div>
        </section>

        <section className="reference-section" aria-label="Citation analysis">
          <h3>Missing</h3>
          <div className="result-list compact" role="list">
            {analysis.missingCitations.length === 0 ? (
              <p>No missing citations.</p>
            ) : (
              analysis.missingCitations.map((citation) => (
                <article
                  className="reference-row compact"
                  key={`${citation.filePath}:${citation.line}:${citation.key}`}
                >
                  <button type="button" onClick={() => onSelectCitation(citation)}>
                    <strong>{citation.key}</strong>
                    <span>
                      {citation.filePath}:{citation.line}
                    </span>
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onRepairMissingCitation(citation.key)}
                  >
                    <Sparkles aria-hidden="true" size={15} />
                    Agent
                  </button>
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
                <button
                  className="result-row"
                  key={`${entry.filePath}:${entry.key}`}
                  type="button"
                  onClick={() => onSelectEntry(entry)}
                >
                  <strong>{entry.key}</strong>
                  <span>{entry.title ?? `${entry.filePath}:${entry.line}`}</span>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function OutlinePanel({
  onJumpToLine,
  outline
}: {
  readonly onJumpToLine: (line: number) => void;
  readonly outline: readonly LatexOutlineItem[];
}) {
  return (
    <div className="result-list" role="list">
      {outline.length === 0 ? (
        <p>No outline for the active file.</p>
      ) : (
        outline.map((item) => (
          <button
            className="result-row"
            key={`${item.kind}:${item.line}:${item.title}`}
            type="button"
            onClick={() => onJumpToLine(item.line)}
          >
            <strong>
              {item.kind} · line {item.line}
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
  auditEvents,
  changesets,
  message,
  onApplyChangeSet,
  onCreateChangeSet,
  onRejectChangeSet,
  onRollbackChangeSet,
  onSelectChangeSet,
  onSnapshotActiveFile,
  selectedChangeSetId
}: {
  readonly activeFile: EditorFileState | null;
  readonly activeFileDirty: boolean;
  readonly auditEvents: readonly AuditEvent[];
  readonly changesets: readonly HistoryChangeSet[];
  readonly message: string;
  readonly onApplyChangeSet: (changesetId: string) => void;
  readonly onCreateChangeSet: () => void;
  readonly onRejectChangeSet: (changesetId: string) => void;
  readonly onRollbackChangeSet: (changesetId: string) => void;
  readonly onSelectChangeSet: (changesetId: string) => void;
  readonly onSnapshotActiveFile: () => void;
  readonly selectedChangeSetId: string | null;
}) {
  const selectedChangeSet =
    changesets.find((changeset) => changeset.id === selectedChangeSetId) ??
    changesets[0] ??
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
                    disabled={selectedChangeSet.status !== "proposed"}
                    onClick={() => onApplyChangeSet(selectedChangeSet.id)}
                  >
                    <Check aria-hidden="true" size={15} />
                    Apply
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
              <pre className="diff-output">{selectedChangeSet.patch}</pre>
            </>
          )}
        </div>
        <div className="audit-list" aria-label="Audit log">
          <strong>Audit</strong>
          {auditEvents.length === 0 ? (
            <p>No audit events.</p>
          ) : (
            auditEvents.slice(0, 8).map((event) => (
              <span key={event.id}>
                {event.eventType} · {event.message}
              </span>
            ))
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

  useEffect(() => {
    if (open) {
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
        aria-labelledby="command-palette-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
          }
        }}
      >
        <div className="palette-input-row">
          <CommandIcon aria-hidden="true" size={18} />
          <input
            ref={inputRef}
            aria-label="Command search"
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
        <div className="command-list" role="listbox">
          {commands.map((command) => (
            <button
              className="command-row"
              disabled={command.disabled}
              key={command.id}
              type="button"
              onClick={() => onRunCommand(command.id)}
            >
              <span>
                <strong>{command.title}</strong>
                <small>{command.group}</small>
              </span>
            </button>
          ))}
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
  agentAuthStatuses,
  agentMode,
  agentProviderId,
  appSettings,
  keybindingQuery,
  onActiveTabChange,
  onClearLocalHistory,
  onClose,
  onKeybindingQueryChange,
  onRefreshPrivacySummary,
  onRefreshAgentAuthStatuses,
  onSetAgentMode,
  onSetAgentProviderId,
  onSetCompiler,
  onSettingsChange,
  privacySummary,
  open
}: {
  readonly activeTab: SettingsTab;
  readonly agentAuthStatuses: AgentAuthStatusByProvider;
  readonly agentMode: AgentMode;
  readonly agentProviderId: AgentProviderId;
  readonly appSettings: AppSettings;
  readonly keybindingQuery: string;
  readonly onActiveTabChange: (tab: SettingsTab) => void;
  readonly onClearLocalHistory: () => void;
  readonly onClose: () => void;
  readonly onKeybindingQueryChange: (query: string) => void;
  readonly onRefreshPrivacySummary: () => void;
  readonly onRefreshAgentAuthStatuses: () => void;
  readonly onSetAgentMode: (mode: AgentMode) => void;
  readonly onSetAgentProviderId: (providerId: AgentProviderId) => void;
  readonly onSetCompiler: (compiler: LatexCompiler) => void;
  readonly onSettingsChange: (updater: (settings: AppSettings) => AppSettings) => void;
  readonly privacySummary: PrivacySummary | null;
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
            agentAuthStatuses={agentAuthStatuses}
            agentMode={agentMode}
            agentProviderId={agentProviderId}
            keybindingQuery={keybindingQuery}
            privacySummary={privacySummary}
            settings={appSettings}
            tab={activeTab}
            onClearLocalHistory={onClearLocalHistory}
            onKeybindingQueryChange={onKeybindingQueryChange}
            onRefreshPrivacySummary={onRefreshPrivacySummary}
            onRefreshAgentAuthStatuses={onRefreshAgentAuthStatuses}
            onSetAgentMode={onSetAgentMode}
            onSetAgentProviderId={onSetAgentProviderId}
            onSetCompiler={onSetCompiler}
            onSettingsChange={onSettingsChange}
          />
        </div>
      </section>
    </div>
  );
}

function SettingsTabPanel({
  agentAuthStatuses,
  agentMode,
  agentProviderId,
  keybindingQuery,
  onClearLocalHistory,
  onKeybindingQueryChange,
  onRefreshPrivacySummary,
  onRefreshAgentAuthStatuses,
  onSetAgentMode,
  onSetAgentProviderId,
  onSetCompiler,
  onSettingsChange,
  privacySummary,
  settings,
  tab
}: {
  readonly agentAuthStatuses: AgentAuthStatusByProvider;
  readonly agentMode: AgentMode;
  readonly agentProviderId: AgentProviderId;
  readonly keybindingQuery: string;
  readonly onClearLocalHistory: () => void;
  readonly onKeybindingQueryChange: (query: string) => void;
  readonly onRefreshPrivacySummary: () => void;
  readonly onRefreshAgentAuthStatuses: () => void;
  readonly onSetAgentMode: (mode: AgentMode) => void;
  readonly onSetAgentProviderId: (providerId: AgentProviderId) => void;
  readonly onSetCompiler: (compiler: LatexCompiler) => void;
  readonly onSettingsChange: (updater: (settings: AppSettings) => AppSettings) => void;
  readonly privacySummary: PrivacySummary | null;
  readonly settings: AppSettings;
  readonly tab: SettingsTab;
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
        </>
      )}
      {tab === "AI Providers" && (
        <>
          {agentProviderIds.map((providerId) => (
            <ProviderSettingsRow
              authStatus={agentAuthStatuses[providerId]}
              credentialStatus={settings.credentials.find(
                (credential) => credential.providerId === providerId
              )}
              key={providerId}
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
            onClick={onRefreshAgentAuthStatuses}
          >
            <RefreshCw aria-hidden="true" size={15} />
            Refresh provider status
          </button>
        </>
      )}
      {tab === "Agent Permissions" && (
        <>
          <SelectField
            label="Default mode"
            value={agentMode}
            options={[
              ["read-only", "Read only"],
              ["suggest", "Suggest"],
              ["apply-with-review", "Apply with review"],
              ["autonomous-local", "Autonomous local"]
            ]}
            onChange={(value) => onSetAgentMode(value as AgentMode)}
          />
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
  credentialStatus,
  providerId
}: {
  readonly authStatus: AgentAuthStatus;
  readonly credentialStatus: AppSettings["credentials"][number] | undefined;
  readonly providerId: AgentProviderId;
}) {
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
      {credentialStatus !== undefined && <p>{credentialStatus.message}</p>}
    </section>
  );
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

function IconButton({
  children,
  disabled = false,
  label,
  onClick,
  pressed = false
}: {
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick?: () => void;
  readonly pressed?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

let monacoConfigured = false;
let citationCompletions: readonly BibliographyEntry[] = [];

const latexSnippets = [
  {
    label: "section",
    insertText: "\\section{${1:Title}}\n$0",
    documentation: "Insert a section heading"
  },
  {
    label: "subsection",
    insertText: "\\subsection{${1:Title}}\n$0",
    documentation: "Insert a subsection heading"
  },
  {
    label: "figure",
    insertText:
      "\\begin{figure}[ht]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${1:path}}\n\\caption{${2:Caption}}\n\\label{fig:${3:label}}\n\\end{figure}\n$0",
    documentation: "Insert a figure environment"
  },
  {
    label: "equation",
    insertText:
      "\\begin{equation}\n${1:E = mc^2}\n\\label{eq:${2:label}}\n\\end{equation}\n$0",
    documentation: "Insert an equation environment"
  },
  {
    label: "cite",
    insertText: "\\cite{${1:key}}",
    documentation: "Insert a citation command"
  }
] as const;

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

      const citationSuggestions = citationCompletions.map((entry) => ({
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
          ...citationSuggestions
        ]
      };
    }
  };

  monaco.languages.registerCompletionItemProvider("latex", completionProvider);
}

function updateMonacoCitationCompletions(entries: readonly BibliographyEntry[]) {
  citationCompletions = entries;
}

function focusMonacoFind(editor: MonacoStandaloneEditor | null) {
  void editor?.getAction("actions.find")?.run();
}

function focusMonacoReplace(editor: MonacoStandaloneEditor | null) {
  void editor?.getAction("editor.action.startFindReplaceAction")?.run();
}

function formatMonacoDocument(editor: MonacoStandaloneEditor | null) {
  void editor?.getAction("editor.action.formatDocument")?.run();
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

function getAgentProviderNote(providerId: AgentProviderId): string {
  switch (providerId) {
    case "mock":
      return "Local deterministic provider for workflow testing.";
    case "openai-codex":
      return "Uses the installed Codex CLI in read-only exec mode, then proposes reviewable patches.";
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function getBaseName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function getSiblingProjectPath(path: string, newName: string) {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return [...segments, newName].join("/");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Project operation failed.";
}
