import { randomUUID } from "node:crypto";

import { ClaudeProvider } from "@latex-agent/provider-anthropic-claude";
import { CodexCliProvider } from "@latex-agent/provider-openai-codex";
import type {
  AgentDeleteEntryOperation,
  AgentMoveEntryOperation,
  AgentApprovalResponseRequest,
  AgentEvent,
  AgentNetworkFetchResult,
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
import { completeDeniedApproval, completeDeniedNetworkApproval } from "./approval.js";

type HostProviderRequest = AgentStartRequest & {
  readonly sessionId: string;
};

type HostSession = {
  readonly request: AgentStartRequest;
  readonly providerId: AgentProviderId;
  readonly changeset?: HistoryChangeSet;
  readonly changesets?: readonly HistoryChangeSet[];
  readonly deleteEntries?: readonly AgentDeleteEntryOperation[];
  readonly moveEntries?: readonly AgentMoveEntryOperation[];
  readonly networkContext?: AgentNetworkFetchResult;
  readonly approvalId?: string;
  readonly approvalToolName?: AgentToolName;
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
  const requestedSession =
    request.sessionId === undefined ? undefined : sessions.get(request.sessionId);
  const canContinueSession =
    requestedSession !== undefined &&
    requestedSession.providerId === request.providerId &&
    requestedSession.request.projectRoot === request.projectRoot &&
    requestedSession.request.mode === request.mode;
  const sessionId =
    canContinueSession && request.sessionId !== undefined
      ? request.sessionId
      : randomUUID();
  const providerRequest: HostProviderRequest = {
    ...request,
    sessionId
  };
  const networkApproval =
    request.networkContext?.fetched === true
      ? undefined
      : createNetworkApprovalRequest(request.prompt);
  if (networkApproval !== undefined) {
    const broker = createBrokerProxy(sessionId, providerRequest);
    const networkEvents: AgentEvent[] = [
      createToolEvent(
        sessionId,
        "network-fetch",
        "running",
        `Fetching ${networkApproval.resource}`,
        "high"
      )
    ];
    const networkContext = await broker.networkFetch!(
      networkApproval.resource,
      request.prompt
    );
    networkEvents.push(
      createToolEvent(
        sessionId,
        "network-fetch",
        networkContext.fetched ? "succeeded" : "failed",
        networkContext.fetched
          ? `Fetched web context for ${networkContext.resource}`
          : `Network fetch failed: ${networkContext.reason}`,
        "high"
      )
    );

    if (!networkContext.fetched) {
      const result: AgentSessionResult = {
        sessionId,
        providerId: request.providerId,
        status: "completed",
        events: [
          ...networkEvents,
          {
            id: randomUUID(),
            sessionId,
            createdAt: new Date().toISOString(),
            type: "message",
            role: "assistant",
            content:
              "I could not fetch the external source. Paste the DOI metadata, BibTeX, or relevant web text and I can continue locally."
          },
          createVerificationEvent(
            sessionId,
            "failed",
            "External web fetch failed before provider execution."
          )
        ]
      };
      sessions.set(sessionId, {
        request: providerRequest,
        providerId: request.providerId,
        events: result.events,
        networkContext
      });
      sendHostMessage({ type: "session.result", requestId, result });
      return;
    }

    const fetchedProviderRequest: HostProviderRequest = {
      ...providerRequest,
      networkContext
    };
    const providerResult = await provider.startSession(
      fetchedProviderRequest,
      createBrokerProxy(sessionId, fetchedProviderRequest)
    );
    const result: AgentSessionResult = {
      ...providerResult,
      events: [...networkEvents, ...providerResult.events]
    };
    const approvalEvent = providerResult.events.find(
      (event) => event.type === "approval" && event.status === "requested"
    );
    const previousEvents = canContinueSession ? requestedSession.events : [];
    sessions.set(result.sessionId, {
      request: fetchedProviderRequest,
      providerId: result.providerId,
      events: [...previousEvents, ...result.events],
      ...(result.changeset !== undefined ? { changeset: result.changeset } : {}),
      ...(result.changesets !== undefined ? { changesets: result.changesets } : {}),
      ...(result.deleteEntries !== undefined
        ? { deleteEntries: result.deleteEntries }
        : {}),
      ...(result.moveEntries !== undefined ? { moveEntries: result.moveEntries } : {}),
      networkContext,
      ...(approvalEvent?.type === "approval"
        ? {
            approvalId: approvalEvent.approvalId,
            approvalToolName: approvalEvent.toolName
          }
        : {})
    });
    sendHostMessage({ type: "session.result", requestId, result });
    return;
  }
  const result = await provider.startSession(
    providerRequest,
    createBrokerProxy(sessionId, request)
  );
  const approvalEvent = result.events.find(
    (event) => event.type === "approval" && event.status === "requested"
  );

  const previousEvents = canContinueSession ? requestedSession.events : [];
  sessions.set(result.sessionId, {
    request: providerRequest,
    providerId: result.providerId,
    events: [...previousEvents, ...result.events],
    ...(result.changeset !== undefined
      ? { changeset: result.changeset }
      : requestedSession?.changeset === undefined
        ? {}
        : { changeset: requestedSession.changeset }),
    ...(result.changesets !== undefined
      ? { changesets: result.changesets }
      : requestedSession?.changesets === undefined
        ? {}
        : { changesets: requestedSession.changesets }),
    ...(result.deleteEntries !== undefined
      ? { deleteEntries: result.deleteEntries }
      : requestedSession?.deleteEntries === undefined
        ? {}
        : { deleteEntries: requestedSession.deleteEntries }),
    ...(result.moveEntries !== undefined
      ? { moveEntries: result.moveEntries }
      : requestedSession?.moveEntries === undefined
        ? {}
        : { moveEntries: requestedSession.moveEntries }),
    ...(approvalEvent?.type === "approval"
      ? {
          approvalId: approvalEvent.approvalId,
          approvalToolName: approvalEvent.toolName
        }
      : requestedSession?.approvalId === undefined
        ? {}
        : {
            approvalId: requestedSession.approvalId,
            ...(requestedSession.approvalToolName === undefined
              ? {}
              : { approvalToolName: requestedSession.approvalToolName })
          })
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
      session.approvalToolName ?? "apply-patch",
      "high",
      request.decision
    )
  ];

  if (request.decision === "denied") {
    const result =
      session.approvalToolName === "network-fetch"
        ? completeDeniedNetworkApproval({
            providerId: session.providerId,
            request,
            baseEvents
          })
        : await completeDeniedApproval({
            session,
            request,
            baseEvents,
            broker: createBrokerProxy(request.sessionId, session.request)
          });
    sessions.set(request.sessionId, {
      ...session,
      events: [...session.events, ...result.events]
    });
    sendHostMessage({ type: "session.result", requestId, result });
    return;
  }

  if (session.approvalToolName === "network-fetch") {
    const networkApproval = createNetworkApprovalRequest(session.request.prompt);
    const broker = createBrokerProxy(request.sessionId, session.request);
    const networkEvents: AgentEvent[] = [
      ...baseEvents,
      createToolEvent(
        request.sessionId,
        "network-fetch",
        "running",
        `Fetching ${networkApproval?.resource ?? "external web content"}`,
        "high"
      )
    ];

    let networkContext: AgentNetworkFetchResult;
    try {
      networkContext = await broker.networkFetch!(
        networkApproval?.resource ?? "external web content",
        session.request.prompt
      );
    } catch (error) {
      networkContext = {
        fetched: false,
        resource: networkApproval?.resource ?? "external web content",
        reason: getErrorMessage(error),
        fetchedAt: new Date().toISOString()
      };
    }

    if (!networkContext.fetched) {
      const result: AgentSessionResult = {
        sessionId: request.sessionId,
        providerId: session.providerId,
        status: "completed",
        events: [
          ...networkEvents,
          createToolEvent(
            request.sessionId,
            "network-fetch",
            "failed",
            `Network fetch failed: ${networkContext.reason}`,
            "high"
          ),
          {
            id: randomUUID(),
            sessionId: request.sessionId,
            createdAt: new Date().toISOString(),
            type: "message",
            role: "assistant",
            content:
              "I could not fetch the approved external source. Paste the DOI metadata, BibTeX, or relevant web text and I can continue locally."
          },
          createVerificationEvent(
            request.sessionId,
            "failed",
            "Network approval was allowed, but the external fetch failed."
          )
        ]
      };
      sessions.set(request.sessionId, {
        ...session,
        events: [...session.events, ...result.events],
        networkContext
      });
      sendHostMessage({ type: "session.result", requestId, result });
      return;
    }

    const providerRequest: HostProviderRequest = {
      ...session.request,
      sessionId: request.sessionId,
      networkContext
    };
    networkEvents.push(
      createToolEvent(
        request.sessionId,
        "network-fetch",
        "succeeded",
        `Fetched approved source context for ${networkContext.resource}`,
        "high"
      )
    );
    const providerResult = await getProvider(session.providerId).startSession(
      providerRequest,
      createBrokerProxy(request.sessionId, providerRequest)
    );
    const result: AgentSessionResult = {
      ...providerResult,
      events: [...networkEvents, ...providerResult.events]
    };
    const approvalEvent = providerResult.events.find(
      (event) => event.type === "approval" && event.status === "requested"
    );
    sessions.set(request.sessionId, {
      ...session,
      request: providerRequest,
      events: [...session.events, ...result.events],
      networkContext,
      ...(result.changeset !== undefined ? { changeset: result.changeset } : {}),
      ...(result.changesets !== undefined ? { changesets: result.changesets } : {}),
      ...(result.deleteEntries !== undefined
        ? { deleteEntries: result.deleteEntries }
        : {}),
      ...(result.moveEntries !== undefined ? { moveEntries: result.moveEntries } : {}),
      ...(approvalEvent?.type === "approval"
        ? {
            approvalId: approvalEvent.approvalId,
            approvalToolName: approvalEvent.toolName
          }
        : {})
    });
    sendHostMessage({ type: "session.result", requestId, result });
    return;
  }

  if (
    session.changeset === undefined &&
    (session.changesets?.length ?? 0) === 0 &&
    (session.deleteEntries?.length ?? 0) === 0 &&
    (session.moveEntries?.length ?? 0) === 0
  ) {
    throw new Error("Approved session has no changeset to apply.");
  }

  const broker = createBrokerProxy(request.sessionId, session.request);
  const events: AgentEvent[] = [...baseEvents];
  const deletedEntries: AgentDeleteEntryOperation[] = [];
  for (const deleteEntry of session.deleteEntries ?? []) {
    events.push(
      createToolEvent(
        request.sessionId,
        "delete-entry",
        "running",
        `Deleting ${deleteEntry.path}`,
        "high"
      )
    );
    const deleted = await broker.deleteEntry?.(deleteEntry.path);
    const deletedPath = deleted?.path ?? deleteEntry.path;
    deletedEntries.push({ path: deletedPath });
    events.push(
      createToolEvent(
        request.sessionId,
        "delete-entry",
        "succeeded",
        `Deleted ${deletedPath}`,
        "high"
      )
    );
  }

  for (const moveEntry of session.moveEntries ?? []) {
    events.push(
      createToolEvent(
        request.sessionId,
        "move-entry",
        "running",
        `Moving ${moveEntry.fromPath} to ${moveEntry.toPath}`,
        "high"
      )
    );
    await broker.moveEntry?.(moveEntry.fromPath, moveEntry.toPath);
    events.push(
      createToolEvent(
        request.sessionId,
        "move-entry",
        "succeeded",
        `Moved ${moveEntry.fromPath} to ${moveEntry.toPath}`,
        "high"
      )
    );
  }

  const pendingChangeSets =
    session.changesets ?? (session.changeset === undefined ? [] : [session.changeset]);

  let appliedChangeSet = session.changeset;
  const appliedChangeSets: HistoryChangeSet[] = [];
  for (const changeSet of pendingChangeSets) {
    events.push(
      createToolEvent(
        request.sessionId,
        "apply-patch",
        "running",
        `Applying ${changeSet.summary}`,
        "high"
      )
    );
    const applied = await broker.applyPatch(changeSet.id);
    appliedChangeSets.push(applied);
    appliedChangeSet =
      appliedChangeSet?.id === changeSet.id || appliedChangeSet === undefined
        ? applied
        : appliedChangeSet;
    events.push(
      createToolEvent(
        request.sessionId,
        "apply-patch",
        "succeeded",
        `Applied ${applied.summary}`,
        "high"
      ),
      {
        id: randomUUID(),
        sessionId: request.sessionId,
        createdAt: new Date().toISOString(),
        type: "patch",
        changesetId: applied.id,
        filePath: applied.filePath,
        summary: applied.summary,
        status: applied.status
      }
    );
  }

  events.push(
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
      `Compile ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${
        buildResult.diagnostics.length === 1 ? "" : "s"
      }`,
      "medium"
    ),
    createVerificationEvent(
      request.sessionId,
      buildResult.status === "succeeded" ? "passed" : "failed",
      `Compile verification ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${
        buildResult.diagnostics.length === 1 ? "" : "s"
      }`,
      buildResult.jobId
    )
  );

  const result: AgentSessionResult = {
    sessionId: request.sessionId,
    providerId: session.providerId,
    status: "completed",
    events,
    ...(appliedChangeSet === undefined ? {} : { changeset: appliedChangeSet }),
    ...(session.changesets === undefined ? {} : { changesets: appliedChangeSets }),
    ...(deletedEntries.length === 0 ? {} : { deleteEntries: deletedEntries }),
    buildResult
  };
  sessions.set(request.sessionId, {
    ...session,
    events: [...session.events, ...events],
    ...(appliedChangeSet === undefined ? {} : { changeset: appliedChangeSet }),
    ...(session.changesets === undefined ? {} : { changesets: appliedChangeSets }),
    ...(deletedEntries.length === 0 ? {} : { deleteEntries: deletedEntries })
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
    emitEvent: (event) =>
      sendHostMessage({
        type: "session.event",
        event
      }),
    readFile: (path) => requestTool(sessionId, context, "read-file", { path }),
    searchProject: (query) =>
      requestTool(sessionId, context, "search-project", { query }),
    capturePdfPreview: () =>
      requestTool(sessionId, context, "capture-pdf-preview", { approved: false }),
    deleteEntry: (path) =>
      requestTool(sessionId, context, "delete-entry", {
        path,
        approved: true
      }),
    moveEntry: (fromPath, toPath) =>
      requestTool(sessionId, context, "move-entry", {
        fromPath,
        toPath,
        approved: true
      }),
    setMainFile: (path) =>
      requestTool(sessionId, context, "set-main-file", {
        path,
        approved: true
      }),
    networkFetch: (resource, prompt) =>
      requestTool(sessionId, context, "network-fetch", {
        resource,
        prompt,
        approved: true
      }),
    proposePatch: (filePath, beforeContents, afterContents, summary) =>
      requestTool(sessionId, context, "propose-patch", {
        filePath,
        beforeContents,
        afterContents,
        summary
      }),
    rejectPatch: (changesetId) =>
      requestTool(sessionId, context, "reject-patch", {
        changesetId,
        approved: false
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

function createNetworkApprovalRequest(
  prompt: string
): { readonly resource: string } | undefined {
  const normalized = prompt.toLowerCase();
  const doi = /\b10\.\d{4,9}\/[^\s]+/iu.exec(prompt)?.[0];
  const url = /https?:\/\/[^\s`'"]+/iu.exec(prompt)?.[0];

  if (
    doi === undefined &&
    url === undefined &&
    !normalized.includes("web search") &&
    !normalized.includes("search web") &&
    !normalized.includes("search online") &&
    !normalized.includes("look it up online") &&
    !normalized.includes("look online") &&
    !normalized.includes("fetch doi") &&
    !normalized.includes("doi metadata") &&
    !normalized.includes("web content") &&
    !normalized.includes("download from") &&
    !isLikelyLatestExternalResourceRequest(normalized)
  ) {
    return undefined;
  }

  return {
    resource: doi ?? url ?? inferNetworkResourceFromPrompt(normalized)
  };
}

function isLikelyLatestExternalResourceRequest(normalizedPrompt: string): boolean {
  return (
    /\blatest\b/u.test(normalizedPrompt) &&
    /\b(template|package|version|journal|publisher|guidelines?|instructions?|class file|cls|style file|bst|online|web)\b/u.test(
      normalizedPrompt
    )
  );
}

function inferNetworkResourceFromPrompt(normalizedPrompt: string): string {
  if (
    normalizedPrompt.includes("ieee") &&
    (normalizedPrompt.includes("template") ||
      normalizedPrompt.includes("systems journal"))
  ) {
    return "official IEEE template sources";
  }

  if (normalizedPrompt.includes("template")) {
    return "external template sources";
  }

  return "external web content";
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
