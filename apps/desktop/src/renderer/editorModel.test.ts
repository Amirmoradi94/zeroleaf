import { describe, expect, it } from "vitest";

import {
  getEditableProjectFiles,
  getLanguageForPath,
  parseLatexOutline,
  searchFileContents
} from "./editorModel.js";

describe("editor model", () => {
  it("parses LaTeX section and label outline items", () => {
    expect(
      parseLatexOutline(`\\section{Intro}
Text
\\subsection{Prior Work}\\label{sec:prior}`)
    ).toEqual([
      { kind: "section", title: "Intro", line: 1 },
      { kind: "subsection", title: "Prior Work", line: 3 },
      { kind: "label", title: "sec:prior", line: 3 }
    ]);
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

  it("searches file contents case-insensitively", () => {
    expect(searchFileContents("main.tex", "Alpha\nbeta\nalphabet", "ALPHA")).toEqual([
      { path: "main.tex", line: 1, preview: "Alpha" },
      { path: "main.tex", line: 3, preview: "alphabet" }
    ]);
  });
});
