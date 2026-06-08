import { randomUUID } from "node:crypto";

import { ClaudeProvider } from "@latex-agent/provider-anthropic-claude";
import { CodexCliProvider } from "@latex-agent/provider-openai-codex";
import type {
  AgentApprovalResponseRequest,
  AgentEvent,
  AgentProviderId,
  AgentSessionResult,
  AgentStartRequest,
  AgentToolCallEvent,
  AgentToolName,
  AgentToolRisk,
  HistoryChangeSet
} from "@latex-agent/ipc-contracts";

import {
  MockAgentProvider,
  type AgentHostInboundMessage,
  type AgentHostOutboundMessage,
  type AgentToolBroker,
  type AgentToolRequestPayloadMap,
  type AgentToolResultMap
} from "./index.js";

type HostProviderRequest = AgentStartRequest & {
  readonly sessionId: string;
};

type HostSession = {
  readonly request: AgentStartRequest;
  readonly providerId: AgentProviderId;
  readonly changeset?: HistoryChangeSet;
  readonly approvalId?: string;
  readonly events: readonly AgentEvent[];
};

type PendingToolRequest = {
  readonly resolve: (result: AgentToolResultMap[AgentToolName]) => void;
  readonly reject: (error: Error) => void;
};

const mockProvider = new MockAgentProvider();
const codexProvider = new CodexCliProvider();
const claudeProvider = new ClaudeProvider();
const sessions = new Map<string, HostSession>();
const pendingToolRequests = new Map<string, PendingToolRequest>();

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

sendHostMessage({ type: "host.ready" });

async function handleMessage(message: unknown): Promise<void> {
  if (!isHostInboundMessage(message)) {
    return;
  }

  try {
    switch (message.type) {
      case "session.auth":
        await getAuthStatus(message.requestId, message.providerId);
        return;
      case "session.start":
        await startSession(message.requestId, message.request);
        return;
      case "session.approval":
        await respondApproval(message.requestId, message.request);
        return;
      case "session.cancel":
        await cancelSession(message.requestId, message.sessionId);
        return;
      case "tool.response":
        resolveToolResponse(message);
        return;
    }
  } catch (error) {
    sendHostMessage({
      type: "host.error",
      ...("requestId" in message ? { requestId: message.requestId } : {}),
      error: getErrorMessage(error)
    });
  }
}

async function getAuthStatus(
  requestId: string,
  providerId: AgentProviderId
): Promise<void> {
  sendHostMessage({
    type: "auth.result",
    requestId,
    status: await getProvider(providerId).getAuthStatus()
  });
}

async function startSession(
  requestId: string,
  request: AgentStartRequest
): Promise<void> {
  const provider = getProvider(request.providerId);
  const sessionId = randomUUID();
  const providerRequest: HostProviderRequest = {
    ...request,
    sessionId
  };
  const result = await provider.startSession(
    providerRequest,
    createBrokerProxy(sessionId, request)
  );
  const approvalEvent = result.events.find(
    (event) => event.type === "approval" && event.status === "requested"
  );

  sessions.set(result.sessionId, {
    request,
    providerId: result.providerId,
    events: result.events,
    ...(result.changeset === undefined ? {} : { changeset: result.changeset }),
    ...(approvalEvent?.type === "approval"
      ? { approvalId: approvalEvent.approvalId }
      : {})
  });

  sendHostMessage({
    type: "session.result",
    requestId,
    result
  });
}

async function respondApproval(
  requestId: string,
  request: AgentApprovalResponseRequest
): Promise<void> {
  const session = sessions.get(request.sessionId);

  if (session === undefined) {
    throw new Error("Agent session is not available.");
  }

  if (session.approvalId !== request.approvalId) {
    throw new Error("Approval request does not match the active session.");
  }

  const baseEvents = [
    createApprovalEvent(
      request.sessionId,
      request.approvalId,
      "apply-patch",
      "high",
      request.decision
    )
  ];

  if (request.decision === "denied") {
    const result: AgentSessionResult = {
      sessionId: request.sessionId,
      providerId: session.providerId,
      status: "completed",
      events: [
        ...baseEvents,
        createVerificationEvent(
          request.sessionId,
          "failed",
          "Patch approval was denied; no files were changed."
        )
      ],
      ...(session.changeset === undefined ? {} : { changeset: session.changeset })
    };
    sessions.set(request.sessionId, {
      ...session,
      events: [...session.events, ...result.events]
    });
    sendHostMessage({ type: "session.result", requestId, result });
    return;
  }

  if (session.changeset === undefined) {
    throw new Error("Approved session has no changeset to apply.");
  }

  const broker = createBrokerProxy(request.sessionId, session.request);
  const events: AgentEvent[] = [...baseEvents];
  events.push(
    createToolEvent(
      request.sessionId,
      "apply-patch",
      "running",
      `Applying ${session.changeset.summary}`,
      "high"
    )
  );
  const appliedChangeSet = await broker.applyPatch(session.changeset.id);
  events.push(
    createToolEvent(
      request.sessionId,
      "apply-patch",
      "succeeded",
      `Applied ${appliedChangeSet.summary}`,
      "high"
    ),
    {
      id: randomUUID(),
      sessionId: request.sessionId,
      createdAt: new Date().toISOString(),
      type: "patch",
      changesetId: appliedChangeSet.id,
      filePath: appliedChangeSet.filePath,
      summary: appliedChangeSet.summary,
      status: appliedChangeSet.status
    },
    createToolEvent(
      request.sessionId,
      "run-compile",
      "running",
      "Running compile verification",
      "medium"
    )
  );
  const buildResult = await broker.runCompile();
  events.push(
    createToolEvent(
      request.sessionId,
      "run-compile",
      buildResult.status === "succeeded" ? "succeeded" : "failed",
      `Compile ${buildResult.status}`,
      "medium"
    ),
    createVerificationEvent(
      request.sessionId,
      buildResult.status === "succeeded" ? "passed" : "failed",
      `Compile verification ${buildResult.status}`,
      buildResult.jobId
    )
  );

  const result: AgentSessionResult = {
    sessionId: request.sessionId,
    providerId: session.providerId,
    status: "completed",
    events,
    changeset: appliedChangeSet,
    buildResult
  };
  sessions.set(request.sessionId, {
    ...session,
    events: [...session.events, ...events],
    changeset: appliedChangeSet
  });
  sendHostMessage({ type: "session.result", requestId, result });
}

async function cancelSession(requestId: string, sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  sendHostMessage({
    type: "session.cancelled",
    requestId,
    cancelled:
      session === undefined
        ? false
        : await getProvider(session.providerId).cancelSession(sessionId)
  });
}

function getProvider(
  providerId: AgentProviderId
): MockAgentProvider | CodexCliProvider | ClaudeProvider {
  switch (providerId) {
    case "mock":
      return mockProvider;
    case "openai-codex":
      return codexProvider;
    case "anthropic-claude":
      return claudeProvider;
  }
}

function createBrokerProxy(
  sessionId: string,
  context: AgentStartRequest
): AgentToolBroker {
  return {
    readFile: (path) => requestTool(sessionId, context, "read-file", { path }),
    searchProject: (query) =>
      requestTool(sessionId, context, "search-project", { query }),
    proposePatch: (filePath, beforeContents, afterContents, summary) =>
      requestTool(sessionId, context, "propose-patch", {
        filePath,
        beforeContents,
        afterContents,
        summary
      }),
    applyPatch: (changesetId) =>
      requestTool(sessionId, context, "apply-patch", {
        changesetId,
        approved: true
      }),
    runCompile: () => requestTool(sessionId, context, "run-compile", { approved: true })
  };
}

function requestTool<TToolName extends AgentToolName>(
  sessionId: string,
  context: AgentStartRequest,
  toolName: TToolName,
  payload: AgentToolRequestPayloadMap[TToolName]
): Promise<AgentToolResultMap[TToolName]> {
  const requestId = randomUUID();

  sendHostMessage({
    type: "tool.request",
    requestId,
    sessionId,
    context,
    toolName,
    payload
  });

  return new Promise((resolve, reject) => {
    pendingToolRequests.set(requestId, {
      resolve: (result) => resolve(result as AgentToolResultMap[TToolName]),
      reject
    });
  });
}

function resolveToolResponse(
  message: Extract<AgentHostInboundMessage, { readonly type: "tool.response" }>
): void {
  const pending = pendingToolRequests.get(message.requestId);

  if (pending === undefined) {
    return;
  }

  pendingToolRequests.delete(message.requestId);

  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error));
  }
}

function sendHostMessage(message: AgentHostOutboundMessage): void {
  process.send?.(message);
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

function createApprovalEvent(
  sessionId: string,
  approvalId: string,
  toolName: AgentToolName,
  risk: AgentToolRisk,
  status: "allowed" | "denied"
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "approval",
    approvalId,
    toolName,
    risk,
    prompt: status === "allowed" ? "Approved by user." : "Denied by user.",
    status
  };
}

function createVerificationEvent(
  sessionId: string,
  status: "pending" | "running" | "passed" | "failed",
  summary: string,
  buildJobId?: string
): AgentEvent {
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

function isHostInboundMessage(value: unknown): value is AgentHostInboundMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "session.auth" ||
    type === "session.start" ||
    type === "session.approval" ||
    type === "session.cancel" ||
    type === "tool.response"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent host failed.";
}
