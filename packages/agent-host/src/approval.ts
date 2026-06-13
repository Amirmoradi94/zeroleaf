import { randomUUID } from "node:crypto";

import type {
  AgentApprovalResponseRequest,
  AgentEvent,
  AgentProviderId,
  AgentSessionResult,
  HistoryChangeSet
} from "@latex-agent/ipc-contracts";

import type { AgentToolBroker } from "./index.js";

export async function completeDeniedApproval({
  session,
  request,
  baseEvents,
  broker
}: {
  readonly session: {
    readonly providerId: AgentProviderId;
    readonly changeset?: HistoryChangeSet;
    readonly changesets?: readonly HistoryChangeSet[];
  };
  readonly request: AgentApprovalResponseRequest;
  readonly baseEvents: readonly AgentEvent[];
  readonly broker: AgentToolBroker;
}): Promise<AgentSessionResult> {
  const events: AgentEvent[] = [...baseEvents];
  const pendingChangeSets =
    session.changesets ?? (session.changeset === undefined ? [] : [session.changeset]);
  let rejectedChangeSet = session.changeset;
  const rejectedChangeSets: HistoryChangeSet[] = [];

  if (pendingChangeSets.length > 0 && broker.rejectPatch !== undefined) {
    for (const changeSet of pendingChangeSets) {
      events.push(
        createToolEvent(
          request.sessionId,
          "reject-patch",
          "running",
          `Rejecting ${changeSet.summary}`,
          "high"
        )
      );
      const rejected = await broker.rejectPatch(changeSet.id);
      rejectedChangeSets.push(rejected);
      rejectedChangeSet =
        rejectedChangeSet?.id === changeSet.id || rejectedChangeSet === undefined
          ? rejected
          : rejectedChangeSet;
      events.push(
        createToolEvent(
          request.sessionId,
          "reject-patch",
          "succeeded",
          `Rejected ${rejected.summary}`,
          "high"
        ),
        {
          id: randomUUID(),
          sessionId: request.sessionId,
          createdAt: new Date().toISOString(),
          type: "patch",
          changesetId: rejected.id,
          filePath: rejected.filePath,
          summary: rejected.summary,
          status: rejected.status
        }
      );
    }
  }

  events.push(
    createVerificationEvent(
      request.sessionId,
      "failed",
      "Patch approval was denied; no files were changed."
    )
  );

  return {
    sessionId: request.sessionId,
    providerId: session.providerId,
    status: "completed",
    events,
    ...(rejectedChangeSet === undefined ? {} : { changeset: rejectedChangeSet }),
    ...(session.changesets === undefined ? {} : { changesets: rejectedChangeSets })
  };
}

export function completeDeniedNetworkApproval({
  providerId,
  request,
  baseEvents
}: {
  readonly providerId: AgentProviderId;
  readonly request: AgentApprovalResponseRequest;
  readonly baseEvents: readonly AgentEvent[];
}): AgentSessionResult {
  const events: AgentEvent[] = [
    ...baseEvents,
    {
      id: randomUUID(),
      sessionId: request.sessionId,
      createdAt: new Date().toISOString(),
      type: "message",
      role: "assistant",
      content:
        "Network access was denied, so I will stay local-only. Paste the DOI metadata, BibTeX, or the relevant web text if you want me to continue without fetching anything."
    },
    createVerificationEvent(
      request.sessionId,
      "failed",
      "Network approval was denied; no external data was fetched."
    )
  ];

  return {
    sessionId: request.sessionId,
    providerId,
    status: "completed",
    events
  };
}

function createToolEvent(
  sessionId: string,
  toolName: "reject-patch",
  status: "running" | "succeeded",
  summary: string,
  risk: "high"
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

function createVerificationEvent(
  sessionId: string,
  status: "failed",
  summary: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "verification",
    status,
    summary
  };
}
