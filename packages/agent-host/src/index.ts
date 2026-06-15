import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";

import { createReadOnlyAgentResponse } from "@latex-agent/ipc-contracts";
import type {
  AgentMoveEntryOperation,
  AgentApprovalResponseRequest,
  AgentAuthStatus,
  AgentEvent,
  AgentProviderId,
  AgentSessionResult,
  AgentStartRequest,
  AgentToolCallEvent,
  AgentToolName,
  AgentToolRisk,
  BuildResult,
  HistoryChangeSet,
  LatexCompiler,
  ProjectFileSnapshot
} from "@latex-agent/ipc-contracts";

export type AgentProvider = {
  readonly id: AgentProviderId;
  getAuthStatus: () => Promise<AgentAuthStatus>;
  startSession: (
    request: AgentStartRequest,
    broker: AgentToolBroker
  ) => Promise<AgentSessionResult>;
  cancelSession: (sessionId: string) => Promise<boolean>;
};

export type AgentToolBroker = {
  readonly emitEvent?: (event: AgentEvent) => void;
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
  readonly moveEntry?: (
    fromPath: string,
    toPath: string
  ) => Promise<AgentMoveEntryOperation>;
  readonly setMainFile?: (path: string) => Promise<{ readonly path: string }>;
  readonly proposePatch: (
    filePath: string,
    beforeContents: string,
    afterContents: string,
    summary: string
  ) => Promise<HistoryChangeSet>;
  readonly rejectPatch?: (changesetId: string) => Promise<HistoryChangeSet>;
  readonly applyPatch: (changesetId: string) => Promise<HistoryChangeSet>;
  readonly runCompile: () => Promise<BuildResult>;
};

export type AgentToolRequestPayloadMap = {
  readonly "read-file": { readonly path: string };
  readonly "search-project": { readonly query: string };
  readonly "move-entry": AgentMoveEntryOperation & { readonly approved: true };
  readonly "set-main-file": { readonly path: string; readonly approved: true };
  readonly "network-fetch": { readonly resource: string };
  readonly "codex-exec": { readonly prompt: string };
  readonly "claude-code": { readonly prompt: string };
  readonly "propose-patch": {
    readonly filePath: string;
    readonly beforeContents: string;
    readonly afterContents: string;
    readonly summary: string;
  };
  readonly "reject-patch": {
    readonly changesetId: string;
    readonly approved: false;
  };
  readonly "apply-patch": {
    readonly changesetId: string;
    readonly approved: boolean;
  };
  readonly "run-compile": {
    readonly approved: boolean;
  };
};

export type AgentToolResultMap = {
  readonly "read-file": ProjectFileSnapshot;
  readonly "search-project": readonly ProjectFileSnapshot[];
  readonly "move-entry": AgentMoveEntryOperation;
  readonly "set-main-file": { readonly path: string };
  readonly "network-fetch": { readonly fetched: false };
  readonly "codex-exec": { readonly completed: true };
  readonly "claude-code": { readonly completed: true };
  readonly "propose-patch": HistoryChangeSet;
  readonly "reject-patch": HistoryChangeSet;
  readonly "apply-patch": HistoryChangeSet;
  readonly "run-compile": BuildResult;
};

export type AgentHostToolRequestMessage<
  TToolName extends AgentToolName = AgentToolName
> = {
  readonly type: "tool.request";
  readonly requestId: string;
  readonly sessionId: string;
  readonly context: AgentStartRequest;
  readonly toolName: TToolName;
  readonly payload: AgentToolRequestPayloadMap[TToolName];
};

export type AgentHostInboundMessage =
  | {
      readonly type: "session.auth";
      readonly requestId: string;
      readonly providerId: AgentProviderId;
    }
  | {
      readonly type: "session.start";
      readonly requestId: string;
      readonly request: AgentStartRequest;
    }
  | {
      readonly type: "session.approval";
      readonly requestId: string;
      readonly request: AgentApprovalResponseRequest;
    }
  | {
      readonly type: "session.cancel";
      readonly requestId: string;
      readonly sessionId: string;
    }
  | {
      readonly type: "tool.response";
      readonly requestId: string;
      readonly ok: true;
      readonly result: AgentToolResultMap[AgentToolName];
    }
  | {
      readonly type: "tool.response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export type AgentHostOutboundMessage =
  | { readonly type: "host.ready" }
  | {
      readonly type: "auth.result";
      readonly requestId: string;
      readonly status: AgentAuthStatus;
    }
  | {
      readonly type: "session.result";
      readonly requestId: string;
      readonly result: AgentSessionResult;
    }
  | {
      readonly type: "session.event";
      readonly event: AgentEvent;
    }
  | {
      readonly type: "session.cancelled";
      readonly requestId: string;
      readonly cancelled: boolean;
    }
  | AgentHostToolRequestMessage
  | {
      readonly type: "host.error";
      readonly requestId?: string;
      readonly error: string;
    };

export type AgentHostToolHandler = (
  message: AgentHostToolRequestMessage
) => Promise<AgentToolResultMap[AgentToolName]>;

export class AgentHostClient {
  private child: ChildProcess | undefined;
  private stopping = false;
  private readonly pendingSessionRequests = new Map<
    string,
    {
      readonly providerId: AgentProviderId;
      readonly resolve: (result: AgentSessionResult) => void;
    }
  >();
  private readonly pendingAuthRequests = new Map<
    string,
    {
      readonly providerId: AgentProviderId;
      readonly resolve: (result: AgentAuthStatus) => void;
    }
  >();
  private readonly pendingCancelRequests = new Map<
    string,
    (result: { readonly cancelled: boolean }) => void
  >();

  constructor(
    private readonly options: {
      readonly hostProcessPath: string;
      readonly handleToolRequest: AgentHostToolHandler;
      readonly onEvent?: (event: AgentEvent) => void;
      readonly onCrash?: (message: string) => void;
    }
  ) {}

  startSession(request: AgentStartRequest): Promise<AgentSessionResult> {
    const requestId = randomUUID();
    return this.sendSessionRequest(requestId, request.providerId, {
      type: "session.start",
      requestId,
      request
    });
  }

  getAuthStatus(providerId: AgentProviderId): Promise<AgentAuthStatus> {
    const requestId = randomUUID();
    this.ensureProcess();

    return new Promise((resolve) => {
      this.pendingAuthRequests.set(requestId, { providerId, resolve });
      this.child?.send({
        type: "session.auth",
        requestId,
        providerId
      } satisfies AgentHostInboundMessage);
    });
  }

  respondApproval(request: AgentApprovalResponseRequest): Promise<AgentSessionResult> {
    const requestId = randomUUID();
    return this.sendSessionRequest(requestId, "mock", {
      type: "session.approval",
      requestId,
      request
    });
  }

  cancelSession(sessionId: string): Promise<{ readonly cancelled: boolean }> {
    const requestId = randomUUID();
    this.ensureProcess();

    return new Promise((resolve) => {
      this.pendingCancelRequests.set(requestId, resolve);
      this.child?.send({
        type: "session.cancel",
        requestId,
        sessionId
      } satisfies AgentHostInboundMessage);
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = undefined;
  }

  private sendSessionRequest(
    requestId: string,
    providerId: AgentProviderId,
    message: AgentHostInboundMessage
  ): Promise<AgentSessionResult> {
    this.ensureProcess();

    return new Promise((resolve) => {
      this.pendingSessionRequests.set(requestId, { providerId, resolve });
      this.child?.send(message);
    });
  }

  private ensureProcess(): void {
    if (this.child !== undefined && !this.child.killed) {
      return;
    }

    const child = fork(this.options.hostProcessPath, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    this.child = child;

    child.on("message", (message: unknown) => {
      void this.handleHostMessage(message);
    });
    child.on("exit", (code, signal) => {
      const message = `Agent host exited with ${code ?? signal ?? "unknown status"}.`;
      this.child = undefined;
      if (this.stopping) {
        this.stopping = false;
        return;
      }
      this.failPendingSessionRequests(message);
      this.failPendingAuthRequests(message);
      this.failPendingCancelRequests();
      this.options.onCrash?.(message);
    });
  }

  private async handleHostMessage(message: unknown): Promise<void> {
    if (!isHostOutboundMessage(message)) {
      return;
    }

    if (message.type === "host.ready") {
      return;
    }

    if (message.type === "session.result") {
      const pending = this.pendingSessionRequests.get(message.requestId);
      this.pendingSessionRequests.delete(message.requestId);
      pending?.resolve(message.result);
      return;
    }

    if (message.type === "session.event") {
      this.emitEvent(message.event);
      return;
    }

    if (message.type === "auth.result") {
      const pending = this.pendingAuthRequests.get(message.requestId);
      this.pendingAuthRequests.delete(message.requestId);
      pending?.resolve(message.status);
      return;
    }

    if (message.type === "session.cancelled") {
      const resolve = this.pendingCancelRequests.get(message.requestId);
      this.pendingCancelRequests.delete(message.requestId);
      resolve?.({ cancelled: message.cancelled });
      return;
    }

    if (message.type === "host.error") {
      if (message.requestId !== undefined) {
        const pendingSession = this.pendingSessionRequests.get(message.requestId);
        this.pendingSessionRequests.delete(message.requestId);
        pendingSession?.resolve(
          createFailedHostResult(pendingSession.providerId, message.error)
        );
        const pendingAuth = this.pendingAuthRequests.get(message.requestId);
        this.pendingAuthRequests.delete(message.requestId);
        pendingAuth?.resolve({
          providerId: pendingAuth.providerId,
          state: "error",
          message: message.error
        });
      }
      return;
    }

    this.emitEvent(
      createClientToolEvent(
        message.sessionId,
        message.requestId,
        message.toolName,
        "running",
        summarizeClientToolRequest(message),
        getAgentToolRisk(message.toolName)
      )
    );

    try {
      const result = await this.options.handleToolRequest(message);
      this.emitEvent(
        createClientToolEvent(
          message.sessionId,
          message.requestId,
          message.toolName,
          "succeeded",
          summarizeClientToolResult(message.toolName, result),
          getAgentToolRisk(message.toolName)
        )
      );
      this.child?.send({
        type: "tool.response",
        requestId: message.requestId,
        ok: true,
        result
      } satisfies AgentHostInboundMessage);
    } catch (error) {
      this.emitEvent(
        createClientToolEvent(
          message.sessionId,
          message.requestId,
          message.toolName,
          "failed",
          getErrorMessage(error),
          getAgentToolRisk(message.toolName)
        )
      );
      this.child?.send({
        type: "tool.response",
        requestId: message.requestId,
        ok: false,
        error: getErrorMessage(error)
      } satisfies AgentHostInboundMessage);
    }
  }

  private emitEvent(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  private failPendingSessionRequests(message: string): void {
    for (const [requestId, pending] of this.pendingSessionRequests.entries()) {
      this.pendingSessionRequests.delete(requestId);
      pending.resolve(createFailedHostResult(pending.providerId, message));
    }
  }

  private failPendingAuthRequests(message: string): void {
    for (const [requestId, pending] of this.pendingAuthRequests.entries()) {
      this.pendingAuthRequests.delete(requestId);
      pending.resolve({
        providerId: pending.providerId,
        state: "error",
        message
      });
    }
  }

  private failPendingCancelRequests(): void {
    for (const [requestId, resolve] of this.pendingCancelRequests.entries()) {
      this.pendingCancelRequests.delete(requestId);
      resolve({ cancelled: false });
    }
  }
}

export class MockAgentProvider implements AgentProvider {
  readonly id = "mock" as const;
  private readonly cancelledSessionIds = new Set<string>();

  getAuthStatus(): Promise<AgentAuthStatus> {
    return Promise.resolve({
      providerId: this.id,
      state: "connected",
      message: "Mock provider is available locally."
    });
  }

  async startSession(
    request: AgentStartRequest,
    broker: AgentToolBroker
  ): Promise<AgentSessionResult> {
    const sessionId = getRequestedSessionId(request) ?? randomUUID();
    const events: AgentEvent[] = [
      createMessageEvent(sessionId, "user", request.prompt),
      createMessageEvent(
        sessionId,
        "assistant",
        request.mode === "read-only"
          ? "I will inspect the scoped project context and answer without requesting edits or compile actions."
          : "I will inspect the scoped project context and prepare a reviewable patch."
      )
    ];
    const targetPath = request.activeFilePath ?? request.mainFilePath;

    if (targetPath === undefined) {
      events.push(
        createErrorEvent(sessionId, "Open a project file before starting the agent.")
      );
      return {
        sessionId,
        providerId: this.id,
        status: "failed",
        events
      };
    }

    events.push(
      createToolEvent(sessionId, "read-file", "running", `Reading ${targetPath}`, "low")
    );
    const snapshot = await broker.readFile(targetPath);
    events.push(
      createToolEvent(
        sessionId,
        "read-file",
        "succeeded",
        `Read ${snapshot.path}`,
        "low"
      )
    );

    if (request.mode === "read-only") {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          await createReadOnlyAgentResponse(request, snapshot, broker)
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    if (this.cancelledSessionIds.has(sessionId)) {
      return {
        sessionId,
        providerId: this.id,
        status: "cancelled",
        events
      };
    }

    const blockedWriteMessage = createBlockedOutsideRootWriteMessage(request.prompt);
    if (blockedWriteMessage !== undefined) {
      events.push(createMessageEvent(sessionId, "assistant", blockedWriteMessage));
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    const networkApproval = createNetworkApprovalRequest(request.prompt);
    if (networkApproval !== undefined) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          `This request needs external network access for ${networkApproval.resource}, which is approval-gated. If you deny it, I will continue with a local-only alternative or ask you to paste the data.`
        ),
        {
          id: randomUUID(),
          sessionId,
          createdAt: new Date().toISOString(),
          type: "approval",
          approvalId: randomUUID(),
          toolName: "network-fetch",
          risk: "high",
          prompt: `Allow external network fetch for ${networkApproval.resource}?`,
          status: "requested"
        }
      );
      return {
        sessionId,
        providerId: this.id,
        status: "awaiting-approval",
        events
      };
    }

    if (request.mode === "autonomous-local") {
      return await runMockAutonomousLocalSession({
        request,
        broker,
        sessionId,
        snapshot,
        baseEvents: events,
        isCancelled: () => this.cancelledSessionIds.has(sessionId)
      });
    }

    const preflightMessage = await createMockPreflightMessage({
      request,
      broker,
      events,
      sessionId
    });

    if (preflightMessage !== undefined) {
      events.push(createMessageEvent(sessionId, "assistant", preflightMessage));
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    const projectWideEdit = await createMockProjectWideEditPlan({
      request,
      broker,
      snapshot,
      sessionId
    });

    if (projectWideEdit !== undefined) {
      if (projectWideEdit.kind === "message") {
        events.push(
          createMessageEvent(sessionId, "assistant", projectWideEdit.message)
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      events.push(...projectWideEdit.events);
      return {
        sessionId,
        providerId: this.id,
        status: "awaiting-approval",
        events,
        changeset: projectWideEdit.primaryChangeSet,
        changesets: projectWideEdit.changeSets,
        ...(projectWideEdit.moveEntries === undefined
          ? {}
          : { moveEntries: projectWideEdit.moveEntries })
      };
    }

    const suggestion = createMockSuggestion(request, snapshot.contents);

    if (suggestion !== undefined) {
      events.push(createMessageEvent(sessionId, "assistant", suggestion));
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    const afterContents = createMockPatchContents(request, snapshot.contents);

    if (afterContents === snapshot.contents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          "I did not find a deterministic mock repair to propose for this request."
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    const auditMessage = createMockPrePatchMessage(request, snapshot.contents);
    if (auditMessage !== undefined) {
      events.push(createMessageEvent(sessionId, "assistant", auditMessage));
    }

    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "running",
        `Creating review patch for ${snapshot.path}`,
        "medium"
      )
    );
    const changeset = await broker.proposePatch(
      snapshot.path,
      snapshot.contents,
      afterContents,
      createMockPatchSummary(request, snapshot.path)
    );
    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "succeeded",
        `Created changeset ${changeset.id}`,
        "medium"
      ),
      {
        id: randomUUID(),
        sessionId,
        createdAt: new Date().toISOString(),
        type: "patch",
        changesetId: changeset.id,
        filePath: changeset.filePath,
        summary: changeset.summary,
        status: changeset.status
      },
      {
        id: randomUUID(),
        sessionId,
        createdAt: new Date().toISOString(),
        type: "approval",
        approvalId: randomUUID(),
        toolName: "apply-patch",
        risk: "medium",
        prompt: "Review the proposed patch before applying it to the project.",
        status: "requested"
      },
      {
        id: randomUUID(),
        sessionId,
        createdAt: new Date().toISOString(),
        type: "verification",
        status: "pending",
        summary: "Apply the patch to start compile verification."
      }
    );

    return {
      sessionId,
      providerId: this.id,
      status: "awaiting-approval",
      events,
      changeset,
      changesets: [changeset]
    };
  }

  cancelSession(sessionId: string): Promise<boolean> {
    this.cancelledSessionIds.add(sessionId);
    return Promise.resolve(true);
  }
}

export function isAgentToolAllowed(
  mode: AgentStartRequest["mode"],
  toolName: AgentToolName,
  approved: boolean
): boolean {
  if (toolName === "read-file" || toolName === "search-project") {
    return true;
  }

  if (mode === "read-only") {
    return false;
  }

  if (toolName === "network-fetch") {
    return false;
  }

  if (toolName === "propose-patch") {
    return (
      mode === "suggest" || mode === "apply-with-review" || mode === "autonomous-local"
    );
  }

  if (toolName === "move-entry") {
    return mode === "autonomous-local" || (mode === "apply-with-review" && approved);
  }

  if (toolName === "set-main-file") {
    return mode === "autonomous-local" || (mode === "apply-with-review" && approved);
  }

  if (toolName === "reject-patch") {
    return mode === "apply-with-review" && !approved;
  }

  if (toolName === "apply-patch" || toolName === "run-compile") {
    return mode === "autonomous-local" || (mode === "apply-with-review" && approved);
  }

  return false;
}

export function getAgentToolRisk(toolName: AgentToolName): AgentToolRisk {
  switch (toolName) {
    case "read-file":
    case "search-project":
      return "low";
    case "network-fetch":
    case "codex-exec":
    case "claude-code":
    case "propose-patch":
    case "run-compile":
      return "medium";
    case "move-entry":
    case "set-main-file":
    case "reject-patch":
    case "apply-patch":
      return "high";
  }
}

export function createFailedHostResult(
  providerId: AgentProviderId,
  message: string
): AgentSessionResult {
  const sessionId = randomUUID();
  return {
    sessionId,
    providerId,
    status: "failed",
    events: [createErrorEvent(sessionId, message)]
  };
}

function createMockPatchContents(
  request: AgentStartRequest,
  beforeContents: string
): string {
  const normalizedPrompt = request.prompt.toLowerCase();

  if (request.selectedText !== undefined && request.selectedText.trim().length > 0) {
    return replaceSelectedText(
      beforeContents,
      request.selectedText,
      createMockSelectionRevision(request)
    );
  }

  if (isTerminologyPrompt(request.prompt)) {
    return normalizeTerminology(beforeContents);
  }

  if (isApplyTitlePatchPrompt(request.prompt)) {
    return applyTitleAndKeywordsPatch(beforeContents);
  }

  if (isTableGenerationPrompt(request.prompt)) {
    return insertGeneratedLatexTable(beforeContents, request.prompt);
  }

  if (isFigureInsertionPrompt(request.prompt)) {
    return insertGeneratedFigureEnvironment(beforeContents, request.prompt);
  }

  if (isEquationGenerationPrompt(request.prompt)) {
    return insertGeneratedEquationEnvironment(beforeContents, request.prompt);
  }

  if (isPreambleCleanupPrompt(request.prompt)) {
    return cleanupPreamble(beforeContents);
  }

  if (isMissingCitationRepairPrompt(normalizedPrompt)) {
    return repairMissingCitationKey(beforeContents, request.prompt) ?? beforeContents;
  }

  if (isBibtexCleanupPrompt(normalizedPrompt)) {
    return cleanupBibtexEntry(beforeContents);
  }

  if (isNatbibAdaptationPrompt(normalizedPrompt)) {
    return adaptCitationCommandsToNatbib(beforeContents);
  }

  if (isImproveTableLayoutPrompt(normalizedPrompt)) {
    return improveExistingTableLayout(beforeContents);
  }

  if (request.diagnostic !== undefined || normalizedPrompt.includes("fix")) {
    if (isUnbalancedCaptionBraceRequest(request)) {
      return repairUnbalancedCaptionBraces(beforeContents);
    }

    if (isUndefinedControlSequenceRequest(request)) {
      return repairKnownUndefinedControlSequence(beforeContents);
    }

    if (isOverfullHBoxRequest(request)) {
      return fixOverfullHBox(beforeContents, request.diagnostic?.message);
    }

    if (normalizedPrompt.includes("syntax and prose")) {
      return ensureDocumentEnd(beforeContents).replace(
        "This prose should stay original.",
        "This prose was rewritten by the agent."
      );
    }

    return ensureDocumentEnd(beforeContents);
  }

  return beforeContents.trimEnd() + "\n\n% Mock agent suggestion.\n";
}

async function createMockPreflightMessage({
  request,
  broker,
  events,
  sessionId
}: {
  readonly request: AgentStartRequest;
  readonly broker: AgentToolBroker;
  readonly events: AgentEvent[];
  readonly sessionId: string;
}): Promise<string | undefined> {
  if (isNatbibAdaptationPrompt(request.prompt.toLowerCase())) {
    const snapshot = await broker.readFile(
      request.activeFilePath ?? request.mainFilePath ?? ""
    );
    if (!/\\usepackage(?:\[[^\]]*\])?\{natbib\}/u.test(snapshot.contents)) {
      return "Citation-style audit: I did not find natbib in the active file preamble, so I will not rewrite citation commands blindly.";
    }
  }

  if (isOverfullHBoxRequest(request)) {
    const snapshot = await broker.readFile(
      request.activeFilePath ?? request.mainFilePath ?? ""
    );
    if (
      !containsBreakableLongUrl(snapshot.contents) &&
      !containsWideTabular(snapshot.contents)
    ) {
      return "I can explain this overfull \\hbox warning from the local source, but I did not find a deterministic long-URL or wide-table fix to apply safely. Please confirm whether the problem is a URL, inline math, or table layout before I propose a patch.";
    }
  }

  if (isFigureInsertionPrompt(request.prompt)) {
    const figureRequest = parseFigureRequest(request.prompt);

    if (figureRequest === undefined) {
      return "I need a project-relative figure file path before proposing a figure environment.";
    }

    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "running",
        `Checking for ${figureRequest.filePath}`,
        "low"
      )
    );
    const matches = await broker.searchProject(figureRequest.filePath);
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "succeeded",
        `Checked for ${figureRequest.filePath}`,
        "low"
      )
    );

    if (
      !matches.some((match) => isSameProjectPath(match.path, figureRequest.filePath))
    ) {
      return `I could not find ${figureRequest.filePath} in the current project, so I will not propose a figure patch yet.`;
    }
  }

  if (isAmbiguousEquationPrompt(request.prompt)) {
    return "The requested equation notation is ambiguous. Please confirm the variables, loss terms, and label before I propose a source patch.";
  }

  const missingPackageFile = getMissingPackageFile(request.diagnostic?.message);
  if (missingPackageFile !== undefined) {
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "running",
        `Checking for ${missingPackageFile}`,
        "low"
      )
    );
    const matches = await broker.searchProject(missingPackageFile);
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "succeeded",
        `Checked for ${missingPackageFile}`,
        "low"
      )
    );

    if (!matches.some((match) => isSameProjectPath(match.path, missingPackageFile))) {
      return `I could not find ${missingPackageFile} in the current project, so this build failure cannot be fixed with a source patch alone. Add the local package file or install it in your TeX setup, then retry. I will not fetch files from the network or write outside the project without explicit approval.`;
    }

    return `${missingPackageFile} exists in the project, but LaTeX still could not load it. Check the package path, filename, and TeX search configuration before retrying. I will not fetch files from the network or write outside the project without explicit approval.`;
  }

  return undefined;
}

function replaceSelectedText(
  beforeContents: string,
  selectedText: string,
  revisedSelection: string
): string {
  if (revisedSelection === selectedText || !beforeContents.includes(selectedText)) {
    return beforeContents;
  }

  return beforeContents.replace(selectedText, revisedSelection);
}

function createMockSelectionRevision(request: AgentStartRequest): string {
  const selectedText = request.selectedText ?? "";
  const prompt = request.prompt.toLowerCase();

  if (isNotesToProsePrompt(prompt)) {
    return expandNotesToProse(selectedText);
  }

  if (
    prompt.includes("academic tone") ||
    prompt.includes("improve academic") ||
    prompt.includes("polish")
  ) {
    return improveAcademicTone(selectedText);
  }

  if (prompt.includes("shorten") && prompt.includes("abstract")) {
    return shortenSelectedAbstract(selectedText);
  }

  if (prompt.includes("explain") || request.mode === "read-only") {
    return selectedText;
  }

  return improveAcademicTone(selectedText);
}

function createMockSuggestion(
  request: AgentStartRequest,
  contents: string
): string | undefined {
  const prompt = request.prompt.toLowerCase();

  if (isMissingCitationRepairPrompt(prompt)) {
    return createCitationRepairSuggestion(request.prompt);
  }

  if (isExplainUnusedReferencePrompt(prompt)) {
    return createUnusedReferenceSuggestion(request.prompt, contents);
  }

  if (isTitleKeywordPrompt(prompt) && !isApplyTitlePatchPrompt(prompt)) {
    return [
      "Suggested title: Reviewable Agent Assistance for Local-First LaTeX Editing",
      "",
      "Suggested keywords: local-first writing tools; LaTeX editors; reviewable patches; compile verification; scholarly workflows",
      "",
      createManuscriptBasis(contents),
      "",
      "No source edits were applied. Choose a title manually or ask for an explicit title patch."
    ].join("\n");
  }

  return undefined;
}

async function createMockProjectWideEditPlan({
  request,
  broker,
  snapshot,
  sessionId
}: {
  readonly request: AgentStartRequest;
  readonly broker: AgentToolBroker;
  readonly snapshot: ProjectFileSnapshot;
  readonly sessionId: string;
}): Promise<
  | {
      readonly kind: "plan";
      readonly primaryChangeSet: HistoryChangeSet;
      readonly changeSets: readonly HistoryChangeSet[];
      readonly events: readonly AgentEvent[];
      readonly moveEntries?: readonly AgentMoveEntryOperation[];
    }
  | {
      readonly kind: "message";
      readonly message: string;
    }
  | undefined
> {
  if (isSplitMonolithicPrompt(request.prompt)) {
    const splitPlan = createSectionSplitPlan(snapshot);

    if (splitPlan === undefined) {
      return {
        kind: "message",
        message:
          "I need at least two top-level sections in the active file before I can propose a safe file split."
      };
    }

    const events: AgentEvent[] = [
      createMessageEvent(
        sessionId,
        "assistant",
        `Split plan: create ${splitPlan.sectionFiles
          .map((file) => file.path)
          .join(
            ", "
          )} and replace those section blocks in ${snapshot.path} with \\input commands.`
      )
    ];
    const changeSets: HistoryChangeSet[] = [];

    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "running",
        `Creating review patch for ${snapshot.path}`,
        "medium"
      )
    );
    const mainChangeSet = await broker.proposePatch(
      snapshot.path,
      snapshot.contents,
      splitPlan.updatedMainContents,
      `Split ${snapshot.path} into ${splitPlan.sectionFiles.length} files`
    );
    changeSets.push(mainChangeSet);
    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "succeeded",
        `Created changeset ${mainChangeSet.id}`,
        "medium"
      ),
      createPatchEvent(sessionId, mainChangeSet)
    );

    for (const sectionFile of splitPlan.sectionFiles) {
      events.push(
        createToolEvent(
          sessionId,
          "propose-patch",
          "running",
          `Creating new file patch for ${sectionFile.path}`,
          "medium"
        )
      );
      const changeset = await broker.proposePatch(
        sectionFile.path,
        "",
        sectionFile.contents,
        `Create ${sectionFile.path} from ${snapshot.path}`
      );
      changeSets.push(changeset);
      events.push(
        createToolEvent(
          sessionId,
          "propose-patch",
          "succeeded",
          `Created changeset ${changeset.id}`,
          "medium"
        ),
        createPatchEvent(sessionId, changeset)
      );
    }

    events.push(
      createApprovalEvent(sessionId),
      createVerificationEvent(
        sessionId,
        "pending",
        "Approve the split plan to create the new files, update the input structure, and run compile verification."
      )
    );

    return {
      kind: "plan",
      primaryChangeSet: mainChangeSet,
      changeSets,
      events
    };
  }

  if (isRenameFilePrompt(request.prompt)) {
    const renameRequest = parseRenameRequest(request.prompt);

    if (renameRequest === undefined) {
      return undefined;
    }

    const searchKey = stripExtension(renameRequest.fromPath);
    const events: AgentEvent[] = [
      createToolEvent(
        sessionId,
        "search-project",
        "running",
        `Checking references to ${renameRequest.fromPath}`,
        "low"
      )
    ];
    const matches = await broker.searchProject(searchKey);
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "succeeded",
        `Checked references to ${renameRequest.fromPath}`,
        "low"
      )
    );

    const sourceExists = matches.some((match) =>
      isSameProjectPath(match.path, renameRequest.fromPath)
    );

    if (!sourceExists || broker.moveEntry === undefined) {
      return sourceExists
        ? undefined
        : {
            kind: "message",
            message: `I could not find ${renameRequest.fromPath} in the current project, so I will not propose a rename plan.`
          };
    }

    const changeSets: HistoryChangeSet[] = [];
    const referenceMatches = matches.filter((match) => match.path.endsWith(".tex"));

    for (const match of referenceMatches) {
      const updatedContents = rewriteInputReference(
        match.contents,
        renameRequest.fromPath,
        renameRequest.toPath
      );

      if (updatedContents === match.contents) {
        continue;
      }

      events.push(
        createToolEvent(
          sessionId,
          "propose-patch",
          "running",
          `Creating reference update for ${match.path}`,
          "medium"
        )
      );
      const changeset = await broker.proposePatch(
        match.path,
        match.contents,
        updatedContents,
        `Update ${match.path} to reference ${renameRequest.toPath}`
      );
      changeSets.push(changeset);
      events.push(
        createToolEvent(
          sessionId,
          "propose-patch",
          "succeeded",
          `Created changeset ${changeset.id}`,
          "medium"
        ),
        createPatchEvent(sessionId, changeset)
      );
    }

    const primaryChangeSet =
      changeSets.find((changeset) => changeset.filePath === snapshot.path) ??
      changeSets[0];

    if (primaryChangeSet === undefined) {
      return {
        kind: "message",
        message: `I found ${renameRequest.fromPath}, but no \\input or \\include references needed updating in the scoped files.`
      };
    }

    events.push(
      createMessageEvent(
        sessionId,
        "assistant",
        `Rename plan: move ${renameRequest.fromPath} to ${renameRequest.toPath} and update ${changeSets.length} referencing file${changeSets.length === 1 ? "" : "s"}.`
      ),
      createApprovalEvent(sessionId),
      createVerificationEvent(
        sessionId,
        "pending",
        "Approve the rename plan to move the file, update references, and run compile verification."
      )
    );

    return {
      kind: "plan",
      primaryChangeSet,
      changeSets,
      events,
      moveEntries: [
        {
          fromPath: renameRequest.fromPath,
          toPath: renameRequest.toPath
        }
      ]
    };
  }

  if (isMissingFigureDiagnosisPrompt(request)) {
    const promptFigurePath =
      parsePromptFigureAssetPath(request.prompt) ??
      extractIncludeGraphicsReferences(snapshot.contents)[0]?.normalizedPath;

    if (promptFigurePath === undefined) {
      return {
        kind: "message",
        message:
          "I did not find a project-relative figure path to diagnose in the active source, so I cannot propose a safe figure-path patch yet."
      };
    }

    const events: AgentEvent[] = [
      createToolEvent(
        sessionId,
        "search-project",
        "running",
        `Checking for ${promptFigurePath}`,
        "low"
      )
    ];
    const exactMatches = await broker.searchProject(promptFigurePath);
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "succeeded",
        `Checked for ${promptFigurePath}`,
        "low"
      )
    );

    if (exactMatches.some((match) => isSameProjectPath(match.path, promptFigurePath))) {
      return isSupportedFigureAssetPath(
        request.compiler ?? "pdflatex",
        promptFigurePath
      )
        ? {
            kind: "message",
            message: `${promptFigurePath} exists in the current project, so I do not see a deterministic local path fix. Check the build log for image-decoder or bounding-box warnings before editing the source.`
          }
        : {
            kind: "message",
            message: `${promptFigurePath} exists in the current project, but its extension is not a safe match for ${request.compiler}. Convert the local asset to PDF, PNG, or JPEG before updating the source. I will not fetch replacement images from the network without approval.`
          };
    }

    const candidateKey = stripExtension(getProjectBaseName(promptFigurePath));
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "running",
        `Searching for local alternatives to ${promptFigurePath}`,
        "low"
      )
    );
    const candidateMatches = await broker.searchProject(candidateKey);
    events.push(
      createToolEvent(
        sessionId,
        "search-project",
        "succeeded",
        `Searched for local alternatives to ${promptFigurePath}`,
        "low"
      )
    );

    const candidatePaths = uniqueStrings(
      candidateMatches
        .map((match) => normalizeProjectPath(match.path))
        .filter(
          (path): path is string =>
            path !== undefined &&
            path !== promptFigurePath &&
            stripExtension(getProjectBaseName(path)) === candidateKey &&
            isSupportedFigureAssetPath(request.compiler ?? "pdflatex", path)
        )
    );

    if (candidatePaths.length !== 1) {
      return {
        kind: "message",
        message:
          candidatePaths.length === 0
            ? `I could not find ${promptFigurePath} or a single deterministic local replacement asset in the current project, so I will not invent or fetch an image path.`
            : `I found multiple plausible local figure assets for ${promptFigurePath}: ${candidatePaths.join(", ")}. I will not rewrite the source path automatically without confirmation.`
      };
    }

    const updatedContents = rewriteIncludeGraphicsPath(
      snapshot.contents,
      promptFigurePath,
      candidatePaths[0] ?? ""
    );

    if (updatedContents === snapshot.contents) {
      return {
        kind: "message",
        message: `I found ${candidatePaths[0]} as a likely local replacement asset, but I could not match the active \\includegraphics path cleanly enough to propose a safe patch.`
      };
    }

    events.push(
      createMessageEvent(
        sessionId,
        "assistant",
        `Figure diagnosis: ${promptFigurePath} is missing from the project, but I found a single local candidate at ${candidatePaths[0]}. I will update only that \\includegraphics path and leave asset files untouched.`
      ),
      createToolEvent(
        sessionId,
        "propose-patch",
        "running",
        `Creating figure path update for ${snapshot.path}`,
        "medium"
      )
    );
    const changeset = await broker.proposePatch(
      snapshot.path,
      snapshot.contents,
      updatedContents,
      `Update figure path from ${promptFigurePath} to ${candidatePaths[0]}`
    );
    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "succeeded",
        `Created changeset ${changeset.id}`,
        "medium"
      ),
      createPatchEvent(sessionId, changeset),
      createApprovalEvent(sessionId),
      createVerificationEvent(
        sessionId,
        "pending",
        "Approve the figure-path patch to update the local source reference and run compile verification."
      )
    );

    return {
      kind: "plan",
      primaryChangeSet: changeset,
      changeSets: [changeset],
      events
    };
  }

  return undefined;
}

function createMockPrePatchMessage(
  request: AgentStartRequest,
  contents: string
): string | undefined {
  if (isOverfullHBoxRequest(request)) {
    if (containsBreakableLongUrl(contents)) {
      return "Overfull-box audit: I found a long URL in the local source, so I will add a line-breaking package instead of suppressing box warnings globally.";
    }

    if (containsWideTabular(contents)) {
      return "Overfull-box audit: the warning appears consistent with a wide tabular block, so I will constrain the table to \\linewidth while preserving the existing values.";
    }
  }

  if (isNatbibAdaptationPrompt(request.prompt.toLowerCase())) {
    return /\\usepackage(?:\[[^\]]*\])?\{natbib\}/u.test(contents)
      ? "Citation-style audit: natbib is present in the preamble, so I will adapt unsupported citation commands to natbib-compatible forms."
      : "Citation-style audit: I did not find natbib in the active file preamble, so I will not rewrite citation commands blindly.";
  }

  if (isTableGenerationPrompt(request.prompt)) {
    const parsedTable = parsePromptTable(request.prompt);

    if (parsedTable !== undefined && parsedTable.rows[0]?.length !== undefined) {
      const columnCount = parsedTable.rows[0].length;

      return columnCount > 6
        ? `Table layout advice: the pasted data has ${columnCount} columns, so review the generated table for width. Consider splitting columns, reducing precision, or using a landscape/table-width strategy before submission.`
        : "Generated a reviewable LaTeX table from the pasted rows.";
    }
  }

  if (isFigureInsertionPrompt(request.prompt)) {
    const figureRequest = parseFigureRequest(request.prompt);

    return figureRequest === undefined
      ? undefined
      : `Figure asset check passed for ${figureRequest.filePath}. I will add only the required graphicx package and figure environment.`;
  }

  if (isEquationGenerationPrompt(request.prompt)) {
    return "Generated a reviewable display equation from the requested notation.";
  }

  if (isPreambleCleanupPrompt(request.prompt)) {
    return "Preamble audit: duplicate package declarations can be merged safely. Risky package changes require review before applying.";
  }

  if (isImproveTableLayoutPrompt(request.prompt)) {
    return "Table layout audit: I will preserve the current numeric values and wrap the existing tabular block in a width-constrained layout instead of rewriting the data.";
  }

  if (isTerminologyPrompt(request.prompt)) {
    const variants = collectTerminologyVariants(contents);
    const domainTerms = variants.includes("corpus") ? ["corpus"] : [];

    return [
      `Terminology audit: found ${formatList(variants)}. I will use "dataset" consistently in prose while preserving LaTeX citations, labels, and command arguments.`,
      domainTerms.length === 0
        ? "Domain-specific terms for confirmation: none detected."
        : `Domain-specific terms for confirmation: ${formatList(domainTerms)}.`
    ].join("\n");
  }

  return undefined;
}

async function runMockAutonomousLocalSession({
  request,
  broker,
  sessionId,
  snapshot,
  baseEvents,
  isCancelled
}: {
  readonly request: AgentStartRequest;
  readonly broker: AgentToolBroker;
  readonly sessionId: string;
  readonly snapshot: ProjectFileSnapshot;
  readonly baseEvents: readonly AgentEvent[];
  readonly isCancelled: () => boolean;
}): Promise<AgentSessionResult> {
  const events: AgentEvent[] = [...baseEvents];
  const maxTurns = Math.max(1, Math.min(request.maxTurns ?? 4, 10));
  let currentContents = snapshot.contents;
  let currentSnapshot = snapshot;
  let latestChangeSet: HistoryChangeSet | undefined;
  let latestBuild: BuildResult | undefined;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (isCancelled()) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          "Autonomous repair was cancelled before the next turn started."
        )
      );
      return {
        sessionId,
        providerId: "mock",
        status: "cancelled",
        events,
        ...(latestBuild === undefined ? {} : { buildResult: latestBuild })
      };
    }

    events.push(
      createMessageEvent(
        sessionId,
        "assistant",
        `Autonomous turn ${turn} of ${maxTurns}: applying the smallest local repair, then running compile verification.`
      )
    );

    const turnRequest =
      latestBuild?.diagnostics[0] === undefined
        ? request
        : { ...request, diagnostic: latestBuild.diagnostics[0] };
    const afterContents = createMockPatchContents(turnRequest, currentContents);

    if (afterContents === currentContents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          "Autonomous repair stopped because I could not find another deterministic local edit to apply safely."
        )
      );
      return {
        sessionId,
        providerId: "mock",
        status: "completed",
        events,
        ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
        ...(latestBuild === undefined ? {} : { buildResult: latestBuild })
      };
    }

    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "running",
        `Creating autonomous patch for ${currentSnapshot.path}`,
        "medium"
      )
    );
    const proposed = await broker.proposePatch(
      currentSnapshot.path,
      currentContents,
      afterContents,
      createMockPatchSummary(turnRequest, currentSnapshot.path)
    );
    latestChangeSet = proposed;
    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "succeeded",
        `Created changeset ${proposed.id}`,
        "medium"
      ),
      createPatchEvent(sessionId, proposed)
    );

    if (isCancelled()) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          "Autonomous repair was cancelled before the proposed patch was applied. No new file write was made in this turn."
        )
      );
      return {
        sessionId,
        providerId: "mock",
        status: "cancelled",
        events,
        changeset: proposed
      };
    }

    events.push(
      createToolEvent(
        sessionId,
        "apply-patch",
        "running",
        `Applying ${proposed.summary}`,
        "high"
      )
    );
    const applied = await broker.applyPatch(proposed.id);
    latestChangeSet = applied;
    events.push(
      createToolEvent(
        sessionId,
        "apply-patch",
        "succeeded",
        `Applied ${applied.summary}`,
        "high"
      ),
      createPatchEvent(sessionId, applied),
      createVerificationEvent(
        sessionId,
        "running",
        `Compile verification started after autonomous turn ${turn}.`
      )
    );

    events.push(
      createToolEvent(
        sessionId,
        "run-compile",
        "running",
        "Running compile verification",
        "medium"
      )
    );
    const buildResult = await broker.runCompile();
    latestBuild = buildResult;
    events.push(
      createToolEvent(
        sessionId,
        "run-compile",
        buildResult.status === "succeeded" ? "succeeded" : "failed",
        `Compile ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${
          buildResult.diagnostics.length === 1 ? "" : "s"
        }`,
        "medium"
      ),
      createVerificationEvent(
        sessionId,
        buildResult.status === "succeeded" ? "passed" : "failed",
        `Compile verification ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${
          buildResult.diagnostics.length === 1 ? "" : "s"
        }`,
        buildResult.jobId
      )
    );

    currentSnapshot = await broker.readFile(currentSnapshot.path);
    currentContents = currentSnapshot.contents;

    if (buildResult.status === "succeeded") {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          `Autonomous repair completed successfully in ${turn} turn${turn === 1 ? "" : "s"}.`
        )
      );
      return {
        sessionId,
        providerId: "mock",
        status: "completed",
        events,
        ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
        buildResult
      };
    }
  }

  events.push(
    createMessageEvent(
      sessionId,
      "assistant",
      `Autonomous repair stopped after reaching the configured limit of ${maxTurns} turn${maxTurns === 1 ? "" : "s"}.`
    )
  );

  return {
    sessionId,
    providerId: "mock",
    status: "completed",
    events,
    ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
    ...(latestBuild === undefined ? {} : { buildResult: latestBuild })
  };
}

function expandNotesToProse(selectedText: string): string {
  const lines = selectedText.split(/\r?\n/u);
  const todoLines = lines.filter((line) => /\bTODO\b/iu.test(line));
  const noteFragments = lines
    .filter((line) => !/\bTODO\b/iu.test(line))
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => ensureSentence(escapeLatexTextSegments(line)));

  if (noteFragments.length === 0) {
    return selectedText;
  }

  const paragraph =
    noteFragments.length === 1
      ? (noteFragments[0] ?? "")
      : `${noteFragments.slice(0, -1).join(" ")} ${noteFragments.at(-1) ?? ""}`;

  return [...todoLines, paragraph]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

function improveAcademicTone(selectedText: string): string {
  let revised = selectedText;

  const replacements: readonly [RegExp, string][] = [
    [/\ba bit rough\b/giu, "preliminary"],
    [/\bkinda\b/giu, "somewhat"],
    [/\breally\b/giu, "substantially"],
    [/\bworks well\b/giu, "performs effectively"],
    [/\bgot\b/giu, "obtained"],
    [/\bwe show that\b/giu, "we demonstrate that"],
    [/\bthis shows that\b/giu, "this demonstrates that"],
    [/\bthings\b/giu, "factors"]
  ];

  for (const [pattern, replacement] of replacements) {
    revised = revised.replace(pattern, replacement);
  }

  if (revised !== selectedText) {
    return revised;
  }

  return selectedText.replace(
    /\b(our|the) method is good\b/iu,
    (_match, determiner: string) => `${determiner} method is effective`
  );
}

function shortenSelectedAbstract(selectedText: string): string {
  const environmentMatch =
    /^(?<prefix>\s*\\begin\{abstract\}\s*)(?<body>[\s\S]*?)(?<suffix>\s*\\end\{abstract\}\s*)$/u.exec(
      selectedText
    );
  const prefix = environmentMatch?.groups?.prefix ?? "";
  const suffix = environmentMatch?.groups?.suffix ?? "";
  const body = environmentMatch?.groups?.body ?? selectedText;
  const sentences = splitSentences(body)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const requiredSentences = sentences.filter((sentence) =>
    /\b(contribution|contributions|we contribute|this paper contributes|our contributions)\b/iu.test(
      sentence
    )
  );
  const citationSentences = sentences
    .filter((sentence) =>
      /\\(?:cite|citep|citet|parencite|ref|autoref)\{/u.test(sentence)
    )
    .slice(0, 1);
  const selectedSentences = selectAbstractSentencesWithinLimit({
    sentences,
    requiredSentences,
    preferredSentences: uniqueStrings([...sentences.slice(0, 2), ...citationSentences]),
    limit: 150
  });
  const shortenedBody = trimToWordLimit(
    selectedSentences.length === 0 ? body : selectedSentences.join(" "),
    150
  );

  return `${prefix}${shortenedBody}${suffix}`;
}

function selectAbstractSentencesWithinLimit({
  sentences,
  requiredSentences,
  preferredSentences,
  limit
}: {
  readonly sentences: readonly string[];
  readonly requiredSentences: readonly string[];
  readonly preferredSentences: readonly string[];
  readonly limit: number;
}): readonly string[] {
  const selectedSentences = new Set(requiredSentences);
  const orderedSelectedSentences = () =>
    sentences.filter((sentence) => selectedSentences.has(sentence));
  const selectedWordCount = () => countWords(orderedSelectedSentences().join(" "));

  for (const sentence of preferredSentences) {
    if (selectedSentences.has(sentence)) {
      continue;
    }

    selectedSentences.add(sentence);
    if (selectedWordCount() > limit) {
      selectedSentences.delete(sentence);
    }
  }

  return orderedSelectedSentences();
}

function splitSentences(value: string): readonly string[] {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .split(/(?<=[.!?])\s+/u);
}

function trimToWordLimit(value: string, limit: number): string {
  const words = value.trim().split(/\s+/u).filter(Boolean);

  if (words.length <= limit) {
    return value.trim();
  }

  return `${words
    .slice(0, limit)
    .join(" ")
    .replace(/[,:;]$/u, "")}.`;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function normalizeTerminology(contents: string): string {
  return transformLatexTextSegments(contents, (segment) =>
    segment
      .replace(/\bdata set\b/giu, "dataset")
      .replace(/\bdata sets\b/giu, "datasets")
      .replace(/\bcorpus\b/giu, "dataset")
      .replace(/\bcorpora\b/giu, "datasets")
  );
}

function applyTitleAndKeywordsPatch(contents: string): string {
  const title = "Reviewable Agent Assistance for Local-First LaTeX Editing";
  const keywords =
    "local-first writing tools; LaTeX editors; reviewable patches; compile verification; scholarly workflows";
  const withTitle = /\\title\{[^}]*\}/u.test(contents)
    ? contents.replace(/\\title\{[^}]*\}/u, `\\title{${title}}`)
    : `\\title{${title}}\n${contents}`;

  if (/\\keywords\{[^}]*\}/u.test(withTitle)) {
    return withTitle.replace(/\\keywords\{[^}]*\}/u, `\\keywords{${keywords}}`);
  }

  if (/%\s*Keywords:/iu.test(withTitle)) {
    return withTitle.replace(/%\s*Keywords:.*$/imu, `% Keywords: ${keywords}`);
  }

  return withTitle.replace(/(\\title\{[^}]*\})/u, `$1\n% Keywords: ${keywords}`);
}

function repairUnbalancedCaptionBraces(contents: string): string {
  const lines = contents.split("\n");
  const repairedLines = [...lines];

  for (const [index, line] of lines.entries()) {
    if (!line.includes("\\caption{")) {
      continue;
    }

    const missingBraceCount = countMissingClosingBraces(line);
    if (missingBraceCount <= 0) {
      continue;
    }

    repairedLines[index] = `${line}${"}".repeat(missingBraceCount)}`;
    return repairedLines.join("\n");
  }

  return contents;
}

function insertGeneratedLatexTable(contents: string, prompt: string): string {
  const parsedTable = parsePromptTable(prompt);

  if (parsedTable === undefined) {
    return contents;
  }

  const tableEnvironment = createLatexTableEnvironment(parsedTable, contents);

  if (contents.includes("\\end{document}")) {
    return contents.replace(
      /\n?\\end\{document\}/u,
      `\n\n${tableEnvironment}\n\n\\end{document}`
    );
  }

  return `${contents.trimEnd()}\n\n${tableEnvironment}\n`;
}

function insertGeneratedFigureEnvironment(contents: string, prompt: string): string {
  const figureRequest = parseFigureRequest(prompt);

  if (figureRequest === undefined) {
    return contents;
  }

  const withGraphicx = ensureLatexPackage(contents, "graphicx");
  const figureEnvironment = [
    "\\begin{figure}[ht]",
    "\\centering",
    `\\includegraphics[width=0.8\\linewidth]{${escapeLatexPath(figureRequest.filePath)}}`,
    `\\caption{${escapeLatexTableCell(figureRequest.caption)}}`,
    `\\label{${figureRequest.label}}`,
    "\\end{figure}"
  ].join("\n");

  return insertBlockBeforeDocumentEnd(withGraphicx, figureEnvironment);
}

function insertGeneratedEquationEnvironment(contents: string, prompt: string): string {
  const equationRequest = parseEquationRequest(prompt);

  if (equationRequest === undefined) {
    return contents;
  }

  const equationEnvironment = [
    "\\begin{equation}",
    `\\label{${equationRequest.label}}`,
    equationRequest.expression,
    "\\end{equation}"
  ].join("\n");

  return insertBlockBeforeDocumentEnd(contents, equationEnvironment);
}

function cleanupPreamble(contents: string): string {
  const lines = contents.split("\n");
  const seenPackages = new Map<string, number>();
  const removedPackageNames = new Set<string>();
  const cleanedLines: string[] = [];

  for (const line of lines) {
    const packageMatch = /^(\s*)\\usepackage(?:\[([^\]]*)\])?\{([^}]+)\}(\s*)$/u.exec(
      line
    );

    if (packageMatch === null) {
      cleanedLines.push(line);
      continue;
    }

    const [, indent = "", options = "", packageList = "", trailing = ""] = packageMatch;
    const packageNames = packageList
      .split(",")
      .map((packageName) => packageName.trim())
      .filter((packageName) => packageName.length > 0);

    if (packageNames.length !== 1) {
      cleanedLines.push(line);
      continue;
    }

    const packageName = packageNames[0] ?? "";
    const existingIndex = seenPackages.get(packageName);

    if (existingIndex === undefined) {
      seenPackages.set(packageName, cleanedLines.length);
      cleanedLines.push(line);
      continue;
    }

    removedPackageNames.add(packageName);
    const existingLine = cleanedLines[existingIndex] ?? "";
    const existingOptions = parsePackageOptions(existingLine);
    const mergedOptions = mergePackageOptions(existingOptions, options);
    cleanedLines[existingIndex] =
      mergedOptions.length === 0
        ? `${indent}\\usepackage{${packageName}}${trailing}`
        : `${indent}\\usepackage[${mergedOptions.join(",")}]{${packageName}}${trailing}`;
  }

  if (removedPackageNames.size === 0) {
    return contents;
  }

  return cleanedLines.join("\n");
}

function fixOverfullHBox(
  contents: string,
  diagnosticMessage: string | undefined
): string {
  if (
    containsBreakableLongUrl(contents) ||
    /overfull \\hbox/iu.test(diagnosticMessage ?? "")
  ) {
    const withXurl = ensureLatexPackage(contents, "xurl");
    if (containsBreakableLongUrl(withXurl)) {
      return withXurl;
    }
  }

  if (containsWideTabular(contents)) {
    return improveExistingTableLayout(contents);
  }

  return contents;
}

function improveExistingTableLayout(contents: string): string {
  const tabularMatch = /\\begin\{tabular\}\{[^}]+\}[\s\S]*?\\end\{tabular\}/u.exec(
    contents
  );

  if (tabularMatch === null) {
    return contents;
  }

  if (tabularMatch[0].includes("\\resizebox{\\linewidth}{!}{%")) {
    return ensureLatexPackage(contents, "graphicx");
  }

  const wrappedTabular = `\\resizebox{\\linewidth}{!}{%\n${tabularMatch[0]}\n}`;
  const rewritten = contents.replace(tabularMatch[0], wrappedTabular);
  return ensureLatexPackage(rewritten, "graphicx");
}

type ParsedPromptTable = {
  readonly rows: readonly (readonly string[])[];
  readonly caption: string;
  readonly label: string;
};

function parsePromptTable(prompt: string): ParsedPromptTable | undefined {
  const rows = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes(",") || line.includes("\t"))
    .map(parseDelimitedRow)
    .filter((row) => row.length > 1);

  if (rows.length < 2) {
    return undefined;
  }

  const width = rows[0]?.length ?? 0;
  const normalizedRows = rows
    .filter((row) => row.length === width)
    .map((row) => row.map((cell) => cell.trim()));

  if (normalizedRows.length < 2) {
    return undefined;
  }

  return {
    rows: normalizedRows,
    caption: parsePromptValue(prompt, "caption") ?? "Experiment results",
    label:
      normalizeLatexLabel(parsePromptValue(prompt, "label")) ?? "tab:experiment-results"
  };
}

function parseDelimitedRow(line: string): readonly string[] {
  const delimiter = line.includes("\t") && !line.includes(",") ? "\t" : ",";
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function createLatexTableEnvironment(
  parsedTable: ParsedPromptTable,
  existingContents: string
): string {
  const [header = [], ...bodyRows] = parsedTable.rows;
  const useBooktabs = /\\usepackage(?:\[[^\]]*\])?\{booktabs\}/u.test(existingContents);
  const alignments = header.map((_, index) =>
    index === 0 || bodyRows.some((row) => !isNumericTableCell(row[index] ?? ""))
      ? "l"
      : "r"
  );
  const lines = [
    "\\begin{table}[ht]",
    "\\centering",
    `\\caption{${escapeLatexTableCell(parsedTable.caption)}}`,
    `\\label{${parsedTable.label}}`,
    `\\begin{tabular}{${alignments.join("")}}`,
    useBooktabs ? "\\toprule" : "\\hline",
    `${formatLatexTableRow(header)} \\\\`,
    useBooktabs ? "\\midrule" : "\\hline",
    ...bodyRows.map((row) => `${formatLatexTableRow(row)} \\\\`),
    useBooktabs ? "\\bottomrule" : "\\hline",
    "\\end{tabular}",
    "\\end{table}"
  ];

  return lines.join("\n");
}

type ParsedFigureRequest = {
  readonly filePath: string;
  readonly caption: string;
  readonly label: string;
};

type IncludeGraphicsReference = {
  readonly rawPath: string;
  readonly normalizedPath?: string;
};

function parseFigureRequest(prompt: string): ParsedFigureRequest | undefined {
  const filePath = normalizeProjectPath(
    parsePromptField(prompt, "file") ??
      parsePromptField(prompt, "path") ??
      parsePromptField(prompt, "figure") ??
      parsePromptField(prompt, "image") ??
      /(?:^|\s|`)((?:figures|images|plots)\/[A-Za-z0-9._/-]+\.(?:pdf|png|jpe?g))(?=`|\s|$)/iu.exec(
        prompt
      )?.[1]
  );

  if (filePath === undefined) {
    return undefined;
  }

  const baseName = filePath
    .split("/")
    .at(-1)
    ?.replace(/\.[^.]+$/u, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();

  return {
    filePath,
    caption: parsePromptField(prompt, "caption") ?? "Result plot",
    label:
      normalizeLatexLabel(parsePromptField(prompt, "label")) ??
      `fig:${baseName === undefined || baseName.length === 0 ? "result" : baseName}`
  };
}

function extractIncludeGraphicsReferences(
  contents: string
): readonly IncludeGraphicsReference[] {
  return Array.from(contents.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/gu))
    .map((match) => (match[1] ?? "").trim())
    .filter((rawPath) => rawPath.length > 0)
    .map((rawPath) => {
      const normalizedPath = normalizeProjectPath(rawPath);
      return {
        rawPath,
        ...(normalizedPath === undefined ? {} : { normalizedPath })
      };
    });
}

function parsePromptFigureAssetPath(prompt: string): string | undefined {
  return normalizeProjectPath(
    /(?:^|\s|`)((?:figures|images|plots|assets)\/[A-Za-z0-9._/-]+\.(?:pdf|png|jpe?g|eps|bmp|gif))(?=`|\s|$)/iu.exec(
      prompt
    )?.[1]
  );
}

function rewriteIncludeGraphicsPath(
  contents: string,
  fromPath: string,
  toPath: string
): string {
  const fromWithoutExtension = stripExtension(fromPath);
  const toWithoutExtension = stripExtension(toPath);

  return contents.replace(
    /(\\includegraphics(?:\[[^\]]*\])?\{)([^}]+)(\})/gu,
    (fullMatch, prefix, rawPath, suffix) => {
      const normalizedPath = normalizeProjectPath((rawPath as string).trim());
      if (normalizedPath === fromPath) {
        return `${prefix}${escapeLatexPath(toPath)}${suffix}`;
      }

      if (normalizedPath === fromWithoutExtension) {
        return `${prefix}${escapeLatexPath(toWithoutExtension)}${suffix}`;
      }

      return fullMatch;
    }
  );
}

function getProjectBaseName(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function getProjectExtension(path: string): string {
  return /\.[^.]+$/u.exec(path)?.[0]?.toLowerCase() ?? "";
}

function isSupportedFigureAssetPath(compiler: LatexCompiler, path: string): boolean {
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

type ParsedEquationRequest = {
  readonly expression: string;
  readonly label: string;
};

function parseEquationRequest(prompt: string): ParsedEquationRequest | undefined {
  const label = normalizeLatexLabel(parsePromptField(prompt, "label")) ?? "eq:loss";
  const normalized = prompt.toLowerCase();

  if (
    normalized.includes("cross entropy") ||
    normalized.includes("cross-entropy") ||
    normalized.includes("classification loss")
  ) {
    return {
      expression:
        "\\mathcal{L} = -\\frac{1}{N} \\sum_{i=1}^{N} \\sum_{c=1}^{C} y_{ic}\\log\\hat{y}_{ic}",
      label
    };
  }

  if (
    normalized.includes("mean squared error") ||
    normalized.includes("mse") ||
    normalized.includes("squared error")
  ) {
    return {
      expression:
        "\\mathcal{L} = \\frac{1}{N} \\sum_{i=1}^{N} \\left(y_i - \\hat{y}_i\\right)^2",
      label
    };
  }

  if (normalized.includes("loss")) {
    return {
      expression:
        "\\mathcal{L}(\\theta) = \\frac{1}{N} \\sum_{i=1}^{N} \\ell(f_\\theta(x_i), y_i)",
      label
    };
  }

  return undefined;
}

function insertBlockBeforeDocumentEnd(contents: string, block: string): string {
  if (contents.includes("\\end{document}")) {
    return contents.replace(/\n?\\end\{document\}/u, `\n\n${block}\n\n\\end{document}`);
  }

  return `${contents.trimEnd()}\n\n${block}\n`;
}

function ensureLatexPackage(contents: string, packageName: string): string {
  const packagePattern = new RegExp(
    `\\\\usepackage(?:\\[[^\\]]*\\])?\\{(?:[^}]*,)?${packageName}(?:,[^}]*)?\\}`,
    "u"
  );

  if (packagePattern.test(contents)) {
    return contents;
  }

  if (/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/u.test(contents)) {
    return contents.replace(
      /(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/u,
      `$1\n\\usepackage{${packageName}}`
    );
  }

  return `\\usepackage{${packageName}}\n${contents}`;
}

function parsePackageOptions(packageLine: string): readonly string[] {
  return (
    /^(\s*)\\usepackage(?:\[([^\]]*)\])?\{([^}]+)\}(\s*)$/u.exec(packageLine)?.[2] ?? ""
  )
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

function mergePackageOptions(
  existingOptions: readonly string[],
  newOptions: string
): readonly string[] {
  return uniqueStrings([
    ...existingOptions,
    ...newOptions
      .split(",")
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
  ]);
}

function formatLatexTableRow(row: readonly string[]): string {
  return row.map(escapeLatexTableCell).join(" & ");
}

function parsePromptValue(
  prompt: string,
  key: "caption" | "label"
): string | undefined {
  return parsePromptField(prompt, key);
}

function parsePromptField(prompt: string, key: string): string | undefined {
  const match = new RegExp(`${key}\\s*:\\s*([^\\n]+)`, "iu").exec(prompt);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0
    ? undefined
    : stripPromptQuotes(value);
}

function stripPromptQuotes(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/gu, "")
    .replace(/^["']|["']$/gu, "")
    .trim();
}

function normalizeLatexLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value
    .trim()
    .replace(/\\label\{([^}]+)\}/u, "$1")
    .replace(/[^A-Za-z0-9:._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function escapeLatexTableCell(value: string): string {
  return value.trim().replace(/([&#%_])/gu, "\\$1");
}

function escapeLatexPath(value: string): string {
  return value.trim().replace(/([#%])/gu, "\\$1");
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

function isNumericTableCell(value: string): boolean {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:%|\\%)?$/u.test(value.trim());
}

function countMissingClosingBraces(value: string): number {
  let depth = 0;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth;
}

function createManuscriptBasis(contents: string): string {
  const normalized = contents.replace(/\s+/gu, " ").trim();
  const checks: readonly (readonly [string, RegExp])[] = [
    ["local-first", /\blocal-first\b/iu],
    ["LaTeX editing", /\\LaTeX|\bLaTeX\b/iu],
    ["reviewable patches", /\breviewable\b|\bpatch(?:es)?\b/iu],
    ["compile verification", /\bcompile\b|\bverification\b/iu],
    ["agent assistance", /\bagent\b/iu]
  ];
  const basisTerms = checks
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([label]) => label);

  return basisTerms.length === 0
    ? "Basis: the suggestions are derived from the active manuscript content."
    : `Basis: the active manuscript emphasizes ${formatList(basisTerms)}.`;
}

function collectTerminologyVariants(contents: string): readonly string[] {
  const variants: string[] = [];
  const checks: readonly [string, RegExp][] = [
    ["dataset", /\bdataset\b/iu],
    ["data set", /\bdata set\b/iu],
    ["corpus", /\bcorpus\b/iu]
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(contents)) {
      variants.push(label);
    }
  }

  return variants;
}

function escapeLatexTextSegments(value: string): string {
  return transformLatexTextSegments(value, (segment) =>
    segment.replace(/([&#%_])/gu, "\\$1")
  );
}

function transformLatexTextSegments(
  value: string,
  transform: (segment: string) => string
): string {
  return value
    .split(/(\\[A-Za-z]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})*)/u)
    .map((segment) => (segment.startsWith("\\") ? segment : transform(segment)))
    .join("");
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatList(values: readonly string[]): string {
  if (values.length === 0) {
    return "none";
  }

  if (values.length === 1) {
    return `"${values[0] ?? ""}"`;
  }

  return `${values
    .slice(0, -1)
    .map((value) => `"${value}"`)
    .join(", ")} and "${values.at(-1) ?? ""}"`;
}

function isNotesToProsePrompt(prompt: string): boolean {
  return (
    prompt.includes("rough notes") ||
    prompt.includes("bullet notes") ||
    (prompt.includes("notes") && prompt.includes("prose"))
  );
}

function isTerminologyPrompt(prompt: string): boolean {
  return (
    prompt.includes("terminology") ||
    prompt.includes("normalize") ||
    prompt.includes("consistent")
  );
}

function isTitleKeywordPrompt(prompt: string): boolean {
  return prompt.includes("title") && prompt.includes("keyword");
}

function isMissingCitationRepairPrompt(prompt: string): boolean {
  return prompt.includes("fix the missing citation key");
}

function isBibtexCleanupPrompt(prompt: string): boolean {
  return (
    prompt.includes("clean") &&
    (prompt.includes("bibtex") ||
      prompt.includes(".bib") ||
      prompt.includes("bibliography"))
  );
}

function isNatbibAdaptationPrompt(prompt: string): boolean {
  return (
    prompt.includes("natbib") ||
    (prompt.includes("citation") &&
      prompt.includes("style") &&
      (prompt.includes("textcite") || prompt.includes("adapt")))
  );
}

function isExplainUnusedReferencePrompt(prompt: string): boolean {
  return (
    prompt.includes("attached bibliography entry") &&
    prompt.includes("only attached key")
  );
}

function isApplyTitlePatchPrompt(prompt: string): boolean {
  return (
    isTitleKeywordPrompt(prompt) &&
    (prompt.includes("apply") ||
      prompt.includes("patch") ||
      prompt.includes("update") ||
      prompt.includes("replace"))
  );
}

function isTableGenerationPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("table") &&
    (normalized.includes("csv") ||
      normalized.includes("pasted data") ||
      normalized.includes("rows") ||
      parsePromptTable(prompt) !== undefined)
  );
}

function isImproveTableLayoutPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("table") &&
    (normalized.includes("layout") ||
      normalized.includes("page width") ||
      normalized.includes("fit") ||
      normalized.includes("width") ||
      normalized.includes("alignment") ||
      normalized.includes("clipped"))
  );
}

function isFigureInsertionPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes("figure") && normalized.includes("insert");
}

function isMissingFigureDiagnosisPrompt(request: AgentStartRequest): boolean {
  const prompt = request.prompt.toLowerCase();
  const diagnosticMessage = request.diagnostic?.message.toLowerCase() ?? "";

  return (
    (prompt.includes("figure") &&
      (prompt.includes("missing") ||
        prompt.includes("blank") ||
        prompt.includes("not shown") ||
        prompt.includes("not showing"))) ||
    diagnosticMessage.includes("includegraphics") ||
    diagnosticMessage.includes("not found")
  );
}

function isEquationGenerationPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    (normalized.includes("equation") || normalized.includes("display math")) &&
    (normalized.includes("create") ||
      normalized.includes("convert") ||
      normalized.includes("insert"))
  );
}

function isAmbiguousEquationPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    isEquationGenerationPrompt(prompt) &&
    (normalized.includes("ambiguous") ||
      (normalized.includes("loss") &&
        !normalized.includes("cross entropy") &&
        !normalized.includes("cross-entropy") &&
        !normalized.includes("mean squared error") &&
        !normalized.includes("mse") &&
        !normalized.includes("classification loss")))
  );
}

function isPreambleCleanupPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes("preamble") && normalized.includes("clean");
}

function createBlockedOutsideRootWriteMessage(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase();
  const outsideRootTarget =
    /(?:^|\s)(\/tmp\/[^\s`'"]+|\/users\/[^\s`'"]+|[a-z]:\\[^\s`'"]+)/iu.exec(
      prompt
    )?.[1];

  if (
    outsideRootTarget === undefined &&
    !normalized.includes("another project") &&
    !normalized.includes("outside project") &&
    !normalized.includes("outside root")
  ) {
    return undefined;
  }

  return [
    outsideRootTarget === undefined
      ? "I blocked this request because it asks for a write outside the active project root."
      : `I blocked this request because ${outsideRootTarget} is outside the active project root.`,
    "Local-first safety policy allows edits only inside the current project unless expanded context is explicitly granted.",
    "No patch, file write, or external project modification was proposed."
  ].join("\n\n");
}

function createNetworkApprovalRequest(
  prompt: string
): { readonly resource: string } | undefined {
  const normalized = prompt.toLowerCase();
  const doi = /\b10\.\d{4,9}\/[^\s]+/iu.exec(prompt)?.[0];
  const url = /https?:\/\/[^\s`'"]+/iu.exec(prompt)?.[0];

  if (
    doi === undefined &&
    url === undefined &&
    !normalized.includes("fetch doi") &&
    !normalized.includes("doi metadata") &&
    !normalized.includes("web content") &&
    !normalized.includes("look it up online") &&
    !normalized.includes("download from")
  ) {
    return undefined;
  }

  return {
    resource: doi ?? url ?? "external web content"
  };
}

function isOverfullHBoxRequest(request: AgentStartRequest): boolean {
  const prompt = request.prompt.toLowerCase();
  const diagnosticMessage = request.diagnostic?.message.toLowerCase() ?? "";

  return (
    diagnosticMessage.includes("overfull \\hbox") ||
    (prompt.includes("overfull") && prompt.includes("hbox"))
  );
}

function containsBreakableLongUrl(contents: string): boolean {
  return /\\url\{https?:\/\/[^}\s]{40,}\}/u.test(contents);
}

function containsWideTabular(contents: string): boolean {
  const tabularMatch = /\\begin\{tabular\}\{([^}]+)\}/u.exec(contents);
  if (tabularMatch === null) {
    return false;
  }

  const alignmentSpec = (tabularMatch[1] ?? "").replace(/[^lcrpmbxX@|]/gu, "");
  return alignmentSpec.length >= 6;
}

function isUnbalancedCaptionBraceRequest(request: AgentStartRequest): boolean {
  const prompt = request.prompt.toLowerCase();
  const diagnosticMessage = request.diagnostic?.message.toLowerCase() ?? "";

  return (
    (prompt.includes("unbalanced") && prompt.includes("brace")) ||
    (prompt.includes("caption") && prompt.includes("brace")) ||
    (diagnosticMessage.includes("runaway argument") &&
      diagnosticMessage.includes("caption")) ||
    (diagnosticMessage.includes("paragraph ended") &&
      diagnosticMessage.includes("caption")) ||
    diagnosticMessage.includes("file ended while scanning")
  );
}

function isMissingDocumentEndRequest(request: AgentStartRequest): boolean {
  const prompt = request.prompt.toLowerCase();
  const diagnosticMessage = request.diagnostic?.message.toLowerCase() ?? "";

  return (
    prompt.includes("missing \\end{document}") ||
    prompt.includes("missing end{document}") ||
    diagnosticMessage.includes("missing \\end{document}") ||
    diagnosticMessage.includes("no legal \\end")
  );
}

function getMissingPackageFile(message: string | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }

  const quotedMatch = /File [`']([^`']+\.sty)['`] not found/iu.exec(message);
  if (quotedMatch?.[1] !== undefined) {
    return quotedMatch[1];
  }

  const bareMatch = /File\s+([^\s]+\.sty)\s+not found/iu.exec(message);
  return bareMatch?.[1];
}

function isUndefinedControlSequenceRequest(request: AgentStartRequest): boolean {
  const prompt = request.prompt.toLowerCase();
  const diagnosticMessage = request.diagnostic?.message.toLowerCase() ?? "";

  return (
    diagnosticMessage.includes("undefined control sequence") ||
    prompt.includes("undefined control sequence") ||
    prompt.includes("undefined command")
  );
}

function getRequestedSessionId(request: AgentStartRequest): string | undefined {
  if (!("sessionId" in request)) {
    return undefined;
  }

  const candidate = (request as { readonly sessionId?: unknown }).sessionId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function ensureDocumentEnd(contents: string): string {
  if (contents.includes("\\end{document}")) {
    return contents;
  }

  return `${contents.trimEnd()}\n\n\\end{document}\n`;
}

function repairKnownUndefinedControlSequence(contents: string): string {
  return contents.replace(
    /\\(undefinedcommand|badmacro|missingmacro|unknowncommand)\b(?:\{([^{}]*)\})?/u,
    (_match, commandName: string, argument: string | undefined) =>
      argument === undefined || argument.length === 0
        ? commandName.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()
        : escapeLatexTextSegments(argument)
  );
}

function createMockPatchSummary(request: AgentStartRequest, filePath: string): string {
  if (isMissingCitationRepairPrompt(request.prompt.toLowerCase())) {
    return `Repair missing citation key in ${filePath}`;
  }

  if (isMissingDocumentEndRequest(request)) {
    return `Add missing \\end{document} to ${filePath}`;
  }

  if (isUndefinedControlSequenceRequest(request)) {
    return `Remove undefined control sequence in ${filePath}`;
  }

  if (request.diagnostic !== undefined) {
    return `Mock fix for ${request.diagnostic.severity} in ${filePath}`;
  }

  if (request.selectedText !== undefined && request.selectedText.trim().length > 0) {
    return `Mock rewrite for selection in ${filePath}`;
  }

  return `Mock agent suggestion for ${filePath}`;
}

function isSplitMonolithicPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("split") &&
    (normalized.includes("monolithic") ||
      normalized.includes("large `main.tex`") ||
      normalized.includes("separate files") ||
      normalized.includes("input structure"))
  );
}

function isRenameFilePrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes("rename") && normalized.includes(".tex");
}

function parseRenameRequest(
  prompt: string
): { readonly fromPath: string; readonly toPath: string } | undefined {
  const match =
    /rename\s+[`"]?([A-Za-z0-9_./-]+\.tex)[`"]?\s+to\s+[`"]?([A-Za-z0-9_./-]+\.tex)[`"]?/iu.exec(
      prompt
    );
  const fromPath = normalizeProjectPath(match?.[1]);
  const toPath = normalizeProjectPath(match?.[2]);

  if (fromPath === undefined || toPath === undefined) {
    return undefined;
  }

  return { fromPath, toPath };
}

function stripExtension(path: string): string {
  return path.replace(/\.[^.]+$/u, "");
}

function createCitationRepairSuggestion(prompt: string): string | undefined {
  const repairContext = parseCitationRepairContext(prompt);

  if (repairContext === undefined) {
    return undefined;
  }

  if (repairContext.candidates.length === 0) {
    return "I could not find any local bibliography entries to compare against the missing citation key. Please provide source details or add the relevant `.bib` entry first.";
  }

  const [best, second] = rankCitationCandidates(
    repairContext.missingKey,
    repairContext.candidates
  );

  if (best === undefined || best.distance > 4) {
    return "I could not find a likely local bibliography match for that citation key. Please provide source details instead of guessing.";
  }

  if (
    second !== undefined &&
    second.distance <= best.distance + 1 &&
    second.distance <= 3
  ) {
    return [
      `I found multiple similar local keys for ${repairContext.missingKey}.`,
      `Closest matches: ${best.entry.key} and ${second.entry.key}.`,
      "Please confirm which source you intended before I propose a citation patch."
    ].join("\n");
  }

  return undefined;
}

function createUnusedReferenceSuggestion(
  prompt: string,
  contents: string
): string | undefined {
  const entry = parseAttachedReferencePrompt(prompt);

  if (entry === undefined) {
    return undefined;
  }

  const manuscriptText = contents.toLowerCase();
  const matchingTerms = (entry.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((term) => term.length >= 5 && manuscriptText.includes(term));

  return [
    `Unused-reference review for ${entry.key}.`,
    matchingTerms.length === 0
      ? "I do not see strong overlap between the active manuscript text and the attached source title, so removing it is reasonable unless another chapter still needs it."
      : `The active manuscript overlaps with the attached source on ${matchingTerms
          .slice(0, 5)
          .join(
            ", "
          )}, so this entry may belong in related work or background if it supports an uncited claim.`,
    "Keep it only if it directly supports an actual manuscript claim; otherwise the reversible unused-reference removal path is appropriate."
  ].join("\n");
}

function repairMissingCitationKey(
  contents: string,
  prompt: string
): string | undefined {
  const repairContext = parseCitationRepairContext(prompt);

  if (repairContext === undefined || repairContext.candidates.length === 0) {
    return undefined;
  }

  const [best, second] = rankCitationCandidates(
    repairContext.missingKey,
    repairContext.candidates
  );

  if (best === undefined || best.distance > 4) {
    return undefined;
  }

  if (
    second !== undefined &&
    second.distance <= best.distance + 1 &&
    second.distance <= 3
  ) {
    return undefined;
  }

  const missingKeyPattern = new RegExp(
    `\\\\(cite|citep|citet|parencite|textcite|autocite|footcite|supercite)(\\*?(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{[^}]*)\\b${escapeRegExp(
      repairContext.missingKey
    )}\\b`,
    "u"
  );

  if (!missingKeyPattern.test(contents)) {
    return undefined;
  }

  return contents.replace(
    missingKeyPattern,
    (_match, command: string, suffix: string) =>
      `\\${command}${suffix}${best.entry.key}`
  );
}

function cleanupBibtexEntry(contents: string): string {
  return contents
    .replace(/\r\n/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/,\s*\n\s*([a-zA-Z]+)\s*=/gu, ",\n  $1 =")
    .replace(/\n\s*([a-zA-Z]+)\s*=/gu, "\n  $1 =")
    .replace(/\{\{([^{}]+)\}\}/gu, "{$1}")
    .replace(/title\s*=\s*\{([^{}]+)\}/iu, (_match, title: string) => {
      const normalizedTitle = preserveAcronymsWithBraces(title.trim());
      return `title = {${normalizedTitle}}`;
    })
    .replace(/author\s*=\s*\{([^{}]+)\}/iu, (_match, author: string) => {
      return `author = {${author
        .split(/\s+and\s+/iu)
        .map((name) => normalizeAuthorName(name))
        .join(" and ")}}`;
    })
    .replace(/doi\s*=\s*\{([^{}]+)\}/iu, (_match, doi: string) => {
      return `doi = {${doi.trim()}}`;
    })
    .replace(/url\s*=\s*\{([^{}]+)\}/iu, (_match, url: string) => {
      return `url = {${url.trim()}}`;
    });
}

function adaptCitationCommandsToNatbib(contents: string): string {
  if (!/\\usepackage(?:\[[^\]]*\])?\{natbib\}/u.test(contents)) {
    return contents;
  }

  return contents
    .replace(/\\textcite(\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^}]+\})/gu, "\\citet$1")
    .replace(/\\parencite(\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^}]+\})/gu, "\\citep$1")
    .replace(/\\autocite(\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^}]+\})/gu, "\\citep$1");
}

function preserveAcronymsWithBraces(title: string): string {
  const normalizedWords = title.split(/\s+/u).map((word) => {
    if (/^[A-Z]{2,}$/.test(word)) {
      return `{${word}}`;
    }

    if (/\\LaTeX/u.test(word)) {
      return `{\\LaTeX}`;
    }

    return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
  });

  return normalizedWords.join(" ");
}

function normalizeAuthorName(name: string): string {
  return name
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function parseCitationRepairContext(prompt: string):
  | {
      readonly missingKey: string;
      readonly candidates: readonly {
        readonly key: string;
        readonly title?: string;
        readonly author?: string;
        readonly year?: string;
      }[];
    }
  | undefined {
  const match = /fix the missing citation key\s+([A-Za-z0-9:_-]+)/iu.exec(prompt);
  const missingKey = match?.[1]?.trim();

  if (missingKey === undefined || missingKey.length === 0) {
    return undefined;
  }

  return {
    missingKey,
    candidates: parsePromptBibliographyEntries(prompt)
  };
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
    .filter((line) => line.includes("|"))
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const key = parts[0]?.trim() ?? "";
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
            ...(title === undefined || title.length === 0 ? {} : { title }),
            ...(author === undefined || author.length === 0 ? {} : { author }),
            ...(year === undefined || year.length === 0 ? {} : { year })
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

function parseAttachedReferencePrompt(prompt: string):
  | {
      readonly key: string;
      readonly title?: string;
      readonly author?: string;
      readonly year?: string;
    }
  | undefined {
  const key = /only attached key is\s+([A-Za-z0-9:_-]+)/iu.exec(prompt)?.[1]?.trim();
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

function rankCitationCandidates(
  missingKey: string,
  candidates: readonly {
    readonly key: string;
    readonly title?: string;
    readonly author?: string;
    readonly year?: string;
  }[]
): readonly {
  readonly entry: {
    readonly key: string;
    readonly title?: string;
    readonly author?: string;
    readonly year?: string;
  };
  readonly distance: number;
}[] {
  return candidates
    .map((entry) => ({
      entry,
      distance: levenshteinDistance(missingKey.toLowerCase(), entry.key.toLowerCase())
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.entry.key.localeCompare(right.entry.key)
    );
}

function levenshteinDistance(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0)
  );

  for (let row = 0; row <= left.length; row += 1) {
    matrix[row]![0] = row;
  }
  for (let column = 0; column <= right.length; column += 1) {
    matrix[0]![column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + cost
      );
    }
  }

  return matrix[left.length]![right.length]!;
}

function rewriteInputReference(
  contents: string,
  fromPath: string,
  toPath: string
): string {
  const fromWithoutExtension = stripExtension(fromPath);
  const toWithoutExtension = stripExtension(toPath);

  return contents
    .replace(
      new RegExp(`\\\\input\\{${escapeRegExp(fromPath)}\\}`, "gu"),
      `\\input{${toPath}}`
    )
    .replace(
      new RegExp(`\\\\include\\{${escapeRegExp(fromPath)}\\}`, "gu"),
      `\\include{${toPath}}`
    )
    .replace(
      new RegExp(`\\\\input\\{${escapeRegExp(fromWithoutExtension)}\\}`, "gu"),
      `\\input{${toWithoutExtension}}`
    )
    .replace(
      new RegExp(`\\\\include\\{${escapeRegExp(fromWithoutExtension)}\\}`, "gu"),
      `\\include{${toWithoutExtension}}`
    );
}

function createSectionSplitPlan(snapshot: ProjectFileSnapshot):
  | {
      readonly updatedMainContents: string;
      readonly sectionFiles: readonly {
        readonly path: string;
        readonly contents: string;
      }[];
    }
  | undefined {
  const lines = snapshot.contents.split(/\r?\n/u);
  const sectionStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\\section\*?\{[^}]+\}/u.test(line));

  if (sectionStarts.length < 2) {
    return undefined;
  }

  const sectionFiles: { path: string; contents: string }[] = [];
  const documentEndIndex = lines.findIndex((line) => line.includes("\\end{document}"));
  const sectionRanges = sectionStarts.map((sectionStart, sectionIndex) => {
    const end = sectionStarts[sectionIndex + 1]?.index ?? documentEndIndex;
    return {
      start: sectionStart.index,
      stop: end === -1 ? lines.length : end,
      line: sectionStart.line
    };
  });

  for (const [sectionIndex, sectionRange] of sectionRanges.entries()) {
    const start = sectionRange.start;
    const stop = sectionRange.stop;
    const blockLines = lines.slice(start, stop);
    const titleMatch = /^\\section\*?\{([^}]+)\}/u.exec(sectionRange.line);
    const slug = slugifyTitle(titleMatch?.[1] ?? `section-${sectionIndex + 1}`);
    const path = `${slug}.tex`;
    sectionFiles.push({
      path,
      contents: `${blockLines.join("\n").trim()}\n`
    });
  }

  const firstSectionStart = sectionRanges[0]?.start ?? 0;
  const trailingStart = sectionRanges.at(-1)?.stop ?? lines.length;
  const nextLines = [
    ...lines.slice(0, firstSectionStart),
    ...sectionFiles.map((file) => `\\input{${stripExtension(file.path)}}`),
    ...lines.slice(trailingStart)
  ];

  return {
    updatedMainContents: `${nextLines.join("\n").trimEnd()}\n`,
    sectionFiles
  };
}

function slugifyTitle(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "section"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createPatchEvent(
  sessionId: string,
  changeset: HistoryChangeSet
): Extract<AgentEvent, { readonly type: "patch" }> {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "patch",
    changesetId: changeset.id,
    filePath: changeset.filePath,
    summary: changeset.summary,
    status: changeset.status
  };
}

function createApprovalEvent(
  sessionId: string
): Extract<AgentEvent, { readonly type: "approval" }> {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "approval",
    approvalId: randomUUID(),
    toolName: "apply-patch",
    risk: "high",
    prompt: "Review the proposed patch before applying it to the project.",
    status: "requested"
  };
}

function createVerificationEvent(
  sessionId: string,
  status: Extract<AgentEvent, { readonly type: "verification" }>["status"],
  summary: string,
  buildJobId?: string
): Extract<AgentEvent, { readonly type: "verification" }> {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "verification",
    status,
    summary,
    ...(buildJobId === undefined ? {} : { buildJobId })
  };
}

function createMessageEvent(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "message",
    role,
    content
  };
}

function createToolEvent(
  sessionId: string,
  toolName: AgentToolName,
  status: AgentToolCallEvent["status"],
  summary: string,
  risk: AgentToolRisk
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "tool-call",
    toolName,
    status,
    summary,
    risk
  };
}

function createClientToolEvent(
  sessionId: string,
  requestId: string,
  toolName: AgentToolName,
  status: AgentToolCallEvent["status"],
  summary: string,
  risk: AgentToolRisk
): AgentEvent {
  return {
    id: `stream:${sessionId}:${requestId}:${toolName}`,
    sessionId,
    createdAt: new Date().toISOString(),
    type: "tool-call",
    toolName,
    status,
    summary,
    risk
  };
}

function summarizeClientToolRequest(message: AgentHostToolRequestMessage): string {
  switch (message.toolName) {
    case "read-file": {
      const payload = message.payload as AgentToolRequestPayloadMap["read-file"];
      return `Reading ${payload.path}`;
    }
    case "search-project": {
      const payload = message.payload as AgentToolRequestPayloadMap["search-project"];
      return `Searching project for "${payload.query}"`;
    }
    case "move-entry": {
      const payload = message.payload as AgentToolRequestPayloadMap["move-entry"];
      return `Moving ${payload.fromPath} to ${payload.toPath}`;
    }
    case "set-main-file": {
      const payload = message.payload as AgentToolRequestPayloadMap["set-main-file"];
      return `Setting main TeX file to ${payload.path}`;
    }
    case "propose-patch": {
      const payload = message.payload as AgentToolRequestPayloadMap["propose-patch"];
      return `Creating review patch for ${payload.filePath}`;
    }
    case "reject-patch": {
      const payload = message.payload as AgentToolRequestPayloadMap["reject-patch"];
      return `Rejecting changeset ${payload.changesetId}`;
    }
    case "apply-patch": {
      const payload = message.payload as AgentToolRequestPayloadMap["apply-patch"];
      return `Applying changeset ${payload.changesetId}`;
    }
    case "run-compile":
      return "Running compile verification";
    case "network-fetch": {
      const payload = message.payload as AgentToolRequestPayloadMap["network-fetch"];
      return `Requesting network access for ${payload.resource}`;
    }
    case "codex-exec":
      return "Running installed Codex CLI";
    case "claude-code":
      return "Running installed Claude Code CLI";
  }
}

function summarizeClientToolResult(
  toolName: AgentToolName,
  _result: AgentToolResultMap[AgentToolName]
): string {
  switch (toolName) {
    case "read-file":
      return "Read project file";
    case "search-project":
      return "Project search completed";
    case "move-entry":
      return "Moved project entry";
    case "set-main-file":
      return "Set project main TeX file";
    case "propose-patch":
      return "Created review patch";
    case "reject-patch":
      return "Rejected review patch";
    case "apply-patch":
      return "Applied review patch";
    case "run-compile":
      return "Compile verification finished";
    case "network-fetch":
      return "Network request completed";
    case "codex-exec":
      return "Codex CLI completed";
    case "claude-code":
      return "Claude Code CLI completed";
  }
}

function createErrorEvent(sessionId: string, message: string): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "error",
    message,
    recoverable: true
  };
}

function isHostOutboundMessage(value: unknown): value is AgentHostOutboundMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "auth.result" ||
    type === "host.ready" ||
    type === "session.result" ||
    type === "session.event" ||
    type === "session.cancelled" ||
    type === "tool.request" ||
    type === "host.error"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent host request failed.";
}
