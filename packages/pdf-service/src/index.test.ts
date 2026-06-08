import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPdfArtifact } from "./index.js";

let sandboxPath: string;
let projectPath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "pdf-service-"));
  projectPath = join(sandboxPath, "paper");
  await mkdir(projectPath);
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("pdf-service", () => {
  it("reads a PDF artifact inside the project root", async () => {
    const pdfPath = join(projectPath, "main.pdf");
    await writeFile(pdfPath, "%PDF-1.7\n", "utf8");
    const resolvedPdfPath = await realpath(pdfPath);

    await expect(readPdfArtifact(projectPath, pdfPath)).resolves.toMatchObject({
      pdfPath: resolvedPdfPath,
      byteLength: 9,
      dataUrl: "data:application/pdf;base64,JVBERi0xLjcK"
    });
  });

  it("rejects PDFs outside the project root", async () => {
    const pdfPath = join(sandboxPath, "outside.pdf");
    await writeFile(pdfPath, "%PDF-1.7\n", "utf8");

    await expect(readPdfArtifact(projectPath, pdfPath)).rejects.toThrow(
      "inside the project root"
    );
  });
});
