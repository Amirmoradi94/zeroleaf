export const ipcChannels = {
  appGetInfo: "app.getInfo",
  workbenchLoadLayout: "workbench.loadLayout",
  workbenchSaveLayout: "workbench.saveLayout",
  editorLoadProjectState: "editor.loadProjectState",
  editorSaveProjectState: "editor.saveProjectState",
  projectGetState: "project.getState",
  projectOpen: "project.open",
  projectOpenRecent: "project.openRecent",
  projectRefresh: "project.refresh",
  projectCreateEntry: "project.createEntry",
  projectRenameEntry: "project.renameEntry",
  projectMoveEntry: "project.moveEntry",
  projectDeleteEntry: "project.deleteEntry",
  projectSetMainFile: "project.setMainFile",
  projectChanged: "project.changed",
  fileRead: "file.read",
  fileWrite: "file.write",
  buildDetectToolchain: "build.detectToolchain",
  buildRun: "build.run",
  buildStop: "build.stop",
  pdfReadArtifact: "pdf.readArtifact",
  synctexForward: "synctex.forward",
  synctexReverse: "synctex.reverse",
  historyListChangeSets: "history.listChangeSets",
  historySnapshotFile: "history.snapshotFile",
  historyCreateChangeSet: "history.createChangeSet",
  historyApplyChangeSet: "history.applyChangeSet",
  historyRejectChangeSet: "history.rejectChangeSet",
  historyRollbackChangeSet: "history.rollbackChangeSet",
  historyListAuditEvents: "history.listAuditEvents",
  referencesAnalyze: "references.analyze",
  referencesSearch: "references.search",
  lifecycleListTemplates: "lifecycle.listTemplates",
  lifecycleExportSourceZip: "lifecycle.exportSourceZip",
  lifecycleExportPdf: "lifecycle.exportPdf",
  lifecycleImportSourceZip: "lifecycle.importSourceZip",
  lifecycleCreateFromTemplate: "lifecycle.createFromTemplate",
  lifecycleCheckSubmission: "lifecycle.checkSubmission",
  settingsLoad: "settings.load",
  settingsSave: "settings.save",
  settingsGetPrivacySummary: "settings.getPrivacySummary",
  settingsClearLocalHistory: "settings.clearLocalHistory",
  agentGetAuthStatus: "agent.getAuthStatus",
  agentStart: "agent.start",
  agentRespondApproval: "agent.respondApproval",
  agentCancel: "agent.cancel"
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

export type AppInfo = {
  readonly appName: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
};

export type WorkbenchLayout = {
  readonly sidebarWidth: number;
  readonly pdfWidth: number;
  readonly agentWidth: number;
  readonly bottomPanelHeight: number;
};

export type EditorProjectState = {
  readonly projectRoot: string;
  readonly openFilePaths: readonly string[];
  readonly activeFilePath?: string;
};

export const defaultWorkbenchLayout: WorkbenchLayout = {
  sidebarWidth: 280,
  pdfWidth: 420,
  agentWidth: 320,
  bottomPanelHeight: 220
};

export type ProjectSummary = {
  readonly rootPath: string;
  readonly displayName: string;
  readonly mainFilePath?: string;
};

export type RecentProject = ProjectSummary & {
  readonly lastOpenedAt: string;
};

export type ProjectFileKind = "directory" | "file";

export type ProjectFileTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly kind: ProjectFileKind;
  readonly children?: readonly ProjectFileTreeNode[];
};

export type ProjectOpenResult = {
  readonly project: ProjectSummary;
  readonly tree: readonly ProjectFileTreeNode[];
  readonly recentProjects: readonly RecentProject[];
};

export type ProjectState = {
  readonly recentProjects: readonly RecentProject[];
};

export type ProjectEntryKind = "directory" | "file";

export type ProjectFileSnapshot = {
  readonly path: string;
  readonly contents: string;
  readonly mtimeMs: number;
};

export type ProjectChangeEvent = {
  readonly projectRoot: string;
  readonly paths: readonly string[];
};

export type LatexCompiler = "pdflatex" | "xelatex" | "lualatex";

export type BuildStatus = "running" | "succeeded" | "failed" | "cancelled";

export type LatexToolchainStatus = {
  readonly latexmkAvailable: boolean;
  readonly synctexAvailable: boolean;
  readonly latexmkVersion?: string;
  readonly availableCompilers: readonly LatexCompiler[];
};

export type LatexDiagnosticSeverity = "error" | "warning";

export type LatexDiagnostic = {
  readonly severity: LatexDiagnosticSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly message: string;
};

export type PdfArtifact = {
  readonly pdfPath: string;
  readonly synctexPath?: string;
  readonly updatedAt: string;
  readonly byteLength: number;
};

export type BuildRunRequest = {
  readonly jobId?: string;
  readonly projectRoot: string;
  readonly mainFilePath: string;
  readonly compiler: LatexCompiler;
};

export type BuildResult = {
  readonly jobId: string;
  readonly status: BuildStatus;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact?: PdfArtifact;
};

export type PdfArtifactData = PdfArtifact & {
  readonly dataUrl: string;
};

export type SyncTexForwardRequest = {
  readonly projectRoot: string;
  readonly sourceFilePath: string;
  readonly line: number;
  readonly column: number;
  readonly pdfPath: string;
};

export type SyncTexForwardResult = {
  readonly available: boolean;
  readonly page?: number;
  readonly x?: number;
  readonly y?: number;
  readonly message?: string;
};

export type SyncTexReverseRequest = {
  readonly projectRoot: string;
  readonly pdfPath: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
};

export type SyncTexReverseResult = {
  readonly available: boolean;
  readonly sourceFilePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message?: string;
};

export type HistoryChangeSetStatus =
  | "proposed"
  | "applied"
  | "rejected"
  | "reverted"
  | "failed";

export type HistorySnapshot = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly contentHash: string;
  readonly createdAt: string;
};

export type HistoryChangeSet = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly summary: string;
  readonly patch: string;
  readonly status: HistoryChangeSetStatus;
  readonly baseSnapshotId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly revertedAt?: string;
};

export type AuditEvent = {
  readonly id: string;
  readonly projectRoot: string;
  readonly eventType: string;
  readonly message: string;
  readonly createdAt: string;
  readonly changesetId?: string;
};

export type BibliographyEntry = {
  readonly type: string;
  readonly key: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
  readonly doi?: string;
  readonly venue?: string;
  readonly filePath: string;
  readonly line: number;
  readonly raw: string;
};

export type CitationOccurrence = {
  readonly key: string;
  readonly command: string;
  readonly filePath: string;
  readonly line: number;
};

export type ReferenceAnalysis = {
  readonly entries: readonly BibliographyEntry[];
  readonly citations: readonly CitationOccurrence[];
  readonly missingCitations: readonly CitationOccurrence[];
  readonly unusedEntries: readonly BibliographyEntry[];
};

export type ReferenceSearchResult = BibliographyEntry & {
  readonly score: number;
};

export type ProjectTemplateId = "article" | "report" | "thesis" | "beamer" | "cv";

export type ProjectTemplate = {
  readonly id: ProjectTemplateId;
  readonly name: string;
  readonly description: string;
};

export type ExportSourceZipResult = {
  readonly archivePath: string;
  readonly fileCount: number;
  readonly byteLength: number;
};

export type ExportPdfResult = {
  readonly pdfPath: string;
  readonly destinationPath: string;
  readonly byteLength: number;
};

export type SubmissionCheckSeverity = "error" | "warning" | "info";

export type SubmissionCheckItem = {
  readonly severity: SubmissionCheckSeverity;
  readonly message: string;
  readonly filePath?: string;
};

export type SubmissionCheckResult = {
  readonly checkedAt: string;
  readonly items: readonly SubmissionCheckItem[];
};

export type AgentProviderId = "mock" | "openai-codex" | "anthropic-claude";

export type AgentMode =
  | "read-only"
  | "suggest"
  | "apply-with-review"
  | "autonomous-local";

export type AgentAuthStatus = {
  readonly providerId: AgentProviderId;
  readonly state: "connected" | "disconnected" | "needs-auth" | "error";
  readonly message?: string;
};

export type AgentToolName =
  | "read-file"
  | "search-project"
  | "codex-exec"
  | "claude-code"
  | "propose-patch"
  | "apply-patch"
  | "run-compile";

export type AgentToolRisk = "low" | "medium" | "high";

export type AgentEventBase = {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
};

export type AgentMessageEvent = AgentEventBase & {
  readonly type: "message";
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
};

export type AgentToolCallEvent = AgentEventBase & {
  readonly type: "tool-call";
  readonly toolName: AgentToolName;
  readonly status: "running" | "succeeded" | "failed" | "blocked";
  readonly summary: string;
  readonly risk: AgentToolRisk;
};

export type AgentPatchEvent = AgentEventBase & {
  readonly type: "patch";
  readonly changesetId: string;
  readonly filePath: string;
  readonly summary: string;
  readonly status: HistoryChangeSetStatus;
};

export type AgentApprovalEvent = AgentEventBase & {
  readonly type: "approval";
  readonly approvalId: string;
  readonly toolName: AgentToolName;
  readonly risk: AgentToolRisk;
  readonly prompt: string;
  readonly status: "requested" | "allowed" | "denied";
};

export type AgentVerificationEvent = AgentEventBase & {
  readonly type: "verification";
  readonly status: "pending" | "running" | "passed" | "failed";
  readonly summary: string;
  readonly buildJobId?: string;
};

export type AgentErrorEvent = AgentEventBase & {
  readonly type: "error";
  readonly message: string;
  readonly recoverable: boolean;
};

export type AgentEvent =
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentPatchEvent
  | AgentApprovalEvent
  | AgentVerificationEvent
  | AgentErrorEvent;

export type AgentStartRequest = {
  readonly providerId: AgentProviderId;
  readonly mode: AgentMode;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly activeFilePath?: string;
  readonly selectedText?: string;
  readonly mainFilePath?: string;
  readonly compiler?: LatexCompiler;
  readonly diagnostic?: LatexDiagnostic;
};

export type AgentSessionStatus =
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentApprovalResponseRequest = {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: "allowed" | "denied";
};

export type AgentSessionResult = {
  readonly sessionId: string;
  readonly providerId: AgentProviderId;
  readonly status: AgentSessionStatus;
  readonly events: readonly AgentEvent[];
  readonly changeset?: HistoryChangeSet;
  readonly buildResult?: BuildResult;
};

export type EditorPreferences = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly autocomplete: boolean;
  readonly minimap: boolean;
};

export type CompilerPreferences = {
  readonly compiler: LatexCompiler;
  readonly buildProfile: "draft" | "normal" | "synctex";
  readonly texPath: string;
  readonly shellEscape: false;
};

export type AgentPermissionPreferences = {
  readonly defaultProviderId: AgentProviderId;
  readonly defaultMode: AgentMode;
  readonly compileAfterPatch: boolean;
  readonly requireApprovalForPatches: boolean;
  readonly networkPolicy: "blocked" | "ask";
  readonly maxTurns: number;
};

export type AppearancePreferences = {
  readonly density: "compact" | "comfortable";
  readonly accent: "teal" | "blue" | "green";
  readonly highContrastLight: boolean;
};

export type PrivacyPreferences = {
  readonly storeAgentTranscripts: boolean;
  readonly storeBuildLogs: boolean;
};

export type CredentialStorageStatus = {
  readonly providerId: AgentProviderId;
  readonly storage: "external-cli-login" | "none";
  readonly storesSecretInApp: boolean;
  readonly message: string;
};

export type AppSettings = {
  readonly editor: EditorPreferences;
  readonly compiler: CompilerPreferences;
  readonly agentPermissions: AgentPermissionPreferences;
  readonly appearance: AppearancePreferences;
  readonly privacy: PrivacyPreferences;
  readonly credentials: readonly CredentialStorageStatus[];
};

export const defaultAppSettings: AppSettings = {
  editor: {
    fontFamily: "Monaco, SFMono-Regular, Consolas, monospace",
    fontSize: 14,
    lineHeight: 22,
    autocomplete: true,
    minimap: false
  },
  compiler: {
    compiler: "pdflatex",
    buildProfile: "synctex",
    texPath: "",
    shellEscape: false
  },
  agentPermissions: {
    defaultProviderId: "mock",
    defaultMode: "apply-with-review",
    compileAfterPatch: true,
    requireApprovalForPatches: true,
    networkPolicy: "blocked",
    maxTurns: 4
  },
  appearance: {
    density: "comfortable",
    accent: "teal",
    highContrastLight: false
  },
  privacy: {
    storeAgentTranscripts: true,
    storeBuildLogs: true
  },
  credentials: [
    {
      providerId: "mock",
      storage: "none",
      storesSecretInApp: false,
      message: "Mock provider does not require credentials."
    },
    {
      providerId: "openai-codex",
      storage: "external-cli-login",
      storesSecretInApp: false,
      message: "Uses the installed Codex CLI login on this computer."
    },
    {
      providerId: "anthropic-claude",
      storage: "external-cli-login",
      storesSecretInApp: false,
      message: "Uses the installed Claude Code CLI login on this computer."
    }
  ]
};

export type PrivacySummary = {
  readonly dataLocation: string;
  readonly projectCount: number;
  readonly snapshotCount: number;
  readonly changesetCount: number;
  readonly auditEventCount: number;
  readonly buildJobCount: number;
  readonly agentSessionCount: number;
};

export type IpcRequestMap = {
  readonly [ipcChannels.appGetInfo]: undefined;
  readonly [ipcChannels.workbenchLoadLayout]: undefined;
  readonly [ipcChannels.workbenchSaveLayout]: WorkbenchLayout;
  readonly [ipcChannels.editorLoadProjectState]: { readonly projectRoot: string };
  readonly [ipcChannels.editorSaveProjectState]: EditorProjectState;
  readonly [ipcChannels.projectGetState]: undefined;
  readonly [ipcChannels.projectOpen]: undefined;
  readonly [ipcChannels.projectOpenRecent]: { readonly rootPath: string };
  readonly [ipcChannels.projectRefresh]: { readonly projectRoot: string };
  readonly [ipcChannels.projectCreateEntry]: {
    readonly projectRoot: string;
    readonly parentPath: string;
    readonly name: string;
    readonly kind: ProjectEntryKind;
  };
  readonly [ipcChannels.projectRenameEntry]: {
    readonly projectRoot: string;
    readonly path: string;
    readonly newName: string;
  };
  readonly [ipcChannels.projectMoveEntry]: {
    readonly projectRoot: string;
    readonly path: string;
    readonly newPath: string;
  };
  readonly [ipcChannels.projectDeleteEntry]: {
    readonly projectRoot: string;
    readonly path: string;
  };
  readonly [ipcChannels.projectSetMainFile]: {
    readonly projectRoot: string;
    readonly path: string;
  };
  readonly [ipcChannels.projectChanged]: ProjectChangeEvent;
  readonly [ipcChannels.fileRead]: {
    readonly projectRoot: string;
    readonly path: string;
  };
  readonly [ipcChannels.fileWrite]: {
    readonly projectRoot: string;
    readonly path: string;
    readonly contents: string;
  };
  readonly [ipcChannels.buildDetectToolchain]: undefined;
  readonly [ipcChannels.buildRun]: BuildRunRequest;
  readonly [ipcChannels.buildStop]: { readonly jobId: string };
  readonly [ipcChannels.pdfReadArtifact]: {
    readonly projectRoot: string;
    readonly pdfPath: string;
  };
  readonly [ipcChannels.synctexForward]: SyncTexForwardRequest;
  readonly [ipcChannels.synctexReverse]: SyncTexReverseRequest;
  readonly [ipcChannels.historyListChangeSets]: { readonly projectRoot: string };
  readonly [ipcChannels.historySnapshotFile]: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly contents?: string;
  };
  readonly [ipcChannels.historyCreateChangeSet]: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly beforeContents: string;
    readonly afterContents: string;
    readonly summary: string;
  };
  readonly [ipcChannels.historyApplyChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyRejectChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyRollbackChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyListAuditEvents]: { readonly projectRoot: string };
  readonly [ipcChannels.referencesAnalyze]: { readonly projectRoot: string };
  readonly [ipcChannels.referencesSearch]: {
    readonly projectRoot: string;
    readonly query: string;
  };
  readonly [ipcChannels.lifecycleListTemplates]: undefined;
  readonly [ipcChannels.lifecycleExportSourceZip]: {
    readonly projectRoot: string;
    readonly includeBuildArtifacts?: boolean;
  };
  readonly [ipcChannels.lifecycleExportPdf]: {
    readonly projectRoot: string;
    readonly pdfPath: string;
  };
  readonly [ipcChannels.lifecycleImportSourceZip]: undefined;
  readonly [ipcChannels.lifecycleCreateFromTemplate]: {
    readonly templateId: ProjectTemplateId;
    readonly projectName: string;
  };
  readonly [ipcChannels.lifecycleCheckSubmission]: {
    readonly projectRoot: string;
    readonly mainFilePath?: string;
  };
  readonly [ipcChannels.settingsLoad]: undefined;
  readonly [ipcChannels.settingsSave]: AppSettings;
  readonly [ipcChannels.settingsGetPrivacySummary]: undefined;
  readonly [ipcChannels.settingsClearLocalHistory]: undefined;
  readonly [ipcChannels.agentGetAuthStatus]: { readonly providerId: AgentProviderId };
  readonly [ipcChannels.agentStart]: AgentStartRequest;
  readonly [ipcChannels.agentRespondApproval]: AgentApprovalResponseRequest;
  readonly [ipcChannels.agentCancel]: { readonly sessionId: string };
};

export type IpcResponseMap = {
  readonly [ipcChannels.appGetInfo]: AppInfo;
  readonly [ipcChannels.workbenchLoadLayout]: WorkbenchLayout;
  readonly [ipcChannels.workbenchSaveLayout]: WorkbenchLayout;
  readonly [ipcChannels.editorLoadProjectState]: EditorProjectState;
  readonly [ipcChannels.editorSaveProjectState]: EditorProjectState;
  readonly [ipcChannels.projectGetState]: ProjectState;
  readonly [ipcChannels.projectOpen]: ProjectOpenResult | undefined;
  readonly [ipcChannels.projectOpenRecent]: ProjectOpenResult;
  readonly [ipcChannels.projectRefresh]: ProjectOpenResult;
  readonly [ipcChannels.projectCreateEntry]: ProjectOpenResult;
  readonly [ipcChannels.projectRenameEntry]: ProjectOpenResult;
  readonly [ipcChannels.projectMoveEntry]: ProjectOpenResult;
  readonly [ipcChannels.projectDeleteEntry]: ProjectOpenResult;
  readonly [ipcChannels.projectSetMainFile]: ProjectOpenResult;
  readonly [ipcChannels.projectChanged]: undefined;
  readonly [ipcChannels.fileRead]: ProjectFileSnapshot;
  readonly [ipcChannels.fileWrite]: {
    readonly saved: true;
    readonly mtimeMs: number;
  };
  readonly [ipcChannels.buildDetectToolchain]: LatexToolchainStatus;
  readonly [ipcChannels.buildRun]: BuildResult;
  readonly [ipcChannels.buildStop]: { readonly stopped: boolean };
  readonly [ipcChannels.pdfReadArtifact]: PdfArtifactData;
  readonly [ipcChannels.synctexForward]: SyncTexForwardResult;
  readonly [ipcChannels.synctexReverse]: SyncTexReverseResult;
  readonly [ipcChannels.historyListChangeSets]: readonly HistoryChangeSet[];
  readonly [ipcChannels.historySnapshotFile]: HistorySnapshot;
  readonly [ipcChannels.historyCreateChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyApplyChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyRejectChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyRollbackChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyListAuditEvents]: readonly AuditEvent[];
  readonly [ipcChannels.referencesAnalyze]: ReferenceAnalysis;
  readonly [ipcChannels.referencesSearch]: readonly ReferenceSearchResult[];
  readonly [ipcChannels.lifecycleListTemplates]: readonly ProjectTemplate[];
  readonly [ipcChannels.lifecycleExportSourceZip]: ExportSourceZipResult | undefined;
  readonly [ipcChannels.lifecycleExportPdf]: ExportPdfResult | undefined;
  readonly [ipcChannels.lifecycleImportSourceZip]: ProjectOpenResult | undefined;
  readonly [ipcChannels.lifecycleCreateFromTemplate]: ProjectOpenResult | undefined;
  readonly [ipcChannels.lifecycleCheckSubmission]: SubmissionCheckResult;
  readonly [ipcChannels.settingsLoad]: AppSettings;
  readonly [ipcChannels.settingsSave]: AppSettings;
  readonly [ipcChannels.settingsGetPrivacySummary]: PrivacySummary;
  readonly [ipcChannels.settingsClearLocalHistory]: PrivacySummary;
  readonly [ipcChannels.agentGetAuthStatus]: AgentAuthStatus;
  readonly [ipcChannels.agentStart]: AgentSessionResult;
  readonly [ipcChannels.agentRespondApproval]: AgentSessionResult;
  readonly [ipcChannels.agentCancel]: { readonly cancelled: boolean };
};

export type IpcRequest<TChannel extends IpcChannel = IpcChannel> = {
  readonly channel: TChannel;
  readonly payload: IpcRequestMap[TChannel];
};

export type IpcInvoke = <TChannel extends IpcChannel>(
  channel: TChannel,
  payload: IpcRequestMap[TChannel]
) => Promise<IpcResponseMap[TChannel]>;

export type DesktopApi = {
  readonly app: {
    readonly getInfo: () => Promise<AppInfo>;
  };
  readonly workbench: {
    readonly loadLayout: () => Promise<WorkbenchLayout>;
    readonly saveLayout: (layout: WorkbenchLayout) => Promise<WorkbenchLayout>;
  };
  readonly editor: {
    readonly loadProjectState: (projectRoot: string) => Promise<EditorProjectState>;
    readonly saveProjectState: (
      state: EditorProjectState
    ) => Promise<EditorProjectState>;
  };
  readonly project: {
    readonly getState: () => Promise<ProjectState>;
    readonly open: () => Promise<ProjectOpenResult | undefined>;
    readonly openRecent: (rootPath: string) => Promise<ProjectOpenResult>;
    readonly refresh: (projectRoot: string) => Promise<ProjectOpenResult>;
    readonly createEntry: (
      request: IpcRequestMap[typeof ipcChannels.projectCreateEntry]
    ) => Promise<ProjectOpenResult>;
    readonly renameEntry: (
      request: IpcRequestMap[typeof ipcChannels.projectRenameEntry]
    ) => Promise<ProjectOpenResult>;
    readonly moveEntry: (
      request: IpcRequestMap[typeof ipcChannels.projectMoveEntry]
    ) => Promise<ProjectOpenResult>;
    readonly deleteEntry: (
      request: IpcRequestMap[typeof ipcChannels.projectDeleteEntry]
    ) => Promise<ProjectOpenResult>;
    readonly setMainFile: (
      request: IpcRequestMap[typeof ipcChannels.projectSetMainFile]
    ) => Promise<ProjectOpenResult>;
    readonly onChanged: (callback: (event: ProjectChangeEvent) => void) => () => void;
  };
  readonly files: {
    readonly read: (
      request: IpcRequestMap[typeof ipcChannels.fileRead]
    ) => Promise<ProjectFileSnapshot>;
    readonly write: (
      request: IpcRequestMap[typeof ipcChannels.fileWrite]
    ) => Promise<IpcResponseMap[typeof ipcChannels.fileWrite]>;
  };
  readonly build: {
    readonly detectToolchain: () => Promise<LatexToolchainStatus>;
    readonly run: (request: BuildRunRequest) => Promise<BuildResult>;
    readonly stop: (jobId: string) => Promise<{ readonly stopped: boolean }>;
  };
  readonly pdf: {
    readonly readArtifact: (
      request: IpcRequestMap[typeof ipcChannels.pdfReadArtifact]
    ) => Promise<PdfArtifactData>;
  };
  readonly synctex: {
    readonly forward: (request: SyncTexForwardRequest) => Promise<SyncTexForwardResult>;
    readonly reverse: (request: SyncTexReverseRequest) => Promise<SyncTexReverseResult>;
  };
  readonly history: {
    readonly listChangeSets: (
      request: IpcRequestMap[typeof ipcChannels.historyListChangeSets]
    ) => Promise<readonly HistoryChangeSet[]>;
    readonly snapshotFile: (
      request: IpcRequestMap[typeof ipcChannels.historySnapshotFile]
    ) => Promise<HistorySnapshot>;
    readonly createChangeSet: (
      request: IpcRequestMap[typeof ipcChannels.historyCreateChangeSet]
    ) => Promise<HistoryChangeSet>;
    readonly applyChangeSet: (changesetId: string) => Promise<HistoryChangeSet>;
    readonly rejectChangeSet: (changesetId: string) => Promise<HistoryChangeSet>;
    readonly rollbackChangeSet: (changesetId: string) => Promise<HistoryChangeSet>;
    readonly listAuditEvents: (
      request: IpcRequestMap[typeof ipcChannels.historyListAuditEvents]
    ) => Promise<readonly AuditEvent[]>;
  };
  readonly references: {
    readonly analyze: (
      request: IpcRequestMap[typeof ipcChannels.referencesAnalyze]
    ) => Promise<ReferenceAnalysis>;
    readonly search: (
      request: IpcRequestMap[typeof ipcChannels.referencesSearch]
    ) => Promise<readonly ReferenceSearchResult[]>;
  };
  readonly lifecycle: {
    readonly listTemplates: () => Promise<readonly ProjectTemplate[]>;
    readonly exportSourceZip: (
      request: IpcRequestMap[typeof ipcChannels.lifecycleExportSourceZip]
    ) => Promise<ExportSourceZipResult | undefined>;
    readonly exportPdf: (
      request: IpcRequestMap[typeof ipcChannels.lifecycleExportPdf]
    ) => Promise<ExportPdfResult | undefined>;
    readonly importSourceZip: () => Promise<ProjectOpenResult | undefined>;
    readonly createFromTemplate: (
      request: IpcRequestMap[typeof ipcChannels.lifecycleCreateFromTemplate]
    ) => Promise<ProjectOpenResult | undefined>;
    readonly checkSubmission: (
      request: IpcRequestMap[typeof ipcChannels.lifecycleCheckSubmission]
    ) => Promise<SubmissionCheckResult>;
  };
  readonly settings: {
    readonly load: () => Promise<AppSettings>;
    readonly save: (settings: AppSettings) => Promise<AppSettings>;
    readonly getPrivacySummary: () => Promise<PrivacySummary>;
    readonly clearLocalHistory: () => Promise<PrivacySummary>;
  };
  readonly agent: {
    readonly getAuthStatus: (providerId: AgentProviderId) => Promise<AgentAuthStatus>;
    readonly start: (request: AgentStartRequest) => Promise<AgentSessionResult>;
    readonly respondApproval: (
      request: AgentApprovalResponseRequest
    ) => Promise<AgentSessionResult>;
    readonly cancel: (sessionId: string) => Promise<{ readonly cancelled: boolean }>;
  };
};
