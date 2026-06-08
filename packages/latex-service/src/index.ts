import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type LatexCompiler = "pdflatex" | "xelatex" | "lualatex";

export type BuildStatus = "running" | "succeeded" | "failed" | "cancelled";

export type LatexToolchainStatus = {
  readonly latexmkAvailable: boolean;
  readonly synctexAvailable: boolean;
  readonly latexmkVersion?: string;
  readonly availableCompilers: readonly LatexCompiler[];
};

export type LatexDiagnosticSeverity = "error" | "warning";

export type LatexDiagnostic = {
  readonly severity: LatexDiagnosticSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly message: string;
};

export type PdfArtifact = {
  readonly pdfPath: string;
  readonly synctexPath?: string;
  readonly updatedAt: string;
  readonly byteLength: number;
};

export type SyncTexForwardRequest = {
  readonly projectRoot: string;
  readonly sourceFilePath: string;
  readonly line: number;
  readonly column: number;
  readonly pdfPath: string;
};

export type SyncTexForwardResult = {
  readonly available: boolean;
  readonly page?: number;
  readonly x?: number;
  readonly y?: number;
  readonly message?: string;
};

export type SyncTexReverseRequest = {
  readonly projectRoot: string;
  readonly pdfPath: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
};

export type SyncTexReverseResult = {
  readonly available: boolean;
  readonly sourceFilePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message?: string;
};

export type BuildRunRequest = {
  readonly jobId?: string;
  readonly projectRoot: string;
  readonly mainFilePath: string;
  readonly compiler: LatexCompiler;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

export type BuildResult = {
  readonly jobId: string;
  readonly status: BuildStatus;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact?: PdfArtifact;
};

type ActiveBuildJob = {
  readonly process: ChildProcessWithoutNullStreams;
  cancelled: boolean;
};

const defaultTimeoutMs = 120_000;
const defaultMaxOutputBytes = 2_000_000;
const activeBuildJobs = new Map<string, ActiveBuildJob>();

export async function detectLatexToolchain(): Promise<LatexToolchainStatus> {
  const [latexmkResult, synctexResult, ...compilerResults] = await Promise.all([
    runVersionCommand("latexmk", ["-version"]),
    runVersionCommand("synctex", ["--version"]),
    runVersionCommand("pdflatex", ["--version"]),
    runVersionCommand("xelatex", ["--version"]),
    runVersionCommand("lualatex", ["--version"])
  ]);
  const compilerNames: readonly LatexCompiler[] = ["pdflatex", "xelatex", "lualatex"];

  return {
    latexmkAvailable: latexmkResult.available,
    synctexAvailable: synctexResult.available,
    ...(latexmkResult.version === undefined
      ? {}
      : { latexmkVersion: latexmkResult.version }),
    availableCompilers: compilerNames.filter(
      (_compiler, index) => compilerResults[index]?.available === true
    )
  };
}

export async function runLatexBuild(request: BuildRunRequest): Promise<BuildResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const jobId = request.jobId ?? randomUUID();
  const root = await validateProjectRoot(request.projectRoot);
  const mainFilePath = await resolveProjectFile(root, request.mainFilePath);
  const outputDirectory = join(root, ".latex-agent", "build");
  await mkdir(outputDirectory, { recursive: true });

  const command = createLatexmkCommand(
    root,
    mainFilePath,
    outputDirectory,
    request.compiler
  );
  const child = spawn(command[0] ?? "latexmk", command.slice(1), {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      max_print_line: "2000"
    }
  });
  const activeJob: ActiveBuildJob = {
    process: child,
    cancelled: false
  };
  const outputLimit = request.maxOutputBytes ?? defaultMaxOutputBytes;
  let stdout = "";
  let stderr = "";

  activeBuildJobs.set(jobId, activeJob);

  const timeout = setTimeout(() => {
    activeJob.cancelled = true;
    killBuildProcess(child);
  }, request.timeoutMs ?? defaultTimeoutMs);

  try {
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk, outputLimit);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk, outputLimit);
      });
      child.on("error", rejectExit);
      child.on("close", resolveExit);
    });
    const finishedAtMs = Date.now();
    const logPath = getExpectedLogPath(outputDirectory, mainFilePath);
    const rawLog = await readOptionalFile(logPath);
    const artifact = await getPdfArtifact(outputDirectory, mainFilePath);
    const status: BuildStatus = activeJob.cancelled
      ? "cancelled"
      : exitCode === 0 && artifact !== undefined
        ? "succeeded"
        : "failed";
    const diagnosticSource =
      status === "succeeded" && rawLog.trim().length > 0
        ? rawLog
        : `${stdout}\n${stderr}\n${rawLog}`;

    return withOptionalBuildFields({
      jobId,
      status,
      command,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      exitCode: exitCode ?? undefined,
      diagnostics: parseLatexDiagnostics(diagnosticSource),
      rawLog,
      stdout,
      stderr,
      artifact
    });
  } finally {
    clearTimeout(timeout);
    activeBuildJobs.delete(jobId);
  }
}

export function stopLatexBuild(jobId: string): boolean {
  const job = activeBuildJobs.get(jobId);

  if (job === undefined) {
    return false;
  }

  job.cancelled = true;
  return killBuildProcess(job.process);
}

export async function runSyncTexForward(
  request: SyncTexForwardRequest
): Promise<SyncTexForwardResult> {
  const root = await validateProjectRoot(request.projectRoot);
  const sourceFilePath = await resolveProjectFile(root, request.sourceFilePath);
  const pdfPath = await resolvePdfArtifact(root, request.pdfPath);
  const output = await runSyncTexCommand([
    "view",
    "-i",
    `${Math.max(1, request.line)}:${Math.max(1, request.column)}:${sourceFilePath}`,
    "-o",
    pdfPath
  ]);

  return parseSyncTexForwardOutput(output);
}

export async function runSyncTexReverse(
  request: SyncTexReverseRequest
): Promise<SyncTexReverseResult> {
  const root = await validateProjectRoot(request.projectRoot);
  const pdfPath = await resolvePdfArtifact(root, request.pdfPath);
  const output = await runSyncTexCommand([
    "edit",
    "-o",
    `${Math.max(1, request.page)}:${Math.max(0, request.x)}:${Math.max(0, request.y)}:${pdfPath}`
  ]);

  return normalizeReverseResult(root, parseSyncTexReverseOutput(output));
}

export function parseLatexDiagnostics(log: string): readonly LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const lines = log.split(/\r?\n/);
  const fileLinePattern = /^(.+\.tex):(\d+):\s*(.+)$/;
  const warningPattern = /^(LaTeX|Package|Class)\s+(.+?)\s+Warning:\s+(.+)$/;

  for (const [index, line] of lines.entries()) {
    const fileLineMatch = fileLinePattern.exec(line);

    if (fileLineMatch !== null) {
      diagnostics.push(
        withOptionalDiagnosticFields({
          severity: "error",
          filePath: normalizeDiagnosticPath(fileLineMatch[1]),
          line: Number(fileLineMatch[2]),
          message: fileLineMatch[3]?.trim() ?? "LaTeX error"
        })
      );
      continue;
    }

    if (line.startsWith("! ")) {
      diagnostics.push({
        severity: "error",
        message: line.slice(2).trim() || "LaTeX error"
      });
      continue;
    }

    const warningMatch = warningPattern.exec(line);
    if (warningMatch !== null) {
      diagnostics.push({
        severity: "warning",
        message: line.trim()
      });
      continue;
    }

    if (line.includes("Warning:")) {
      diagnostics.push({
        severity: "warning",
        message: line.trim()
      });
    }

    if (line.trim() === "l." && lines[index + 1] !== undefined) {
      diagnostics.push({
        severity: "error",
        message: lines[index + 1]?.trim() ?? "LaTeX error"
      });
    }
  }

  return dedupeDiagnostics(diagnostics).slice(0, 200);
}

function createLatexmkCommand(
  projectRoot: string,
  mainFilePath: string,
  outputDirectory: string,
  compiler: LatexCompiler
): readonly string[] {
  const relativeMainFile = relative(projectRoot, mainFilePath);
  const engineMode =
    compiler === "xelatex" ? "-pdfxe" : compiler === "lualatex" ? "-pdflua" : "-pdf";
  const engineOption =
    compiler === "xelatex"
      ? `-xelatex=${compiler} -interaction=nonstopmode -halt-on-error -file-line-error -synctex=1 -no-shell-escape %O %S`
      : compiler === "lualatex"
        ? `-lualatex=${compiler} -interaction=nonstopmode -halt-on-error -file-line-error -synctex=1 -no-shell-escape %O %S`
        : `-pdflatex=${compiler} -interaction=nonstopmode -halt-on-error -file-line-error -synctex=1 -no-shell-escape %O %S`;

  return [
    "latexmk",
    engineMode,
    engineOption,
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-synctex=1",
    `-outdir=${outputDirectory}`,
    relativeMainFile
  ];
}

async function validateProjectRoot(rootPath: string): Promise<string> {
  const root = await realpath(rootPath);
  const rootStats = await stat(root);

  if (!rootStats.isDirectory()) {
    throw new Error("Project root must be a directory.");
  }

  return root;
}

async function resolveProjectFile(
  rootPath: string,
  projectPath: string
): Promise<string> {
  if (isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw new Error("Main file path must be project-relative.");
  }

  const resolvedPath = resolve(rootPath, projectPath);
  const realPath = await realpath(resolvedPath);

  if (!isInsideRoot(rootPath, realPath) || !realPath.endsWith(".tex")) {
    throw new Error("Main file must be a .tex file inside the project root.");
  }

  return realPath;
}

async function resolvePdfArtifact(rootPath: string, pdfPath: string): Promise<string> {
  if (!pdfPath.endsWith(".pdf") || pdfPath.includes("\0")) {
    throw new Error("PDF artifact path is invalid.");
  }

  const resolvedPath = isAbsolute(pdfPath) ? pdfPath : resolve(rootPath, pdfPath);
  const realPath = await realpath(resolvedPath);

  if (!isInsideRoot(rootPath, realPath)) {
    throw new Error("PDF artifact must be inside the project root.");
  }

  return realPath;
}

async function getPdfArtifact(
  outputDirectory: string,
  mainFilePath: string
): Promise<PdfArtifact | undefined> {
  const pdfPath = join(outputDirectory, `${basename(mainFilePath, ".tex")}.pdf`);
  const synctexPath = join(
    outputDirectory,
    `${basename(mainFilePath, ".tex")}.synctex.gz`
  );

  try {
    const pdfStats = await stat(pdfPath);

    if (!pdfStats.isFile()) {
      return undefined;
    }

    return {
      pdfPath,
      ...((await fileExists(synctexPath)) ? { synctexPath } : {}),
      updatedAt: pdfStats.mtime.toISOString(),
      byteLength: pdfStats.size
    };
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);
    return fileStats.isFile();
  } catch {
    return false;
  }
}

function getExpectedLogPath(outputDirectory: string, mainFilePath: string): string {
  return join(outputDirectory, `${basename(mainFilePath, ".tex")}.log`);
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;

  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  return combined.slice(-maxBytes);
}

async function runSyncTexCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("synctex", [...args]);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () =>
      resolveOutput(
        "SyncTeX result begin\nUnavailable: synctex command not found\nSyncTeX result end"
      )
    );
    child.on("close", (code) => {
      if (code !== 0 && stdout.trim().length === 0) {
        rejectOutput(new Error(stderr.trim() || "SyncTeX lookup failed."));
        return;
      }

      resolveOutput(stdout);
    });
  });
}

export function parseSyncTexForwardOutput(output: string): SyncTexForwardResult {
  if (output.includes("Unavailable:")) {
    return {
      available: false,
      message: getSyncTexValue(output, "Unavailable") ?? "SyncTeX unavailable."
    };
  }

  const page = toNumber(getSyncTexValue(output, "Page"));
  const x = toNumber(getSyncTexValue(output, "x"));
  const y = toNumber(getSyncTexValue(output, "y"));

  if (page === undefined) {
    return {
      available: false,
      message: "No SyncTeX mapping found."
    };
  }

  return {
    available: true,
    page,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y })
  };
}

export function parseSyncTexReverseOutput(output: string): SyncTexReverseResult {
  if (output.includes("Unavailable:")) {
    return {
      available: false,
      message: getSyncTexValue(output, "Unavailable") ?? "SyncTeX unavailable."
    };
  }

  const sourceFilePath = getSyncTexValue(output, "Input");
  const line = toNumber(getSyncTexValue(output, "Line"));
  const column = toNumber(getSyncTexValue(output, "Column"));

  if (sourceFilePath === undefined || line === undefined) {
    return {
      available: false,
      message: "No SyncTeX mapping found."
    };
  }

  return {
    available: true,
    sourceFilePath,
    line,
    ...(column === undefined ? {} : { column })
  };
}

function normalizeReverseResult(
  rootPath: string,
  result: SyncTexReverseResult
): SyncTexReverseResult {
  if (!result.available || result.sourceFilePath === undefined) {
    return result;
  }

  const sourcePath = result.sourceFilePath;
  const relativePath = isAbsolute(sourcePath)
    ? relative(rootPath, sourcePath)
    : sourcePath;

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return {
      available: false,
      message: "SyncTeX source is outside the project root."
    };
  }

  return {
    ...result,
    sourceFilePath: relativePath.split("\\").join("/")
  };
}

function getSyncTexValue(output: string, key: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}:`));

  return line?.slice(key.length + 1).trim();
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function killBuildProcess(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return true;
    } catch {
      return child.kill("SIGTERM");
    }
  }

  return child.kill("SIGTERM");
}

async function runVersionCommand(
  command: string,
  args: readonly string[]
): Promise<{ readonly available: boolean; readonly version?: string }> {
  return new Promise((resolveVersion) => {
    const child = spawn(command, [...args]);
    let output = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolveVersion({ available: false }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolveVersion({ available: false });
        return;
      }

      const version = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      resolveVersion(
        version === undefined ? { available: true } : { available: true, version }
      );
    });
  });
}

function normalizeDiagnosticPath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return path.trim().split("\\").join("/");
}

function dedupeDiagnostics(
  diagnostics: readonly LatexDiagnostic[]
): readonly LatexDiagnostic[] {
  const seen = new Set<string>();
  const uniqueDiagnostics: LatexDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}:${diagnostic.filePath ?? ""}:${diagnostic.line ?? ""}:${diagnostic.message}`;

    if (!seen.has(key)) {
      seen.add(key);
      uniqueDiagnostics.push(diagnostic);
    }
  }

  return uniqueDiagnostics;
}

function isInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function withOptionalBuildFields(result: {
  readonly jobId: string;
  readonly status: BuildStatus;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | undefined;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact: PdfArtifact | undefined;
}): BuildResult {
  return {
    jobId: result.jobId,
    status: result.status,
    command: result.command,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    diagnostics: result.diagnostics,
    rawLog: result.rawLog,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.artifact === undefined ? {} : { artifact: result.artifact })
  };
}

function withOptionalDiagnosticFields(diagnostic: {
  readonly severity: LatexDiagnosticSeverity;
  readonly filePath: string | undefined;
  readonly line: number | undefined;
  readonly message: string;
}): LatexDiagnostic {
  return {
    severity: diagnostic.severity,
    ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
    ...(diagnostic.line === undefined || Number.isNaN(diagnostic.line)
      ? {}
      : { line: diagnostic.line }),
    message: diagnostic.message
  };
}
