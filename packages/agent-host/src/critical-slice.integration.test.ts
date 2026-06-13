import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HistoryStore } from "@latex-agent/history-service";
import { detectLatexToolchain, runLatexBuild } from "@latex-agent/latex-service";
import {
  createProjectEntry,
  deleteProjectEntry,
  moveProjectEntry,
  type ProjectFileTreeNode,
  ProjectMetadataStore,
  openProject,
  readProjectFile,
  setProjectMainFile,
  writeProjectFile
} from "@latex-agent/project-service";

import { completeDeniedApproval } from "./approval.js";
import { MockAgentProvider, type AgentToolBroker } from "./index.js";

let sandboxPath: string;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-critical-slice-"));
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("critical vertical slice", () => {
  it("reviews an agent compile fix as a changeset, rejects without writing, then applies and verifies", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "agent-review-paper");
    await mkdir(projectRoot, { recursive: true });
    const brokenMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Missing document end.",
      ""
    ].join("\n");
    await writeFile(join(projectRoot, "main.tex"), brokenMain, "utf8");

    const history = new HistoryStore(join(sandboxPath, "agent-review.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const failedBuild = await broker.runCompile();
      expect(failedBuild.status).toBe("failed");

      const rejectedResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );
      expect(rejectedResult.status).toBe("awaiting-approval");
      expect(rejectedResult.changeset?.filePath).toBe("main.tex");
      expect(rejectedResult.changeset?.patch).toContain("+\\end{document}");

      const rejectedChangeset = history.rejectChangeSet(
        rejectedResult.changeset?.id ?? ""
      );
      expect(rejectedChangeset.status).toBe("rejected");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe(
        brokenMain
      );

      const approvedResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );
      expect(approvedResult.changeset?.status).toBe("proposed");
      const applied = await broker.applyPatch(approvedResult.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\end{document}"
      );

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("runs a bounded autonomous local repair loop until compile succeeds", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "autonomous-local-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "See Figure~\\ref{fig:missing}.",
        "Hello",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "autonomous-local.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "autonomous-local",
          projectRoot,
          prompt: "Repair the local compile error autonomously.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          maxTurns: 2
        },
        broker
      );

      expect(result.status).toBe("completed");
      expect(result.buildResult?.status).toBe("succeeded");
      expect(result.events.some((event) => event.type === "verification")).toBe(true);
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\end{document}"
      );
    } finally {
      history.close();
    }
  }, 120_000);

  it("applies a selected prose improvement without rewriting unrelated text, then compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "selected-prose-paper");
    await mkdir(projectRoot, { recursive: true });
    const selectedParagraph =
      "This is a bit rough, but we show that our method works well in \\autoref{sec:method} and follows \\citep{smith2024}.";
    const unrelatedParagraph =
      "This unrelated paragraph with \\label{sec:method} must remain exactly the same.";
    const originalMain = [
      "\\documentclass{article}",
      "\\usepackage{hyperref}",
      "\\usepackage{natbib}",
      "\\begin{document}",
      unrelatedParagraph,
      selectedParagraph,
      "\\bibliographystyle{plainnat}",
      "\\bibliography{references}",
      "\\end{document}",
      ""
    ].join("\n");
    await writeFile(join(projectRoot, "main.tex"), originalMain, "utf8");
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@article{smith2024,",
        "  title={Reliable Local Editing},",
        "  author={Smith, Ada},",
        "  journal={Journal of Typesetting},",
        "  year={2024}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "selected-prose.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Improve academic tone of the selected paragraph",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          selectedText: selectedParagraph
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain(unrelatedParagraph);
      expect(result.changeset?.patch).toContain("\\autoref{sec:method}");
      expect(result.changeset?.patch).toContain("\\citep{smith2024}");
      expect(result.changeset?.patch).toContain("preliminary");
      expect(result.changeset?.patch).toContain("we demonstrate that");
      expect(result.changeset?.patch).toContain("performs effectively");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain(unrelatedParagraph);
      expect(updatedMain).toContain("\\autoref{sec:method}");
      expect(updatedMain).toContain("\\citep{smith2024}");
      expect(updatedMain).not.toContain(selectedParagraph);

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("applies a shortened selected abstract, keeps contributions, verifies word count, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "shorten-abstract-paper");
    await mkdir(projectRoot, { recursive: true });
    const abstractBody = [
      "This paper studies local-first LaTeX editing workflows for researchers, instructors, students, and laboratory teams who need reliable compilation, reviewable changes, reproducible source control, local privacy boundaries, careful file handling, and predictable editing support during long scholarly writing projects.",
      "The prototype combines project navigation, PDF feedback, constrained agent assistance, structured histories, reference checks, diagnostics, and submission preparation so authors can inspect errors, revise drafts, and continue writing without granting an unrestricted external tool access to every project on the machine.",
      "Related systems motivate the workflow \\citep{doe2025}.",
      "We evaluate the approach with representative thesis-like projects, citation-heavy manuscripts, figure-heavy manuscripts, and broken builds that expose common editing failures across typical academic writing sessions.",
      "Our contributions are a scoped agent workflow, a review-first patch model, and compile verification after approved changes.",
      "Additional background material describes onboarding examples, annotation details, configuration choices, interface alternatives, classroom deployment notes, and pilot-study logistics that are useful for planning but unnecessary for the concise abstract.",
      "The remaining discussion describes optional integrations, deployment notes, interface alternatives, and additional implementation details that are not required for the core claim."
    ].join(" ");
    const selectedAbstract = `\\begin{abstract}\n${abstractBody}\n\\end{abstract}`;
    const unrelatedBody = "\\section{Introduction}\nUnrelated body text must remain.";
    const originalMain = [
      "\\documentclass{article}",
      "\\usepackage{natbib}",
      "\\begin{document}",
      selectedAbstract,
      unrelatedBody,
      "\\bibliographystyle{plainnat}",
      "\\bibliography{references}",
      "\\end{document}",
      ""
    ].join("\n");
    await writeFile(join(projectRoot, "main.tex"), originalMain, "utf8");
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@article{doe2025,",
        "  title={Agentic Writing Tools},",
        "  author={Doe, Jane},",
        "  journal={Journal of Scholarly Systems},",
        "  year={2025}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "shorten-abstract.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Shorten the selected abstract to 150 words",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          selectedText: selectedAbstract
        },
        broker
      );

      expect(countWords(abstractBody)).toBeGreaterThan(150);
      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\begin{abstract}");
      expect(result.changeset?.patch).toContain("\\end{abstract}");
      expect(result.changeset?.patch).toContain("\\citep{doe2025}");
      expect(result.changeset?.patch).toContain("Our contributions are");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      const revisedAbstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/u.exec(
        updatedMain
      )?.[1];
      expect(updatedMain).toContain(unrelatedBody);
      expect(updatedMain).toContain("\\begin{abstract}");
      expect(updatedMain).toContain("\\end{abstract}");
      expect(revisedAbstract).toContain("\\citep{doe2025}");
      expect(revisedAbstract).toContain("Our contributions are");
      expect(revisedAbstract).not.toContain("optional integrations");
      expect(countWords(revisedAbstract ?? "")).toBeLessThanOrEqual(150);

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("expands selected method notes, preserves TODOs, applies review patch, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "method-notes-paper");
    await mkdir(projectRoot, { recursive: true });
    const selectedNotes = [
      "- recruited 24 participants from writing lab",
      "- compared draft time & compile recovery",
      "- observed 12% fewer unresolved errors",
      "- TODO: confirm participant exclusion criteria"
    ].join("\n");
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Method}",
        selectedNotes,
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "method-notes.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Expand the selected rough notes into polished method prose",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          selectedText: selectedNotes
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain(
        "TODO: confirm participant exclusion criteria"
      );
      expect(result.changeset?.patch).toContain("draft time \\& compile recovery");
      expect(result.changeset?.patch).toContain("12\\% fewer unresolved errors");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("TODO: confirm participant exclusion criteria");
      expect(updatedMain).not.toContain("- recruited");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("normalizes terminology after audit, preserves citation and label internals, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "terminology-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Dataset}",
        "\\label{sec:corpus}",
        "The dataset includes a small data set from the camera corpus.",
        "We compare the corpus with prior work \\cite{corpus2024}.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "terminology.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt:
            "Run a consistency audit and normalize terminology for dataset, data set, and corpus.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(
        result.events.some(
          (event) =>
            event.type === "message" &&
            event.content.includes('Domain-specific terms for confirmation: "corpus"')
        )
      ).toBe(true);

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\label{sec:corpus}");
      expect(updatedMain).toContain("\\cite{corpus2024}");
      expect(updatedMain).toContain(
        "The dataset includes a small dataset from the camera dataset."
      );
      expect(updatedMain).toContain("We compare the dataset with prior work");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("repairs an unbalanced caption brace with a minimal patch and recompiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "caption-brace-paper");
    await mkdir(projectRoot, { recursive: true });
    const brokenCaption = "\\caption{Accuracy for \\textbf{best run";
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{figure}",
        brokenCaption,
        "\\label{fig:accuracy}",
        "\\end{figure}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "caption-brace.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the unbalanced brace in the caption only.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic: {
            severity: "error",
            filePath: "main.tex",
            line: 4,
            message: "Runaway argument in \\caption"
          }
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain(
        "\\caption{Accuracy for \\textbf{best run}}"
      );
      expect(result.changeset?.patch).toContain("\\label{fig:accuracy}");
      expect(result.changeset?.patch).not.toContain("This prose was rewritten");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\caption{Accuracy for \\textbf{best run}}");
      expect(updatedMain).toContain("\\label{fig:accuracy}");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("generates a table from pasted data, applies review patch, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "generated-table-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Results}",
        "The experimental summary appears below.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "generated-table.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: [
            "Generate a LaTeX table from this pasted data.",
            "caption: Experiment results",
            "label: tab:experiment-results",
            "Method,Accuracy,F1",
            "Baseline,0.81,0.78",
            "Proposed,0.89,0.86"
          ].join("\n"),
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\begin{table}[ht]");
      expect(result.changeset?.patch).toContain("\\caption{Experiment results}");
      expect(result.changeset?.patch).toContain("\\label{tab:experiment-results}");
      expect(result.changeset?.patch).toContain("Method & Accuracy & F1 \\\\");
      expect(
        result.events.some(
          (event) =>
            event.type === "message" &&
            event.content.includes("Generated a reviewable LaTeX table")
        )
      ).toBe(true);

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\begin{table}[ht]");
      expect(updatedMain).toContain("Proposed & 0.89 & 0.86 \\\\");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("inserts a figure environment for an existing asset, applies review patch, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "insert-figure-paper");
    await mkdir(join(projectRoot, "figures"), { recursive: true });
    await writeFile(
      join(projectRoot, "asset-source.tex"),
      [
        "\\documentclass{article}",
        "\\pagestyle{empty}",
        "\\begin{document}",
        "\\fbox{Accuracy}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    const assetBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "asset-source.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(assetBuild.status).toBe("succeeded");
    await copyFile(
      assetBuild.artifact?.pdfPath ?? "",
      join(projectRoot, "figures", "accuracy.pdf")
    );
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Results}",
        "The accuracy trend is summarized below.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "insert-figure.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: [
            "Insert a figure environment after the results paragraph.",
            "file: figures/accuracy.pdf",
            "caption: Accuracy by epoch",
            "label: fig:accuracy"
          ].join("\n"),
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\usepackage{graphicx}");
      expect(result.changeset?.patch).toContain(
        "\\includegraphics[width=0.8\\linewidth]{figures/accuracy.pdf}"
      );
      expect(result.changeset?.patch).toContain("\\caption{Accuracy by epoch}");
      expect(result.changeset?.patch).toContain("\\label{fig:accuracy}");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\begin{figure}[ht]");
      expect(updatedMain).toContain("\\label{fig:accuracy}");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("repairs an overfull hbox caused by a long URL, applies the review patch, and recompiles cleanly", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "overfull-url-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{hyperref}",
        "\\begin{document}",
        "Reference URL:",
        "\\url{https://example.com/really/long/path/with/many/segments/that/should/overflow/in/a/narrow/measure/without/xurl/support/in/this/document}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "overfull-url.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const originalBuild = await broker.runCompile();
      expect(originalBuild.status).toBe("succeeded");
      expect(originalBuild.rawLog).toMatch(/Overfull \\hbox/iu);

      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix this overfull hbox warning without hiding warnings globally.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic: originalBuild.diagnostics[0] ?? {
            severity: "warning",
            filePath: "main.tex",
            line: 5,
            message: "Overfull \\hbox"
          }
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\usepackage{xurl}");

      await broker.applyPatch(result.changeset?.id ?? "");
      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.rawLog).not.toMatch(/Overfull \\hbox/iu);
    } finally {
      history.close();
    }
  }, 120_000);

  it("improves a wide table layout with a reviewed patch and recompiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "wide-table-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{table}[ht]",
        "\\centering",
        "\\caption{Wide results}",
        "\\label{tab:wide-results}",
        "\\begin{tabular}{lrrrrrr}",
        "\\hline",
        "Model & Accuracy & F1 & Latency & Memory & Params & Notes \\\\",
        "\\hline",
        "Baseline & 0.81 & 0.78 & 42 & 512 & 10M & fast \\\\",
        "Full & 0.89 & 0.86 & 55 & 640 & 12M & best \\\\",
        "\\hline",
        "\\end{tabular}",
        "\\end{table}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "wide-table.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const originalBuild = await broker.runCompile();
      expect(originalBuild.status).toBe("succeeded");

      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt:
            "Improve table layout so it fits page width without changing numeric values.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\usepackage{graphicx}");
      expect(result.changeset?.patch).toContain("\\resizebox{\\linewidth}{!}{%");

      await broker.applyPatch(result.changeset?.id ?? "");
      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\resizebox{\\linewidth}{!}{%"
      );
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "Baseline & 0.81 & 0.78 & 42 & 512 & 10M & fast \\\\"
      );
    } finally {
      history.close();
    }
  }, 120_000);

  it("converts rough math into a labelled display equation and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "display-equation-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Model}",
        "The training objective is defined below.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "display-equation.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt:
            "Convert rough math into a display equation for mean squared error loss and label: eq:mse-loss",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\begin{equation}");
      expect(result.changeset?.patch).toContain("\\label{eq:mse-loss}");
      expect(result.changeset?.patch).toContain("\\left(y_i - \\hat{y}_i\\right)^2");

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\begin{equation}");
      expect(updatedMain).toContain("\\end{equation}");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("cleans duplicate preamble packages with a minimal patch and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "preamble-cleanup-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage[dvipsnames]{xcolor}",
        "\\usepackage[table]{xcolor}",
        "\\usepackage{hyperref}",
        "\\usepackage{hyperref}",
        "\\begin{document}",
        "Preamble cleanup.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "preamble-cleanup.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Clean up the preamble by removing duplicate package declarations.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic: {
            severity: "error",
            filePath: "main.tex",
            line: 3,
            message: "Option clash for package xcolor"
          }
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain(
        "\\usepackage[dvipsnames,table]{xcolor}"
      );
      expect(
        result.events.some(
          (event) =>
            event.type === "message" && event.content.includes("Preamble audit")
        )
      ).toBe(true);

      const applied = await broker.applyPatch(result.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain.match(/\\usepackage(?:\[[^\]]*\])?\{xcolor\}/gu)).toHaveLength(
        1
      );
      expect(updatedMain.match(/\\usepackage\{hyperref\}/gu)).toHaveLength(1);

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("explains an unresolved missing local package without proposing a patch", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "missing-style-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{customstyle}",
        "\\begin{document}",
        "Body.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "missing-style.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const failedBuild = await broker.runCompile();
      expect(failedBuild.status).toBe("failed");
      expect(`${failedBuild.stdout}\n${failedBuild.rawLog}`).toContain(
        "customstyle.sty"
      );
      const diagnostic = failedBuild.diagnostics.find((entry) =>
        entry.message.includes("customstyle.sty")
      );
      if (diagnostic === undefined) {
        throw new Error("Expected missing customstyle.sty diagnostic.");
      }

      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic
        },
        broker
      );

      expect(result.status).toBe("completed");
      expect(result.changeset).toBeUndefined();
      expect(
        result.events.some(
          (event) =>
            event.type === "message" &&
            event.content.includes("customstyle.sty") &&
            event.content.includes("Add the local package file or install it")
        )
      ).toBe(true);
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\usepackage{customstyle}"
      );
    } finally {
      history.close();
    }
  }, 90_000);

  it("rolls back a bad applied edit, restores the file, records audit, and recompiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "rollback-paper");
    await mkdir(projectRoot, { recursive: true });
    const originalMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Original claim: treatment improves accuracy.",
      "\\end{document}",
      ""
    ].join("\n");
    const wrongMain = originalMain.replace("improves accuracy", "reduces accuracy");
    await writeFile(join(projectRoot, "main.tex"), originalMain, "utf8");

    const history = new HistoryStore(join(sandboxPath, "rollback.sqlite"));

    try {
      const originalBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(originalBuild.status).toBe("succeeded");

      const changeset = await history.createChangeSet({
        projectRoot,
        filePath: "main.tex",
        beforeContents: originalMain,
        afterContents: wrongMain,
        summary: "Bad meaning change"
      });
      expect(changeset.patch).toContain(
        "-Original claim: treatment improves accuracy."
      );
      expect(changeset.patch).toContain("+Original claim: treatment reduces accuracy.");

      const applied = await history.applyChangeSet(changeset.id);
      expect(applied.status).toBe("applied");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe(
        wrongMain
      );

      const badBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(badBuild.status).toBe("succeeded");

      const reverted = await history.rollbackChangeSet(applied.id);
      expect(reverted.status).toBe("reverted");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe(
        originalMain
      );

      const verifiedBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(verifiedBuild.status).toBe("succeeded");

      const auditEvents = await history.listAuditEvents(projectRoot);
      expect(
        auditEvents.some(
          (event) =>
            event.eventType === "changeset.reverted" &&
            event.changesetId === changeset.id
        )
      ).toBe(true);
    } finally {
      history.close();
    }
  }, 90_000);

  it("rolls back a failed overbroad agent repair, restores the file, and succeeds with a smaller retry", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "rollback-agent-repair-paper");
    await mkdir(projectRoot, { recursive: true });
    const originalMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Original claim: treatment improves accuracy.",
      ""
    ].join("\n");
    const badRepairMain = [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "Original claim: treatment improves accuracy.",
      "\\begin{figure}",
      "\\caption{Broken repair for \\textbf{results",
      "\\label{fig:broken}",
      "\\end{figure}",
      "\\undefinedcommand",
      "\\end{document}",
      ""
    ].join("\n");
    await writeFile(join(projectRoot, "main.tex"), originalMain, "utf8");

    const history = new HistoryStore(join(sandboxPath, "rollback-agent-repair.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const originalBuild = await broker.runCompile();
      expect(originalBuild.status).toBe("failed");
      expect(originalBuild.diagnostics[0]?.message).toContain(
        "Missing \\end{document}"
      );

      const badRepair = await history.createChangeSet({
        projectRoot,
        filePath: "main.tex",
        beforeContents: originalMain,
        afterContents: badRepairMain,
        summary: "Overbroad agent repair"
      });
      const applied = await history.applyChangeSet(badRepair.id);
      expect(applied.status).toBe("applied");

      const badBuild = await broker.runCompile();
      expect(badBuild.status).toBe("failed");
      expect(badBuild.diagnostics.length).toBeGreaterThan(
        originalBuild.diagnostics.length
      );

      const reverted = await history.rollbackChangeSet(applied.id);
      expect(reverted.status).toBe("reverted");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe(
        originalMain
      );

      const auditEvents = await history.listAuditEvents(projectRoot);
      expect(
        auditEvents.some(
          (event) =>
            event.eventType === "changeset.reverted" &&
            event.changesetId === badRepair.id
        )
      ).toBe(true);

      const diagnostic = originalBuild.diagnostics[0];
      if (diagnostic === undefined) {
        throw new Error("Expected original missing document-end diagnostic.");
      }

      const retryResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error with the smallest correct edit.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic
        },
        broker
      );

      expect(retryResult.status).toBe("awaiting-approval");
      expect(retryResult.changeset?.summary).toBe(
        "Add missing \\end{document} to main.tex"
      );
      expect(retryResult.changeset?.patch).not.toContain("\\undefinedcommand");

      const repaired = await broker.applyPatch(retryResult.changeset?.id ?? "");
      expect(repaired.status).toBe("applied");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      expect(verifiedBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("moves a figure asset, catches the stale includegraphics path, updates source, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "figure-paper");
    await mkdir(join(projectRoot, "figures"), { recursive: true });
    await writeFile(
      join(projectRoot, "asset-source.tex"),
      [
        "\\documentclass{article}",
        "\\pagestyle{empty}",
        "\\begin{document}",
        "\\fbox{Plot}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    const assetBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "asset-source.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(assetBuild.status).toBe("succeeded");
    expect(assetBuild.artifact?.pdfPath).toBeDefined();
    await copyFile(assetBuild.artifact?.pdfPath ?? "", join(projectRoot, "plot1.pdf"));
    await writeFile(join(projectRoot, "figures", "error-rate.pdf"), "existing", "utf8");
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\begin{figure}",
        "\\includegraphics[width=0.4\\linewidth]{plot1}",
        "\\caption{Error rate.}",
        "\\end{figure}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const openedProject = await openProject(projectRoot, metadata);
    expect(openedProject.project.mainFilePath).toBe("main.tex");
    await expect(
      moveProjectEntry(projectRoot, "plot1.pdf", "figures/error-rate.pdf")
    ).rejects.toMatchObject({
      message: "Target path already exists."
    });

    await rm(join(projectRoot, "figures", "error-rate.pdf"));
    await moveProjectEntry(projectRoot, "plot1.pdf", "figures/error-rate.pdf");

    const staleSourceBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(staleSourceBuild.status).toBe("failed");
    expect(`${staleSourceBuild.stdout}\n${staleSourceBuild.rawLog}`).toContain("plot1");

    await writeProjectFile(
      projectRoot,
      "main.tex",
      [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\begin{figure}",
        "\\includegraphics[width=0.4\\linewidth]{figures/error-rate}",
        "\\caption{Error rate.}",
        "\\end{figure}",
        "\\end{document}",
        ""
      ].join("\n")
    );

    const refreshedProject = await openProject(projectRoot, metadata);
    const paths = flattenTree(refreshedProject.tree).map((node) => node.path);
    expect(paths).toContain("figures/error-rate.pdf");
    expect(paths).not.toContain("plot1.pdf");

    const updatedSourceBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(updatedSourceBuild.status).toBe("succeeded");
    expect(updatedSourceBuild.artifact?.pdfPath).toContain("main.pdf");
  }, 120_000);

  it("repairs a missing figure path from a single local asset candidate and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "missing-figure-agent-paper");
    await mkdir(join(projectRoot, "assets"), { recursive: true });
    await writeFile(
      join(projectRoot, "asset-source.tex"),
      [
        "\\documentclass{article}",
        "\\pagestyle{empty}",
        "\\begin{document}",
        "\\fbox{Model}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    const assetBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "asset-source.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(assetBuild.status).toBe("succeeded");
    await writeFile(
      join(projectRoot, "assets", "model.pdf"),
      await readFile(assetBuild.artifact?.pdfPath ?? "")
    );
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\begin{figure}[ht]",
        "\\centering",
        "\\includegraphics[width=0.4\\linewidth]{figures/model.png}",
        "\\caption{Model architecture}",
        "\\label{fig:model}",
        "\\end{figure}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "missing-figure-agent.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
      searchProject: async (query) => {
        const candidates = ["assets/model.pdf", "figures/model.png"];
        return (
          await Promise.all(
            candidates.map(async (candidate) => {
              const filePath = join(projectRoot, candidate);
              try {
                const fileStat = await stat(filePath);
                const basename = candidate.split("/").at(-1) ?? "";
                if (
                  query === candidate ||
                  query === "model" ||
                  query === basename.replace(/\.[^.]+$/u, "")
                ) {
                  return {
                    path: candidate,
                    contents: "",
                    mtimeMs: fileStat.mtimeMs
                  };
                }
              } catch {
                return undefined;
              }

              return undefined;
            })
          )
        ).filter(
          (match): match is { path: string; contents: string; mtimeMs: number } =>
            match !== undefined
        );
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

    try {
      const failedBuild = await broker.runCompile();
      expect(failedBuild.status).toBe("failed");

      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the missing figure in the PDF for figures/model.png.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain(
        "\\includegraphics[width=0.4\\linewidth]{assets/model.pdf}"
      );

      await broker.applyPatch(result.changeset?.id ?? "");
      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\includegraphics[width=0.4\\linewidth]{assets/model.pdf}"
      );
    } finally {
      history.close();
    }
  }, 120_000);

  it("creates a new section file, includes it from main.tex, blocks traversal, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Manuscript body.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const openedProject = await openProject(projectRoot, metadata);
    expect(openedProject.project.mainFilePath).toBe("main.tex");

    await createProjectEntry(projectRoot, ".", "sections", "directory");
    await createProjectEntry(projectRoot, "sections", "evaluation.tex", "file");
    await expect(
      createProjectEntry(projectRoot, ".", "../evaluation.tex", "file")
    ).rejects.toThrow();

    await writeProjectFile(
      projectRoot,
      "sections/evaluation.tex",
      [
        "\\section{Evaluation}",
        "\\typeout{EVALUATION_SECTION_INCLUDED}",
        "Evaluation results.",
        ""
      ].join("\n")
    );

    await writeProjectFile(
      projectRoot,
      "main.tex",
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Manuscript body.",
        "\\input{sections/evaluation}",
        "\\end{document}",
        ""
      ].join("\n")
    );

    const refreshedProject = await openProject(projectRoot, metadata);
    const sectionsNode = refreshedProject.tree.find((node) => node.path === "sections");

    expect(
      sectionsNode?.children?.some((node) => node.path === "sections/evaluation.tex")
    ).toBe(true);

    const build = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });

    expect(build.status).toBe("succeeded");
    expect(`${build.stdout}\n${build.rawLog}`).toContain("EVALUATION_SECTION_INCLUDED");
  }, 90_000);

  it("deletes an obsolete draft, searches for stale references, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "draft-cleanup");
    await mkdir(join(projectRoot, "sections"), { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Current manuscript.",
        "\\input{sections/method}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "sections", "method.tex"),
      ["\\section{Method}", "Included method section.", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "old-results.tex"),
      ["\\section{Old Results}", "Obsolete draft.", ""].join("\n"),
      "utf8"
    );

    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const openedProject = await openProject(projectRoot, metadata);
    expect(openedProject.project.mainFilePath).toBe("main.tex");

    const deletedEntry = await deleteProjectEntry(projectRoot, "old-results.tex");
    const refreshedProject = await openProject(projectRoot, metadata);
    const refreshedPaths = flattenTree(refreshedProject.tree).map((node) => node.path);
    const staleReferences = await searchEditableProjectFiles(
      projectRoot,
      refreshedProject.tree,
      "old-results"
    );

    expect(deletedEntry.deletedPath).toBe("old-results.tex");
    await expect(
      readFile(join(projectRoot, deletedEntry.backupPath), "utf8")
    ).resolves.toContain("Obsolete draft.");
    expect(refreshedPaths).not.toContain("old-results.tex");
    expect(refreshedPaths).toContain("sections/method.tex");
    expect(staleReferences).toHaveLength(0);

    const build = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(build.status).toBe("succeeded");

    await writeFile(join(projectRoot, "included-draft.tex"), "Included draft.", "utf8");
    await writeProjectFile(
      projectRoot,
      "main.tex",
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Current manuscript.",
        "\\input{included-draft}",
        "\\end{document}",
        ""
      ].join("\n")
    );
    await deleteProjectEntry(projectRoot, "included-draft.tex");

    const staleInputReferences = await searchEditableProjectFiles(
      projectRoot,
      (await openProject(projectRoot, metadata)).tree,
      "included-draft"
    );
    expect(staleInputReferences).toContain("main.tex");

    const missingInputBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(missingInputBuild.status).toBe("failed");
    expect(`${missingInputBuild.stdout}\n${missingInputBuild.rawLog}`).toContain(
      "included-draft"
    );
  }, 120_000);

  it("selects the correct main file in a template, compiles it, and persists the choice", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "conference-template");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "sample.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\typeout{SCENARIO_FOUR_SAMPLE_MAIN}",
        "Conference sample.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\typeout{SCENARIO_FOUR_MAIN_FILE}",
        "Conference paper.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "supplement.tex"),
      ["\\section{Supplement}", "Supplementary details.", ""].join("\n"),
      "utf8"
    );

    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const openedProject = await openProject(projectRoot, metadata);
    expect(openedProject.project.mainFilePath).toBe("main.tex");

    const sampleProject = await setProjectMainFile(projectRoot, metadata, "sample.tex");
    const sampleBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: sampleProject.project.mainFilePath ?? "",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(sampleBuild.status).toBe("succeeded");
    expect(sampleBuild.artifact?.pdfPath).toContain("sample.pdf");
    expect(`${sampleBuild.stdout}\n${sampleBuild.rawLog}`).toContain(
      "SCENARIO_FOUR_SAMPLE_MAIN"
    );

    const reopenedSampleProject = await openProject(projectRoot, metadata);
    expect(reopenedSampleProject.project.mainFilePath).toBe("sample.tex");

    const mainProject = await setProjectMainFile(projectRoot, metadata, "main.tex");
    const mainBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: mainProject.project.mainFilePath ?? "",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(mainBuild.status).toBe("succeeded");
    expect(mainBuild.artifact?.pdfPath).toContain("main.pdf");
    expect(`${mainBuild.stdout}\n${mainBuild.rawLog}`).toContain(
      "SCENARIO_FOUR_MAIN_FILE"
    );

    const reopenedMainProject = await openProject(projectRoot, metadata);
    expect(reopenedMainProject.project.mainFilePath).toBe("main.tex");
  }, 120_000);

  it("recompiles after an external figure asset is regenerated", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "external-figure-update");
    await mkdir(join(projectRoot, "figures"), { recursive: true });
    await writeFile(
      join(projectRoot, "asset-source.tex"),
      [
        "\\documentclass{article}",
        "\\pagestyle{empty}",
        "\\begin{document}",
        "\\fbox{Version 1}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    const firstAssetBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "asset-source.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(firstAssetBuild.status).toBe("succeeded");
    await copyFile(
      firstAssetBuild.artifact?.pdfPath ?? "",
      join(projectRoot, "figures", "results.pdf")
    );
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\includegraphics[width=0.4\\linewidth]{figures/results}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const openedProject = await openProject(projectRoot, metadata);
    expect(flattenTree(openedProject.tree).map((node) => node.path)).toContain(
      "figures/results.pdf"
    );

    const firstMainBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(firstMainBuild.status).toBe("succeeded");

    await writeProjectFile(
      projectRoot,
      "asset-source.tex",
      [
        "\\documentclass{article}",
        "\\pagestyle{empty}",
        "\\begin{document}",
        "\\fbox{Version 2}",
        "\\end{document}",
        ""
      ].join("\n")
    );
    const regeneratedAssetBuild = await runLatexBuild({
      projectRoot,
      mainFilePath: "asset-source.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(regeneratedAssetBuild.status).toBe("succeeded");
    await copyFile(
      regeneratedAssetBuild.artifact?.pdfPath ?? "",
      join(projectRoot, "figures", "results.pdf")
    );

    const refreshedProject = await openProject(projectRoot, metadata);
    expect(flattenTree(refreshedProject.tree).map((node) => node.path)).toContain(
      "figures/results.pdf"
    );

    const recompiledMain = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    expect(recompiledMain.status).toBe("succeeded");
    expect(recompiledMain.artifact?.pdfPath).toContain("main.pdf");
  }, 120_000);

  it("opens, edits, compiles, gets an agent patch, applies it, and recompiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "broken-project");
    await cp(join(repoRoot, "samples", "broken-compile"), projectRoot, {
      recursive: true
    });
    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const history = new HistoryStore(join(sandboxPath, "history.sqlite"));

    try {
      const openedProject = await openProject(projectRoot, metadata);
      expect(openedProject.project.mainFilePath).toBe("main.tex");

      const firstBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(firstBuild.status).toBe("failed");
      expect(firstBuild.diagnostics[0]?.message).toContain("Missing \\end{document}");
      const firstDiagnostic = firstBuild.diagnostics[0];
      if (firstDiagnostic === undefined) {
        throw new Error("Expected missing document-end diagnostic.");
      }

      const provider = new MockAgentProvider();
      const broker: AgentToolBroker = {
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
            mainFilePath: "main.tex",
            compiler: "pdflatex",
            timeoutMs: 60_000
          })
      };

      const agentResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic: firstDiagnostic
        },
        broker
      );

      expect(agentResult.status).toBe("awaiting-approval");
      expect(agentResult.changeset?.status).toBe("proposed");
      expect(agentResult.changeset?.summary).toBe(
        "Add missing \\end{document} to main.tex"
      );

      const applied = await history.applyChangeSet(agentResult.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\end{document}"
      );

      const secondBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(secondBuild.status).toBe("succeeded");
      expect(secondBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);

  it("splits a monolithic document into section files, applies the review set, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "split-manuscript");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        "Intro text with \\label{sec:intro}.",
        "\\section{Method}",
        "Method text that references \\ref{sec:intro}.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "split-manuscript.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt:
            "Split this monolithic main.tex into separate files and propose the input structure.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changesets).toHaveLength(3);

      for (const changeset of result.changesets ?? []) {
        await broker.applyPatch(changeset.id);
      }

      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\input{introduction}"
      );
      await expect(
        readFile(join(projectRoot, "introduction.tex"), "utf8")
      ).resolves.toContain("\\label{sec:intro}");
      await expect(
        readFile(join(projectRoot, "method.tex"), "utf8")
      ).resolves.toContain("\\ref{sec:intro}");

      const build = await broker.runCompile();
      expect(build.status).toBe("succeeded");
    } finally {
      history.close();
    }
  }, 120_000);

  it("renames a file, updates input references, applies the review set, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "rename-manuscript");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\input{old_method}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "old_method.tex"),
      ["\\section{Method}", "\\label{sec:method}", "Method body.", ""].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "rename-manuscript.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
      searchProject: async (query) => {
        const paths = ["main.tex", "old_method.tex"];
        const snapshots = await Promise.all(
          paths.map(async (path) => {
            const filePath = join(projectRoot, path);
            const fileStat = await stat(filePath);
            return {
              path,
              contents: await readFile(filePath, "utf8"),
              mtimeMs: fileStat.mtimeMs
            };
          })
        );
        return snapshots.filter(
          (snapshot) =>
            snapshot.path.includes(query) || snapshot.contents.includes(query)
        );
      },
      moveEntry: (fromPath, toPath) =>
        moveProjectEntry(projectRoot, fromPath, toPath).then(() => ({
          fromPath,
          toPath
        })),
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

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Rename old_method.tex to method.tex and update references.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.moveEntries).toEqual([
        { fromPath: "old_method.tex", toPath: "method.tex" }
      ]);

      for (const moveEntry of result.moveEntries ?? []) {
        await broker.moveEntry?.(moveEntry.fromPath, moveEntry.toPath);
      }
      for (const changeset of result.changesets ?? []) {
        await broker.applyPatch(changeset.id);
      }

      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\input{method}"
      );
      await expect(stat(join(projectRoot, "method.tex"))).resolves.toBeDefined();
      await expect(stat(join(projectRoot, "old_method.tex"))).rejects.toThrow();

      const build = await broker.runCompile();
      expect(build.status).toBe("succeeded");
    } finally {
      history.close();
    }
  }, 120_000);

  it("repairs a missing citation-key typo from local bibliography context and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "citation-typo-manuscript");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{natbib}",
        "\\begin{document}",
        "Foundational guidance appears in \\citep{lamprt1994}.",
        "\\bibliographystyle{plain}",
        "\\bibliography{references}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@book{lamport1994,",
        "  title = {LaTeX: A Document Preparation System},",
        "  author = {Lamport, Leslie},",
        "  year = {1994},",
        "  publisher = {Addison-Wesley}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "citation-typo.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: [
            "Fix the missing citation key lamprt1994.",
            "Use only the local bibliography context below.",
            "If a likely local reference exists, replace the missing key with that key.",
            "",
            "Local bibliography entries:",
            "lamport1994 | title=LaTeX: A Document Preparation System | author=Lamport, Leslie | year=1994"
          ].join("\n"),
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset?.patch).toContain("\\citep{lamport1994}");

      await broker.applyPatch(result.changeset?.id ?? "");
      const build = await broker.runCompile();
      expect(build.status).toBe("succeeded");
      expect(build.rawLog).not.toMatch(/undefined citations?|Citation .* undefined/iu);
    } finally {
      history.close();
    }
  }, 120_000);

  it("cleans a malformed BibTeX entry, preserves DOI/URL fields, and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "bibtex-cleanup-manuscript");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "See \\cite{smith2024}.",
        "\\bibliographystyle{plain}",
        "\\bibliography{references}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@article{smith2024,",
        "title={a study of LATEX workflows},",
        "author={ada smith and BYRON LEE},",
        "doi={ 10.1000/example },",
        "url={ https://example.com/paper },",
        "year={2024}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "bibtex-cleanup.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt:
            "Clean this malformed BibTeX entry without dropping important fields.",
          activeFilePath: "references.bib",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      await broker.applyPatch(result.changeset?.id ?? "");
      const build = await broker.runCompile();
      expect(build.status).toBe("succeeded");
      await expect(
        readFile(join(projectRoot, "references.bib"), "utf8")
      ).resolves.toContain("doi = {10.1000/example}");
      await expect(
        readFile(join(projectRoot, "references.bib"), "utf8")
      ).resolves.toContain("url = {https://example.com/paper}");
    } finally {
      history.close();
    }
  }, 120_000);

  it("adapts unsupported citation commands to natbib-compatible forms and compiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "natbib-adaptation-manuscript");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{natbib}",
        "\\begin{document}",
        "As \\textcite{lamport1994} explains, prior work exists.",
        "Later discussion uses \\parencite{knuth1984}.",
        "\\bibliographystyle{plainnat}",
        "\\bibliography{references}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@book{lamport1994,",
        "  title = {LaTeX: A Document Preparation System},",
        "  author = {Lamport, Leslie},",
        "  year = {1994},",
        "  publisher = {Addison-Wesley}",
        "}",
        "@book{knuth1984,",
        "  title = {The TeXbook},",
        "  author = {Knuth, Donald},",
        "  year = {1984},",
        "  publisher = {Addison-Wesley}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "natbib-adaptation.sqlite"));
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: async (path) => {
        const filePath = join(projectRoot, path);
        const fileStat = await stat(filePath);
        return {
          path,
          contents: await readFile(filePath, "utf8"),
          mtimeMs: fileStat.mtimeMs
        };
      },
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
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          timeoutMs: 60_000
        })
    };

    try {
      const result = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Adapt citation commands to natbib style.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.status).toBe("awaiting-approval");
      await broker.applyPatch(result.changeset?.id ?? "");
      const build = await broker.runCompile();
      expect(build.status).toBe("succeeded");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\citet{lamport1994}"
      );
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\citep{knuth1984}"
      );
    } finally {
      history.close();
    }
  }, 120_000);

  it("repairs two independent compile errors one at a time within a max attempt limit", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "multi-error-paper");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "The first compile surfaces a runaway caption.",
        "\\begin{figure}",
        "\\caption{Accuracy for \\textbf{best run",
        "\\label{fig:hidden-error}",
        "\\end{figure}",
        "The next compile surfaces \\undefinedcommand.",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );

    const history = new HistoryStore(join(sandboxPath, "multi-error.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);
    const maxRepairAttempts = 3;
    const summaries: string[] = [];

    try {
      let build = await broker.runCompile();
      expect(build.status).toBe("failed");

      let attempts = 0;
      while (build.status === "failed" && attempts < maxRepairAttempts) {
        const topDiagnostic = build.diagnostics[0];
        if (topDiagnostic === undefined) {
          throw new Error("Expected a top compile diagnostic for repair.");
        }

        const result = await provider.startSession(
          {
            providerId: "mock",
            mode: "apply-with-review",
            projectRoot,
            prompt: "Fix the top compile error with the smallest correct edit.",
            activeFilePath: "main.tex",
            mainFilePath: "main.tex",
            compiler: "pdflatex",
            diagnostic: topDiagnostic
          },
          broker
        );

        expect(result.status).toBe("awaiting-approval");
        expect(result.changeset?.status).toBe("proposed");
        summaries.push(result.changeset?.summary ?? "");

        const applied = await broker.applyPatch(result.changeset?.id ?? "");
        expect(applied.status).toBe("applied");

        attempts += 1;
        build = await broker.runCompile();
      }

      expect(attempts).toBe(2);
      expect(attempts).toBeLessThanOrEqual(maxRepairAttempts);
      expect(summaries).toEqual([
        "Mock fix for error in main.tex",
        "Remove undefined control sequence in main.tex"
      ]);
      expect(build.status).toBe("succeeded");
      expect(build.artifact?.pdfPath).toContain("main.pdf");

      const updatedMain = await readFile(join(projectRoot, "main.tex"), "utf8");
      expect(updatedMain).toContain("\\caption{Accuracy for \\textbf{best run}}");
      expect(updatedMain).not.toContain("\\undefinedcommand");
    } finally {
      history.close();
    }
  }, 90_000);

  it("denies an unsafe mixed patch, records rejection, then accepts a smaller syntax-only patch", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "deny-unsafe-patch-paper");
    await mkdir(projectRoot, { recursive: true });
    const originalMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "This prose should stay original.",
      "Syntax fix belongs below.",
      ""
    ].join("\n");
    await writeFile(join(projectRoot, "main.tex"), originalMain, "utf8");

    const history = new HistoryStore(join(sandboxPath, "deny-unsafe-patch.sqlite"));
    const provider = new MockAgentProvider();
    const broker = createFileBackedAgentBroker(projectRoot, history);

    try {
      const mixedResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix syntax and prose",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(mixedResult.status).toBe("awaiting-approval");
      expect(mixedResult.changeset?.patch).toContain(
        "This prose was rewritten by the agent."
      );
      expect(mixedResult.changeset?.patch).toContain("\\end{document}");
      const approvalEvent = mixedResult.events.find(
        (
          event
        ): event is Extract<
          (typeof mixedResult.events)[number],
          { readonly type: "approval" }
        > => event.type === "approval" && event.status === "requested"
      );
      if (approvalEvent === undefined || mixedResult.changeset === undefined) {
        throw new Error("Expected an approval-ready mixed patch.");
      }

      const deniedResult = await completeDeniedApproval({
        session: {
          providerId: "mock",
          changeset: mixedResult.changeset
        },
        request: {
          sessionId: mixedResult.sessionId,
          approvalId: approvalEvent.approvalId,
          decision: "denied"
        },
        baseEvents: [
          {
            id: "approval-event-denied",
            sessionId: mixedResult.sessionId,
            createdAt: "2026-06-10T00:00:00.000Z",
            type: "approval",
            approvalId: approvalEvent.approvalId,
            toolName: "apply-patch",
            risk: "high",
            prompt: "Review the proposed patch before applying it to the project.",
            status: "denied"
          }
        ],
        broker
      });

      expect(deniedResult.changeset?.status).toBe("rejected");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe(
        originalMain
      );
      const auditEvents = await history.listAuditEvents(projectRoot);
      expect(
        auditEvents.some(
          (event) =>
            event.eventType === "changeset.rejected" &&
            event.changesetId === mixedResult.changeset?.id
        )
      ).toBe(true);

      const smallerResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error with the smallest correct edit.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex",
          diagnostic: {
            severity: "error",
            filePath: "main.tex",
            line: 2,
            message:
              "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
          }
        },
        broker
      );

      expect(smallerResult.status).toBe("awaiting-approval");
      expect(smallerResult.changeset?.summary).toBe(
        "Add missing \\end{document} to main.tex"
      );
      expect(smallerResult.changeset?.patch).not.toContain(
        "This prose was rewritten by the agent."
      );

      const applied = await broker.applyPatch(smallerResult.changeset?.id ?? "");
      expect(applied.status).toBe("applied");

      const verifiedBuild = await broker.runCompile();
      expect(verifiedBuild.status).toBe("succeeded");
    } finally {
      history.close();
    }
  }, 90_000);
});

function flattenTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children === undefined ? [] : flattenTree(node.children))
  ]);
}

async function searchEditableProjectFiles(
  projectRoot: string,
  tree: readonly ProjectFileTreeNode[],
  query: string
): Promise<readonly string[]> {
  const matches: string[] = [];

  await Promise.all(
    flattenTree(tree)
      .filter((node) => node.kind === "file" && node.path.endsWith(".tex"))
      .map(async (node) => {
        const snapshot = await readProjectFile(projectRoot, node.path);
        if (snapshot.contents.includes(query)) {
          matches.push(snapshot.path);
        }
      })
  );

  return matches.sort();
}

function countWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function createFileBackedAgentBroker(
  projectRoot: string,
  history: HistoryStore,
  mainFilePath = "main.tex"
): AgentToolBroker {
  return {
    readFile: async (path) => {
      const filePath = join(projectRoot, path);
      const fileStat = await stat(filePath);
      return {
        path,
        contents: await readFile(filePath, "utf8"),
        mtimeMs: fileStat.mtimeMs
      };
    },
    searchProject: async (query) => {
      const filePath = join(projectRoot, query);
      try {
        const fileStat = await stat(filePath);
        return [
          {
            path: query,
            contents: "",
            mtimeMs: fileStat.mtimeMs
          }
        ];
      } catch {
        return [];
      }
    },
    proposePatch: (filePath, beforeContents, afterContents, summary) =>
      history.createChangeSet({
        projectRoot,
        filePath,
        beforeContents,
        afterContents,
        summary
      }),
    rejectPatch: (changesetId) => Promise.resolve(history.rejectChangeSet(changesetId)),
    applyPatch: (changesetId) => history.applyChangeSet(changesetId),
    runCompile: () =>
      runLatexBuild({
        projectRoot,
        mainFilePath,
        compiler: "pdflatex",
        timeoutMs: 60_000
      })
  };
}
