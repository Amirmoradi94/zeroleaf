import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { tmpdir } from "node:os";

export type ProjectTemplateId = "article" | "report" | "thesis" | "beamer" | "cv";

export type ProjectTemplate = {
  readonly id: ProjectTemplateId;
  readonly name: string;
  readonly description: string;
};

export type ExportSourceZipRequest = {
  readonly projectRoot: string;
  readonly destinationPath: string;
  readonly includeBuildArtifacts?: boolean;
};

export type ExportSourceZipResult = {
  readonly archivePath: string;
  readonly fileCount: number;
  readonly byteLength: number;
  readonly includedBuildArtifacts: boolean;
};

export type ExportPdfRequest = {
  readonly pdfPath: string;
  readonly destinationPath: string;
};

export type ExportPdfResult = {
  readonly pdfPath: string;
  readonly destinationPath: string;
  readonly byteLength: number;
  readonly openedInViewer?: boolean;
  readonly viewerOpenError?: string;
};

export type ImportProjectZipRequest = {
  readonly zipPath: string;
  readonly destinationParentPath: string;
  readonly projectName?: string;
};

export type ImportProjectZipResult = {
  readonly projectRoot: string;
  readonly fileCount: number;
};

export type CreateProjectFromTemplateRequest = {
  readonly templateId: ProjectTemplateId;
  readonly destinationParentPath: string;
  readonly projectName: string;
};

export type CreateProjectFromTemplateResult = {
  readonly projectRoot: string;
  readonly fileCount: number;
  readonly mainFilePath: string;
};

export type SubmissionCheckSeverity = "error" | "warning" | "info";

export type SubmissionCheckItem = {
  readonly severity: SubmissionCheckSeverity;
  readonly message: string;
  readonly filePath?: string;
};

export type SubmissionCheckResult = {
  readonly checkedAt: string;
  readonly items: readonly SubmissionCheckItem[];
};

export class ProjectLifecycleServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "conflict"
      | "invalid-name"
      | "invalid-path"
      | "missing-file"
      | "not-directory"
      | "not-file"
      | "unsupported-zip"
  ) {
    super(message);
    this.name = "ProjectLifecycleServiceError";
  }
}

export const projectTemplates: readonly ProjectTemplate[] = [
  {
    id: "article",
    name: "Article",
    description: "Compact scholarly article with bibliography."
  },
  {
    id: "report",
    name: "Report",
    description: "Structured technical report with chapters."
  },
  {
    id: "thesis",
    name: "Thesis",
    description: "Long-form thesis skeleton with front matter."
  },
  {
    id: "beamer",
    name: "Beamer",
    description: "Presentation slides using Beamer."
  },
  {
    id: "cv",
    name: "CV",
    description: "Academic CV template."
  }
];

const ignoredSourceDirectories = new Set([
  ".git",
  ".latex-agent",
  ".latexmk",
  "dist",
  "node_modules",
  "out"
]);
const buildArtifactExtensions = new Set([
  ".aux",
  ".bbl",
  ".bcf",
  ".blg",
  ".fdb_latexmk",
  ".fls",
  ".log",
  ".nav",
  ".out",
  ".snm",
  ".synctex",
  ".toc",
  ".vrb"
]);
const imageExtensions = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"];
const standardDocumentClasses = new Set([
  "article",
  "report",
  "book",
  "letter",
  "beamer",
  "proc",
  "slides"
]);

export async function exportSourceZip(
  request: ExportSourceZipRequest
): Promise<ExportSourceZipResult> {
  const projectRoot = await validateDirectory(request.projectRoot);
  const destinationPath = resolve(request.destinationPath);
  const files = await collectProjectFiles(
    projectRoot,
    request.includeBuildArtifacts === true
  );
  const zipEntries = await Promise.all(
    files.map(async (filePath) => ({
      path: filePath,
      data: await readFile(join(projectRoot, filePath))
    }))
  );
  const archive = createZipArchive(zipEntries);

  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, archive);

  return {
    archivePath: destinationPath,
    fileCount: zipEntries.length,
    byteLength: archive.byteLength,
    includedBuildArtifacts: request.includeBuildArtifacts === true
  };
}

export async function exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult> {
  const pdfPath = await validateFile(request.pdfPath);
  const destinationPath = resolve(request.destinationPath);

  if (extname(pdfPath).toLowerCase() !== ".pdf") {
    throw new ProjectLifecycleServiceError("Source file must be a PDF.", "not-file");
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(pdfPath, destinationPath);
  const fileStats = await stat(destinationPath);

  return {
    pdfPath,
    destinationPath,
    byteLength: fileStats.size
  };
}

export async function importProjectZip(
  request: ImportProjectZipRequest
): Promise<ImportProjectZipResult> {
  const zipPath = await validateFile(request.zipPath);
  const destinationParentPath = await validateDirectory(request.destinationParentPath);
  const projectName =
    request.projectName === undefined
      ? sanitizeProjectName(basename(zipPath, extname(zipPath)))
      : validateProjectName(request.projectName);
  const projectRoot = resolve(destinationParentPath, projectName);
  const entries = readZipArchive(await readFile(zipPath));

  assertInsideRoot(destinationParentPath, projectRoot);
  await createNewProjectRoot(projectRoot);

  let fileCount = 0;
  for (const entry of entries) {
    const normalizedPath = normalizeZipPath(entry.path);
    if (normalizedPath === undefined) {
      continue;
    }

    const targetPath = resolve(projectRoot, normalizedPath);
    assertInsideRoot(projectRoot, targetPath);

    if (entry.directory) {
      await mkdir(targetPath, { recursive: true });
    } else {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.data);
      fileCount += 1;
    }
  }

  return { projectRoot, fileCount };
}

export async function createProjectFromTemplate(
  request: CreateProjectFromTemplateRequest
): Promise<CreateProjectFromTemplateResult> {
  const destinationParentPath = await validateDirectory(request.destinationParentPath);
  const template = getTemplateFiles(request.templateId);
  const projectName = validateProjectName(request.projectName);
  const projectRoot = resolve(destinationParentPath, projectName);

  assertInsideRoot(destinationParentPath, projectRoot);
  await createNewProjectRoot(projectRoot);

  for (const file of template.files) {
    const targetPath = resolve(projectRoot, file.path);
    assertInsideRoot(projectRoot, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.contents, "utf8");
  }

  return {
    projectRoot,
    fileCount: template.files.length,
    mainFilePath: template.mainFilePath
  };
}

export async function checkSubmissionBundle(
  projectRoot: string,
  mainFilePath?: string
): Promise<SubmissionCheckResult> {
  const root = await validateDirectory(projectRoot);
  const items: SubmissionCheckItem[] = [];
  const files = await collectProjectFiles(root, true);
  const fileSet = new Set(files);
  const texFiles = files.filter((filePath) => filePath.endsWith(".tex"));

  if (mainFilePath === undefined || mainFilePath.length === 0) {
    items.push({
      severity: "error",
      message: "No main .tex file is selected."
    });
  } else if (!fileSet.has(mainFilePath)) {
    items.push({
      severity: "error",
      message: "Selected main .tex file is missing.",
      filePath: mainFilePath
    });
  } else {
    const mainContents = await readFile(join(root, mainFilePath), "utf8");
    if (!mainContents.includes("\\documentclass")) {
      items.push({
        severity: "warning",
        message: "Main file does not contain a document class.",
        filePath: mainFilePath
      });
    }
    addMissingAssetChecks(items, root, fileSet, mainFilePath, mainContents);
    addDocumentClassChecks(items, fileSet, mainFilePath, mainContents);
  }

  for (const texFile of texFiles.filter((filePath) => filePath !== mainFilePath)) {
    const contents = await readFile(join(root, texFile), "utf8");
    addMissingAssetChecks(items, root, fileSet, texFile, contents);
  }

  for (const filePath of files) {
    if (isBuildArtifact(filePath)) {
      items.push({
        severity: "warning",
        message: "Generated build artifact is present in the source tree.",
        filePath
      });
    }
  }

  if (items.length === 0) {
    items.push({
      severity: "info",
      message: "No submission issues found in the local bundle check."
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    items
  };
}

export async function createTemporaryExportPath(
  projectRoot: string,
  extension: string
): Promise<string> {
  const root = await validateDirectory(projectRoot);
  const tempRoot = await mkdtemp(join(tmpdir(), "latex-export-"));
  return join(tempRoot, `${basename(root)}.${extension.replace(/^\./u, "")}`);
}

async function collectProjectFiles(
  projectRoot: string,
  includeBuildArtifacts: boolean
): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const absolutePath = join(directoryPath, entry.name);
      const projectPath = toProjectPath(projectRoot, absolutePath);

      if (entry.isDirectory()) {
        if (!includeBuildArtifacts && ignoredSourceDirectories.has(entry.name)) {
          continue;
        }
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!includeBuildArtifacts && isBuildArtifact(projectPath)) {
        continue;
      }

      files.push(projectPath);
    }
  }

  await visit(projectRoot);
  return files;
}

function createZipArchive(
  entries: readonly { readonly path: string; readonly data: Buffer }[]
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path.replace(/\\\\/gu, "/"), "utf8");
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

function readZipArchive(archive: Buffer): readonly {
  readonly path: string;
  readonly data: Buffer;
  readonly directory: boolean;
}[] {
  const entries: { path: string; data: Buffer; directory: boolean }[] = [];
  let offset = 0;

  while (offset + 4 <= archive.byteLength) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50) {
      throw new ProjectLifecycleServiceError("Invalid ZIP archive.", "unsupported-zip");
    }

    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    if ((flags & 0x0008) !== 0) {
      throw new ProjectLifecycleServiceError(
        "ZIP data descriptors are not supported.",
        "unsupported-zip"
      );
    }

    const path = archive
      .subarray(nameStart, nameStart + fileNameLength)
      .toString("utf8");
    const compressedData = archive.subarray(dataStart, dataEnd);
    const data =
      method === 0
        ? Buffer.from(compressedData)
        : method === 8
          ? inflateRawSync(compressedData)
          : undefined;

    if (data === undefined) {
      throw new ProjectLifecycleServiceError(
        "ZIP compression method is not supported.",
        "unsupported-zip"
      );
    }

    entries.push({
      path,
      data,
      directory: path.endsWith("/")
    });
    offset = dataEnd;
  }

  return entries;
}

function addMissingAssetChecks(
  items: SubmissionCheckItem[],
  root: string,
  fileSet: ReadonlySet<string>,
  texFile: string,
  contents: string
) {
  const baseDirectory = dirname(texFile) === "." ? "" : dirname(texFile);
  const graphicsMatches = contents.matchAll(
    /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/gu
  );
  const bibliographyMatches = contents.matchAll(
    /\\(?:bibliography|addbibresource)\{([^}]+)\}/gu
  );

  for (const match of graphicsMatches) {
    const assetPath = match[1]?.trim();
    if (assetPath === undefined || assetPath.length === 0) {
      continue;
    }

    const candidates =
      extname(assetPath).length > 0
        ? [assetPath]
        : imageExtensions.map((extension) => `${assetPath}${extension}`);
    const found = candidates.some((candidate) =>
      fileSet.has(toProjectPath(root, resolve(root, baseDirectory, candidate)))
    );

    if (!found) {
      items.push({
        severity: "error",
        message: "Referenced graphics file is missing.",
        filePath: `${texFile}: ${assetPath}`
      });
    }
  }

  for (const match of bibliographyMatches) {
    const rawValue = match[1]?.trim();
    if (rawValue === undefined || rawValue.length === 0) {
      continue;
    }

    for (const bibValue of rawValue.split(",").map((value) => value.trim())) {
      const bibPath = bibValue.endsWith(".bib") ? bibValue : `${bibValue}.bib`;
      const normalizedPath = toProjectPath(root, resolve(root, baseDirectory, bibPath));
      if (!fileSet.has(normalizedPath)) {
        items.push({
          severity: "error",
          message: "Referenced bibliography file is missing.",
          filePath: `${texFile}: ${bibPath}`
        });
      }
    }
  }
}

function addDocumentClassChecks(
  items: SubmissionCheckItem[],
  fileSet: ReadonlySet<string>,
  texFile: string,
  contents: string
) {
  const documentClass = /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/u.exec(
    contents
  )?.[1];

  if (
    documentClass !== undefined &&
    !standardDocumentClasses.has(documentClass) &&
    !fileSet.has(`${documentClass}.cls`)
  ) {
    items.push({
      severity: "warning",
      message: "Custom document class may need to be included.",
      filePath: `${texFile}: ${documentClass}.cls`
    });
  }
}

function getTemplateFiles(templateId: ProjectTemplateId): {
  readonly mainFilePath: string;
  readonly files: readonly { readonly path: string; readonly contents: string }[];
} {
  switch (templateId) {
    case "article":
      return withBibliography("article", articleMain());
    case "report":
      return withBibliography("report", reportMain());
    case "thesis":
      return withBibliography("thesis", thesisMain());
    case "beamer":
      return {
        mainFilePath: "main.tex",
        files: [{ path: "main.tex", contents: beamerMain() }]
      };
    case "cv":
      return {
        mainFilePath: "main.tex",
        files: [{ path: "main.tex", contents: cvMain() }]
      };
  }
}

function withBibliography(
  key: string,
  mainContents: string
): {
  readonly mainFilePath: string;
  readonly files: readonly { readonly path: string; readonly contents: string }[];
} {
  return {
    mainFilePath: "main.tex",
    files: [
      { path: "main.tex", contents: mainContents },
      {
        path: "references.bib",
        contents: `@article{${key}2026,\n  title = {A Local First Writing Workflow},\n  author = {Researcher, Ada},\n  journal = {Journal of Reproducible Documents},\n  year = {2026}\n}\n`
      }
    ]
  };
}

function articleMain(): string {
  return `\\documentclass{article}\n\\usepackage{graphicx}\n\\usepackage{hyperref}\n\\title{Article Title}\n\\author{Author Name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWrite a concise summary of the contribution.\n\\end{abstract}\n\n\\section{Introduction}\nIntroduce the problem and cite relevant work~\\cite{article2026}.\n\n\\section{Method}\nDescribe the method.\n\n\\section{Results}\nSummarize the findings.\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`;
}

function reportMain(): string {
  return `\\documentclass{report}\n\\usepackage{hyperref}\n\\title{Technical Report}\n\\author{Author Name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\tableofcontents\n\n\\chapter{Overview}\nSummarize the report scope~\\cite{report2026}.\n\n\\chapter{Analysis}\nAdd technical detail here.\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`;
}

function thesisMain(): string {
  return `\\documentclass{report}\n\\usepackage{hyperref}\n\\title{Thesis Title}\n\\author{Author Name}\n\\date{\\today}\n\n\\begin{document}\n\\pagenumbering{roman}\n\\maketitle\n\\tableofcontents\n\\clearpage\n\\pagenumbering{arabic}\n\n\\chapter{Introduction}\nState the thesis and background~\\cite{thesis2026}.\n\n\\chapter{Related Work}\nDiscuss prior work.\n\n\\chapter{Conclusion}\nSummarize contributions.\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n`;
}

function beamerMain(): string {
  return `\\documentclass{beamer}\n\\usetheme{Madrid}\n\\title{Presentation Title}\n\\author{Author Name}\n\\date{\\today}\n\n\\begin{document}\n\\frame{\\titlepage}\n\n\\begin{frame}{Motivation}\nAdd the core problem statement.\n\\end{frame}\n\n\\begin{frame}{Result}\nSummarize the key result.\n\\end{frame}\n\\end{document}\n`;
}

function cvMain(): string {
  return `\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{hyperref}\n\\pagenumbering{gobble}\n\n\\begin{document}\n\\begin{center}\n{\\LARGE Name Surname}\\\\\n\\href{mailto:name@example.com}{name@example.com} \\quad example.com\n\\end{center}\n\n\\section*{Education}\nDegree, Institution, Year\n\n\\section*{Publications}\nAuthor. Publication title. Venue, Year.\n\n\\section*{Experience}\nRole, Organization, Dates\n\\end{document}\n`;
}

async function validateDirectory(path: string): Promise<string> {
  if (!isNonEmptyString(path)) {
    throw new ProjectLifecycleServiceError(
      "Directory path is required.",
      "invalid-path"
    );
  }

  const resolvedPath = await realpath(path);
  const fileStats = await stat(resolvedPath);

  if (!fileStats.isDirectory()) {
    throw new ProjectLifecycleServiceError(
      "Path must be a directory.",
      "not-directory"
    );
  }

  return resolvedPath;
}

async function validateFile(path: string): Promise<string> {
  if (!isNonEmptyString(path)) {
    throw new ProjectLifecycleServiceError("File path is required.", "invalid-path");
  }

  const resolvedPath = await realpath(path);
  const fileStats = await stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new ProjectLifecycleServiceError("Path must be a file.", "not-file");
  }

  return resolvedPath;
}

function validateProjectName(name: string): string {
  const trimmedName = name.trim();

  if (
    trimmedName.length === 0 ||
    trimmedName === "." ||
    trimmedName === ".." ||
    trimmedName.includes("/") ||
    trimmedName.includes("\\")
  ) {
    throw new ProjectLifecycleServiceError("Invalid project name.", "invalid-name");
  }

  return trimmedName;
}

async function createNewProjectRoot(projectRoot: string): Promise<void> {
  try {
    await mkdir(projectRoot, { recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ProjectLifecycleServiceError(
        "A project folder with that name already exists in the chosen destination.",
        "conflict"
      );
    }

    throw error;
  }
}

function sanitizeProjectName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return validateProjectName(sanitized.length === 0 ? "imported-project" : sanitized);
}

function normalizeZipPath(path: string): string | undefined {
  const normalizedPath = path.replace(/\\\\/gu, "/").replace(/^\.\//u, "");

  if (
    normalizedPath.length === 0 ||
    normalizedPath.startsWith("/") ||
    normalizedPath.split("/").includes("..") ||
    normalizedPath === "__MACOSX" ||
    normalizedPath.startsWith("__MACOSX/")
  ) {
    return undefined;
  }

  return normalizedPath.replace(/\/$/u, "");
}

function assertInsideRoot(rootPath: string, targetPath: string): void {
  const relativePath = relative(rootPath, targetPath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new ProjectLifecycleServiceError(
      "Path resolves outside the project root.",
      "invalid-path"
    );
  }
}

function toProjectPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

function isBuildArtifact(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return (
    lowerPath.endsWith(".synctex.gz") || buildArtifactExtensions.has(extname(lowerPath))
  );
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

const crcTable = new Uint32Array(256).map((_value, index) => {
  let code = index;
  for (let bit = 0; bit < 8; bit += 1) {
    code = code & 1 ? 0xedb88320 ^ (code >>> 1) : code >>> 1;
  }
  return code >>> 0;
});

function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = (crcTable[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
