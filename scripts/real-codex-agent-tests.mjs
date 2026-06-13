#!/usr/bin/env node
import { rm, mkdir, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexCliProvider } from "../packages/provider-openai-codex/dist/index.js";
import { HistoryStore } from "../packages/history-service/dist/index.js";
import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import { readProjectFile } from "../packages/project-service/dist/index.js";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const reportRoot = join(workspaceRoot, "docs", "qa", "real-codex-agent-2026-06-11");

const provider = new CodexCliProvider({ timeoutMs: 240_000 });

const cases = [
  {
    id: "01-missing-document-end",
    title: "Fix missing document terminator",
    prompt:
      "Fix the compile error with the smallest syntax-only edit. Do not rewrite prose.",
    mode: "apply-with-review",
    main: [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "This article studies local-first review workflows for scholarly writing.",
      ""
    ].join("\n"),
    expectInitialCompile: "failed",
    expectChange: true,
    verify: ({ finalContents, verifiedBuild }) => {
      assert(
        finalContents.includes("\\end{document}"),
        "final file should include \\end{document}"
      );
      assert(
        verifiedBuild?.status === "succeeded",
        "applied Codex patch should compile"
      );
    }
  },
  {
    id: "02-unbalanced-caption-brace",
    title: "Fix unbalanced caption brace",
    prompt:
      "Fix only the unbalanced brace in the figure caption. Preserve the caption text and label.",
    mode: "apply-with-review",
    main: [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "\\section{Results}",
      "\\begin{figure}",
      "\\centering",
      "\\fbox{Result panel}",
      "\\caption{Accuracy improves across folds.\\label{fig:accuracy}",
      "\\end{figure}",
      "Figure~\\ref{fig:accuracy} summarizes the result.",
      "\\end{document}",
      ""
    ].join("\n"),
    expectInitialCompile: "failed",
    expectChange: true,
    verify: ({ finalContents, verifiedBuild }) => {
      assert(
        finalContents.includes(
          "\\caption{Accuracy improves across folds.\\label{fig:accuracy}}"
        ),
        "caption brace should be balanced without changing label"
      );
      assert(
        verifiedBuild?.status === "succeeded",
        "caption brace repair should compile"
      );
    }
  },
  {
    id: "03-selected-prose-only",
    title: "Improve selected prose only",
    prompt:
      "Improve the academic tone of the selected sentence only. Do not add claims or citations.",
    mode: "apply-with-review",
    selectedText:
      "Our tool is pretty good because it helps writers find problems fast.",
    main: [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Method}\\label{sec:method}",
      "Our tool is pretty good because it helps writers find problems fast.",
      "This unrelated sentence cites prior work~\\cite{doe2024} and must remain unchanged.",
      "\\begin{thebibliography}{1}",
      "\\bibitem{doe2024} Doe, A. (2024). Reference Study.",
      "\\end{thebibliography}",
      "\\end{document}",
      ""
    ].join("\n"),
    expectInitialCompile: "succeeded",
    expectChange: true,
    verify: ({ beforeContents, finalContents, verifiedBuild }) => {
      assert(
        !finalContents.includes(
          "Our tool is pretty good because it helps writers find problems fast."
        ),
        "selected sentence should be revised"
      );
      assert(
        finalContents.includes(
          "This unrelated sentence cites prior work~\\cite{doe2024} and must remain unchanged."
        ),
        "unrelated citation sentence should be preserved"
      );
      assert(
        finalContents.includes("\\label{sec:method}"),
        "section label should be preserved"
      );
      assert(finalContents !== beforeContents, "file should change");
      assert(
        verifiedBuild?.status === "succeeded",
        "selected prose edit should compile"
      );
    }
  },
  {
    id: "04-insert-results-table",
    title: "Insert a compact results table",
    prompt:
      "Replace the '% INSERT RESULTS TABLE HERE' marker with a compact LaTeX table for these rows: Baseline 71.2, Proposed 84.6. Include a caption and label.",
    mode: "apply-with-review",
    main: [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Evaluation}",
      "Table~\\ref{tab:accuracy} should summarize the accuracy.",
      "% INSERT RESULTS TABLE HERE",
      "\\end{document}",
      ""
    ].join("\n"),
    expectInitialCompile: "succeeded",
    expectChange: true,
    verify: ({ finalContents, verifiedBuild }) => {
      assert(finalContents.includes("\\begin{tabular}"), "table should use tabular");
      assert(finalContents.includes("\\caption{"), "table should include a caption");
      assert(
        finalContents.includes("\\label{tab:accuracy}"),
        "table label should match reference"
      );
      assert(finalContents.includes("Baseline"), "table should include Baseline row");
      assert(finalContents.includes("Proposed"), "table should include Proposed row");
      assert(verifiedBuild?.status === "succeeded", "table insertion should compile");
    }
  },
  {
    id: "05-missing-package-explanation",
    title: "Explain missing package without fabricating a source fix",
    prompt:
      "The compile fails because a required .sty package is not installed locally. Do not remove the package or invent a replacement. Explain the dependency issue in notes and leave the source unchanged.",
    mode: "apply-with-review",
    main: [
      "\\documentclass{article}",
      "\\usepackage{definitelymissinglocalpackagexyz}",
      "\\begin{document}",
      "This source intentionally depends on a package that is not installed.",
      "\\end{document}",
      ""
    ].join("\n"),
    expectInitialCompile: "failed",
    expectChange: false,
    verify: ({ beforeContents, finalContents, result }) => {
      assert(
        finalContents === beforeContents,
        "missing package source should remain unchanged"
      );
      assert(
        result.status === "completed",
        "no-edit dependency explanation should complete"
      );
      const notes = result.events
        .filter((event) => event.type === "tool-call")
        .map((event) => event.summary)
        .join("\n");
      assert(
        /package|dependency|install|missing|sty/iu.test(notes),
        "Codex notes should explain the missing package/dependency"
      );
    }
  }
];

async function main() {
  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });

  const authStatus = await provider.getAuthStatus();
  assert(
    authStatus.state === "connected",
    `Codex provider is not connected: ${authStatus.message}`
  );

  const results = [];

  for (const testCase of cases) {
    const caseResult = await runCase(testCase);
    results.push(caseResult);
    console.log(
      `${caseResult.passed ? "PASS" : "FAIL"} ${testCase.id}: ${testCase.title}`
    );
    if (!caseResult.passed) {
      console.log(`  ${caseResult.error}`);
    }
  }

  const report = {
    createdAt: new Date().toISOString(),
    authStatus,
    reportRoot,
    passed: results.every((result) => result.passed),
    results
  };
  await writeFile(
    join(reportRoot, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function runCase(testCase) {
  const projectRoot = join(reportRoot, testCase.id, "project");
  const historyPath = join(reportRoot, testCase.id, "history.sqlite");
  const artifactDir = join(reportRoot, testCase.id);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "main.tex"), testCase.main, "utf8");

  const history = new HistoryStore(historyPath);
  const startedAt = Date.now();
  const beforeContents = await readFile(join(projectRoot, "main.tex"), "utf8");

  try {
    const initialBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    assert(
      initialBuild.status === testCase.expectInitialCompile,
      `initial compile expected ${testCase.expectInitialCompile}, got ${initialBuild.status}`
    );

    const diagnostic = initialBuild.diagnostics[0];
    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: testCase.mode,
        projectRoot,
        prompt: testCase.prompt,
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        ...(testCase.selectedText === undefined
          ? {}
          : { selectedText: testCase.selectedText }),
        ...(diagnostic === undefined ? {} : { diagnostic })
      },
      createBroker(projectRoot, history)
    );

    await writeFile(
      join(artifactDir, "agent-events.json"),
      JSON.stringify(result.events, null, 2),
      "utf8"
    );

    let appliedChangeSet;
    let verifiedBuild;
    if (testCase.expectChange) {
      assert(
        result.status === "awaiting-approval",
        `expected approval, got ${result.status}`
      );
      assert(result.changeset !== undefined, "expected Codex to create a changeset");
      await writeFile(join(artifactDir, "patch.diff"), result.changeset.patch, "utf8");
      appliedChangeSet = await history.applyChangeSet(result.changeset.id);
      verifiedBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      await writeFile(
        join(artifactDir, "verification-log.txt"),
        verifiedBuild.rawLog,
        "utf8"
      );
    } else {
      assert(result.changeset === undefined, "expected no changeset for no-edit case");
    }

    const finalContents = await readFile(join(projectRoot, "main.tex"), "utf8");
    testCase.verify({
      beforeContents,
      finalContents,
      initialBuild,
      result,
      appliedChangeSet,
      verifiedBuild
    });
    await writeFile(join(artifactDir, "final-main.tex"), finalContents, "utf8");

    return {
      id: testCase.id,
      title: testCase.title,
      passed: true,
      durationMs: Date.now() - startedAt,
      initialCompileStatus: initialBuild.status,
      agentStatus: result.status,
      changeSetId: result.changeset?.id,
      verificationStatus: verifiedBuild?.status,
      artifactDir
    };
  } catch (error) {
    const finalContents = await readFile(join(projectRoot, "main.tex"), "utf8").catch(
      () => ""
    );
    await writeFile(join(artifactDir, "final-main.tex"), finalContents, "utf8");
    return {
      id: testCase.id,
      title: testCase.title,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      artifactDir
    };
  } finally {
    history.close();
  }
}

function createBroker(projectRoot, history) {
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
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      })
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
