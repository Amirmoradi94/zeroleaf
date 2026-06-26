import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { detectLatexToolchain, runLatexBuild } from "@latex-agent/latex-service";
import type {
  BibliographyEntry,
  BuildResult,
  PdfArtifactData
} from "@latex-agent/ipc-contracts";

import {
  buildProjectLatexOutline,
  createCitationCommand,
  createDiagnosticAgentPrompt,
  createFinalFormattingReviewPrompt,
  createNumberingMismatchAgentPrompt,
  createSelectionContextFromText,
  createLatexCompletionState,
  createReferenceEntryAgentPrompt,
  detectPreferredCitationCommand,
  finishPdfPreviewBuild,
  getEditableProjectFiles,
  getLanguageForPath,
  getLatexLabelReferences,
  groupMissingCitations,
  insertTextAtLineColumn,
  latexSnippets,
  planEditorRestore,
  parseLatexOutline,
  searchFileContents,
  shouldMarkPdfStaleForProjectChange,
  startLatexCompletionProject,
  startPdfPreviewBuild,
  updateLatexCompletionCitations,
  updateLatexCompletionLabels
} from "./editorModel.js";

const tempRoots: string[] = [];

function createSelectionFromOffsets(
  contents: string,
  startOffset: number,
  endOffset: number
): {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
} {
  const start = createPositionFromOffset(contents, startOffset);
  const end = createPositionFromOffset(contents, endOffset);

  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  };
}

function createPositionFromOffset(contents: string, offset: number) {
  const beforeOffset = contents.slice(0, offset);
  const lines = beforeOffset.split("\n");
  const lineNumber = lines.length;
  const column = (lines.at(-1) ?? "").length + 1;

  return { column, lineNumber };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
  tempRoots.length = 0;
});

describe("editor model", () => {
  it("identifies the containing paragraph for a selected word", () => {
    const paragraph = [
      "We sincerely thank the Editor-in-Chief, the Associate Editor, and both reviewers for their careful",
      "reading of our manuscript and their insightful, constructive comments. The feedback has substantially",
      "improved the technical rigor, clarity, and feasibility framing of the paper. Below, we provide a detailed",
      "point-by-point response to the reviewers."
    ].join("\n");
    const contents = [
      "Previous response text should not be included.",
      "",
      paragraph,
      "",
      "==========================",
      "Response to Reviewer 1",
      "=========================="
    ].join("\n");
    const rigorOffset = contents.indexOf("rigor");
    const selection = createSelectionFromOffsets(
      contents,
      rigorOffset,
      rigorOffset + "rigor".length
    );
    const context = createSelectionContextFromText({ contents, selection });

    if (context === null) {
      throw new Error("Expected selection context for rigor.");
    }

    expect(context.selectedText).toBe("rigor");
    expect(context.containingParagraph).toBe(paragraph);
    expect(context.containingParagraph).toContain("technical rigor, clarity");
    expect(context.containingParagraph).not.toContain("Previous response text");
    expect(context.containingParagraph).not.toContain("Response to Reviewer 1");
    expect(
      context.containingParagraph.slice(
        context.selectionStartOffset,
        context.selectionEndOffset
      )
    ).toBe("rigor");
  });

  it("parses LaTeX section and label outline items", () => {
    expect(
      parseLatexOutline(
        `\\section{Intro}
Text
\\subsection{Prior Work}\\label{sec:prior}`,
        "main.tex"
      )
    ).toEqual([
      { kind: "section", title: "Intro", path: "main.tex", line: 1 },
      { kind: "subsection", title: "Prior Work", path: "main.tex", line: 3 },
      { kind: "label", title: "sec:prior", path: "main.tex", line: 3 }
    ]);
  });

  it("extracts a thesis outline in main-file include order with navigation targets", () => {
    expect(
      buildProjectLatexOutline({
        mainFilePath: "main.tex",
        files: [
          {
            path: "main.tex",
            contents: [
              "\\documentclass{report}",
              "\\begin{document}",
              "\\input{chapters/introduction}",
              "\\input{chapters/method}",
              "\\input{chapters/conclusion}",
              "\\end{document}"
            ].join("\n")
          },
          {
            path: "chapters/method.tex",
            contents: "\\chapter{Method}\n\\section{Data}"
          },
          {
            path: "chapters/conclusion.tex",
            contents: "\\chapter{Conclusion}"
          },
          {
            path: "chapters/introduction.tex",
            contents: "\\chapter{Introduction}\n\\section{Motivation}"
          }
        ]
      })
    ).toEqual([
      {
        kind: "chapter",
        title: "Introduction",
        path: "chapters/introduction.tex",
        line: 1
      },
      {
        kind: "section",
        title: "Motivation",
        path: "chapters/introduction.tex",
        line: 2
      },
      {
        kind: "chapter",
        title: "Method",
        path: "chapters/method.tex",
        line: 1
      },
      {
        kind: "section",
        title: "Data",
        path: "chapters/method.tex",
        line: 2
      },
      {
        kind: "chapter",
        title: "Conclusion",
        path: "chapters/conclusion.tex",
        line: 1
      }
    ]);
  });

  it("extracts navigation targets from the thesis-like sample project", async () => {
    const sampleFiles = await Promise.all(
      [
        "main.tex",
        "chapters/introduction.tex",
        "chapters/method.tex",
        "chapters/conclusion.tex"
      ].map(async (path) => ({
        path,
        contents: await readFile(
          fileURLToPath(
            new URL(`../../../../samples/thesis-like/${path}`, import.meta.url)
          ),
          "utf8"
        )
      }))
    );

    expect(
      buildProjectLatexOutline({
        mainFilePath: "main.tex",
        files: sampleFiles
      }).filter((item) => ["Introduction", "Method", "Conclusion"].includes(item.title))
    ).toEqual([
      {
        kind: "chapter",
        title: "Introduction",
        path: "chapters/introduction.tex",
        line: 1
      },
      {
        kind: "chapter",
        title: "Method",
        path: "chapters/method.tex",
        line: 1
      },
      {
        kind: "chapter",
        title: "Conclusion",
        path: "chapters/conclusion.tex",
        line: 1
      }
    ]);
  });

  it("skips malformed headings without crashing outline extraction", () => {
    expect(
      parseLatexOutline(
        [
          "\\chapter{Valid}",
          "\\section{Missing close brace",
          "% \\section{Commented out}",
          "\\subsection{Still Parsed}"
        ].join("\n"),
        "main.tex"
      )
    ).toEqual([
      { kind: "chapter", title: "Valid", path: "main.tex", line: 1 },
      { kind: "subsection", title: "Still Parsed", path: "main.tex", line: 4 }
    ]);
  });

  it("provides figure and equation snippets with editable placeholders and final cursor stops", () => {
    const figureSnippet = getSnippet("figure");
    const equationSnippet = getSnippet("equation");

    expect(figureSnippet.insertText).toContain("\\begin{figure}");
    expect(figureSnippet.insertText).toContain("\\includegraphics");
    expect(figureSnippet.insertText).toContain("\\label{fig:${3:label}}");
    expect(figureSnippet.insertText.endsWith("$0")).toBe(true);
    expect(equationSnippet.insertText).toContain("\\begin{equation}");
    expect(equationSnippet.insertText).toContain("\\label{eq:${2:label}}");
    expect(equationSnippet.insertText.endsWith("$0")).toBe(true);
  });

  it("compiles filled figure and equation snippets as valid LaTeX scaffolds", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-snippets-"));
    tempRoots.push(projectRoot);

    const figure = materializeSnippet(getSnippet("figure").insertText, {
      1: "figures/result",
      2: "Result figure",
      3: "result"
    });
    const equation = materializeSnippet(getSnippet("equation").insertText, {
      1: "E = mc^2",
      2: "energy"
    });

    await writeFile(
      join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage[demo]{graphicx}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
        figure,
        equation,
        "See Figure~\\ref{fig:result}, Equation~\\eqref{eq:energy}, and \\cite{smith2024}.",
        "\\bibliographystyle{plain}",
        "\\bibliography{references}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@article{smith2024,",
        "  title = {Snippet Study},",
        "  author = {Smith, Ada},",
        "  year = {2024},",
        "  journal = {Journal of Tests}",
        "}"
      ].join("\n"),
      "utf8"
    );

    await expect(
      runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      })
    ).resolves.toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("extracts label references for autocomplete from the project outline", () => {
    expect(
      getLatexLabelReferences(
        parseLatexOutline(
          [
            "\\section{Intro}\\label{sec:intro}",
            "\\begin{figure}\\label{fig:result}\\end{figure}",
            "\\section{Duplicate}\\label{sec:intro}"
          ].join("\n"),
          "main.tex"
        )
      )
    ).toEqual([
      { key: "sec:intro", path: "main.tex", line: 1 },
      { key: "fig:result", path: "main.tex", line: 2 }
    ]);
  });

  it("keeps citation and label completions scoped to the active project", () => {
    const projectAEntry = createBibliographyEntry("projectA2026");
    const projectBEntry = createBibliographyEntry("projectB2026");
    const projectBLabel = { key: "fig:project-b", path: "main.tex", line: 8 };

    let state = startLatexCompletionProject(createLatexCompletionState(), "/project-a");
    state = updateLatexCompletionCitations(state, "/project-a", [projectAEntry]);
    state = startLatexCompletionProject(state, "/project-b");
    state = updateLatexCompletionCitations(state, "/project-a", [projectAEntry]);
    state = updateLatexCompletionCitations(state, "/project-b", [projectBEntry]);
    state = updateLatexCompletionLabels(state, "/project-a", [
      { key: "fig:project-a", path: "main.tex", line: 3 }
    ]);
    state = updateLatexCompletionLabels(state, "/project-b", [projectBLabel]);

    expect(state.citations.map((entry) => entry.key)).toEqual(["projectB2026"]);
    expect(state.labels).toEqual([projectBLabel]);
  });

  it("groups multiple missing citation occurrences by key", () => {
    expect(
      groupMissingCitations([
        {
          key: "missing2026",
          command: "cite",
          filePath: "main.tex",
          line: 12
        },
        {
          key: "other2026",
          command: "citep",
          filePath: "main.tex",
          line: 18
        },
        {
          key: "missing2026",
          command: "textcite",
          filePath: "sections/related.tex",
          line: 4
        }
      ])
    ).toEqual([
      {
        key: "missing2026",
        occurrences: [
          {
            key: "missing2026",
            command: "cite",
            filePath: "main.tex",
            line: 12
          },
          {
            key: "missing2026",
            command: "textcite",
            filePath: "sections/related.tex",
            line: 4
          }
        ]
      },
      {
        key: "other2026",
        occurrences: [
          {
            key: "other2026",
            command: "citep",
            filePath: "main.tex",
            line: 18
          }
        ]
      }
    ]);
  });

  it("creates citation commands that match detectable project style", () => {
    expect(
      createCitationCommand({
        key: "knuth1984",
        sources: [
          {
            path: "main.tex",
            contents: "\\documentclass{article}\n\\begin{document}"
          }
        ]
      })
    ).toBe("\\cite{knuth1984}");
    expect(
      createCitationCommand({
        key: "lamport1994",
        sources: [
          {
            path: "main.tex",
            contents: [
              "\\documentclass{article}",
              "\\usepackage{natbib}",
              "\\begin{document}"
            ].join("\n")
          }
        ]
      })
    ).toBe("\\citep{lamport1994}");
    expect(
      createCitationCommand({
        key: "knuth1984",
        sources: [
          {
            path: "main.tex",
            contents: [
              "\\documentclass{article}",
              "\\usepackage[backend=biber]{biblatex}",
              "\\begin{document}"
            ].join("\n")
          }
        ]
      })
    ).toBe("\\parencite{knuth1984}");
  });

  it("falls back to existing citation command style when no package declares one", () => {
    expect(
      detectPreferredCitationCommand([
        {
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "% \\usepackage{natbib}",
            "\\begin{document}",
            "Earlier work used \\parencite{known2026}."
          ].join("\n")
        }
      ])
    ).toBe("parencite");
  });

  it("inserts generated citation text at a multi-line cursor position", () => {
    const citation = createCitationCommand({
      key: "knuth1984",
      sources: [
        {
          path: "main.tex",
          contents: "\\documentclass{article}\n\\begin{document}"
        }
      ]
    });

    expect(
      insertTextAtLineColumn({
        contents: ["\\section{Related Work}", "Prior work includes ."].join("\n"),
        lineNumber: 2,
        column: "Prior work includes ".length + 1,
        text: citation
      })
    ).toBe(
      ["\\section{Related Work}", "Prior work includes \\cite{knuth1984}."].join("\n")
    );
  });

  it("creates capped diagnostic agent prompts with build log context", () => {
    const diagnostic = {
      severity: "error" as const,
      filePath: "main.tex",
      line: 12,
      message: "Missing } inserted"
    };
    const buildResult = {
      ...createBuildResult("failed"),
      diagnostics: [diagnostic],
      rawLog: `${"early log line\n".repeat(400)}! Missing } inserted.\n${"late log line\n".repeat(400)}`,
      rawLogTruncated: true,
      rawLogBytes: 8_000,
      rawLogOriginalBytes: 24_000
    };

    const prompt = createDiagnosticAgentPrompt(diagnostic, buildResult);

    expect(prompt).toContain("Fix this LaTeX diagnostic.");
    expect(prompt).toContain("Diagnostic: error at main.tex:12: Missing } inserted");
    expect(prompt).toContain("Build log context (capped to");
    expect(prompt).toContain("do not infer from omitted log lines");
    expect(prompt).toContain("truncated to 8000 of 24000 bytes");
    expect(prompt).toContain("! Missing } inserted.");
    expect(prompt.length).toBeLessThan(4_000);
  });

  it("creates bibliography-entry prompts constrained to the attached key", () => {
    const prompt = createReferenceEntryAgentPrompt({
      type: "article",
      key: "smith2026",
      title: "Reliable LaTeX Workflows",
      author: "Smith",
      year: "2026",
      venue: "Journal of Typesetting",
      doi: "10.1000/example",
      filePath: "references.bib",
      line: 7,
      raw: `@article{smith2026,\n  title={Reliable LaTeX Workflows}\n}`
    });

    expect(prompt).toContain("Use only the attached bibliography entry below.");
    expect(prompt).toContain("\\cite{smith2026}");
    expect(prompt).toContain("the only attached key is smith2026");
    expect(prompt).toContain("key=smith2026");
    expect(prompt).not.toContain("knuth1984");
  });

  it("creates final formatting review prompts from diagnostics, references, and submission checks", () => {
    const prompt = createFinalFormattingReviewPrompt(
      {
        ...createBuildResult("failed"),
        diagnostics: [
          {
            severity: "warning",
            filePath: "main.tex",
            line: 14,
            message: "Reference `missing2026' undefined"
          }
        ]
      },
      {
        entries: [
          {
            type: "article",
            key: "smith2024",
            title: "Local Editing",
            filePath: "references.bib",
            line: 22,
            raw: "@article{smith2024}"
          }
        ],
        citations: [
          {
            key: "missing2026",
            command: "\\cite",
            filePath: "main.tex",
            line: 14
          }
        ],
        missingCitations: [
          {
            key: "missing2026",
            command: "\\cite",
            filePath: "main.tex",
            line: 14
          }
        ],
        unusedEntries: [
          {
            type: "article",
            key: "smith2024",
            title: "Local Editing",
            filePath: "references.bib",
            line: 22,
            raw: "@article{smith2024}"
          }
        ]
      },
      {
        checkedAt: "2026-06-10T00:00:00.000Z",
        items: [
          {
            severity: "warning",
            message: "Generated build artifact is present in the source tree.",
            filePath: ".latex-agent/build/main.log"
          }
        ]
      }
    );

    expect(prompt).toContain("Final PDF formatting review before submission.");
    expect(prompt).toContain(
      "Inspect warnings, figures, tables, references, and the submission check."
    );
    expect(prompt).toContain("Reference `missing2026' undefined");
    expect(prompt).toContain("Missing citation key missing2026 referenced by \\cite.");
    expect(prompt).toContain("Unused bibliography entry smith2024.");
    expect(prompt).toContain("Generated build artifact is present in the source tree.");
    expect(prompt).toContain(
      "If no rendered PDF snapshot is attached, keep visual claims limited to source, diagnostics, and submission-check evidence."
    );
  });

  it("creates a figure numbering mismatch review prompt", () => {
    const prompt = createNumberingMismatchAgentPrompt();

    expect(prompt).toContain("Figure numbering mismatch");
    expect(prompt).toContain("Compare source figure order");
    expect(prompt).toContain("Inspect \\label before \\caption");
    expect(prompt).toContain("preserve semantic source order");
  });

  it("compiles after inserting a searched local bibliography citation", async () => {
    const toolchain = await detectLatexToolchain();

    if (
      !toolchain.latexmkAvailable ||
      !toolchain.availableCompilers.includes("pdflatex")
    ) {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "citation-insert-"));
    tempRoots.push(projectRoot);
    const initialSource = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Related work includes CURSOR.",
      "\\bibliographystyle{plain}",
      "\\bibliography{references}",
      "\\end{document}",
      ""
    ].join("\n");
    const insertedCitation = createCitationCommand({
      key: "knuth1984",
      sources: [{ path: "main.tex", contents: initialSource }]
    });

    await writeFile(
      join(projectRoot, "main.tex"),
      initialSource.replace("CURSOR", insertedCitation),
      "utf8"
    );
    await writeFile(
      join(projectRoot, "references.bib"),
      [
        "@book{knuth1984,",
        "  title = {The TeXbook},",
        "  author = {Knuth, Donald},",
        "  year = {1984},",
        "  publisher = {Addison-Wesley}",
        "}",
        "",
        "@book{lamport1994,",
        "  title = {LaTeX: A Document Preparation System},",
        "  author = {Lamport, Leslie},",
        "  year = {1994},",
        "  publisher = {Addison-Wesley}",
        "}"
      ].join("\n"),
      "utf8"
    );

    const result = await runLatexBuild({
      projectRoot,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });
    const finalSource = await readFile(join(projectRoot, "main.tex"), "utf8");

    expect(finalSource).toContain("\\cite{knuth1984}");
    expect(result.status).toBe("succeeded");
    expect(result.rawLog).not.toMatch(/undefined citations?|Citation .* undefined/iu);
  }, 90_000);

  it("preserves the visible stale PDF while a compile is running", () => {
    const artifactData = createPdfArtifactData("old.pdf");

    expect(
      startPdfPreviewBuild({
        artifactData,
        stale: true
      })
    ).toEqual({
      artifactData,
      stale: true
    });
  });

  it("replaces the PDF artifact and clears stale state after a successful build", () => {
    const oldArtifactData = createPdfArtifactData("old.pdf");
    const newArtifactData = createPdfArtifactData("new.pdf");

    expect(
      finishPdfPreviewBuild({
        state: {
          artifactData: oldArtifactData,
          stale: true
        },
        result: createBuildResult("succeeded"),
        artifactData: newArtifactData
      })
    ).toEqual({
      artifactData: newArtifactData,
      stale: false
    });
  });

  it("keeps the previous PDF visible and stale after a failed build", () => {
    const artifactData = createPdfArtifactData("old.pdf");

    expect(
      finishPdfPreviewBuild({
        state: {
          artifactData,
          stale: false
        },
        result: createBuildResult("failed")
      })
    ).toEqual({
      artifactData,
      stale: true
    });
  });

  it("detects editor language by project path", () => {
    expect(getLanguageForPath("main.tex")).toBe("latex");
    expect(getLanguageForPath("references.bib")).toBe("bibtex");
    expect(getLanguageForPath("notes.md")).toBe("markdown");
  });

  it("filters editable text files from a project tree", () => {
    expect(
      getEditableProjectFiles([
        { kind: "file", name: "main.tex", path: "main.tex" },
        { kind: "file", name: "figure.pdf", path: "figure.pdf" },
        {
          kind: "directory",
          name: "sections",
          path: "sections",
          children: [{ kind: "file", name: "intro.tex", path: "sections/intro.tex" }]
        }
      ]).map((file) => file.path)
    ).toEqual(["main.tex", "sections/intro.tex"]);
  });

  it("restores the saved active dissertation chapter before the main file", () => {
    expect(
      planEditorRestore({
        availablePaths: new Set([
          "main.tex",
          "chapters/background.tex",
          "chapters/results.tex"
        ]),
        mainFilePath: "main.tex",
        savedState: {
          projectRoot: "/projects/dissertation",
          openFilePaths: [
            "main.tex",
            "chapters/background.tex",
            "chapters/results.tex"
          ],
          activeFilePath: "chapters/results.tex"
        }
      })
    ).toEqual({
      filePaths: ["chapters/results.tex", "main.tex", "chapters/background.tex"],
      activeFilePath: "chapters/results.tex"
    });
  });

  it("ignores missing restored files and falls back to the main file", () => {
    expect(
      planEditorRestore({
        availablePaths: new Set(["main.tex"]),
        mainFilePath: "main.tex",
        savedState: {
          projectRoot: "/projects/dissertation",
          openFilePaths: ["chapters/moved.tex"],
          activeFilePath: "chapters/moved.tex"
        }
      })
    ).toEqual({
      filePaths: ["main.tex"],
      activeFilePath: "main.tex"
    });
  });

  it("lets explicit project actions prefer a newly targeted file", () => {
    expect(
      planEditorRestore({
        availablePaths: new Set(["main.tex", "chapters/revised.tex"]),
        mainFilePath: "main.tex",
        preferredFilePath: "chapters/revised.tex",
        savedState: {
          projectRoot: "/projects/dissertation",
          openFilePaths: ["main.tex"],
          activeFilePath: "main.tex"
        }
      })
    ).toEqual({
      filePaths: ["chapters/revised.tex", "main.tex"],
      activeFilePath: "chapters/revised.tex"
    });
  });

  it("searches file contents case-insensitively", () => {
    expect(searchFileContents("main.tex", "Alpha\nbeta\nalphabet", "ALPHA")).toEqual([
      { path: "main.tex", line: 1, preview: "Alpha" },
      { path: "main.tex", line: 3, preview: "alphabet" }
    ]);
  });

  it("marks rendered PDF stale for external project changes but not app internals", () => {
    expect(shouldMarkPdfStaleForProjectChange(["figures/results.pdf"])).toBe(true);
    expect(shouldMarkPdfStaleForProjectChange(["figures\\results.pdf"])).toBe(true);
    expect(shouldMarkPdfStaleForProjectChange([])).toBe(true);
    expect(
      shouldMarkPdfStaleForProjectChange([
        ".latex-agent/build/main.pdf",
        ".latex-agent/build/main.log",
        ".zeroleaf/word-pdf/findings.pdf"
      ])
    ).toBe(false);
  });
});

function getSnippet(label: string) {
  const snippet = latexSnippets.find((candidate) => candidate.label === label);

  if (snippet === undefined) {
    throw new Error(`Missing snippet ${label}`);
  }

  return snippet;
}

function materializeSnippet(
  snippet: string,
  replacements: Readonly<Record<number, string>>
) {
  return snippet
    .replace(/\$\{(\d+):([^}]*)\}/gu, (_match, index: string, fallback: string) => {
      const replacement = replacements[Number(index)];
      return replacement ?? fallback;
    })
    .replace(/\$0/gu, "");
}

function createBibliographyEntry(key: string): BibliographyEntry {
  return {
    type: "article",
    key,
    title: key,
    author: "Author",
    year: "2026",
    filePath: "references.bib",
    line: 1,
    raw: `@article{${key}}`
  };
}

function createPdfArtifactData(pdfPath: string): PdfArtifactData {
  return {
    pdfPath,
    updatedAt: "2026-06-09T00:00:00.000Z",
    dataUrl: `data:application/pdf;base64,${Buffer.from(pdfPath).toString("base64")}`,
    byteLength: pdfPath.length
  };
}

function createBuildResult(status: BuildResult["status"]): BuildResult {
  return {
    jobId: `build-${status}`,
    status,
    compiler: "pdflatex",
    command: ["latexmk"],
    securityPolicy: {
      shellEscape: {
        enabled: false,
        commandFlag: "-no-shell-escape",
        approvalRequiredToEnable: true,
        agentMayEnable: false,
        message: "Shell escape is disabled for LaTeX builds."
      }
    },
    startedAt: "2026-06-09T00:00:00.000Z",
    finishedAt: "2026-06-09T00:00:01.000Z",
    durationMs: 1000,
    diagnostics: [],
    rawLog: "",
    stdout: "",
    stderr: ""
  };
}
