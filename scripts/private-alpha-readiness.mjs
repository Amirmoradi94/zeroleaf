import { access, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MockAgentProvider } from "../packages/agent-host/dist/index.js";
import { HistoryStore } from "../packages/history-service/dist/index.js";
import {
  detectLatexToolchain,
  runLatexBuild
} from "../packages/latex-service/dist/index.js";
import {
  ProjectMetadataStore,
  openProject,
  readProjectFile
} from "../packages/project-service/dist/index.js";
import { analyzeProjectReferences } from "../packages/reference-service/dist/index.js";
import {
  checkSubmissionBundle,
  exportSourceZip,
  importProjectZip
} from "../packages/project-lifecycle-service/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sampleNames = [
  "valid-article",
  "broken-compile",
  "citation-heavy",
  "figure-heavy",
  "thesis-like"
];
const compileSampleNames = [
  "valid-article",
  "citation-heavy",
  "figure-heavy",
  "thesis-like"
];

const sandboxRoot = await mkdtemp(join(tmpdir(), "latex-alpha-readiness-"));

try {
  const toolchain = await detectLatexToolchain();
  if (!toolchain.latexmkAvailable) {
    throw new Error("latexmk is required for private alpha readiness.");
  }

  const samples = await prepareSamples();
  const compileResults = await compilePassingSamples(samples);
  const repairResult = await repairBrokenSample(samples["broken-compile"]);
  const referenceResult = await analyzeReferences(samples["citation-heavy"]);
  const lifecycleResult = await checkLifecycle(samples["valid-article"]);
  const packageResult = await checkPackage();
  await checkDocs();

  const result = {
    checkedAt: new Date().toISOString(),
    latexmkVersion: toolchain.latexmkVersion ?? "available",
    samples: Object.keys(samples),
    compileResults,
    repairResult,
    referenceResult,
    lifecycleResult,
    packageResult,
    docs: [
      "docs/alpha-user-guide.md",
      "docs/security/mvp-security-review.md",
      "docs/privacy/error-reporting-policy.md"
    ]
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(sandboxRoot, { recursive: true, force: true });
}

async function prepareSamples() {
  const samples = {};
  for (const sampleName of sampleNames) {
    const sourceRoot = resolve(repoRoot, "samples", sampleName);
    const targetRoot = join(sandboxRoot, sampleName);
    await access(join(sourceRoot, "main.tex"), constants.R_OK);
    await cp(sourceRoot, targetRoot, { recursive: true });
    samples[sampleName] = targetRoot;
  }
  return samples;
}

async function compilePassingSamples(samples) {
  const results = {};
  for (const sampleName of compileSampleNames) {
    const metadata = new ProjectMetadataStore(
      join(sandboxRoot, `${sampleName}-metadata.json`)
    );
    const opened = await openProject(samples[sampleName], metadata);
    const mainFilePath = opened.project.mainFilePath ?? "main.tex";
    const build = await runLatexBuild({
      projectRoot: samples[sampleName],
      mainFilePath,
      compiler: "pdflatex",
      timeoutMs: 90_000
    });
    if (build.status !== "succeeded") {
      throw new Error(`${sampleName} did not compile: ${build.status}`);
    }
    results[sampleName] = {
      mainFilePath,
      status: build.status,
      diagnostics: build.diagnostics.length,
      pdfPath: build.artifact?.pdfPath
    };
  }
  return results;
}

async function repairBrokenSample(projectRoot) {
  const metadata = new ProjectMetadataStore(join(sandboxRoot, "broken-metadata.json"));
  const opened = await openProject(projectRoot, metadata);
  const history = new HistoryStore(join(sandboxRoot, "broken-history.sqlite"));
  try {
    const mainFilePath = opened.project.mainFilePath ?? "main.tex";
    const failedBuild = await runLatexBuild({
      projectRoot,
      mainFilePath,
      compiler: "pdflatex",
      timeoutMs: 90_000
    });
    if (failedBuild.status !== "failed") {
      throw new Error("Broken sample unexpectedly compiled before repair.");
    }

    const provider = new MockAgentProvider();
    const agentResult = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot,
        prompt: "Fix the compile error",
        activeFilePath: mainFilePath,
        mainFilePath,
        compiler: "pdflatex"
      },
      {
        readFile: (path) => readProjectFile(projectRoot, path),
        searchProject: () => Promise.resolve([]),
        proposePatch: (filePath, beforeContents, afterContents, summary) =>
          history.createChangeSet({
            projectRoot,
            filePath,
            beforeContents,
            afterContents,
            summary
          }),
        applyPatch: (changesetId) => history.applyChangeSet(changesetId),
        runCompile: () =>
          runLatexBuild({
            projectRoot,
            mainFilePath,
            compiler: "pdflatex",
            timeoutMs: 90_000
          })
      }
    );

    if (agentResult.changeset === undefined) {
      throw new Error("Mock agent did not propose a changeset.");
    }

    const applied = await history.applyChangeSet(agentResult.changeset.id);
    const repairedBuild = await runLatexBuild({
      projectRoot,
      mainFilePath,
      compiler: "pdflatex",
      timeoutMs: 90_000
    });
    if (repairedBuild.status !== "succeeded") {
      throw new Error("Broken sample did not compile after agent repair.");
    }

    return {
      initialStatus: failedBuild.status,
      agentStatus: agentResult.status,
      changesetStatus: applied.status,
      repairedStatus: repairedBuild.status
    };
  } finally {
    history.close();
  }
}

async function analyzeReferences(projectRoot) {
  const analysis = await analyzeProjectReferences(projectRoot);
  if (analysis.missingCitations.length === 0 || analysis.unusedEntries.length === 0) {
    throw new Error("Citation-heavy sample did not expose missing and unused refs.");
  }
  return {
    entries: analysis.entries.length,
    citations: analysis.citations.length,
    missing: analysis.missingCitations.map((citation) => citation.key),
    unused: analysis.unusedEntries.map((entry) => entry.key)
  };
}

async function checkLifecycle(projectRoot) {
  const zipPath = join(sandboxRoot, "valid-article-source.zip");
  const exported = await exportSourceZip({
    projectRoot,
    destinationPath: zipPath
  });
  const importedParent = join(sandboxRoot, "imports");
  await cp(projectRoot, join(sandboxRoot, "source-copy"), { recursive: true });
  await access(zipPath, constants.R_OK);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(importedParent));
  const imported = await importProjectZip({
    zipPath,
    destinationParentPath: importedParent,
    projectName: "valid-article-imported"
  });
  const submission = await checkSubmissionBundle(projectRoot, "main.tex");

  return {
    exportedFiles: exported.fileCount,
    exportedBytes: exported.byteLength,
    importedFiles: imported.fileCount,
    submissionMessages: submission.items.map((item) => item.message)
  };
}

async function checkPackage() {
  const appRoot = resolve(repoRoot, "release/mac/AI LaTeX Editor.app");
  const launcherPath = join(appRoot, "Contents", "MacOS", "AI LaTeX Editor");
  const plistPath = join(appRoot, "Contents", "Info.plist");
  const launcherStats = await stat(launcherPath);
  const plist = await readFile(plistPath, "utf8");
  const shellCheck = spawnSync("sh", ["-n", launcherPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (shellCheck.status !== 0) {
    throw new Error(shellCheck.stderr || "Packaged app launcher shell check failed.");
  }
  if (!plist.includes("CFBundleExecutable")) {
    throw new Error("Packaged app Info.plist is missing CFBundleExecutable.");
  }
  return {
    appRoot,
    launcherExecutable: (launcherStats.mode & 0o111) !== 0,
    plistBundleName: plist.includes("AI LaTeX Editor")
  };
}

async function checkDocs() {
  await Promise.all(
    [
      "docs/alpha-user-guide.md",
      "docs/security/mvp-security-review.md",
      "docs/privacy/error-reporting-policy.md"
    ].map((path) => access(resolve(repoRoot, path), constants.R_OK))
  );
}
