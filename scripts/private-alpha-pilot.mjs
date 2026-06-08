#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { AgentHostClient } from "../packages/agent-host/dist/index.js";
import { HistoryStore } from "../packages/history-service/dist/index.js";
import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import { readProjectFile } from "../packages/project-service/dist/index.js";
import {
  analyzeProjectReferences,
  searchProjectReferences
} from "../packages/reference-service/dist/index.js";
import {
  checkSubmissionBundle,
  exportPdf,
  exportSourceZip,
  importProjectZip
} from "../packages/project-lifecycle-service/dist/index.js";

const repoRoot = process.cwd();
const pilotRoot = join(repoRoot, "tmp", "private-alpha-pilot");
const hostProcessPath = resolve(
  repoRoot,
  "packages",
  "agent-host",
  "dist",
  "host-process.js"
);
const providerIds = ["openai-codex", "anthropic-claude"];

await rm(pilotRoot, { recursive: true, force: true });
await mkdir(pilotRoot, { recursive: true });

const summary = {
  checkedAt: new Date().toISOString(),
  root: pilotRoot,
  cliVersions: {
    codex: getCommandVersion("codex", ["--version"]),
    claude: getCommandVersion("claude", ["--version"])
  },
  scenarios: []
};

const historyStores = new Map();
const client = new AgentHostClient({
  hostProcessPath,
  handleToolRequest: async (message) => {
    const store = getHistoryStore(message.context.projectRoot);

    switch (message.toolName) {
      case "read-file":
        return readProjectFile(message.context.projectRoot, message.payload.path);
      case "search-project":
        return [];
      case "propose-patch":
        return store.createChangeSet({
          projectRoot: message.context.projectRoot,
          filePath: message.payload.filePath,
          beforeContents: message.payload.beforeContents,
          afterContents: message.payload.afterContents,
          summary: message.payload.summary
        });
      case "apply-patch":
        assert(message.payload.approved, "Agent patch was not approved.");
        return store.applyChangeSet(message.payload.changesetId);
      case "run-compile":
        assert(message.payload.approved, "Agent compile was not approved.");
        return runCompile(message.context.projectRoot);
      case "codex-exec":
      case "claude-code":
        throw new Error(`${message.toolName} must stay provider-local.`);
      default:
        throw new Error(`Unhandled tool ${message.toolName}`);
    }
  }
});

try {
  await runValidArticleEditScenario();
  await runCitationScenario();
  await runFigureScenario();
  await runThesisScenario();
  await runRealAgentRepairScenario();
} finally {
  client.stop();
  for (const store of historyStores.values()) {
    store.close();
  }
}

await writeFile(
  join(pilotRoot, "report.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8"
);
console.log(JSON.stringify(summary, null, 2));

async function runValidArticleEditScenario() {
  const projectRoot = await copySample("valid-article", "01-valid-article-edit");
  const mainPath = join(projectRoot, "main.tex");
  const original = await readFile(mainPath, "utf8");
  await writeFile(
    mainPath,
    original.replace(
      "\\section{Result}",
      "\\section{Private Alpha Edit}\nThis line verifies the saved edit path.\n\n\\section{Result}"
    ),
    "utf8"
  );

  const build = await runCompile(projectRoot);
  const sourceZipPath = join(pilotRoot, "valid-article-source.zip");
  const pdfExportPath = join(pilotRoot, "valid-article.pdf");
  const sourceZip = await exportSourceZip({
    projectRoot,
    destinationPath: sourceZipPath
  });
  const pdf = await exportPdf({
    pdfPath: build.artifact.pdfPath,
    destinationPath: pdfExportPath
  });
  const imported = await importProjectZip({
    zipPath: sourceZip.archivePath,
    destinationParentPath: pilotRoot,
    projectName: "01-valid-article-imported"
  });

  assert(sourceZip.fileCount >= 2, "Source export missed expected files.");
  assert(pdf.byteLength > 0, "PDF export was empty.");
  assert(imported.fileCount === sourceZip.fileCount, "Import file count mismatch.");

  summary.scenarios.push({
    name: "valid-article edit compile export import",
    status: "passed",
    projectRoot,
    pdfBytes: pdf.byteLength,
    exportedFiles: sourceZip.fileCount,
    importedFiles: imported.fileCount
  });
}

async function runCitationScenario() {
  const projectRoot = await copySample("citation-heavy", "02-citation-heavy");
  const build = await runCompile(projectRoot);
  const analysis = await analyzeProjectReferences(projectRoot);
  const search = await searchProjectReferences(projectRoot, "latex");

  assert(
    analysis.missingCitations.some((citation) => citation.key === "missing2026"),
    "Missing citation was not detected."
  );
  assert(
    analysis.unusedEntries.some((entry) => entry.key === "unused2026"),
    "Unused bibliography entry was not detected."
  );
  assert(search.length > 0, "Reference search returned no results.");

  summary.scenarios.push({
    name: "citation-heavy compile references search",
    status: "passed",
    projectRoot,
    diagnostics: build.diagnostics.length,
    entries: analysis.entries.length,
    citations: analysis.citations.length,
    missing: analysis.missingCitations.map((citation) => citation.key),
    unused: analysis.unusedEntries.map((entry) => entry.key)
  });
}

async function runFigureScenario() {
  const projectRoot = await copySample("figure-heavy", "03-figure-heavy");
  const build = await runCompile(projectRoot);

  summary.scenarios.push({
    name: "figure-heavy compile pdf artifact",
    status: "passed",
    projectRoot,
    pdfBytes: await fileSize(build.artifact.pdfPath),
    diagnostics: build.diagnostics.length
  });
}

async function runThesisScenario() {
  const projectRoot = await copySample("thesis-like", "04-thesis-like");
  const build = await runCompile(projectRoot);
  const submission = await checkSubmissionBundle(projectRoot, "main.tex");
  const blockingIssues = submission.items.filter((item) => item.severity === "error");

  assert(blockingIssues.length === 0, "Thesis sample has blocking submission issues.");

  summary.scenarios.push({
    name: "thesis-like multi-file compile submission check",
    status: "passed",
    projectRoot,
    pdfBytes: await fileSize(build.artifact.pdfPath),
    submissionWarnings: submission.items.filter((item) => item.severity === "warning")
      .length
  });
}

async function runRealAgentRepairScenario() {
  const providerResults = [];

  for (const providerId of providerIds) {
    const projectRoot = await copySample(
      "broken-compile",
      `05-broken-compile-${providerId}`
    );
    const initial = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 120_000,
      maxOutputBytes: 2_000_000
    });
    assert(initial.status === "failed", `${providerId} scenario did not start broken.`);

    const auth = await client.getAuthStatus(providerId);
    assert(
      auth.state === "connected",
      `${providerId} is not connected: ${auth.message ?? auth.state}`
    );

    const start = await client.startSession({
      providerId,
      mode: "apply-with-review",
      projectRoot,
      prompt:
        "Fix the LaTeX compile error with the smallest correct edit. Do not change unrelated content.",
      activeFilePath: "main.tex",
      mainFilePath: "main.tex",
      compiler: "pdflatex"
    });
    const approval = start.events.find(
      (event) => event.type === "approval" && event.status === "requested"
    );
    assert(
      start.status === "awaiting-approval" && approval !== undefined,
      `${providerId} did not propose an approval-ready patch.`
    );

    const final = await client.respondApproval({
      sessionId: start.sessionId,
      approvalId: approval.approvalId,
      decision: "allowed"
    });
    const finalText = await readFile(join(projectRoot, "main.tex"), "utf8");
    const pdfPath = final.buildResult?.artifact?.pdfPath;
    const pdfBytes = pdfPath === undefined ? 0 : await fileSize(pdfPath);

    assert(final.status === "completed", `${providerId} did not complete.`);
    assert(final.changeset?.status === "applied", `${providerId} patch not applied.`);
    assert(final.buildResult?.status === "succeeded", `${providerId} build failed.`);
    assert(
      finalText.includes("\\end{document}"),
      `${providerId} did not repair main.tex.`
    );
    assert(pdfBytes > 0, `${providerId} produced no PDF.`);

    providerResults.push({
      providerId,
      status: "passed",
      changesetId: final.changeset.id,
      summary: final.changeset.summary,
      pdfBytes
    });
  }

  summary.scenarios.push({
    name: "broken compile repaired by real Codex and Claude CLI agents",
    status: "passed",
    providers: providerResults
  });
}

async function copySample(sampleName, targetName) {
  const targetRoot = join(pilotRoot, targetName);
  await cp(join(repoRoot, "samples", sampleName), targetRoot, { recursive: true });
  return targetRoot;
}

async function runCompile(projectRoot) {
  const result = await runLatexBuild({
    projectRoot,
    mainFilePath: "main.tex",
    compiler: "pdflatex",
    timeoutMs: 120_000,
    maxOutputBytes: 2_000_000
  });
  assert(result.status === "succeeded", `Compile failed for ${projectRoot}.`);
  assert(
    result.artifact !== undefined,
    `Compile produced no artifact for ${projectRoot}.`
  );
  assert(
    (await fileSize(result.artifact.pdfPath)) > 0,
    "Compile produced an empty PDF."
  );
  return result;
}

async function fileSize(filePath) {
  return (await stat(filePath)).size;
}

function getHistoryStore(projectRoot) {
  const existing = historyStores.get(projectRoot);
  if (existing !== undefined) {
    return existing;
  }

  const store = new HistoryStore(join(projectRoot, "history.sqlite"));
  historyStores.set(projectRoot, store);
  return store;
}

function getCommandVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000
  });
  return result.status === 0
    ? `${result.stdout}${result.stderr}`.trim()
    : "unavailable";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
