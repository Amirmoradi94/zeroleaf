import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export type PdfArtifact = {
  readonly pdfPath: string;
  readonly updatedAt: string;
  readonly byteLength: number;
};

export type PdfArtifactData = PdfArtifact & {
  readonly dataUrl: string;
};

export async function readPdfArtifact(
  projectRoot: string,
  pdfPath: string
): Promise<PdfArtifactData> {
  const root = await realpath(projectRoot);
  const resolvedPdfPath = await realpath(pdfPath);

  if (!isInsideRoot(root, resolvedPdfPath) || !resolvedPdfPath.endsWith(".pdf")) {
    throw new Error("PDF artifact must be inside the project root.");
  }

  const pdfStats = await stat(resolvedPdfPath);

  if (!pdfStats.isFile()) {
    throw new Error("PDF artifact must be a file.");
  }

  const pdfBytes = await readFile(resolvedPdfPath);

  return {
    pdfPath: resolvedPdfPath,
    updatedAt: pdfStats.mtime.toISOString(),
    byteLength: pdfStats.size,
    dataUrl: `data:application/pdf;base64,${pdfBytes.toString("base64")}`
  };
}

function isInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
