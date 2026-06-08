import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkSubmissionBundle,
  createProjectFromTemplate,
  exportPdf,
  exportSourceZip,
  importProjectZip
} from "./index.js";

let sandboxPath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-lifecycle-service-"));
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("project-lifecycle-service", () => {
  it("exports and imports a real source zip while excluding build artifacts", async () => {
    const projectPath = join(sandboxPath, "paper");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
      "utf8"
    );
    await writeFile(join(projectPath, "main.aux"), "generated", "utf8");
    await mkdir(join(projectPath, ".latex-agent"), { recursive: true });
    await writeFile(join(projectPath, ".latex-agent", "state.json"), "{}", "utf8");

    const archivePath = join(sandboxPath, "paper.zip");
    const exportResult = await exportSourceZip({
      projectRoot: projectPath,
      destinationPath: archivePath
    });
    const importParentPath = join(sandboxPath, "imports");
    await mkdir(importParentPath);
    const importResult = await importProjectZip({
      zipPath: archivePath,
      destinationParentPath: importParentPath,
      projectName: "paper-import"
    });

    expect(exportResult.fileCount).toBe(1);
    expect(exportResult.byteLength).toBeGreaterThan(0);
    await expect(
      readFile(join(importResult.projectRoot, "main.tex"), "utf8")
    ).resolves.toContain("\\documentclass");
    await expect(stat(join(importResult.projectRoot, "main.aux"))).rejects.toThrow();
    expect(importResult.fileCount).toBe(1);
  });

  it("creates built-in template projects", async () => {
    const result = await createProjectFromTemplate({
      templateId: "beamer",
      destinationParentPath: sandboxPath,
      projectName: "slides"
    });

    expect(result.mainFilePath).toBe("main.tex");
    await expect(
      readFile(join(result.projectRoot, "main.tex"), "utf8")
    ).resolves.toContain("\\documentclass{beamer}");
  });

  it("exports a real PDF file copy", async () => {
    const pdfPath = join(sandboxPath, "paper.pdf");
    const destinationPath = join(sandboxPath, "exports", "paper.pdf");
    await writeFile(pdfPath, Buffer.from("%PDF-1.7\n"));

    const result = await exportPdf({ pdfPath, destinationPath });

    expect(result.byteLength).toBeGreaterThan(0);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("%PDF-1.7\n");
  });

  it("checks arXiv-style submission bundle issues", async () => {
    const projectPath = join(sandboxPath, "submission");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      [
        "\\documentclass{customclass}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\includegraphics{figures/missing}",
        "\\bibliography{refs}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectPath, "main.log"), "generated", "utf8");

    const result = await checkSubmissionBundle(projectPath, "main.tex");

    expect(result.items.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        "Referenced graphics file is missing.",
        "Referenced bibliography file is missing.",
        "Custom document class may need to be included.",
        "Generated build artifact is present in the source tree."
      ])
    );
  });
});
