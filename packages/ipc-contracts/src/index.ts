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
  historyCreateAppliedChangeSet: "history.createAppliedChangeSet",
  historyApplyChangeSet: "history.applyChangeSet",
  historyApplyChangeSetHunks: "history.applyChangeSetHunks",
  historyRejectChangeSet: "history.rejectChangeSet",
  historyRollbackChangeSet: "history.rollbackChangeSet",
  historyListAuditEvents: "history.listAuditEvents",
  referencesAnalyze: "references.analyze",
  referencesSearch: "references.search",
  referencesRemoveUnused: "references.removeUnused",
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
  agentCancel: "agent.cancel",
  agentEvent: "agent.event"
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
  sidebarWidth: 240,
  pdfWidth: 560,
  agentWidth: 360,
  bottomPanelHeight: 180
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

export type ProjectDeleteBackup = {
  readonly deletedPath: string;
  readonly backupPath: string;
  readonly deletedAt: string;
};

export type ProjectDeleteResult = ProjectOpenResult & {
  readonly deletedEntry: ProjectDeleteBackup;
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

export type ShellEscapePolicy = {
  readonly enabled: false;
  readonly commandFlag: "-no-shell-escape";
  readonly approvalRequiredToEnable: true;
  readonly agentMayEnable: false;
  readonly message: string;
};

export type BuildSecurityPolicy = {
  readonly shellEscape: ShellEscapePolicy;
};

export type BuildResult = {
  readonly jobId: string;
  readonly status: BuildStatus;
  readonly compiler: LatexCompiler;
  readonly command: readonly string[];
  readonly securityPolicy: BuildSecurityPolicy;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly rawLogTruncated?: boolean;
  readonly rawLogBytes?: number;
  readonly rawLogOriginalBytes?: number;
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

export type RemoveUnusedReferenceResult = {
  readonly removedEntry: BibliographyEntry;
  readonly analysis: ReferenceAnalysis;
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
  readonly includedBuildArtifacts: boolean;
};

export type ExportPdfResult = {
  readonly pdfPath: string;
  readonly destinationPath: string;
  readonly byteLength: number;
  readonly openedInViewer?: boolean;
  readonly viewerOpenError?: string;
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
  | "move-entry"
  | "set-main-file"
  | "network-fetch"
  | "codex-exec"
  | "claude-code"
  | "propose-patch"
  | "reject-patch"
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
  readonly sessionId?: string;
  readonly maxTurns?: number;
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
  readonly changesets?: readonly HistoryChangeSet[];
  readonly moveEntries?: readonly AgentMoveEntryOperation[];
  readonly buildResult?: BuildResult;
};

export type AgentMoveEntryOperation = {
  readonly fromPath: string;
  readonly toPath: string;
};

export function createReadOnlyAgentExplanation(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  const target = request.diagnostic?.filePath ?? snapshot.path;
  const location = formatDiagnosticLocation(request.diagnostic);
  const selection = formatSelectedLatexContext(request.selectedText);
  const lines = [
    ...(selection === undefined
      ? []
      : [
          "I am limiting this answer to the selected LaTeX and the explicitly attached project context.",
          selection
        ]),
    request.diagnostic === undefined
      ? `For ${target}, I would treat this as an explanation-only review of the selected project context.`
      : `The attached LaTeX ${request.diagnostic.severity}${location} says: "${request.diagnostic.message}"`,
    request.selectedText === undefined
      ? ""
      : explainSelectedLatex(request.selectedText),
    explainLatexDiagnostic(request.diagnostic)
  ];

  return lines.filter((line) => line.length > 0).join("\n\n");
}

export type ReadOnlyInspectionBroker = {
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
};

export async function createReadOnlyAgentResponse(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const inspection = await createProjectInspectionResponse(request, snapshot, broker);
  return inspection ?? createReadOnlyAgentExplanation(request, snapshot);
}

function formatSelectedLatexContext(
  selectedText: string | undefined
): string | undefined {
  if (selectedText === undefined || selectedText.trim().length === 0) {
    return undefined;
  }

  const normalizedSelection = selectedText.trim();
  const cappedSelection =
    normalizedSelection.length > 1_200
      ? `${normalizedSelection.slice(0, 1_200).trimEnd()}\n...`
      : normalizedSelection;

  return `Selected LaTeX:\n${cappedSelection}`;
}

function explainSelectedLatex(selectedText: string): string {
  const normalizedSelection = selectedText.toLowerCase();

  if (
    normalizedSelection.includes("\\begin{align") ||
    normalizedSelection.includes("\\begin{aligned")
  ) {
    return "This selection is an aligned equation block: each row is a related equation or transformation, ampersands mark the alignment column, and double backslashes separate rows.";
  }

  if (
    normalizedSelection.includes("\\begin{equation") ||
    normalizedSelection.includes("\\[")
  ) {
    return "This selection is display math. I would explain its symbols and transformations without inferring edits.";
  }

  return "I would answer from the selected source text without rewriting it.";
}

async function createProjectInspectionResponse(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string | undefined> {
  const prompt = request.prompt.toLowerCase();

  if (isMissingFigureInspectionPrompt(prompt)) {
    return await createMissingFigureInspection(request, snapshot, broker);
  }

  if (isProposedChangeExplanationPrompt(prompt, request.selectedText)) {
    return createProposedChangeExplanationInspection(request, snapshot);
  }

  if (isNumberingMismatchPrompt(prompt)) {
    return await createNumberingMismatchInspection(request, snapshot, broker);
  }

  if (isFinalFormattingReviewPrompt(prompt)) {
    return await createFinalFormattingReviewInspection(request, snapshot, broker);
  }

  if (isTodoPlaceholderPrompt(prompt)) {
    return await createTodoPlaceholderInspection(snapshot, broker);
  }

  if (isCitationSuggestionPrompt(prompt)) {
    return createCitationSuggestionInspection(prompt);
  }

  if (isAttachedReferencePrompt(prompt)) {
    return createUnusedReferenceInspection(prompt, snapshot.contents);
  }

  if (isSubmissionChecklistPrompt(prompt)) {
    return createSubmissionChecklistInspection(request.prompt);
  }

  if (isProjectSummaryPrompt(prompt)) {
    return await createProjectSummaryInspection(request, snapshot, broker);
  }

  return undefined;
}

function isTodoPlaceholderPrompt(prompt: string): boolean {
  const markers = ["todo", "citation needed", "placeholder", "fixme", "tbd"];
  return markers.some((marker) => prompt.includes(marker));
}

function isMissingFigureInspectionPrompt(prompt: string): boolean {
  return (
    (prompt.includes("figure") &&
      (prompt.includes("missing") ||
        prompt.includes("blank") ||
        prompt.includes("not shown") ||
        prompt.includes("not showing"))) ||
    prompt.includes("unsupported format")
  );
}

function isProposedChangeExplanationPrompt(
  prompt: string,
  selectedText: string | undefined
): boolean {
  return (
    (prompt.includes("explain") &&
      (prompt.includes("proposed change") ||
        prompt.includes("this hunk") ||
        prompt.includes("this diff") ||
        prompt.includes("why agent changed") ||
        prompt.includes("why did the agent"))) ||
    (selectedText?.includes("\\usepackage") ?? false)
  );
}

function isNumberingMismatchPrompt(prompt: string): boolean {
  return (
    (prompt.includes("figure 3") && prompt.includes("figure 2")) ||
    prompt.includes("numbering mismatch") ||
    prompt.includes("referenced before") ||
    (prompt.includes("figure") && prompt.includes("numbering"))
  );
}

function isFinalFormattingReviewPrompt(prompt: string): boolean {
  return (
    prompt.includes("final pdf formatting review") ||
    prompt.includes("formatting review") ||
    prompt.includes("before submission") ||
    (prompt.includes("submission") &&
      prompt.includes("warnings") &&
      prompt.includes("figures") &&
      prompt.includes("tables"))
  );
}

function isProjectSummaryPrompt(prompt: string): boolean {
  const summaryIntent =
    prompt.includes("summar") ||
    prompt.includes("overview") ||
    prompt.includes("inspect") ||
    prompt.includes("about");
  const projectScopeHints = [
    "project",
    "paper",
    "article",
    "thesis",
    "dissertation",
    "manuscript",
    "chapter",
    "claim",
    "missing section",
    "build health",
    "structure"
  ];

  return summaryIntent && projectScopeHints.some((hint) => prompt.includes(hint));
}

function isSubmissionChecklistPrompt(prompt: string): boolean {
  return (
    prompt.includes("submission readiness") || prompt.includes("submission checklist")
  );
}

function isCitationSuggestionPrompt(prompt: string): boolean {
  return (
    prompt.includes("suggest where citations should be added") ||
    prompt.includes("local bibliography entries")
  );
}

function isAttachedReferencePrompt(prompt: string): boolean {
  return (
    prompt.includes("attached bibliography entry") &&
    prompt.includes("the only attached key is")
  );
}

async function createProjectSummaryInspection(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const maxFiles = 24;
  const mainPath = request.mainFilePath ?? snapshot.path;
  const loaded = await loadScopedLatexFiles(mainPath, snapshot, broker, maxFiles);
  const outline = loaded.snapshots.flatMap((file) =>
    extractOutlineItems(file.contents, file.path)
  );
  const chapterItems = outline.filter((item) => item.kind === "chapter");
  const sectionItems = outline.filter((item) => item.kind === "section");
  const claims = extractMainClaims(loaded.snapshots);
  const missingSections = detectMissingSections(loaded.snapshots, outline);
  const unresolvedMarkers = extractIssueMarkersFromSnapshots(loaded.snapshots);
  const buildHealth = formatBuildHealthSummary(
    request,
    loaded.snapshots,
    unresolvedMarkers
  );
  const structureSummary =
    chapterItems.length > 0
      ? `Structure: ${mainPath} includes ${chapterItems.length} chapter files in order: ${chapterItems
          .slice(0, 8)
          .map((item) => item.title)
          .join(", ")}.`
      : sectionItems.length > 0
        ? `Structure: ${mainPath} contains ${sectionItems.length} top-level sections, including ${sectionItems
            .slice(0, 8)
            .map((item) => item.title)
            .join(", ")}.`
        : `Structure: ${mainPath} is available, but I did not find chapter or section headings in the loaded scoped files.`;
  const claimsSummary =
    claims.length === 0
      ? "Main claims: I did not find clear thesis-style claim sentences in the loaded files, so the contribution framing may still need to be made explicit."
      : `Main claims: ${claims.join(" ")}`;
  const missingSummary =
    missingSections.length === 0
      ? "Missing sections: none of the standard thesis sections looked obviously absent in the loaded files."
      : `Missing sections: likely gaps include ${missingSections.join(", ")}.`;
  const coverageSummary =
    loaded.truncated === true
      ? `Coverage: inspected ${loaded.snapshots.length} scoped files and stopped at the incremental cap of ${maxFiles} files.`
      : `Coverage: inspected ${loaded.snapshots.length} scoped files rooted at ${mainPath}.`;

  return [structureSummary, claimsSummary, missingSummary, buildHealth, coverageSummary]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

async function createTodoPlaceholderInspection(
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const queryTerms = ["TODO", "FIXME", "TBD", "citation needed", "placeholder"];
  const searchResults = await Promise.all(
    queryTerms.map((query) => broker.searchProject(query))
  );
  const snapshots = uniqueSnapshots([snapshot, ...searchResults.flat()]);
  const findings = extractIssueMarkersFromSnapshots(snapshots).slice(0, 24);

  if (findings.length === 0) {
    return [
      "Checklist: I searched the scoped project files for TODO, FIXME, TBD, citation needed, and placeholder markers.",
      "Findings: no unresolved markers were found in the readable project text files.",
      "Build outputs and internal .latex-agent state are excluded from this scoped search."
    ].join("\n\n");
  }

  return [
    `Checklist: found ${findings.length} unresolved TODO or placeholder markers across ${
      new Set(findings.map((finding) => finding.path)).size
    } files.`,
    ...findings.map(
      (finding) =>
        `- ${finding.path}:${finding.line} [${finding.marker}] ${finding.preview}`
    ),
    "Build outputs and internal .latex-agent state are excluded from this scoped search."
  ].join("\n");
}

function createSubmissionChecklistInspection(prompt: string): string {
  const checklistItems = parseSubmissionChecklistItems(prompt);

  if (checklistItems.length === 0) {
    return [
      "Submission checklist: no automated bundle-check items were attached to the prompt yet.",
      "Next step: run the local submission bundle check first, then ask again for a prioritized checklist."
    ].join("\n\n");
  }

  const errors = checklistItems.filter((line) => /^-\s+error:/iu.test(line));
  const warnings = checklistItems.filter((line) => /^-\s+warning:/iu.test(line));
  const infos = checklistItems.filter((line) => /^-\s+info:/iu.test(line));

  return [
    `Submission checklist: ${errors.length} blocker${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}, ${infos.length} info item${infos.length === 1 ? "" : "s"}.`,
    ...(errors.length === 0 ? [] : ["Blockers:", ...errors]),
    ...(warnings.length === 0 ? [] : ["Warnings:", ...warnings]),
    ...(infos.length === 0 ? [] : ["Info:", ...infos]),
    "Export the source ZIP after the blockers and required warnings are resolved."
  ].join("\n");
}

function parseSubmissionChecklistItems(prompt: string): readonly string[] {
  return prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^-\s+(error|warning|info):/iu.test(line));
}

async function createMissingFigureInspection(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const mainPath = request.mainFilePath ?? snapshot.path;
  const loaded = await loadScopedLatexFiles(mainPath, snapshot, broker, 24);
  const figureReferences = loaded.snapshots.flatMap((file) =>
    extractIncludeGraphicsReferences(file.path, file.contents)
  );
  const requestedPath =
    parseProjectAssetPathFromPrompt(request.prompt) ??
    figureReferences[0]?.normalizedPath ??
    figureReferences[0]?.rawPath;

  if (requestedPath === undefined) {
    return [
      "Figure diagnosis: I did not find a project-relative \\includegraphics path in the loaded scoped files or prompt.",
      "Attach the affected figure path or active file so I can compare the local source against the project tree."
    ].join("\n\n");
  }

  const sourceMentions = figureReferences.filter(
    (reference) =>
      reference.normalizedPath === requestedPath ||
      stripProjectExtension(reference.normalizedPath ?? reference.rawPath) ===
        stripProjectExtension(requestedPath)
  );
  const exactMatches = await broker.searchProject(requestedPath);
  const exactExists = exactMatches.some((match) =>
    isSameProjectPath(match.path, requestedPath)
  );

  if (exactExists) {
    if (!isSupportedFigureFormat(request.compiler ?? "pdflatex", requestedPath)) {
      return [
        `Figure diagnosis: ${requestedPath} exists in the project, but its extension is not a safe match for ${request.compiler}.`,
        `Evidence: referenced from ${formatFigureSourceMentions(sourceMentions)}.`,
        "Next step: convert the asset to a compiler-supported local format such as PDF, PNG, or JPEG, then update the source path. I will not fetch replacement images from the network without approval."
      ].join("\n\n");
    }

    return [
      `Figure diagnosis: ${requestedPath} exists in the project and is referenced from ${formatFigureSourceMentions(sourceMentions)}.`,
      "Source evidence does not show a wrong local path. If the figure is blank in the PDF, inspect the attached build log for decoder or bounding-box warnings and confirm the asset is not corrupt or zero-byte.",
      "No network fetch is permitted for missing or replacement images without approval."
    ].join("\n\n");
  }

  const candidateMatches = await broker.searchProject(
    stripProjectExtension(getProjectBaseName(requestedPath))
  );
  const candidatePaths = uniqueStrings(
    candidateMatches
      .map((match) => normalizeProjectPath(match.path))
      .filter(
        (path): path is string =>
          path !== undefined &&
          path !== requestedPath &&
          stripProjectExtension(getProjectBaseName(path)) ===
            stripProjectExtension(getProjectBaseName(requestedPath))
      )
  );

  if (candidatePaths.length === 1) {
    return [
      `Figure diagnosis: ${requestedPath} is referenced from ${formatFigureSourceMentions(sourceMentions)}, but that exact asset is missing from the project tree.`,
      `Local candidate: found a single similarly named asset at ${candidatePaths[0]}.`,
      "This is a deterministic local path mismatch, so a reviewable source patch is appropriate. I will not fetch images from the network without approval."
    ].join("\n\n");
  }

  if (candidatePaths.length > 1) {
    return [
      `Figure diagnosis: ${requestedPath} is missing from the project tree.`,
      `Local candidates: ${candidatePaths.join(", ")}.`,
      "There are multiple plausible local assets, so I would not rewrite the path automatically without confirmation."
    ].join("\n\n");
  }

  return [
    `Figure diagnosis: ${requestedPath} is referenced from ${formatFigureSourceMentions(sourceMentions)}, but I could not find that asset anywhere in the scoped project files.`,
    "This looks like a genuinely missing local asset rather than a deterministic path typo.",
    "I will not fetch images from the network or outside the project without approval."
  ].join("\n\n");
}

function createProposedChangeExplanationInspection(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  const selectedText = request.selectedText?.trim() ?? "";
  const packageName =
    /\+?\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/u.exec(selectedText)?.[1]?.trim() ??
    /\+?\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/u.exec(snapshot.contents)?.[1]?.trim();

  if (packageName?.includes("booktabs")) {
    const usesBooktabsCommands = /\\(?:toprule|midrule|bottomrule)\b/u.test(
      snapshot.contents
    );

    return [
      "Change explanation: the proposed hunk adds `\\usepackage{booktabs}`.",
      usesBooktabsCommands
        ? "Source evidence: the current file uses `\\toprule`, `\\midrule`, or `\\bottomrule`, and those commands come from `booktabs`."
        : "Source evidence: this package is commonly added when the table style switches from plain `\\hline` rules to `booktabs` commands for cleaner publication tables.",
      request.diagnostic === undefined
        ? "Build/log evidence: no specific diagnostic was attached, so this justification is source-backed rather than log-backed."
        : `Build/log evidence: attached ${request.diagnostic.severity}${formatDiagnosticLocation(
            request.diagnostic
          )} says "${request.diagnostic.message}". The package change is consistent with a table-formatting repair rather than an unrelated edit.`,
      "This explanation is read-only. It does not approve, reject, or apply any new edit."
    ].join("\n\n");
  }

  if (packageName !== undefined) {
    return [
      `Change explanation: the proposed hunk adds or modifies \\usepackage{${packageName}}.`,
      "I would justify that change only if the current source or attached diagnostic requires commands from that package.",
      "This explanation is read-only. It does not apply any additional edit."
    ].join("\n\n");
  }

  return [
    "Change explanation: I did not find a package-addition hunk in the attached selection.",
    "Attach the specific diff hunk or selected changed lines if you want a source-backed explanation before approving."
  ].join("\n\n");
}

async function createNumberingMismatchInspection(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const mainPath = request.mainFilePath ?? snapshot.path;
  const loaded = await loadScopedLatexFiles(mainPath, snapshot, broker, 24);
  const figureBlocks = loaded.snapshots.flatMap((file) =>
    extractFigureBlocks(file.path, file.contents)
  );

  if (figureBlocks.length === 0) {
    return [
      "Numbering review: I did not find any figure environments in the scoped LaTeX files I loaded.",
      "Attach the relevant source file or main project entry so I can compare source order against the reported PDF numbering."
    ].join("\n\n");
  }

  const orderedLabels = figureBlocks.map(
    (block, index) =>
      `${index + 1}. ${block.label ?? "(unlabeled figure)"} at ${block.path}:${block.line}`
  );
  const labelPlacementIssues = figureBlocks.filter(
    (block) =>
      block.labelLine !== undefined &&
      block.captionLine !== undefined &&
      block.labelLine < block.captionLine
  );
  const duplicateLabels = collectDuplicateFigureLabels(figureBlocks);

  if (labelPlacementIssues.length > 0) {
    return [
      `Source order: ${orderedLabels.join("; ")}.`,
      `Label placement issue: ${labelPlacementIssues
        .map(
          (block) =>
            `${block.label ?? "(unlabeled)"} has \\label before \\caption at ${block.path}:${block.line}`
        )
        .join("; ")}.`,
      "That can make a reference point to the previous figure number. Safe fix: move each \\label to immediately after its \\caption before considering any reordering."
    ].join("\n\n");
  }

  if (duplicateLabels.length > 0) {
    return [
      `Source order: ${orderedLabels.join("; ")}.`,
      `Duplicate labels: ${duplicateLabels.join(", ")}.`,
      "Duplicate figure labels can make cross-references appear to skip or repeat numbers. Renaming the duplicate labels is safer than reordering figures."
    ].join("\n\n");
  }

  return [
    `Source order: ${orderedLabels.join("; ")}.`,
    "No label-before-caption or duplicate-label issue was found in the scoped source.",
    "If the PDF shows Figure 3 before Figure 2, the most likely explanation is normal LaTeX float movement rather than semantic source order. Preserve source order first; only tighten placement or add float barriers if you explicitly want a formatting patch."
  ].join("\n\n");
}

async function createFinalFormattingReviewInspection(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker
): Promise<string> {
  const mainPath = request.mainFilePath ?? snapshot.path;
  const loaded = await loadScopedLatexFiles(mainPath, snapshot, broker, 24);
  const issueMarkers = extractIssueMarkersFromSnapshots(loaded.snapshots);
  const figureBlocks = loaded.snapshots.flatMap((file) =>
    extractFigureBlocks(file.path, file.contents)
  );
  const tableBlocks = loaded.snapshots.flatMap((file) =>
    extractTableBlocks(file.path, file.contents)
  );
  const citationCount = loaded.snapshots.reduce(
    (count, file) => count + countCitationCommands(file.contents),
    0
  );
  const hasBibliography = loaded.snapshots.some(
    (file) =>
      file.contents.includes("\\bibliography{") ||
      file.contents.includes("\\printbibliography")
  );
  const checklistItems = parseSubmissionChecklistItems(request.prompt);
  const exactFigureChecks = await Promise.all(
    figureBlocks.slice(0, 8).map(async (block) => ({
      block,
      matches: await broker.searchProject(block.assetPath)
    }))
  );
  const missingFigureAssets = exactFigureChecks
    .filter(
      ({ block, matches }) =>
        !matches.some((match) => isSameProjectPath(match.path, block.assetPath))
    )
    .map(({ block }) => `${block.assetPath} (${block.path}:${block.line})`);

  const blockers = [
    ...checklistItems.filter((line) => /^-\s+error:/iu.test(line)),
    ...(citationCount > 0 && !hasBibliography
      ? [
          "- error: Citation commands are present, but no bibliography inclusion was found in the scoped source."
        ]
      : []),
    ...(missingFigureAssets.length === 0
      ? []
      : missingFigureAssets.map(
          (item) =>
            `- error: Missing local figure asset referenced by source. (${item})`
        ))
  ];
  const warnings = [
    ...checklistItems.filter((line) => /^-\s+warning:/iu.test(line)),
    ...figureBlocks
      .filter((block) => block.label === undefined || block.captionLine === undefined)
      .map(
        (block) =>
          `- warning: Figure is missing a ${block.label === undefined ? "\\label" : "\\caption"} in source. (${block.path}:${block.line})`
      ),
    ...tableBlocks
      .filter((block) => block.columnCount >= 6)
      .map(
        (block) =>
          `- warning: Wide table may need width review before submission. (${block.path}:${block.line}, ${block.columnCount} columns)`
      ),
    ...(request.diagnostic === undefined
      ? []
      : [
          `- warning: Attached ${request.diagnostic.severity}${formatDiagnosticLocation(
            request.diagnostic
          )} ${request.diagnostic.message}`
        ])
  ];
  const polish = [
    ...checklistItems.filter((line) => /^-\s+info:/iu.test(line)),
    `- info: Scoped source contains ${citationCount} citation command${citationCount === 1 ? "" : "s"} and ${hasBibliography ? "does" : "does not"} include a bibliography command.`,
    ...issueMarkers
      .slice(0, 6)
      .map(
        (marker) =>
          `- info: Unresolved draft marker remains in source. (${marker.path}:${marker.line} ${marker.marker})`
      ),
    ...(loaded.truncated === true
      ? [
          "- info: Source inspection hit the scoped file cap, so lower-priority formatting issues may still remain."
        ]
      : []),
    "- info: No rendered PDF snapshot was attached to this inspection prompt, so visual ordering claims remain source- and log-backed only."
  ];

  return [
    `Evidence basis: inspected ${loaded.snapshots.length} scoped source file${loaded.snapshots.length === 1 ? "" : "s"}, ${checklistItems.length} attached submission-check item${checklistItems.length === 1 ? "" : "s"}, and ${figureBlocks.length} figure / ${tableBlocks.length} table block${figureBlocks.length + tableBlocks.length === 1 ? "" : "s"}.`,
    blockers.length === 0
      ? "Priority 1 blockers: none from the attached evidence."
      : `Priority 1 blockers:\n${blockers.join("\n")}`,
    warnings.length === 0
      ? "Priority 2 warnings: none from the attached evidence."
      : `Priority 2 warnings:\n${warnings.join("\n")}`,
    polish.length === 0
      ? "Priority 3 polish: none from the attached evidence."
      : `Priority 3 polish:\n${polish.join("\n")}`,
    "This is a review checklist only. I am not applying risky formatting changes automatically."
  ].join("\n\n");
}

function createCitationSuggestionInspection(prompt: string): string {
  const entries = parsePromptBibliographyEntries(prompt);

  if (entries.length === 0) {
    return [
      "Citation suggestions: no local bibliography entries were attached to this prompt.",
      "Add or load a local `.bib` file before asking for citation suggestions."
    ].join("\n\n");
  }

  const ranked = entries
    .map((entry) => ({
      ...entry,
      score:
        scoreCitationEntry(entry, prompt) +
        (entry.author === undefined ? 0 : 1) +
        (entry.year === undefined ? 0 : 1)
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.key.localeCompare(right.key)
    )
    .slice(0, 5);

  const candidates = (ranked.length > 0 ? ranked : entries.slice(0, 3)).map(
    (entry) =>
      `- ${entry.key}${entry.title === undefined ? "" : ` | ${entry.title}`}${entry.author === undefined ? "" : ` | ${entry.author}`}${entry.year === undefined ? "" : ` | ${entry.year}`}`
  );

  return [
    "Citation suggestions: use only the local bibliography entries below and choose one that directly supports the uncited claim before inserting anything.",
    "Candidate local sources:",
    ...candidates,
    "If none of these sources actually support the claim, ask for source details instead of inventing a citation."
  ].join("\n");
}

function createUnusedReferenceInspection(
  prompt: string,
  activeContents: string
): string {
  const entry = parseAttachedReferenceEntry(prompt);

  if (entry === undefined) {
    return [
      "Unused-reference review: I could not parse the attached bibliography entry.",
      "Reattach the unused entry before asking whether it should be kept or pruned."
    ].join("\n\n");
  }

  const manuscriptText = activeContents.toLowerCase();
  const titleTerms = (entry.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((term) => term.length >= 5);
  const matchingTerms = titleTerms.filter((term) => manuscriptText.includes(term));

  return [
    `Unused-reference review for ${entry.key}: ${entry.title ?? "untitled entry"}.`,
    matchingTerms.length === 0
      ? "Fit with the active manuscript: I do not see strong title-term overlap in the current LaTeX context, so pruning is reasonable unless another chapter still needs this source."
      : `Fit with the active manuscript: overlapping terms include ${matchingTerms
          .slice(0, 5)
          .join(
            ", "
          )}, so this source may belong in related work or background if it supports an uncited claim.`,
    "Decision rule: keep it only if it directly supports a real manuscript claim; otherwise leave it unused or remove it with the reversible unused-reference action."
  ].join("\n\n");
}

function parsePromptBibliographyEntries(prompt: string): readonly {
  readonly key: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
}[] {
  return prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Local bibliography entries"))
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const key = parts[0]?.replace(/^- /u, "").trim() ?? "";
      const title = parts
        .find((part) => part.startsWith("title="))
        ?.replace(/^title=/u, "")
        .trim();
      const author = parts
        .find((part) => part.startsWith("author="))
        ?.replace(/^author=/u, "")
        .trim();
      const year = parts
        .find((part) => part.startsWith("year="))
        ?.replace(/^year=/u, "")
        .trim();

      return key.length === 0
        ? undefined
        : {
            key,
            ...(title ? { title } : {}),
            ...(author ? { author } : {}),
            ...(year ? { year } : {})
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

function parseAttachedReferenceEntry(prompt: string):
  | {
      readonly key: string;
      readonly title?: string;
      readonly author?: string;
      readonly year?: string;
    }
  | undefined {
  const match = /the only attached key is\s+([A-Za-z0-9:_-]+)/iu.exec(prompt);
  const key = match?.[1]?.trim();
  if (key === undefined || key.length === 0) {
    return undefined;
  }

  const title = /title=(.+)/iu.exec(prompt)?.[1]?.split("\n")[0]?.trim();
  const author = /author=(.+)/iu.exec(prompt)?.[1]?.split("\n")[0]?.trim();
  const year = /year=(.+)/iu.exec(prompt)?.[1]?.split("\n")[0]?.trim();

  return {
    key,
    ...(title === undefined || title.length === 0 ? {} : { title }),
    ...(author === undefined || author.length === 0 ? {} : { author }),
    ...(year === undefined || year.length === 0 ? {} : { year })
  };
}

function scoreCitationEntry(
  entry: {
    readonly key: string;
    readonly title?: string;
    readonly author?: string;
    readonly year?: string;
  },
  prompt: string
): number {
  const corpus =
    `${entry.key} ${entry.title ?? ""} ${entry.author ?? ""} ${entry.year ?? ""}`.toLowerCase();
  const terms = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((term) => term.length >= 4)
    .slice(0, 20);

  return terms.reduce((score, term) => (corpus.includes(term) ? score + 2 : score), 0);
}

async function loadScopedLatexFiles(
  mainPath: string,
  snapshot: ProjectFileSnapshot,
  broker: ReadOnlyInspectionBroker,
  maxFiles: number
): Promise<{
  readonly snapshots: readonly ProjectFileSnapshot[];
  readonly truncated: boolean;
}> {
  const loaded = new Map<string, ProjectFileSnapshot>([[snapshot.path, snapshot]]);
  const pending = [mainPath];
  let truncated = false;

  while (pending.length > 0) {
    const nextPath = pending.shift() ?? "";
    if (loaded.size >= maxFiles && !loaded.has(nextPath)) {
      truncated = true;
      continue;
    }

    let nextSnapshot = loaded.get(nextPath);
    if (nextSnapshot === undefined) {
      try {
        nextSnapshot = await broker.readFile(nextPath);
        loaded.set(nextPath, nextSnapshot);
      } catch {
        continue;
      }
    }

    if (!nextSnapshot.path.endsWith(".tex")) {
      continue;
    }

    for (const includePath of extractIncludedPaths(
      nextSnapshot.path,
      nextSnapshot.contents
    )) {
      if (!loaded.has(includePath) && !pending.includes(includePath)) {
        pending.push(includePath);
      }
    }
  }

  return {
    snapshots: Array.from(loaded.values()),
    truncated
  };
}

function extractIncludedPaths(path: string, contents: string): readonly string[] {
  const matches = contents.matchAll(/\\(?:input|include)\{([^}]+)\}/gu);
  const includedPaths: string[] = [];

  for (const match of matches) {
    const rawPath = match[1]?.trim() ?? "";
    if (rawPath.length === 0 || rawPath.startsWith("/")) {
      continue;
    }

    const candidate = rawPath.includes(".") ? rawPath : `${rawPath}.tex`;
    includedPaths.push(resolveProjectPath(path, candidate));
  }

  return includedPaths;
}

function resolveProjectPath(fromPath: string, targetPath: string): string {
  const baseSegments = splitProjectPath(getProjectDirectory(fromPath));
  const targetSegments = splitProjectPath(targetPath);
  const resolved = targetPath.startsWith("/")
    ? targetSegments
    : [...baseSegments, ...targetSegments];
  const normalized: string[] = [];

  for (const segment of resolved) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      normalized.pop();
      continue;
    }

    normalized.push(segment);
  }

  return normalized.join("/");
}

function getProjectDirectory(path: string): string {
  const segments = splitProjectPath(path);
  return segments.slice(0, -1).join("/");
}

function splitProjectPath(path: string): readonly string[] {
  return path.replace(/\\/gu, "/").split("/");
}

function extractOutlineItems(
  contents: string,
  path: string
): readonly {
  readonly kind: "chapter" | "section";
  readonly title: string;
  readonly path: string;
}[] {
  const items: { kind: "chapter" | "section"; title: string; path: string }[] = [];
  const matches = contents.matchAll(/\\(chapter|section)\*?\{([^}]+)\}/gu);

  for (const match of matches) {
    const kind = match[1] === "chapter" ? "chapter" : "section";
    const title = cleanLatexTitle(match[2] ?? "");
    if (title.length > 0) {
      items.push({ kind, title, path });
    }
  }

  return items;
}

function cleanLatexTitle(value: string): string {
  return value.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^}]*)\}/gu, "$1").trim();
}

function extractMainClaims(
  snapshots: readonly ProjectFileSnapshot[]
): readonly string[] {
  const sentences = snapshots.flatMap((snapshot) =>
    stripLatexForTextAnalysis(snapshot.contents)
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0)
  );

  return uniqueStrings(
    sentences.filter((sentence) =>
      /\b(we (?:show|demonstrate|propose|present|argue|evaluate)|this (?:thesis|dissertation|work|paper)|our contributions?)\b/iu.test(
        sentence
      )
    )
  )
    .slice(0, 3)
    .map((sentence) => ensureTrailingPeriod(sentence));
}

function detectMissingSections(
  snapshots: readonly ProjectFileSnapshot[],
  outline: readonly { readonly title: string }[]
): readonly string[] {
  const normalizedTitles = outline.map((item) => item.title.toLowerCase());
  const fullText = snapshots
    .map((snapshot) => snapshot.contents.toLowerCase())
    .join("\n");
  const expectedSections = [
    {
      label: "abstract",
      present:
        fullText.includes("\\begin{abstract}") || fullText.includes("\\abstract{")
    },
    {
      label: "introduction",
      present: normalizedTitles.some((title) => title.includes("introduction"))
    },
    {
      label: "related work or literature review",
      present: normalizedTitles.some(
        (title) =>
          title.includes("related work") ||
          title.includes("literature review") ||
          title.includes("background")
      )
    },
    {
      label: "methodology",
      present: normalizedTitles.some(
        (title) => title.includes("method") || title.includes("methodology")
      )
    },
    {
      label: "results or evaluation",
      present: normalizedTitles.some(
        (title) =>
          title.includes("result") ||
          title.includes("evaluation") ||
          title.includes("experiment")
      )
    },
    {
      label: "discussion",
      present: normalizedTitles.some((title) => title.includes("discussion"))
    },
    {
      label: "conclusion",
      present: normalizedTitles.some((title) => title.includes("conclusion"))
    },
    {
      label: "bibliography",
      present:
        fullText.includes("\\bibliography{") || fullText.includes("\\printbibliography")
    }
  ];

  return expectedSections
    .filter((section) => !section.present)
    .map((section) => section.label)
    .slice(0, 5);
}

function formatBuildHealthSummary(
  request: AgentStartRequest,
  snapshots: readonly ProjectFileSnapshot[],
  markers: readonly {
    readonly path: string;
    readonly line: number;
  }[]
): string {
  const mainSnapshot = snapshots[0];
  const hasDocumentClass = mainSnapshot?.contents.includes("\\documentclass") === true;
  const hasDocumentStart =
    mainSnapshot?.contents.includes("\\begin{document}") === true;
  const hasDocumentEnd = mainSnapshot?.contents.includes("\\end{document}") === true;

  if (request.diagnostic !== undefined) {
    const location = formatDiagnosticLocation(request.diagnostic);
    return `Build health: attached ${request.diagnostic.severity}${location} says "${request.diagnostic.message}". Source checks: documentclass ${hasDocumentClass ? "present" : "missing"}, begin/end document ${hasDocumentStart && hasDocumentEnd ? "present" : "incomplete"}, unresolved markers in loaded files ${markers.length}.`;
  }

  return `Build health: no compile result or diagnostic was attached to this read-only inspection, so compile status is unverified. Source checks: documentclass ${hasDocumentClass ? "present" : "missing"}, begin/end document ${hasDocumentStart && hasDocumentEnd ? "present" : "incomplete"}, unresolved markers in loaded files ${markers.length}.`;
}

function extractIssueMarkersFromSnapshots(
  snapshots: readonly ProjectFileSnapshot[]
): readonly {
  readonly path: string;
  readonly line: number;
  readonly marker: string;
  readonly preview: string;
}[] {
  const findings: {
    path: string;
    line: number;
    marker: string;
    preview: string;
  }[] = [];
  const patterns: readonly { readonly marker: string; readonly pattern: RegExp }[] = [
    { marker: "TODO", pattern: /\bTODO\b/iu },
    { marker: "FIXME", pattern: /\bFIXME\b/iu },
    { marker: "TBD", pattern: /\bTBD\b/iu },
    { marker: "citation needed", pattern: /citation needed/iu },
    { marker: "placeholder", pattern: /\bplaceholder\b/iu }
  ];

  for (const snapshot of snapshots) {
    const lines = snapshot.contents.split(/\r?\n/u);

    for (const [index, line] of lines.entries()) {
      const marker = patterns.find(({ pattern }) => pattern.test(line))?.marker;
      if (marker === undefined) {
        continue;
      }

      findings.push({
        path: snapshot.path,
        line: index + 1,
        marker,
        preview: line.trim()
      });
    }
  }

  return findings.sort((left, right) =>
    left.path === right.path
      ? left.line - right.line
      : left.path.localeCompare(right.path)
  );
}

type IncludeGraphicsReference = {
  readonly path: string;
  readonly line: number;
  readonly rawPath: string;
  readonly normalizedPath?: string;
};

function extractIncludeGraphicsReferences(
  path: string,
  contents: string
): readonly IncludeGraphicsReference[] {
  const references: IncludeGraphicsReference[] = [];
  const lines = contents.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const matches = line.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/gu);
    for (const match of matches) {
      const rawPath = (match[1] ?? "").trim();
      if (rawPath.length === 0) {
        continue;
      }

      const normalizedPath = normalizeProjectPath(rawPath);
      references.push({
        path,
        line: index + 1,
        rawPath,
        ...(normalizedPath === undefined ? {} : { normalizedPath })
      });
    }
  }

  return references;
}

type FigureBlock = {
  readonly path: string;
  readonly line: number;
  readonly assetPath: string;
  readonly label?: string;
  readonly captionLine?: number;
  readonly labelLine?: number;
};

function extractFigureBlocks(path: string, contents: string): readonly FigureBlock[] {
  const blocks: FigureBlock[] = [];

  for (const match of contents.matchAll(
    /\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/gu
  )) {
    const body = match[1] ?? "";
    const startOffset = match.index ?? 0;
    const startLine = countLinesBeforeOffset(contents, startOffset) + 1;
    const assetPath =
      /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/u.exec(body)?.[1]?.trim() ?? "";
    if (assetPath.length === 0) {
      continue;
    }

    const labelMatch = /\\label\{([^}]+)\}/u.exec(body);
    const captionMatch = /\\caption\{([^}]*)\}/u.exec(body);
    const label = labelMatch?.[1]?.trim();
    const labelLine =
      labelMatch?.index === undefined
        ? undefined
        : startLine + countLinesBeforeOffset(body, labelMatch.index);
    const captionLine =
      captionMatch?.index === undefined
        ? undefined
        : startLine + countLinesBeforeOffset(body, captionMatch.index);

    blocks.push({
      path,
      line: startLine,
      assetPath,
      ...(label === undefined ? {} : { label }),
      ...(labelLine === undefined ? {} : { labelLine }),
      ...(captionLine === undefined ? {} : { captionLine })
    });
  }

  return blocks;
}

type TableBlock = {
  readonly path: string;
  readonly line: number;
  readonly columnCount: number;
};

function extractTableBlocks(path: string, contents: string): readonly TableBlock[] {
  const blocks: TableBlock[] = [];

  for (const match of contents.matchAll(
    /\\begin\{table\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{table\}/gu
  )) {
    const body = match[1] ?? "";
    const startOffset = match.index ?? 0;
    const startLine = countLinesBeforeOffset(contents, startOffset) + 1;
    const alignment = /\\begin\{tabular\}\{([^}]+)\}/u.exec(body)?.[1] ?? "";
    const columnCount = alignment.replace(/[^lcrpmbxX]/gu, "").length;

    blocks.push({
      path,
      line: startLine,
      columnCount
    });
  }

  return blocks;
}

function countLinesBeforeOffset(contents: string, offset: number): number {
  return contents.slice(0, offset).split(/\r?\n/u).length - 1;
}

function formatFigureSourceMentions(
  mentions: readonly { readonly path: string; readonly line: number }[]
): string {
  if (mentions.length === 0) {
    return "the loaded scoped source";
  }

  return mentions.map((mention) => `${mention.path}:${mention.line}`).join(", ");
}

function getProjectBaseName(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function stripProjectExtension(path: string): string {
  return path.replace(/\.[^.]+$/u, "");
}

function parseProjectAssetPathFromPrompt(prompt: string): string | undefined {
  return normalizeProjectPath(
    /(?:^|\s|`)((?:figures|images|plots|assets)\/[A-Za-z0-9._/-]+\.(?:pdf|png|jpe?g|eps|bmp|gif))(?=`|\s|$)/iu.exec(
      prompt
    )?.[1]
  );
}

function isSupportedFigureFormat(compiler: LatexCompiler, path: string): boolean {
  const extension = getProjectExtension(path);
  if (extension.length === 0) {
    return true;
  }

  const supportedExtensions =
    compiler === "pdflatex"
      ? new Set([".pdf", ".png", ".jpg", ".jpeg"])
      : new Set([".pdf", ".png", ".jpg", ".jpeg"]);
  return supportedExtensions.has(extension);
}

function getProjectExtension(path: string): string {
  const match = /\.[^.]+$/u.exec(path);
  return match?.[0]?.toLowerCase() ?? "";
}

function normalizeProjectPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("../")
  ) {
    return undefined;
  }

  return normalized;
}

function isSameProjectPath(left: string, right: string): boolean {
  const normalizedLeft = normalizeProjectPath(left);
  const normalizedRight = normalizeProjectPath(right);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function collectDuplicateFigureLabels(
  blocks: readonly FigureBlock[]
): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const block of blocks) {
    if (block.label === undefined) {
      continue;
    }

    if (seen.has(block.label)) {
      duplicates.add(block.label);
      continue;
    }

    seen.add(block.label);
  }

  return Array.from(duplicates.values());
}

function countCitationCommands(contents: string): number {
  return Array.from(
    contents.matchAll(
      /\\(?:cite|citep|citet|parencite|textcite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{/gu
    )
  ).length;
}

function uniqueSnapshots(
  snapshots: readonly ProjectFileSnapshot[]
): readonly ProjectFileSnapshot[] {
  const byPath = new Map<string, ProjectFileSnapshot>();

  for (const snapshot of snapshots) {
    byPath.set(snapshot.path, snapshot);
  }

  return Array.from(byPath.values());
}

function stripLatexForTextAnalysis(contents: string): string {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|[^\\])%.*/u, "$1"))
    .join(" ")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/gu, " ")
    .replace(/[{}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function ensureTrailingPeriod(sentence: string): string {
  return /[.!?]\s*$/u.test(sentence) ? sentence : `${sentence}.`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function formatDiagnosticLocation(diagnostic: LatexDiagnostic | undefined): string {
  if (diagnostic?.filePath === undefined && diagnostic?.line === undefined) {
    return "";
  }

  const file = diagnostic.filePath ?? "the active file";
  const line = diagnostic.line === undefined ? "" : `:${diagnostic.line}`;
  return ` at ${file}${line}`;
}

function explainLatexDiagnostic(diagnostic: LatexDiagnostic | undefined): string {
  if (diagnostic === undefined) {
    return "I did not receive a specific build diagnostic, so I am not inferring a source change.";
  }

  const message = diagnostic.message.toLowerCase();

  if (message.includes("overfull \\hbox")) {
    return "This warning means a line is wider than the allowed text block. It usually points to a long word, URL, inline formula, citation cluster, or unbreakable box near the reported line.";
  }

  if (message.includes("underfull \\hbox")) {
    return "This warning means LaTeX could not space a line cleanly. It is often cosmetic and may come from short lines, manual line breaks, or constrained environments.";
  }

  if (message.includes("undefined references") || message.includes("reference")) {
    return "This warning means at least one cross-reference was not resolved. It can require another compile pass, or it can point to a missing or misspelled label.";
  }

  if (message.includes("citation") || message.includes("undefined")) {
    return "This warning means LaTeX or BibTeX could not resolve a citation or identifier. Check that the key exists in a local bibliography file and that the bibliography is included by the main document.";
  }

  if (message.includes("multiply defined")) {
    return "This warning means the same label or identifier appears more than once. LaTeX will pick one target, which can make references point to the wrong place.";
  }

  return diagnostic.severity === "warning"
    ? "This is a warning, so LaTeX may still produce a PDF. It flags output or reference quality that should be reviewed before submission."
    : "This is an error, so LaTeX may have stopped before producing a reliable PDF. The source near the reported file and line is the first place to inspect.";
}

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
    fontFamily: '"JetBrains Mono", Monaco, SFMono-Regular, Consolas, monospace',
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
    defaultMode: "suggest",
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
  readonly [ipcChannels.historyCreateAppliedChangeSet]: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly beforeContents: string;
    readonly afterContents: string;
    readonly summary: string;
  };
  readonly [ipcChannels.historyApplyChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyApplyChangeSetHunks]: {
    readonly changesetId: string;
    readonly acceptedHunkIndexes: readonly number[];
  };
  readonly [ipcChannels.historyRejectChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyRollbackChangeSet]: { readonly changesetId: string };
  readonly [ipcChannels.historyListAuditEvents]: { readonly projectRoot: string };
  readonly [ipcChannels.referencesAnalyze]: { readonly projectRoot: string };
  readonly [ipcChannels.referencesSearch]: {
    readonly projectRoot: string;
    readonly query: string;
  };
  readonly [ipcChannels.referencesRemoveUnused]: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly key: string;
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
  readonly [ipcChannels.agentEvent]: AgentEvent;
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
  readonly [ipcChannels.projectDeleteEntry]: ProjectDeleteResult;
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
  readonly [ipcChannels.historyCreateAppliedChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyApplyChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyApplyChangeSetHunks]: HistoryChangeSet;
  readonly [ipcChannels.historyRejectChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyRollbackChangeSet]: HistoryChangeSet;
  readonly [ipcChannels.historyListAuditEvents]: readonly AuditEvent[];
  readonly [ipcChannels.referencesAnalyze]: ReferenceAnalysis;
  readonly [ipcChannels.referencesSearch]: readonly ReferenceSearchResult[];
  readonly [ipcChannels.referencesRemoveUnused]: RemoveUnusedReferenceResult;
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
  readonly [ipcChannels.agentEvent]: undefined;
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
    ) => Promise<ProjectDeleteResult>;
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
    readonly createAppliedChangeSet: (
      request: IpcRequestMap[typeof ipcChannels.historyCreateAppliedChangeSet]
    ) => Promise<HistoryChangeSet>;
    readonly applyChangeSet: (changesetId: string) => Promise<HistoryChangeSet>;
    readonly applyChangeSetHunks: (
      request: IpcRequestMap[typeof ipcChannels.historyApplyChangeSetHunks]
    ) => Promise<HistoryChangeSet>;
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
    readonly removeUnused: (
      request: IpcRequestMap[typeof ipcChannels.referencesRemoveUnused]
    ) => Promise<RemoveUnusedReferenceResult>;
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
    readonly onEvent: (callback: (event: AgentEvent) => void) => () => void;
  };
};
