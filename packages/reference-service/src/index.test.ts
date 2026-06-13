import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeProjectReferences,
  parseBibFile,
  parseLatexCitations,
  removeUnusedReferenceEntry,
  searchProjectReferences
} from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
  tempRoots.length = 0;
});

describe("reference-service", () => {
  it("parses BibTeX entries with title, author, year, DOI, and venue", () => {
    expect(
      parseBibFile(
        `@article{smith2024,
  title = {A {Robust} Study},
  author = {Smith, Ada and Lee, Byron},
  year = {2024},
  doi = {10.1000/example},
  journal = {Journal of Tests}
}

@inproceedings{doe2023,
  title = "Conference Paper",
  booktitle = "Proceedings of Real Tests",
  year = 2023
}`,
        "refs.bib"
      )
    ).toMatchObject([
      {
        type: "article",
        key: "smith2024",
        title: "A Robust Study",
        author: "Smith, Ada and Lee, Byron",
        year: "2024",
        doi: "10.1000/example",
        venue: "Journal of Tests",
        filePath: "refs.bib",
        line: 1
      },
      {
        type: "inproceedings",
        key: "doe2023",
        title: "Conference Paper",
        venue: "Proceedings of Real Tests",
        year: "2023",
        filePath: "refs.bib",
        line: 9
      }
    ]);
  });

  it("parses LaTeX citation keys from common cite commands", () => {
    expect(
      parseLatexCitations(
        `Text \\cite{smith2024, missing2022}
More text \\parencite[see][12]{doe2023}.`,
        "main.tex"
      )
    ).toEqual([
      { key: "smith2024", command: "cite", filePath: "main.tex", line: 1 },
      { key: "missing2022", command: "cite", filePath: "main.tex", line: 1 },
      { key: "doe2023", command: "parencite", filePath: "main.tex", line: 2 }
    ]);
  });

  it("analyzes real project files for missing and unused references", async () => {
    const projectRoot = await createTempProject({
      "main.tex": `\\documentclass{article}
\\begin{document}
Known \\cite{smith2024}; missing \\textcite{missing2022}.
Repeated missing \\citep{missing2022}.
\\end{document}`,
      "refs.bib": `@article{smith2024,
  title = {A Robust Study},
  author = {Smith, Ada},
  year = {2024},
  journal = {Journal of Tests}
}

@book{unused2021,
  title = {Unused Book},
  year = {2021},
  publisher = {Local Press}
}`
    });

    const analysis = await analyzeProjectReferences(projectRoot);

    expect(analysis.entries.map((entry) => entry.key)).toEqual([
      "smith2024",
      "unused2021"
    ]);
    expect(analysis.citations.map((citation) => citation.key)).toEqual([
      "smith2024",
      "missing2022",
      "missing2022"
    ]);
    expect(analysis.missingCitations).toEqual([
      { key: "missing2022", command: "textcite", filePath: "main.tex", line: 3 },
      { key: "missing2022", command: "citep", filePath: "main.tex", line: 4 }
    ]);
    expect(analysis.unusedEntries.map((entry) => entry.key)).toEqual(["unused2021"]);
  });

  it("does not mark entries cited from included chapter files as unused", async () => {
    const projectRoot = await createTempProject({
      "main.tex": `\\documentclass{article}
\\begin{document}
\\input{chapters/related-work}
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}`,
      "chapters/related-work.tex": "Chapter cites \\cite{chapter2026}.",
      "refs.bib": `@article{chapter2026,
  title = {Chapter Citation},
  year = {2026}
}

@article{unused2026,
  title = {Unused Citation},
  year = {2026}
}`
    });

    const analysis = await analyzeProjectReferences(projectRoot);

    expect(analysis.citations).toContainEqual({
      key: "chapter2026",
      command: "cite",
      filePath: "chapters/related-work.tex",
      line: 1
    });
    expect(analysis.unusedEntries.map((entry) => entry.key)).toEqual(["unused2026"]);
  });

  it("removes a selected unused bibliography entry and keeps cited entries", async () => {
    const projectRoot = await createTempProject({
      "main.tex": `\\documentclass{article}
\\begin{document}
\\input{chapters/related-work}
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}`,
      "chapters/related-work.tex": "Chapter cites \\cite{chapter2026}.",
      "refs.bib": `@article{chapter2026,
  title = {Chapter Citation},
  year = {2026}
}

@article{unused2026,
  title = {Unused Citation},
  year = {2026}
}
`
    });

    await expect(
      removeUnusedReferenceEntry(projectRoot, {
        filePath: "refs.bib",
        key: "chapter2026"
      })
    ).rejects.toMatchObject({ code: "entry-still-cited" });

    const result = await removeUnusedReferenceEntry(projectRoot, {
      filePath: "refs.bib",
      key: "unused2026"
    });
    const updatedBib = await readFile(join(projectRoot, "refs.bib"), "utf8");

    expect(result.removedEntry.key).toBe("unused2026");
    expect(result.analysis.unusedEntries).toEqual([]);
    expect(updatedBib).toContain("@article{chapter2026");
    expect(updatedBib).not.toContain("unused2026");
  });

  it("searches real project references by key, title, author, year, DOI, and venue", async () => {
    const projectRoot = await createTempProject({
      "refs.bib": `@article{smith2024,
  title = {A Robust Study},
  author = {Smith, Ada},
  year = {2024},
  doi = {10.1000/example},
  journal = {Journal of Tests}
}

@inproceedings{lamport1994,
  title = {LaTeX: A Document Preparation System},
  author = {Lamport, Leslie},
  year = {1994},
  booktitle = {Document Engineering Archive}
}`
    });

    await expect(searchProjectReferences(projectRoot, "robust")).resolves.toMatchObject(
      [{ key: "smith2024", title: "A Robust Study" }]
    );
    await expect(searchProjectReferences(projectRoot, "Smith")).resolves.toMatchObject([
      { key: "smith2024", author: "Smith, Ada" }
    ]);
    await expect(searchProjectReferences(projectRoot, "1994")).resolves.toMatchObject([
      { key: "lamport1994", year: "1994" }
    ]);
    await expect(
      searchProjectReferences(projectRoot, "10.1000/example")
    ).resolves.toMatchObject([{ key: "smith2024", doi: "10.1000/example" }]);
    await expect(
      searchProjectReferences(projectRoot, "journal")
    ).resolves.toMatchObject([{ key: "smith2024", venue: "Journal of Tests" }]);
    await expect(
      searchProjectReferences(projectRoot, "lamport")
    ).resolves.toMatchObject([{ key: "lamport1994", author: "Lamport, Leslie" }]);
  });

  it("continues indexing valid references after a malformed BibTeX entry", async () => {
    const projectRoot = await createTempProject({
      "refs.bib": `@article{broken2026,
  title = {Missing the closing delimiter},
  author = {Broken, Entry}

@book{knuth1984,
  title = {The TeXbook},
  author = {Knuth, Donald},
  year = {1984},
  publisher = {Addison-Wesley}
}`
    });

    await expect(searchProjectReferences(projectRoot, "knuth")).resolves.toMatchObject([
      { key: "knuth1984", title: "The TeXbook", author: "Knuth, Donald" }
    ]);
  });

  it("does not treat generated bbl entries as source bibliography truth", async () => {
    const projectRoot = await createTempProject({
      "main.tex": `\\documentclass{article}
\\begin{document}
Generated-only citation \\cite{generatedOnly2026}.
\\bibliography{refs}
\\end{document}`,
      "main.bbl": "\\bibitem{generatedOnly2026} Generated build output.",
      "refs.bib": `@article{real2026,
  title = {Real Source Entry},
  year = {2026}
}`
    });

    const analysis = await analyzeProjectReferences(projectRoot);

    expect(analysis.entries.map((entry) => entry.key)).toEqual(["real2026"]);
    expect(analysis.missingCitations).toContainEqual({
      key: "generatedOnly2026",
      command: "cite",
      filePath: "main.tex",
      line: 3
    });
  });

  it("searches the citation-heavy sample for local knuth and lamport entries", async () => {
    const projectRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../samples/citation-heavy"
    );

    await expect(searchProjectReferences(projectRoot, "knuth")).resolves.toMatchObject([
      { key: "knuth1984", title: "The TeXbook" }
    ]);
    await expect(
      searchProjectReferences(projectRoot, "lamport")
    ).resolves.toMatchObject([
      { key: "lamport1994", title: "LaTeX: A Document Preparation System" }
    ]);
  });
});

async function createTempProject(
  files: Readonly<Record<string, string>>
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "reference-service-"));
  tempRoots.push(projectRoot);

  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      await mkdir(dirname(join(projectRoot, path)), { recursive: true });
      await writeFile(join(projectRoot, path), contents, "utf8");
    })
  );

  return projectRoot;
}
