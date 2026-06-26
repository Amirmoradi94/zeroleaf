#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexCliProvider } from "../packages/provider-openai-codex/dist/index.js";
import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import { readProjectFile } from "../packages/project-service/dist/index.js";
import {
  SharedProjectCache,
  SharedProjectHttpClient
} from "../packages/shared-project-client/dist/index.js";
import {
  createSharedProjectHttpServer,
  SharedProjectService,
  SharedProjectStore
} from "../packages/shared-project-server/dist/index.js";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const reportRoot = join(
  workspaceRoot,
  "docs",
  "qa",
  "real-shared-codex-agent-2026-06-25"
);

const provider = new CodexCliProvider({ timeoutMs: 240_000 });

async function main() {
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });

  const authStatus = await provider.getAuthStatus();
  assert(
    authStatus.state === "connected",
    `Codex provider is not connected: ${authStatus.message}`
  );

  const sandboxPath = await mkdtemp(join(tmpdir(), "zeroleaf-real-shared-codex-"));
  const store = new SharedProjectStore(join(sandboxPath, "server", "db.json"));
  const service = new SharedProjectService(store);
  const server = createSharedProjectHttpServer(service);

  try {
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert(address !== null && typeof address !== "string", "server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await runSharedCodexCase({ baseUrl, sandboxPath });
    const report = {
      createdAt: new Date().toISOString(),
      authStatus,
      baseUrl,
      reportRoot,
      passed: true,
      result
    };
    await writeFile(
      join(reportRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      createdAt: new Date().toISOString(),
      authStatus,
      reportRoot,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    };
    await writeFile(
      join(reportRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await rm(sandboxPath, { recursive: true, force: true });
  }
}

async function runSharedCodexCase({ baseUrl, sandboxPath }) {
  const owner = new SharedProjectHttpClient({ baseUrl });
  const editor = new SharedProjectHttpClient({ baseUrl });
  await owner.signIn("owner@example.test", "Owner");
  await editor.signIn("editor@example.test", "Editor");

  const brokenContents = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Introduction}",
    "This shared paper intentionally misses the document terminator.",
    ""
  ].join("\n");
  const project = await owner.createProject({
    name: "Real Codex Shared Agent Paper",
    files: [{ path: "main.tex", contents: brokenContents }]
  });
  const invitation = await owner.invite(project.id, "editor@example.test", "editor");
  await editor.acceptInvitation(invitation.id);

  const realtimeMonitor = createRealtimeMonitor();
  const realtimeSession = await owner.openRealtimeSession(project.id, {
    onEvent: realtimeMonitor.handleEvent,
    onError: realtimeMonitor.handleError
  });

  try {
    const cache = new SharedProjectCache(join(sandboxPath, "cache"));
    const materialized = await cache.materializeProject(editor, project.id);
    const initialBuild = await runLatexBuild({
      projectRoot: materialized.workingPath,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    assert(
      initialBuild.status === "failed",
      `initial shared compile expected failed, got ${initialBuild.status}`
    );

    const prompt =
      "Fix the compile error with the smallest syntax-only edit. Do not rewrite prose.";
    const runningAgentRunEventPromise = realtimeMonitor.waitForNextEvent(
      (event) => event.type === "agent.run.updated" && event.status === "running"
    );
    const agentRun = await editor.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt,
      status: "running"
    });
    const runningAgentRunEvent = await runningAgentRunEventPromise;
    assert(
      runningAgentRunEvent.type === "agent.run.updated" &&
        runningAgentRunEvent.agentRunId === agentRun.id,
      "owner realtime session did not receive running agent run update"
    );

    const broker = createInMemoryBroker(materialized.workingPath);
    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: materialized.workingPath,
        prompt,
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: initialBuild.diagnostics[0]
      },
      broker
    );

    await writeFile(
      join(reportRoot, "agent-events.json"),
      `${JSON.stringify(result.events, null, 2)}\n`,
      "utf8"
    );
    assert(
      result.status === "awaiting-approval",
      `expected approval, got ${result.status}`
    );
    assert(result.changeset !== undefined, "expected Codex to create a changeset");

    const localChangeSet = broker.getChangeSetWithContents(result.changeset.id);
    assert(
      localChangeSet.filePath === "main.tex",
      `expected main.tex changeset, got ${localChangeSet.filePath}`
    );
    assert(
      localChangeSet.afterContents.includes("\\end{document}"),
      "Codex patch should add the missing document terminator"
    );
    await writeFile(join(reportRoot, "patch.diff"), localChangeSet.patch, "utf8");

    const proposedChangeSetEventPromise = realtimeMonitor.waitForNextEvent(
      (event) => event.type === "agent.changeset.updated" && event.status === "proposed"
    );
    const sharedBeforeRevision = await editor.readFile(project.id, "main.tex");
    const sharedChangeSet = await editor.createChangeSet(project.id, {
      agentRunId: agentRun.id,
      filePath: localChangeSet.filePath,
      beforeRevisionId: sharedBeforeRevision.id,
      beforeContents: localChangeSet.beforeContents,
      afterContents: localChangeSet.afterContents,
      summary: localChangeSet.summary
    });
    const proposedChangeSetEvent = await proposedChangeSetEventPromise;
    assert(
      proposedChangeSetEvent.type === "agent.changeset.updated" &&
        proposedChangeSetEvent.changesetId === sharedChangeSet.id,
      "owner realtime session did not receive proposed changeset update"
    );
    const appliedChangeSetEventPromise = realtimeMonitor.waitForNextEvent(
      (event) =>
        event.type === "agent.changeset.updated" &&
        event.changesetId === sharedChangeSet.id &&
        event.status === "applied"
    );
    const agentDocumentUpdateEventPromise = realtimeMonitor.waitForNextEvent(
      (event) => event.type === "document.updated" && event.path === "main.tex"
    );
    const agentFileUpdateEventPromise = realtimeMonitor.waitForNextEvent(
      (event) => event.type === "file.updated" && event.path === "main.tex"
    );
    const appliedSharedChangeSet = await editor.applyChangeSet(
      project.id,
      sharedChangeSet.id
    );
    const appliedChangeSetEvent = await appliedChangeSetEventPromise;
    const agentDocumentUpdateEvent = await agentDocumentUpdateEventPromise;
    const agentFileUpdateEvent = await agentFileUpdateEventPromise;
    assert(
      appliedSharedChangeSet.status === "applied",
      `expected shared changeset applied, got ${appliedSharedChangeSet.status}`
    );
    assert(
      agentDocumentUpdateEvent.type === "document.updated" &&
        agentDocumentUpdateEvent.revisionId ===
          appliedSharedChangeSet.appliedRevisionId,
      "owner realtime session did not receive agent document update"
    );
    assert(
      agentFileUpdateEvent.type === "file.updated" &&
        agentFileUpdateEvent.revisionId === appliedSharedChangeSet.appliedRevisionId,
      "owner realtime session did not receive agent file update"
    );

    await broker.applyPatch(localChangeSet.id);
    const verifiedBuild = await runLatexBuild({
      projectRoot: materialized.workingPath,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    await writeFile(
      join(reportRoot, "verification-log.txt"),
      verifiedBuild.rawLog,
      "utf8"
    );
    assert(
      verifiedBuild.status === "succeeded",
      `verified shared compile expected succeeded, got ${verifiedBuild.status}`
    );
    assert(
      verifiedBuild.artifact?.pdfPath !== undefined,
      "verified build did not emit PDF"
    );

    const fixedRevision = await editor.readFile(project.id, "main.tex");
    const pdfBytes = await readFile(verifiedBuild.artifact.pdfPath);
    const buildArtifactEventPromise = realtimeMonitor.waitForNextEvent(
      (event) => event.type === "build-artifact.created"
    );
    const uploaded = await editor.uploadBuildArtifact(project.id, {
      sourceRevisionId: fixedRevision.id,
      desktopClientId: "real-shared-codex-agent",
      compiler: verifiedBuild.compiler,
      status: verifiedBuild.status,
      platform: process.platform,
      rawLog: verifiedBuild.rawLog,
      diagnostics: verifiedBuild.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
      })),
      pdfBase64: pdfBytes.toString("base64"),
      pdfByteLength: pdfBytes.byteLength
    });
    const buildArtifactEvent = await buildArtifactEventPromise;
    assert(
      buildArtifactEvent.type === "build-artifact.created" &&
        buildArtifactEvent.artifactId === uploaded.id,
      "owner realtime session did not receive build artifact creation"
    );
    const completedAgentRunEventPromise = realtimeMonitor.waitForNextEvent(
      (event) =>
        event.type === "agent.run.updated" &&
        event.agentRunId === agentRun.id &&
        event.status === "completed"
    );
    const completedRun = await editor.attachBuildArtifactToAgentRun(
      project.id,
      agentRun.id,
      {
        artifactId: uploaded.id
      }
    );
    const completedAgentRunEvent = await completedAgentRunEventPromise;

    const ownerFile = await owner.readFile(project.id, "main.tex");
    assert(
      ownerFile.contents === fixedRevision.contents,
      "owner did not see fixed source"
    );
    assert(
      ownerFile.contents.includes("\\end{document}"),
      "owner-visible fixed source is missing document terminator"
    );
    const ownerRuns = await owner.listAgentRuns(project.id);
    assert(
      ownerRuns.some(
        (run) =>
          run.id === agentRun.id &&
          run.status === "completed" &&
          run.changesetIds.includes(sharedChangeSet.id) &&
          run.buildArtifactIds.includes(uploaded.id)
      ),
      "owner did not see completed agent run with changeset and compile evidence"
    );
    const ownerAuditEvents = await owner.listAuditEvents(project.id);
    for (const eventType of [
      "agent.run.created",
      "agent.changeset.applied",
      "agent.run.build-artifact.attached"
    ]) {
      assert(
        ownerAuditEvents.some((event) => event.eventType === eventType),
        `owner audit log missing ${eventType}`
      );
    }
    const ownerArtifact = await owner.getBuildArtifact(project.id, uploaded.id);
    assert(
      ownerArtifact.pdfByteLength === pdfBytes.byteLength,
      "owner artifact inspection did not return uploaded PDF evidence"
    );

    await writeFile(join(reportRoot, "final-main.tex"), ownerFile.contents, "utf8");

    return {
      projectId: project.id,
      invitationId: invitation.id,
      agentRunId: completedRun.id,
      sharedChangeSetId: sharedChangeSet.id,
      localChangeSetId: localChangeSet.id,
      sourceRevisionId: fixedRevision.id,
      buildArtifactId: uploaded.id,
      realtimeRunningAgentRunId: runningAgentRunEvent.agentRunId,
      realtimeProposedChangeSetId: proposedChangeSetEvent.changesetId,
      realtimeAppliedChangeSetId: appliedChangeSetEvent.changesetId,
      realtimeAgentDocumentUpdateId: agentDocumentUpdateEvent.updateId,
      realtimeAgentFileRevisionId: agentFileUpdateEvent.revisionId,
      realtimeBuildArtifactId: buildArtifactEvent.artifactId,
      realtimeCompletedAgentRunId: completedAgentRunEvent.agentRunId,
      initialCompileStatus: initialBuild.status,
      verifiedCompileStatus: verifiedBuild.status,
      auditEventCount: ownerAuditEvents.length,
      pdfByteLength: pdfBytes.byteLength
    };
  } finally {
    await realtimeSession.close();
  }
}

function createRealtimeMonitor() {
  const events = [];
  const waiters = [];
  return {
    handleEvent(event) {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiter.resolve(event);
          waiter.cleanup();
        }
      }
    },
    handleError(error) {
      for (const waiter of [...waiters]) {
        waiter.reject(error);
        waiter.cleanup();
      }
    },
    waitForEvent(predicate, timeoutMs = 10_000) {
      const existingEvent = events.find(predicate);
      if (existingEvent !== undefined) {
        return Promise.resolve(existingEvent);
      }

      return this.waitForNextEvent(predicate, timeoutMs);
    },
    waitForNextEvent(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
          }
        };
        const timer = setTimeout(() => {
          waiter.cleanup();
          reject(new Error("Timed out waiting for realtime event."));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

function createInMemoryBroker(projectRoot) {
  const changeSets = new Map();

  return {
    readFile: (path) => readProjectFile(projectRoot, path),
    searchProject: async (query) => {
      const matches = [];
      for (const filePath of await listTexFiles(projectRoot)) {
        const snapshot = await readProjectFile(projectRoot, filePath);
        if (
          filePath.toLowerCase().includes(query.toLowerCase()) ||
          snapshot.contents.toLowerCase().includes(query.toLowerCase())
        ) {
          matches.push(snapshot);
        }
      }
      return matches;
    },
    proposePatch: async (filePath, beforeContents, afterContents, summary) => {
      const now = new Date().toISOString();
      const changeSet = {
        id: randomUUID(),
        projectRoot,
        filePath,
        summary,
        patch: createSimpleUnifiedDiff(beforeContents, afterContents),
        status: "proposed",
        baseSnapshotId: createSnapshotId(projectRoot, filePath, beforeContents),
        createdAt: now,
        updatedAt: now,
        beforeContents,
        afterContents
      };
      changeSets.set(changeSet.id, changeSet);
      return stripChangeSetContents(changeSet);
    },
    applyPatch: async (changesetId) => {
      const changeSet = changeSets.get(changesetId);
      assert(changeSet !== undefined, `missing changeset ${changesetId}`);
      await writeFile(
        join(projectRoot, changeSet.filePath),
        changeSet.afterContents,
        "utf8"
      );
      const applied = {
        ...changeSet,
        status: "applied",
        updatedAt: new Date().toISOString(),
        appliedAt: new Date().toISOString()
      };
      changeSets.set(changesetId, applied);
      return stripChangeSetContents(applied);
    },
    runCompile: () =>
      runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      }),
    getChangeSetWithContents: (changesetId) => {
      const changeSet = changeSets.get(changesetId);
      assert(changeSet !== undefined, `missing changeset ${changesetId}`);
      return changeSet;
    }
  };
}

async function listTexFiles(projectRoot, directory = projectRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".latex-agent") {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTexFiles(projectRoot, absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".tex")) {
      files.push(relative(projectRoot, absolutePath));
    }
  }

  return files;
}

function createSimpleUnifiedDiff(beforeContents, afterContents) {
  const beforeLines = beforeContents.split(/\r?\n/u);
  const afterLines = afterContents.split(/\r?\n/u);
  return [
    `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

function createSnapshotId(projectRoot, filePath, contents) {
  return createHash("sha256")
    .update(projectRoot)
    .update("\0")
    .update(filePath)
    .update("\0")
    .update(contents)
    .digest("hex");
}

function stripChangeSetContents(changeSet) {
  const summary = { ...changeSet };
  delete summary.beforeContents;
  delete summary.afterContents;
  return summary;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
