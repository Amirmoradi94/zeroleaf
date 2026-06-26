#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import {
  SharedProjectCache,
  SharedProjectDocumentSession,
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
  "real-shared-collaboration-2026-06-25"
);

async function main() {
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });

  const sandboxPath = await mkdtemp(join(tmpdir(), "zeroleaf-real-shared-collab-"));
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
    const result = await runRealSharedCollaborationCase({ baseUrl, sandboxPath });
    const report = {
      createdAt: new Date().toISOString(),
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

async function runRealSharedCollaborationCase({ baseUrl, sandboxPath }) {
  const owner = new SharedProjectHttpClient({ baseUrl });
  const editor = new SharedProjectHttpClient({ baseUrl });
  const viewer = new SharedProjectHttpClient({ baseUrl });

  await owner.signIn("owner@example.test", "Owner");
  await editor.signIn("editor@example.test", "Editor");
  await viewer.signIn("viewer@example.test", "Viewer");

  const initialMain = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Shared Proof}",
    "Initial shared manuscript.",
    "\\end{document}",
    ""
  ].join("\n");
  const project = await owner.createProject({
    name: "Real Shared Collaboration Paper",
    mainFilePath: "main.tex",
    compiler: "pdflatex",
    directories: [{ path: "sections" }],
    files: [
      { path: "main.tex", contents: initialMain },
      { path: "sections/notes.tex", contents: "Notes for collaborators.\n" }
    ]
  });

  const editorInvitation = await owner.invite(
    project.id,
    "editor@example.test",
    "editor"
  );
  const viewerInvitation = await owner.invite(
    project.id,
    "viewer@example.test",
    "viewer"
  );
  await editor.acceptInvitation(editorInvitation.id);
  await viewer.acceptInvitation(viewerInvitation.id);

  const ownerMembers = await owner.listMembers(project.id);
  assert(
    ownerMembers.some(
      (member) => member.email === "editor@example.test" && member.role === "editor"
    ),
    "editor membership was not visible to owner"
  );
  assert(
    ownerMembers.some(
      (member) => member.email === "viewer@example.test" && member.role === "viewer"
    ),
    "viewer membership was not visible to owner"
  );

  await assertRejects(
    () =>
      viewer.writeFile(
        project.id,
        "main.tex",
        "\\documentclass{article}\\begin{document}viewer write\\end{document}"
      ),
    "viewer write should be rejected"
  );

  const cache = new SharedProjectCache(join(sandboxPath, "cache"));
  const materialized = await cache.materializeProject(editor, project.id);
  const build = await runLatexBuild({
    projectRoot: materialized.workingPath,
    mainFilePath: "main.tex",
    compiler: "pdflatex",
    timeoutMs: 60_000
  });
  await writeFile(join(reportRoot, "local-build.log"), build.rawLog, "utf8");
  assert(build.status === "succeeded", `local shared compile failed: ${build.status}`);
  assert(
    build.artifact?.pdfPath !== undefined,
    "local shared compile did not emit PDF"
  );

  const compiledRevision = await editor.readFile(project.id, "main.tex");
  const pdfBytes = await readFile(build.artifact.pdfPath);
  const uploadedArtifact = await editor.uploadBuildArtifact(project.id, {
    sourceRevisionId: compiledRevision.id,
    desktopClientId: "real-shared-collaboration",
    compiler: build.compiler,
    status: build.status,
    platform: process.platform,
    rawLog: build.rawLog,
    diagnostics: build.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
    })),
    pdfBase64: pdfBytes.toString("base64"),
    pdfByteLength: pdfBytes.byteLength
  });
  const ownerArtifact = await owner.getBuildArtifact(project.id, uploadedArtifact.id);
  assert(
    ownerArtifact.pdfByteLength === pdfBytes.byteLength,
    "owner could not inspect uploaded local compile artifact"
  );

  const realtimeMonitor = createRealtimeMonitor();
  const realtimeSession = await owner.openRealtimeSession(project.id, {
    onEvent: realtimeMonitor.handleEvent,
    onError: realtimeMonitor.handleError
  });
  const presenceEventPromise = realtimeMonitor.waitForEvent(
    (event) => event.type === "presence.updated"
  );
  await editor.updatePresence(project.id, {
    filePath: "main.tex",
    cursorLine: 3,
    cursorColumn: 5
  });
  const realtimePresence = await presenceEventPromise;
  assert(
    realtimePresence.type === "presence.updated" &&
      realtimePresence.presence.displayName === "Editor",
    "owner realtime session did not receive editor presence"
  );

  const ownerDocument = await SharedProjectDocumentSession.open(
    owner,
    project.id,
    "main.tex"
  );
  const editorDocument = await SharedProjectDocumentSession.open(
    editor,
    project.id,
    "main.tex"
  );
  const initialCursor = ownerDocument.updateCursor;
  const ownerEdit = await ownerDocument.applyTextOperations(
    [{ rangeOffset: initialMain.indexOf("Initial"), rangeLength: 0, text: "Owner " }],
    "real-owner-edit"
  );
  const editorDocumentEventPromise = realtimeMonitor.waitForNextEvent(
    (event) => event.type === "document.updated" && event.path === "main.tex"
  );
  const editorEdit = await editorDocument.applyTextOperations(
    [
      {
        rangeOffset: initialMain.indexOf("manuscript"),
        rangeLength: 0,
        text: "collaborative "
      }
    ],
    "real-editor-edit"
  );
  const editorDocumentEvent = await editorDocumentEventPromise;
  await realtimeSession.close();
  await ownerDocument.pullRemoteUpdates(ownerEdit.update.id);
  const reconnectDocument = await SharedProjectDocumentSession.open(
    owner,
    project.id,
    "main.tex"
  );
  const reconnectPull = await reconnectDocument.pullRemoteUpdates(initialCursor);
  const finalRevision = await owner.readFile(project.id, "main.tex");
  assert(
    finalRevision.contents.includes("Owner Initial"),
    "owner edit did not persist"
  );
  assert(
    finalRevision.contents.includes("collaborative manuscript"),
    "editor edit did not persist"
  );
  assert(
    editorEdit.state.contents === ownerDocument.contents &&
      reconnectDocument.contents === ownerDocument.contents,
    "shared document sessions did not converge"
  );
  assert(
    reconnectPull.updates.length >= 2,
    "reconnect did not catch up with concurrent document updates"
  );
  assert(
    editorDocumentEvent.type === "document.updated" &&
      editorDocumentEvent.updateId === editorEdit.update.id &&
      editorDocumentEvent.revisionId === editorEdit.revision.id,
    "owner realtime session did not receive editor document update"
  );

  const comment = await owner.createComment(project.id, {
    filePath: "main.tex",
    body: "Please review the collaborative sentence."
  });
  const resolvedComment = await editor.resolveComment(project.id, comment.id);
  assert(resolvedComment.resolved, "editor did not resolve owner comment");

  const sourceExport = await owner.exportProjectSource(project.id);
  assert(
    sourceExport.files.some(
      (file) => file.path === "main.tex" && file.contents === finalRevision.contents
    ),
    "owner source export did not include latest shared source"
  );

  await writeFile(join(reportRoot, "final-main.tex"), finalRevision.contents, "utf8");

  return {
    projectId: project.id,
    editorInvitationId: editorInvitation.id,
    viewerInvitationId: viewerInvitation.id,
    compiledRevisionId: compiledRevision.id,
    uploadedArtifactId: uploadedArtifact.id,
    realtimePresenceUser: realtimePresence.presence.displayName,
    ownerDocumentUpdateId: ownerEdit.update.id,
    editorDocumentUpdateId: editorEdit.update.id,
    realtimeDocumentUpdateId: editorDocumentEvent.updateId,
    finalRevisionId: finalRevision.id,
    resolvedCommentId: resolvedComment.id,
    exportedFileCount: sourceExport.files.length,
    pdfByteLength: pdfBytes.byteLength
  };
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

async function assertRejects(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }

  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
