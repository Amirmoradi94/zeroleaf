import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkSubmissionBundle,
  collectSharedProjectSourceFiles,
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
    await writeFile(join(projectPath, "main.bbl"), "generated bibliography", "utf8");
    await mkdir(join(projectPath, "assets", "empty"), { recursive: true });
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
    expect(exportResult.includedBuildArtifacts).toBe(false);
    await expect(
      readFile(join(importResult.projectRoot, "main.tex"), "utf8")
    ).resolves.toContain("\\documentclass");
    await expect(stat(join(importResult.projectRoot, "main.aux"))).rejects.toThrow();
    await expect(stat(join(importResult.projectRoot, "main.bbl"))).rejects.toThrow();
    const emptyDirectoryStats = await stat(
      join(importResult.projectRoot, "assets", "empty")
    );
    expect(emptyDirectoryStats.isDirectory()).toBe(true);
    expect(importResult.fileCount).toBe(1);
  });

  it("can export source zips with generated artifacts when explicitly requested", async () => {
    const projectPath = join(sandboxPath, "paper-with-artifacts");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      "\\begin{document}Hi\\end{document}\n"
    );
    await writeFile(join(projectPath, "main.aux"), "generated", "utf8");
    await writeFile(join(projectPath, "main.bbl"), "generated bibliography", "utf8");

    const archivePath = join(sandboxPath, "paper-with-artifacts.zip");
    const exportResult = await exportSourceZip({
      projectRoot: projectPath,
      destinationPath: archivePath,
      includeBuildArtifacts: true
    });
    const importParentPath = join(sandboxPath, "imports-with-artifacts");
    await mkdir(importParentPath);
    const importResult = await importProjectZip({
      zipPath: archivePath,
      destinationParentPath: importParentPath,
      projectName: "paper-with-artifacts-import"
    });

    expect(exportResult.includedBuildArtifacts).toBe(true);
    expect(exportResult.fileCount).toBe(3);
    await expect(
      stat(join(importResult.projectRoot, "main.aux"))
    ).resolves.toBeDefined();
    await expect(
      stat(join(importResult.projectRoot, "main.bbl"))
    ).resolves.toBeDefined();
    expect(importResult.fileCount).toBe(3);
  });

  it("collects source files and binary assets for shared project creation", async () => {
    const projectPath = join(sandboxPath, "shareable-paper");
    await mkdir(join(projectPath, "sections"), { recursive: true });
    await mkdir(join(projectPath, "sections", "drafts"), { recursive: true });
    await mkdir(join(projectPath, "figures"), { recursive: true });
    await mkdir(join(projectPath, ".latex-agent", "build"), { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
      "utf8"
    );
    await writeFile(join(projectPath, "sections", "intro.tex"), "Intro\n", "utf8");
    await writeFile(join(projectPath, "main.aux"), "generated", "utf8");
    await writeFile(
      join(projectPath, ".latex-agent", "build", "main.log"),
      "generated",
      "utf8"
    );
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    await writeFile(join(projectPath, "figures", "plot.png"), pngBytes);

    const result = await collectSharedProjectSourceFiles({
      projectRoot: projectPath
    });

    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "main.tex" }),
        expect.objectContaining({ path: "sections/intro.tex" }),
        expect.objectContaining({
          path: "figures/plot.png",
          contents: pngBytes.toString("base64"),
          contentEncoding: "base64"
        })
      ])
    );
    expect(result.files.map((file) => file.path)).not.toContain("main.aux");
    expect(result.files.map((file) => file.path)).not.toContain(
      ".latex-agent/build/main.log"
    );
    expect(result.directories).toEqual(
      expect.arrayContaining([
        { path: "figures" },
        { path: "sections" },
        { path: "sections/drafts" }
      ])
    );
    expect(result.skippedFilePaths).toEqual([]);
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

  it("rejects invalid template project names", async () => {
    await expect(
      createProjectFromTemplate({
        templateId: "beamer",
        destinationParentPath: sandboxPath,
        projectName: "../slides"
      })
    ).rejects.toMatchObject({
      name: "ProjectLifecycleServiceError",
      message: "Invalid project name.",
      code: "invalid-name"
    });
  });

  it("reports a clear conflict when the import destination already exists", async () => {
    const projectPath = join(sandboxPath, "paper");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
      "utf8"
    );
    const archivePath = join(sandboxPath, "paper.zip");
    await exportSourceZip({
      projectRoot: projectPath,
      destinationPath: archivePath
    });

    const importParentPath = join(sandboxPath, "imports-conflict");
    await mkdir(join(importParentPath, "paper-import"), { recursive: true });

    await expect(
      importProjectZip({
        zipPath: archivePath,
        destinationParentPath: importParentPath,
        projectName: "paper-import"
      })
    ).rejects.toMatchObject({
      name: "ProjectLifecycleServiceError",
      message:
        "A project folder with that name already exists in the chosen destination.",
      code: "conflict"
    });
  });

  it("skips ZIP path traversal entries and imports only safe files", async () => {
    const archivePath = join(sandboxPath, "overleaf.zip");
    const importParentPath = join(sandboxPath, "imports-safe");
    await mkdir(importParentPath, { recursive: true });
    await writeFile(
      archivePath,
      createTestZipArchive([
        {
          path: "main.tex",
          data: Buffer.from(
            "\\documentclass{article}\\begin{document}Hi\\end{document}\n"
          )
        },
        {
          path: "../escape.tex",
          data: Buffer.from("blocked\n")
        },
        {
          path: "__MACOSX/._main.tex",
          data: Buffer.from("ignored\n")
        }
      ])
    );

    const importResult = await importProjectZip({
      zipPath: archivePath,
      destinationParentPath: importParentPath,
      projectName: "safe-import"
    });

    expect(importResult.fileCount).toBe(1);
    await expect(
      readFile(join(importResult.projectRoot, "main.tex"), "utf8")
    ).resolves.toContain("\\documentclass");
    await expect(stat(join(importParentPath, "escape.tex"))).rejects.toThrow();
  });

  it("reports a clear conflict when a template project name already exists", async () => {
    await mkdir(join(sandboxPath, "slides"), { recursive: true });

    await expect(
      createProjectFromTemplate({
        templateId: "beamer",
        destinationParentPath: sandboxPath,
        projectName: "slides"
      })
    ).rejects.toMatchObject({
      name: "ProjectLifecycleServiceError",
      message:
        "A project folder with that name already exists in the chosen destination.",
      code: "conflict"
    });
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
    await writeFile(join(projectPath, "main.bbl"), "generated", "utf8");

    const result = await checkSubmissionBundle(projectPath, "main.tex");

    expect(result.items.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        "Referenced graphics file is missing.",
        "Referenced bibliography file is missing.",
        "Custom document class may need to be included.",
        "Generated build artifact is present in the source tree."
      ])
    );
    expect(result.items).toContainEqual({
      severity: "warning",
      message: "Generated build artifact is present in the source tree.",
      filePath: "main.bbl"
    });
  });

  it("reports a missing main file selection in submission checks", async () => {
    const projectPath = join(sandboxPath, "missing-main-selection");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "main.tex"),
      "\\documentclass{article}\\begin{document}Ready\\end{document}\n",
      "utf8"
    );

    const result = await checkSubmissionBundle(projectPath);

    expect(result.items).toContainEqual({
      severity: "error",
      message: "No main .tex file is selected."
    });
  });
});

function createTestZipArchive(
  entries: readonly { readonly path: string; readonly data: Buffer }[]
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const compressedData = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.byteLength, 18);
    localHeader.writeUInt32LE(entry.data.byteLength, 22);
    localHeader.writeUInt16LE(pathBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, pathBytes, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.byteLength, 20);
    centralHeader.writeUInt32LE(entry.data.byteLength, 24);
    centralHeader.writeUInt16LE(pathBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, pathBytes);
    offset += localHeader.byteLength + pathBytes.byteLength + compressedData.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.byteLength, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = (crcTable[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256).map((_value, index) => {
  let code = index;
  for (let bit = 0; bit < 8; bit += 1) {
    code = code & 1 ? 0xedb88320 ^ (code >>> 1) : code >>> 1;
  }
  return code >>> 0;
});
