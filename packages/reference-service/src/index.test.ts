import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeProjectReferences,
  parseBibFile,
  parseLatexCitations,
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
      "missing2022"
    ]);
    expect(analysis.missingCitations).toEqual([
      { key: "missing2022", command: "textcite", filePath: "main.tex", line: 3 }
    ]);
    expect(analysis.unusedEntries.map((entry) => entry.key)).toEqual(["unused2021"]);
  });

  it("searches real project references by key, title, author, and venue", async () => {
    const projectRoot = await createTempProject({
      "refs.bib": `@article{smith2024,
  title = {A Robust Study},
  author = {Smith, Ada},
  year = {2024},
  journal = {Journal of Tests}
}`
    });

    await expect(searchProjectReferences(projectRoot, "robust")).resolves.toMatchObject(
      [{ key: "smith2024", title: "A Robust Study" }]
    );
    await expect(
      searchProjectReferences(projectRoot, "journal")
    ).resolves.toMatchObject([{ key: "smith2024", venue: "Journal of Tests" }]);
  });
});

async function createTempProject(
  files: Readonly<Record<string, string>>
): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "reference-service-"));
  tempRoots.push(projectRoot);

  await Promise.all(
    Object.entries(files).map(([path, contents]) =>
      writeFile(join(projectRoot, path), contents, "utf8")
    )
  );

  return projectRoot;
}
