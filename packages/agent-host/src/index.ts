import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";

import type {
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
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
  readonly proposePatch: (
    filePath: string,
    beforeContents: string,
    afterContents: string,
    summary: string
  ) => Promise<HistoryChangeSet>;
  readonly applyPatch: (changesetId: string) => Promise<HistoryChangeSet>;
  readonly runCompile: () => Promise<BuildResult>;
};

export type AgentToolRequestPayloadMap = {
  readonly "read-file": { readonly path: string };
  readonly "search-project": { readonly query: string };
  readonly "codex-exec": { readonly prompt: string };
  readonly "claude-code": { readonly prompt: string };
  readonly "propose-patch": {
    readonly filePath: string;
    readonly beforeContents: string;
    readonly afterContents: string;
    readonly summary: string;
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
  readonly "codex-exec": { readonly completed: true };
  readonly "claude-code": { readonly completed: true };
  readonly "propose-patch": HistoryChangeSet;
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
    (result: AgentSessionResult) => void
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
      readonly onCrash?: (message: string) => void;
    }
  ) {}

  startSession(request: AgentStartRequest): Promise<AgentSessionResult> {
    const requestId = randomUUID();
    return this.sendSessionRequest(requestId, {
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
    return this.sendSessionRequest(requestId, {
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
    message: AgentHostInboundMessage
  ): Promise<AgentSessionResult> {
    this.ensureProcess();

    return new Promise((resolve) => {
      this.pendingSessionRequests.set(requestId, resolve);
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
      const resolve = this.pendingSessionRequests.get(message.requestId);
      this.pendingSessionRequests.delete(message.requestId);
      resolve?.(message.result);
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
        const resolve = this.pendingSessionRequests.get(message.requestId);
        this.pendingSessionRequests.delete(message.requestId);
        resolve?.(createFailedHostResult("mock", message.error));
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

    try {
      const result = await this.options.handleToolRequest(message);
      this.child?.send({
        type: "tool.response",
        requestId: message.requestId,
        ok: true,
        result
      } satisfies AgentHostInboundMessage);
    } catch (error) {
      this.child?.send({
        type: "tool.response",
        requestId: message.requestId,
        ok: false,
        error: getErrorMessage(error)
      } satisfies AgentHostInboundMessage);
    }
  }

  private failPendingSessionRequests(message: string): void {
    for (const [requestId, resolve] of this.pendingSessionRequests.entries()) {
      this.pendingSessionRequests.delete(requestId);
      resolve(createFailedHostResult("mock", message));
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
        "I will inspect the scoped project context and prepare a reviewable patch."
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
          "Read-only mode is active, so I stopped before proposing edits."
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
      changeset
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

  if (toolName === "propose-patch") {
    return (
      mode === "suggest" || mode === "apply-with-review" || mode === "autonomous-local"
    );
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
    case "codex-exec":
    case "claude-code":
    case "propose-patch":
    case "run-compile":
      return "medium";
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
  if (request.selectedText !== undefined && request.selectedText.trim().length > 0) {
    const replacement = request.selectedText.replace(/\s+/g, " ").trim();
    const revised = `${replacement}\n% Mock agent reviewed this selection.`;
    return beforeContents.replace(request.selectedText, revised);
  }

  if (
    request.diagnostic !== undefined ||
    request.prompt.toLowerCase().includes("fix")
  ) {
    return ensureDocumentEnd(beforeContents);
  }

  return beforeContents.trimEnd() + "\n\n% Mock agent suggestion.\n";
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

function createMockPatchSummary(request: AgentStartRequest, filePath: string): string {
  if (request.diagnostic !== undefined) {
    return `Mock fix for ${request.diagnostic.severity} in ${filePath}`;
  }

  if (request.selectedText !== undefined && request.selectedText.trim().length > 0) {
    return `Mock rewrite for selection in ${filePath}`;
  }

  return `Mock agent suggestion for ${filePath}`;
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
    type === "session.cancelled" ||
    type === "tool.request" ||
    type === "host.error"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent host request failed.";
}
