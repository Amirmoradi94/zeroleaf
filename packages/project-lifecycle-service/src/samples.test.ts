import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const samples = [
  "valid-article",
  "broken-compile",
  "citation-heavy",
  "figure-heavy",
  "thesis-like"
] as const;

describe("sample test projects", () => {
  it("keeps representative MVP sample projects available", async () => {
    for (const sample of samples) {
      const root = resolve("samples", sample);
      const mainPath = join(root, "main.tex");
      await expect(access(mainPath)).resolves.toBeUndefined();
      await expect(readFile(mainPath, "utf8")).resolves.toContain("\\documentclass");
    }
  });

  it("keeps citation-heavy and thesis-like samples multi-file", async () => {
    await expect(
      readFile(resolve("samples/citation-heavy/references.bib"), "utf8")
    ).resolves.toContain("@book");
    await expect(
      access(resolve("samples/thesis-like/chapters/introduction.tex"))
    ).resolves.toBeUndefined();
  });
});
