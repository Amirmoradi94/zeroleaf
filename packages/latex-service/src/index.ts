import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
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

type LatexDiagnosticParseOptions = {
  readonly mainFilePath?: string;
  readonly mainSource?: string;
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

export type ShellEscapePolicy = {
  readonly enabled: false;
  readonly commandFlag: "-no-shell-escape";
  readonly approvalRequiredToEnable: true;
  readonly agentMayEnable: false;
  readonly message: string;
};

export type BuildSecurityPolicy = {
  readonly shellEscape: ShellEscapePolicy;
};

export type BuildResult = {
  readonly jobId: string;
  readonly status: BuildStatus;
  readonly compiler: LatexCompiler;
  readonly command: readonly string[];
  readonly securityPolicy: BuildSecurityPolicy;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly rawLogTruncated?: boolean;
  readonly rawLogBytes?: number;
  readonly rawLogOriginalBytes?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact?: PdfArtifact;
};

type ActiveBuildJob = {
  readonly process: ChildProcessWithoutNullStreams;
  readonly processGroupId?: number;
  cancelled: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout>;
};

const defaultTimeoutMs = 120_000;
const defaultMaxOutputBytes = 2_000_000;
const forceKillDelayMs = 1_500;
const processTreeExitTimeoutMs = 5_000;
const texPathDiscoveryDisabledEnv = "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY";
const standardTexBinPaths =
  process.platform === "darwin"
    ? [
        "/Library/TeX/texbin",
        "/usr/local/texlive/2026/bin/universal-darwin",
        "/usr/local/texlive/2025/bin/universal-darwin",
        "/usr/local/texlive/2024/bin/universal-darwin"
      ]
    : process.platform === "win32"
      ? []
      : [
          "/usr/local/texlive/2026/bin/x86_64-linux",
          "/usr/local/texlive/2025/bin/x86_64-linux"
        ];
const activeBuildJobs = new Map<string, ActiveBuildJob>();
const defaultBuildSecurityPolicy: BuildSecurityPolicy = {
  shellEscape: {
    enabled: false,
    commandFlag: "-no-shell-escape",
    approvalRequiredToEnable: true,
    agentMayEnable: false,
    message:
      "Shell escape is disabled for LaTeX builds. Enabling it requires an explicit user approval path and cannot be changed by the agent."
  }
};

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
  const toolchain = await detectLatexToolchain();
  const setupMessage = getToolchainSetupMessage(toolchain, request.compiler);

  if (setupMessage !== undefined) {
    return createPreflightBuildFailure({
      jobId,
      compiler: request.compiler,
      command,
      startedAt,
      startedAtMs,
      message: setupMessage
    });
  }

  const child = spawn(command[0] ?? "latexmk", command.slice(1), {
    cwd: root,
    detached: process.platform !== "win32",
    env: createLatexProcessEnv()
  });
  const activeJob: ActiveBuildJob = {
    process: child,
    ...(child.pid === undefined ? {} : { processGroupId: child.pid }),
    cancelled: false
  };
  const outputLimit = request.maxOutputBytes ?? defaultMaxOutputBytes;
  let stdout = "";
  let stderr = "";

  activeBuildJobs.set(jobId, activeJob);

  const timeout = setTimeout(() => {
    activeJob.cancelled = true;
    terminateBuildProcess(activeJob);
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
    if (activeJob.cancelled) {
      await waitForBuildProcessTreeExit(activeJob);
    }
    const finishedAtMs = Date.now();
    const logPath = getExpectedLogPath(outputDirectory, mainFilePath);
    const rawLogResult = await readOptionalCappedFile(logPath, outputLimit);
    const rawLog = rawLogResult.contents;
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
    const mainSource = await readOptionalFile(mainFilePath);

    return withOptionalBuildFields({
      jobId,
      status,
      compiler: request.compiler,
      command,
      securityPolicy: defaultBuildSecurityPolicy,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      exitCode: exitCode ?? undefined,
      diagnostics: parseLatexDiagnostics(diagnosticSource, {
        mainFilePath: relative(root, mainFilePath),
        mainSource
      }),
      rawLog,
      rawLogTruncated: rawLogResult.truncated,
      rawLogBytes: Buffer.byteLength(rawLog, "utf8"),
      rawLogOriginalBytes: rawLogResult.originalBytes,
      stdout,
      stderr,
      artifact
    });
  } finally {
    clearTimeout(timeout);
    if (!activeJob.cancelled && activeJob.forceKillTimer !== undefined) {
      clearTimeout(activeJob.forceKillTimer);
    }
    activeBuildJobs.delete(jobId);
  }
}

export function stopLatexBuild(jobId: string): boolean {
  const job = activeBuildJobs.get(jobId);

  if (job === undefined) {
    return false;
  }

  job.cancelled = true;
  return terminateBuildProcess(job);
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

export function parseLatexDiagnostics(
  log: string,
  options: LatexDiagnosticParseOptions = {}
): readonly LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const lines = log.split(/\r?\n/);
  const fileLinePattern = /^(.+\.tex):(\d+):\s*(.+)$/;
  const warningPattern = /^(LaTeX|Package|Class)\s+(.+?)\s+Warning:\s+(.+)$/;
  const missingLegalEnd =
    /job aborted,\s*no legal \\end found|no legal \\end found/iu.test(log);

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
      if (
        missingLegalEnd &&
        (line.includes("Emergency stop") || line.includes("Fatal error occurred"))
      ) {
        continue;
      }
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

  if (missingLegalEnd) {
    diagnostics.unshift(createMissingDocumentEndDiagnostic(options));
  }

  if (logMentionsBlockedShellEscape(log)) {
    diagnostics.unshift({
      severity: "warning",
      message:
        "Shell escape was requested by this project but stayed disabled with -no-shell-escape. Review the package or project source before approving any future shell-escape build."
    });
  }

  return dedupeDiagnostics(diagnostics).slice(0, 200);
}

function logMentionsBlockedShellEscape(log: string): boolean {
  return (
    /runsystem\(.+?\)\s*\.\.\.\s*disabled/isu.test(log) ||
    /Package\s+.+?\s+Error:.*(?:-shell-escape|shell\s+escape)/iu.test(log) ||
    /(?:requires?|needs?|must invoke|enable).*shell\s*-?\s*escape/iu.test(log)
  );
}

function createMissingDocumentEndDiagnostic(
  options: LatexDiagnosticParseOptions
): LatexDiagnostic {
  const line = findBeginDocumentLine(options.mainSource);

  return withOptionalDiagnosticFields({
    severity: "error",
    filePath: options.mainFilePath,
    line,
    message:
      "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
  });
}

function findBeginDocumentLine(source: string | undefined): number | undefined {
  if (source === undefined) {
    return undefined;
  }

  const lines = source.split(/\r?\n/);
  const beginDocumentIndex = lines.findIndex((line) =>
    /\\begin\s*\{\s*document\s*\}/u.test(line)
  );

  if (beginDocumentIndex >= 0) {
    return beginDocumentIndex + 1;
  }

  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim().length !== 0) {
      lastContentIndex = index;
      break;
    }
  }

  return lastContentIndex >= 0 ? lastContentIndex + 1 : undefined;
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

function getToolchainSetupMessage(
  toolchain: LatexToolchainStatus,
  compiler: LatexCompiler
): string | undefined {
  if (!toolchain.latexmkAvailable) {
    return "latexmk is not available on PATH. Install MacTeX or BasicTeX, then restart the app or make sure /Library/TeX/texbin is on PATH.";
  }

  if (!toolchain.availableCompilers.includes(compiler)) {
    const availableCompilers =
      toolchain.availableCompilers.length === 0
        ? "none detected"
        : toolchain.availableCompilers.join(", ");

    return `${compiler} is not available on PATH. Install MacTeX or BasicTeX, choose an available compiler, or make sure /Library/TeX/texbin is on PATH. Available compilers: ${availableCompilers}.`;
  }

  return undefined;
}

function createLatexProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: createLatexPath(process.env.PATH),
    max_print_line: "2000"
  };
}

function createLatexPath(currentPath: string | undefined): string {
  if (
    process.env[texPathDiscoveryDisabledEnv] === "1" ||
    currentPath === undefined ||
    currentPath.trim().length === 0
  ) {
    return currentPath ?? "";
  }

  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const existingParts = currentPath.split(pathSeparator).filter(Boolean);
  const existing = new Set(existingParts);
  const discoveredParts = standardTexBinPaths.filter((path) => !existing.has(path));

  return [...existingParts, ...discoveredParts].join(pathSeparator);
}

function createPreflightBuildFailure({
  jobId,
  compiler,
  command,
  startedAt,
  startedAtMs,
  message
}: {
  readonly jobId: string;
  readonly compiler: LatexCompiler;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly message: string;
}): BuildResult {
  const finishedAtMs = Date.now();

  return {
    jobId,
    status: "failed",
    compiler,
    command,
    securityPolicy: defaultBuildSecurityPolicy,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    diagnostics: [
      {
        severity: "error",
        message
      }
    ],
    rawLog: message,
    rawLogTruncated: false,
    rawLogBytes: Buffer.byteLength(message, "utf8"),
    rawLogOriginalBytes: Buffer.byteLength(message, "utf8"),
    stdout: "",
    stderr: message
  };
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

async function readOptionalCappedFile(
  path: string,
  maxBytes: number
): Promise<{
  readonly contents: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}> {
  try {
    const fileStats = await stat(path);

    if (!fileStats.isFile()) {
      return { contents: "", truncated: false, originalBytes: 0 };
    }

    const byteBudget = Math.max(1, maxBytes);

    if (fileStats.size <= byteBudget) {
      return {
        contents: await readFile(path, "utf8"),
        truncated: false,
        originalBytes: fileStats.size
      };
    }

    const marker = createTruncatedLogMarker(fileStats.size, byteBudget);
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= byteBudget) {
      return {
        contents: marker.slice(0, byteBudget),
        truncated: true,
        originalBytes: fileStats.size
      };
    }

    const retainedBytes = byteBudget - markerBytes;
    const headBytes = Math.floor(retainedBytes / 2);
    const tailBytes = retainedBytes - headBytes;
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const handle = await open(path, "r");

    try {
      await handle.read(head, 0, headBytes, 0);
      await handle.read(tail, 0, tailBytes, Math.max(0, fileStats.size - tailBytes));
    } finally {
      await handle.close();
    }

    return {
      contents: `${head.toString("utf8")}${marker}${tail.toString("utf8")}`,
      truncated: true,
      originalBytes: fileStats.size
    };
  } catch {
    return { contents: "", truncated: false, originalBytes: 0 };
  }
}

function createTruncatedLogMarker(originalBytes: number, maxBytes: number): string {
  return [
    "",
    "----- LaTeX log truncated -----",
    `Original log was ${originalBytes} bytes; capped to ${maxBytes} bytes from the beginning and end.`,
    "Search results may not include omitted middle content.",
    "----- End truncation notice -----",
    ""
  ].join("\n");
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
    const child = spawn("synctex", [...args], { env: createLatexProcessEnv() });
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

function terminateBuildProcess(job: ActiveBuildJob): boolean {
  const signalled = sendBuildTerminationSignal(job, "SIGTERM");

  if (signalled) {
    scheduleForcedBuildTermination(job);
  }

  return signalled;
}

function scheduleForcedBuildTermination(job: ActiveBuildJob): void {
  if (job.forceKillTimer !== undefined || process.platform === "win32") {
    return;
  }

  job.forceKillTimer = setTimeout(() => {
    sendBuildTerminationSignal(job, "SIGKILL");
  }, forceKillDelayMs);
  job.forceKillTimer.unref();
}

function sendBuildTerminationSignal(
  job: ActiveBuildJob,
  signal: NodeJS.Signals
): boolean {
  if (process.platform === "win32") {
    return terminateWindowsBuildTree(job.process);
  }

  if (job.processGroupId !== undefined) {
    try {
      process.kill(-job.processGroupId, signal);
      return true;
    } catch {
      return job.process.kill(signal);
    }
  }

  return job.process.kill(signal);
}

function terminateWindowsBuildTree(child: ChildProcessWithoutNullStreams): boolean {
  if (child.pid === undefined) {
    return child.kill("SIGTERM");
  }

  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore"
  });
  killer.unref();
  return true;
}

async function waitForBuildProcessTreeExit(job: ActiveBuildJob): Promise<void> {
  if (process.platform === "win32" || job.processGroupId === undefined) {
    return;
  }

  const deadline = Date.now() + processTreeExitTimeoutMs;

  while (processGroupExists(job.processGroupId)) {
    if (Date.now() >= deadline) {
      sendBuildTerminationSignal(job, "SIGKILL");
      return;
    }

    await delay(50);
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function runVersionCommand(
  command: string,
  args: readonly string[]
): Promise<{ readonly available: boolean; readonly version?: string }> {
  return new Promise((resolveVersion) => {
    const child = spawn(command, [...args], { env: createLatexProcessEnv() });
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
  readonly compiler: LatexCompiler;
  readonly command: readonly string[];
  readonly securityPolicy: BuildSecurityPolicy;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | undefined;
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly rawLog: string;
  readonly rawLogTruncated: boolean;
  readonly rawLogBytes: number;
  readonly rawLogOriginalBytes: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact: PdfArtifact | undefined;
}): BuildResult {
  return {
    jobId: result.jobId,
    status: result.status,
    compiler: result.compiler,
    command: result.command,
    securityPolicy: result.securityPolicy,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    diagnostics: result.diagnostics,
    rawLog: result.rawLog,
    rawLogTruncated: result.rawLogTruncated,
    rawLogBytes: result.rawLogBytes,
    rawLogOriginalBytes: result.rawLogOriginalBytes,
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
