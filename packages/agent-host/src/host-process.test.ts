import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { completeDeniedApproval, completeDeniedNetworkApproval } from "./approval.js";

describe("agent host process session routing", () => {
  it("continues sessions only when provider, project root, and mode match", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./host-process.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("requestedSession.providerId === request.providerId");
    expect(source).toContain(
      "requestedSession.request.projectRoot === request.projectRoot"
    );
    expect(source).toContain("requestedSession.request.mode === request.mode");
    expect(source).toContain("canContinueSession && request.sessionId !== undefined");
    expect(source).toContain(": randomUUID()");
    expect(source).toContain("events: [...previousEvents, ...result.events]");
  });

  it("binds approval responses to the active approval id and tool name", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./host-process.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("if (session.approvalId !== request.approvalId)");
    expect(source).toContain(
      'throw new Error("Approval request does not match the active session.");'
    );
    expect(source).toContain("approvalToolName: approvalEvent.toolName");
    expect(source).toContain('session.approvalToolName === "network-fetch"');
    expect(source).toContain('session.approvalToolName ?? "apply-patch"');
  });

  it("fetches external web research before provider execution without approval", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./host-process.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("const networkApproval = createNetworkApprovalRequest");
    expect(source).toContain("networkContext = await broker.networkFetch!");
    expect(source).toContain("provider.startSession(");
    expect(source).toContain("providerRequest");
    expect(source).toContain('normalized.includes("web search")');
    expect(source).toContain("isLikelyLatestExternalResourceRequest");
    expect(source).toContain("official IEEE template sources");
    expect(source).not.toContain("which is approval-gated");
    expect(source).not.toContain("external fetch is not implemented");
  });

  it("rejects proposed changesets when approval is denied", async () => {
    const rejectedIds: string[] = [];
    const result = await completeDeniedApproval({
      session: {
        providerId: "mock",
        changeset: {
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary: "Mixed syntax and prose patch",
          patch: "@@ ...",
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        },
        changesets: [
          {
            id: "changeset-1",
            projectRoot: "/tmp/project",
            filePath: "main.tex",
            summary: "Mixed syntax and prose patch",
            patch: "@@ ...",
            status: "proposed",
            baseSnapshotId: "snapshot-1",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:00.000Z"
          },
          {
            id: "changeset-2",
            projectRoot: "/tmp/project",
            filePath: "method.tex",
            summary: "Create method file",
            patch: "@@ ...",
            status: "proposed",
            baseSnapshotId: "snapshot-2",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:00.000Z"
          }
        ]
      },
      request: {
        sessionId: "session-1",
        approvalId: "approval-1",
        decision: "denied"
      },
      baseEvents: [
        {
          id: "approval-event-1",
          sessionId: "session-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          type: "approval",
          approvalId: "approval-1",
          toolName: "apply-patch",
          risk: "high",
          prompt: "Review the proposed patch before applying it to the project.",
          status: "denied"
        }
      ],
      broker: {
        readFile: () => {
          throw new Error("Denied approval should not read files.");
        },
        searchProject: () => {
          throw new Error("Denied approval should not search the project.");
        },
        proposePatch: () => {
          throw new Error("Denied approval should not propose a new patch.");
        },
        rejectPatch: (changesetId) => {
          rejectedIds.push(changesetId);
          return Promise.resolve({
            id: changesetId,
            projectRoot: "/tmp/project",
            filePath: changesetId === "changeset-1" ? "main.tex" : "method.tex",
            summary:
              changesetId === "changeset-1"
                ? "Mixed syntax and prose patch"
                : "Create method file",
            patch: "@@ ...",
            status: "rejected",
            baseSnapshotId: changesetId === "changeset-1" ? "snapshot-1" : "snapshot-2",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:01.000Z"
          });
        },
        applyPatch: () => {
          throw new Error("Denied approval should not apply patches.");
        },
        runCompile: () => {
          throw new Error("Denied approval should not compile.");
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(result.changeset?.status).toBe("rejected");
    expect(result.changesets).toHaveLength(2);
    expect(rejectedIds).toEqual(["changeset-1", "changeset-2"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "reject-patch" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "patch" && event.status === "rejected"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.summary === "Patch approval was denied; no files were changed."
      )
    ).toBe(true);
  });

  it("returns a local-only fallback when network approval is denied", () => {
    const result = completeDeniedNetworkApproval({
      providerId: "mock",
      request: {
        sessionId: "session-1",
        approvalId: "approval-1",
        decision: "denied"
      },
      baseEvents: [
        {
          id: "approval-event-1",
          sessionId: "session-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          type: "approval",
          approvalId: "approval-1",
          toolName: "network-fetch",
          risk: "high",
          prompt: "Allow external network fetch for 10.1000/example?",
          status: "denied"
        }
      ]
    });

    expect(result.status).toBe("completed");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "Paste the DOI metadata, BibTeX, or the relevant web text"
          )
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.summary === "Network approval was denied; no external data was fetched."
      )
    ).toBe(true);
  });
});
