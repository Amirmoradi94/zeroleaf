import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HistoryServiceError, HistoryStore, generateUnifiedDiff } from "./index.js";

let sandboxPath: string;
let projectPath: string;
let history: HistoryStore;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-history-service-"));
  projectPath = join(sandboxPath, "paper");
  await writeFile(join(sandboxPath, "outside.tex"), "outside", "utf8");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(projectPath, { recursive: true })
  );
  await writeFile(join(projectPath, "main.tex"), "Before\n", "utf8");
  history = new HistoryStore(join(sandboxPath, "history.sqlite"));
});

afterEach(async () => {
  history.close();
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("history-service", () => {
  it("stores snapshots and proposed changesets", async () => {
    const snapshot = await history.snapshotFile({
      projectRoot: projectPath,
      filePath: "main.tex"
    });
    const changeset = await history.createChangeSet({
      projectRoot: projectPath,
      filePath: "main.tex",
      beforeContents: "Before\n",
      afterContents: "After\n",
      summary: "Change main text"
    });

    expect(snapshot.filePath).toBe("main.tex");
    expect(snapshot.contentHash).toHaveLength(64);
    expect(changeset.status).toBe("proposed");
    expect(changeset.patch).toContain("-Before");
    expect(changeset.patch).toContain("+After");
    await expect(history.listChangeSets(projectPath)).resolves.toHaveLength(1);
  });

  it("applies and rolls back changesets", async () => {
    const changeset = await history.createChangeSet({
      projectRoot: projectPath,
      filePath: "main.tex",
      beforeContents: "Before\n",
      afterContents: "After\n",
      summary: "Apply text change"
    });

    const applied = await history.applyChangeSet(changeset.id);
    expect(applied.status).toBe("applied");
    await expect(readFile(join(projectPath, "main.tex"), "utf8")).resolves.toBe(
      "After\n"
    );

    const reverted = await history.rollbackChangeSet(changeset.id);
    expect(reverted.status).toBe("reverted");
    await expect(readFile(join(projectPath, "main.tex"), "utf8")).resolves.toBe(
      "Before\n"
    );
  });

  it("rejects proposed changesets without writing files", async () => {
    const changeset = await history.createChangeSet({
      projectRoot: projectPath,
      filePath: "main.tex",
      beforeContents: "Before\n",
      afterContents: "After\n",
      summary: "Reject text change"
    });

    const rejected = history.rejectChangeSet(changeset.id);

    expect(rejected.status).toBe("rejected");
    await expect(readFile(join(projectPath, "main.tex"), "utf8")).resolves.toBe(
      "Before\n"
    );
  });

  it("records explicit agent audit events", async () => {
    const event = await history.recordAuditEvent({
      projectRoot: projectPath,
      eventType: "agent.tool.started",
      message: "read-file"
    });
    const events = await history.listAuditEvents(projectPath);

    expect(event.eventType).toBe("agent.tool.started");
    expect(events[0]?.message).toBe("read-file");
  });

  it("summarizes and clears local history data", async () => {
    await history.createChangeSet({
      projectRoot: projectPath,
      filePath: "main.tex",
      beforeContents: "Before\n",
      afterContents: "After\n",
      summary: "Track privacy counts"
    });
    await history.recordAuditEvent({
      projectRoot: projectPath,
      eventType: "agent.message",
      message: "transcript event"
    });

    const summary = history.getPrivacySummary();
    expect(summary.projectCount).toBe(1);
    expect(summary.snapshotCount).toBe(1);
    expect(summary.changesetCount).toBe(1);
    expect(summary.auditEventCount).toBeGreaterThanOrEqual(2);

    const cleared = history.clearAll();
    expect(cleared).toEqual({
      projectCount: 0,
      snapshotCount: 0,
      changesetCount: 0,
      auditEventCount: 0,
      buildJobCount: 0,
      agentSessionCount: 0
    });
  });

  it("rejects empty changesets and outside-root paths", async () => {
    await expect(
      history.createChangeSet({
        projectRoot: projectPath,
        filePath: "main.tex",
        beforeContents: "Same",
        afterContents: "Same",
        summary: "Empty"
      })
    ).rejects.toBeInstanceOf(HistoryServiceError);

    await expect(
      history.snapshotFile({
        projectRoot: projectPath,
        filePath: "../outside.tex"
      })
    ).rejects.toBeInstanceOf(HistoryServiceError);
  });

  it("generates unified diffs", () => {
    expect(generateUnifiedDiff("main.tex", "A\nB\n", "A\nC\n")).toContain(
      "@@ -1,2 +1,2 @@\n A\n-B\n+C"
    );
  });
});
