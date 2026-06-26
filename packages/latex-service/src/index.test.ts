import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectLatexToolchain,
  parseLatexDiagnostics,
  parseSyncTexForwardOutput,
  parseSyncTexReverseOutput,
  runLatexBuild,
  stopLatexBuild
} from "./index.js";

describe("latex-service diagnostics", () => {
  it("parses file-line-error diagnostics", () => {
    expect(
      parseLatexDiagnostics("sections/intro.tex:12: Undefined control sequence.")
    ).toEqual([
      {
        severity: "error",
        filePath: "sections/intro.tex",
        line: 12,
        message: "Undefined control sequence."
      }
    ]);
  });

  it("parses LaTeX warnings", () => {
    expect(
      parseLatexDiagnostics(
        "LaTeX Warning: Reference `sec:intro' on page 1 undefined on input line 22."
      )
    ).toEqual([
      {
        severity: "warning",
        message:
          "LaTeX Warning: Reference `sec:intro' on page 1 undefined on input line 22."
      }
    ]);
  });

  it("deduplicates repeated diagnostics", () => {
    expect(
      parseLatexDiagnostics(
        "main.tex:4: Missing $ inserted.\nmain.tex:4: Missing $ inserted."
      )
    ).toHaveLength(1);
  });

  it("creates a source diagnostic for a missing document terminator with main source context", () => {
    expect(
      parseLatexDiagnostics(
        [
          "! Emergency stop.",
          "<*> main.tex",
          "*** (job aborted, no legal \\end found)",
          "!  ==> Fatal error occurred, no output PDF file produced!"
        ].join("\n"),
        {
          mainFilePath: "main.tex",
          mainSource: [
            "\\documentclass{article}",
            "\\begin{document}",
            "Homework answer."
          ].join("\n")
        }
      )
    ).toEqual([
      {
        severity: "error",
        filePath: "main.tex",
        line: 2,
        message:
          "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
      }
    ]);
  });

  it("keeps a missing document terminator diagnostic even when the exact source line is uncertain", () => {
    expect(
      parseLatexDiagnostics(
        [
          "! Emergency stop.",
          "<*> main.tex",
          "*** (job aborted, no legal \\end found)",
          "!  ==> Fatal error occurred, no output PDF file produced!"
        ].join("\n")
      )
    ).toEqual([
      {
        severity: "error",
        message:
          "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
      }
    ]);
  });
});

describe("latex-service synctex", () => {
  it("parses source-to-PDF output", () => {
    expect(
      parseSyncTexForwardOutput(`SyncTeX result begin
Output:/tmp/main.pdf
Page:3
x:144.25
y:220.5
SyncTeX result end`)
    ).toEqual({
      available: true,
      page: 3,
      x: 144.25,
      y: 220.5
    });
  });

  it("parses PDF-to-source output", () => {
    expect(
      parseSyncTexReverseOutput(`SyncTeX result begin
Input:/tmp/paper/sections/intro.tex
Line:42
Column:7
SyncTeX result end`)
    ).toEqual({
      available: true,
      sourceFilePath: "/tmp/paper/sections/intro.tex",
      line: 42,
      column: 7
    });
  });

  it("returns unavailable when no mapping exists", () => {
    expect(
      parseSyncTexForwardOutput("SyncTeX result begin\nSyncTeX result end")
    ).toEqual({
      available: false,
      message: "No SyncTeX mapping found."
    });
  });

  it("returns unavailable for PDF-to-source output without a source mapping", () => {
    expect(
      parseSyncTexReverseOutput("SyncTeX result begin\nSyncTeX result end")
    ).toEqual({
      available: false,
      message: "No SyncTeX mapping found."
    });
  });
});

describe("latex-service toolchain preflight", () => {
  it("returns setup guidance when latexmk is missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-missing-toolchain-"));
    const originalPath = process.env.PATH;

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        "\\documentclass{article}\\begin{document}Hello\\end{document}",
        "utf8"
      );
      process.env.PATH = "";

      const result = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      });

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]?.message).toContain("latexmk");
      expect(result.diagnostics[0]?.message).toContain("MacTeX or BasicTeX");
      expect(result.rawLog).toContain("PATH");
    } finally {
      process.env.PATH = originalPath;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports a missing selected engine distinctly from LaTeX syntax errors", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-missing-engine-"));
    const binPath = join(projectRoot, "bin");
    const originalPath = process.env.PATH;
    const originalTexPathDiscovery = disableTexPathDiscovery();

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        [
          "\\documentclass{article}",
          "\\begin{document}",
          "\\undefinedcommand",
          "\\end{document}",
          ""
        ].join("\n"),
        "utf8"
      );
      await mkdir(binPath, { recursive: true });
      await writeFile(
        join(binPath, "latexmk"),
        "#!/bin/sh\nprintf 'Latexmk fake 1.0\\n'\n",
        "utf8"
      );
      await chmod(join(binPath, "latexmk"), 0o755);
      process.env.PATH = binPath;

      const result = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "xelatex"
      });

      expect(result.status).toBe("failed");
      expect(result.compiler).toBe("xelatex");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.message).toContain(
        "xelatex is not available on PATH"
      );
      expect(result.diagnostics[0]?.message).not.toContain("Undefined control");
      expect(result.rawLog).toContain("xelatex is not available on PATH");
    } finally {
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("latex-service toolchain metadata", () => {
  it("reports latexmk and compiler version strings for available tools", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-toolchain-metadata-"));
    const binPath = join(projectRoot, "bin");
    const originalPath = process.env.PATH;
    const originalTexPathDiscovery = disableTexPathDiscovery();

    try {
      await installFakeLatexToolchain(binPath);
      process.env.PATH = binPath;

      const toolchain = await detectLatexToolchain();

      expect(toolchain.latexmkVersion).toBe("Latexmk fake 1.0");
      expect(toolchain.compilerVersions?.pdflatex).toBe("pdfTeX fake 1.0");
      expect(toolchain.compilerVersions?.xelatex).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("latex-service build cancellation", () => {
  it("stops a runaway build process tree without killing unrelated processes", async () => {
    if (process.platform === "win32") {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "latex-runaway-build-"));
    const binPath = join(projectRoot, "bin");
    const latexmkPidPath = join(projectRoot, "latexmk.pid");
    const childPidPath = join(projectRoot, "child.pid");
    const originalPath = process.env.PATH;
    const originalLatexmkPidFile = process.env.LATEXMK_PID_FILE;
    const originalLatexChildPidFile = process.env.LATEX_CHILD_PID_FILE;
    const originalTexPathDiscovery = disableTexPathDiscovery();
    const unrelatedProcess = spawnUnrelatedProcess();
    const jobId = "runaway-build";

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        "\\documentclass{article}\\begin{document}\\input{main}\\end{document}",
        "utf8"
      );
      await mkdir(binPath, { recursive: true });
      await writeFile(
        join(binPath, "pdflatex"),
        "#!/bin/sh\nprintf 'pdfTeX fake 1.0\\n'\n",
        "utf8"
      );
      await writeFile(
        join(binPath, "latexmk"),
        [
          "#!/bin/sh",
          'if [ "$1" = "-version" ]; then',
          "  printf 'Latexmk fake 1.0\\n'",
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$$" > "$LATEXMK_PID_FILE"',
          '/bin/sh -c \'printf "%s\\n" "$$" > "$LATEX_CHILD_PID_FILE"; trap "" TERM; while :; do /bin/sleep 1; done\' &',
          "child=$!",
          'wait "$child"',
          ""
        ].join("\n"),
        "utf8"
      );
      await chmod(join(binPath, "pdflatex"), 0o755);
      await chmod(join(binPath, "latexmk"), 0o755);
      process.env.PATH = binPath;
      process.env.LATEXMK_PID_FILE = latexmkPidPath;
      process.env.LATEX_CHILD_PID_FILE = childPidPath;

      const buildPromise = runLatexBuild({
        jobId,
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 30_000
      });

      await waitForFile(childPidPath);
      const childPid = Number((await readFile(childPidPath, "utf8")).trim());

      expect(stopLatexBuild(jobId)).toBe(true);

      const result = await buildPromise;

      expect(result.status).toBe("cancelled");
      await waitForProcessExit(childPid);
      expect(processExists(unrelatedProcess.pid)).toBe(true);

      await writeFile(join(projectRoot, "main.tex"), fixedArticleSource(), "utf8");
      await writeFile(join(binPath, "latexmk"), successfulLatexmkScript(), "utf8");
      await chmod(join(binPath, "latexmk"), 0o755);

      const repairedResult = await runLatexBuild({
        jobId: "after-runaway-build",
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 5_000
      });

      expect(repairedResult.status).toBe("succeeded");
      expect(repairedResult.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      stopLatexBuild(jobId);
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      restoreOptionalEnv("LATEXMK_PID_FILE", originalLatexmkPidFile);
      restoreOptionalEnv("LATEX_CHILD_PID_FILE", originalLatexChildPidFile);
      terminateProcess(unrelatedProcess);
      await killPidFileProcess(latexmkPidPath);
      await killPidFileProcess(childPidPath);
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("latex-service raw log inspection", () => {
  it("preserves raw package messages for a conflict before succeeding after preamble repair", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-package-conflict-"));
    const binPath = join(projectRoot, "bin");
    const fakeLogPath = join(projectRoot, "fake.log");
    const originalPath = process.env.PATH;
    const originalFakeLogFile = process.env.LATEX_FAKE_LOG_FILE;
    const originalFakeExitCode = process.env.LATEX_FAKE_EXIT_CODE;
    const originalTexPathDiscovery = disableTexPathDiscovery();

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        [
          "\\documentclass{article}",
          "\\usepackage[dvipsnames]{xcolor}",
          "\\usepackage[table]{xcolor}",
          "\\usepackage{hyperref}",
          "\\begin{document}",
          "Conflict.",
          "\\end{document}",
          ""
        ].join("\n"),
        "utf8"
      );
      await installFakeLatexToolchain(binPath);
      await writeFile(
        fakeLogPath,
        [
          "Package xcolor Info: Driver file: pdftex.def",
          "Package hyperref Warning: Token not allowed in a PDF string.",
          "! LaTeX Error: Option clash for package xcolor.",
          "See the xcolor package documentation for explanation.",
          ""
        ].join("\n"),
        "utf8"
      );
      process.env.PATH = binPath;
      process.env.LATEX_FAKE_LOG_FILE = fakeLogPath;
      process.env.LATEX_FAKE_EXIT_CODE = "1";

      const conflictResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 5_000
      });

      expect(conflictResult.status).toBe("failed");
      expect(conflictResult.rawLog).toContain("Package xcolor Info");
      expect(conflictResult.rawLog).toContain("Package hyperref Warning");
      expect(conflictResult.rawLog).toContain("Option clash for package xcolor");
      expect(conflictResult.rawLogTruncated).toBe(false);

      await writeFile(join(projectRoot, "main.tex"), fixedArticleSource(), "utf8");
      await writeFile(fakeLogPath, "Package xcolor Info: Loaded once.\\n", "utf8");
      process.env.LATEX_FAKE_EXIT_CODE = "0";

      const repairedResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 5_000
      });

      expect(repairedResult.status).toBe("succeeded");
      expect(repairedResult.rawLog).toContain("Package xcolor Info");
      expect(repairedResult.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      restoreOptionalEnv("LATEX_FAKE_LOG_FILE", originalFakeLogFile);
      restoreOptionalEnv("LATEX_FAKE_EXIT_CODE", originalFakeExitCode);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps shell escape disabled when a package asks for it", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-shell-escape-"));
    const binPath = join(projectRoot, "bin");
    const fakeLogPath = join(projectRoot, "fake.log");
    const argvPath = join(projectRoot, "latexmk.argv");
    const originalPath = process.env.PATH;
    const originalFakeLogFile = process.env.LATEX_FAKE_LOG_FILE;
    const originalFakeExitCode = process.env.LATEX_FAKE_EXIT_CODE;
    const originalFakeArgvFile = process.env.LATEX_FAKE_ARGV_FILE;
    const originalTexPathDiscovery = disableTexPathDiscovery();

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        [
          "\\documentclass{article}",
          "\\usepackage{minted}",
          "\\begin{document}",
          "\\begin{minted}{tex}",
          "\\documentclass{article}",
          "\\end{minted}",
          "\\end{document}",
          ""
        ].join("\n"),
        "utf8"
      );
      await installFakeLatexToolchain(binPath);
      await writeFile(
        fakeLogPath,
        [
          "runsystem(pygmentize -V)...disabled.",
          "! Package minted Error: You must invoke LaTeX with the -shell-escape flag.",
          ""
        ].join("\n"),
        "utf8"
      );
      process.env.PATH = binPath;
      process.env.LATEX_FAKE_LOG_FILE = fakeLogPath;
      process.env.LATEX_FAKE_EXIT_CODE = "1";
      process.env.LATEX_FAKE_ARGV_FILE = argvPath;

      const result = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 5_000
      });
      const latexmkArgs = await readFile(argvPath, "utf8");

      expect(result.status).toBe("failed");
      expect(result.securityPolicy.shellEscape).toEqual({
        enabled: false,
        commandFlag: "-no-shell-escape",
        approvalRequiredToEnable: true,
        agentMayEnable: false,
        message:
          "Shell escape is disabled for LaTeX builds. Enabling it requires an explicit user approval path and cannot be changed by the agent."
      });
      expect(result.command.join(" ")).toContain("-no-shell-escape");
      expect(latexmkArgs).toContain("-no-shell-escape");
      expect(latexmkArgs).not.toMatch(/(^|\n)-shell-escape($|\n)/u);
      expect(result.rawLog).toContain("runsystem(pygmentize -V)...disabled");
      expect(result.rawLog).toContain("Package minted Error");
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            message: expect.stringContaining("Shell escape was requested")
          })
        ])
      );
    } finally {
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      restoreOptionalEnv("LATEX_FAKE_LOG_FILE", originalFakeLogFile);
      restoreOptionalEnv("LATEX_FAKE_EXIT_CODE", originalFakeExitCode);
      restoreOptionalEnv("LATEX_FAKE_ARGV_FILE", originalFakeArgvFile);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("caps very large raw logs and explains truncation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "latex-large-log-"));
    const binPath = join(projectRoot, "bin");
    const fakeLogPath = join(projectRoot, "fake.log");
    const originalPath = process.env.PATH;
    const originalFakeLogFile = process.env.LATEX_FAKE_LOG_FILE;
    const originalFakeExitCode = process.env.LATEX_FAKE_EXIT_CODE;
    const originalTexPathDiscovery = disableTexPathDiscovery();

    try {
      await writeFile(join(projectRoot, "main.tex"), fixedArticleSource(), "utf8");
      await installFakeLatexToolchain(binPath);
      await writeFile(
        fakeLogPath,
        [
          "Package geometry Info: head message.",
          "middle noise\n".repeat(400),
          "Package xcolor Info: tail message.",
          ""
        ].join("\n"),
        "utf8"
      );
      process.env.PATH = binPath;
      process.env.LATEX_FAKE_LOG_FILE = fakeLogPath;
      process.env.LATEX_FAKE_EXIT_CODE = "1";

      const result = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        maxOutputBytes: 900,
        timeoutMs: 5_000
      });

      expect(result.status).toBe("failed");
      expect(result.rawLogTruncated).toBe(true);
      expect(result.rawLogBytes).toBeLessThanOrEqual(900);
      expect(result.rawLogOriginalBytes).toBeGreaterThan(900);
      expect(result.rawLog).toContain("LaTeX log truncated");
      expect(result.rawLog).toContain("Package geometry Info");
      expect(result.rawLog).toContain("Package xcolor Info");
      expect(result.rawLog).toContain(
        "Search results may not include omitted middle content."
      );
    } finally {
      process.env.PATH = originalPath;
      restoreOptionalEnv(
        "ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY",
        originalTexPathDiscovery
      );
      restoreOptionalEnv("LATEX_FAKE_LOG_FILE", originalFakeLogFile);
      restoreOptionalEnv("LATEX_FAKE_EXIT_CODE", originalFakeExitCode);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("latex-service missing terminator build", () => {
  it("returns raw log and a clickable main-file diagnostic before succeeding after repair", async () => {
    const toolchain = await detectLatexToolchain();

    if (
      !toolchain.latexmkAvailable ||
      !toolchain.availableCompilers.includes("pdflatex")
    ) {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "latex-missing-end-build-"));

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        ["\\documentclass{article}", "\\begin{document}", "Homework answer.", ""].join(
          "\n"
        ),
        "utf8"
      );

      const failedResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });

      expect(failedResult.status).toBe("failed");
      expect(failedResult.rawLog).toContain("no legal \\end found");
      expect(failedResult.diagnostics[0]).toEqual({
        severity: "error",
        filePath: "main.tex",
        line: 2,
        message:
          "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
      });

      await writeFile(
        join(projectRoot, "main.tex"),
        [
          "\\documentclass{article}",
          "\\begin{document}",
          "Homework answer.",
          "\\end{document}",
          ""
        ].join("\n"),
        "utf8"
      );

      const repairedResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });

      expect(repairedResult.status).toBe("succeeded");
      expect(repairedResult.diagnostics).toEqual([]);
      expect(repairedResult.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("latex-service compiler selection", () => {
  it("records the selected compiler and compiles Unicode source with XeLaTeX", async () => {
    const toolchain = await detectLatexToolchain();

    if (
      !toolchain.latexmkAvailable ||
      !toolchain.availableCompilers.includes("pdflatex") ||
      !toolchain.availableCompilers.includes("xelatex")
    ) {
      return;
    }

    const projectRoot = await mkdtemp(join(tmpdir(), "latex-unicode-engine-"));

    try {
      await writeFile(
        join(projectRoot, "main.tex"),
        [
          "\\documentclass{article}",
          "\\begin{document}",
          "Unicode alpha α beta β.",
          "\\end{document}",
          ""
        ].join("\n"),
        "utf8"
      );

      const pdfLatexResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });

      expect(pdfLatexResult.status).toBe("failed");
      expect(pdfLatexResult.compiler).toBe("pdflatex");
      expect(pdfLatexResult.rawLog).toContain("Unicode character");

      const xeLatexResult = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "xelatex",
        timeoutMs: 60_000
      });

      expect(xeLatexResult.status).toBe("succeeded");
      expect(xeLatexResult.compiler).toBe("xelatex");
      expect(xeLatexResult.command).toContain("-pdfxe");
      expect(xeLatexResult.command.join(" ")).toContain("-xelatex=xelatex");
      expect(xeLatexResult.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

function spawnUnrelatedProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

function fixedArticleSource(): string {
  return [
    "\\documentclass{article}",
    "\\begin{document}",
    "Recovered after cancellation.",
    "\\end{document}",
    ""
  ].join("\n");
}

function successfulLatexmkScript(): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "-version" ]; then',
    "  printf 'Latexmk fake 1.0\\n'",
    "  exit 0",
    "fi",
    "outdir=''",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    -outdir=*) outdir=${arg#-outdir=} ;;",
    "  esac",
    "done",
    'if [ -z "$outdir" ]; then',
    "  exit 2",
    "fi",
    '/bin/mkdir -p "$outdir"',
    'printf "%PDF-1.4\\n" > "$outdir/main.pdf"',
    'printf "Build succeeded\\n" > "$outdir/main.log"',
    ""
  ].join("\n");
}

async function installFakeLatexToolchain(binPath: string): Promise<void> {
  await mkdir(binPath, { recursive: true });
  await writeFile(
    join(binPath, "pdflatex"),
    "#!/bin/sh\nprintf 'pdfTeX fake 1.0\\n'\n",
    "utf8"
  );
  await writeFile(
    join(binPath, "latexmk"),
    [
      "#!/bin/sh",
      'if [ "$1" = "-version" ]; then',
      "  printf 'Latexmk fake 1.0\\n'",
      "  exit 0",
      "fi",
      "outdir=''",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    -outdir=*) outdir=${arg#-outdir=} ;;",
      "  esac",
      "done",
      'if [ -z "$outdir" ]; then',
      "  exit 2",
      "fi",
      '/bin/mkdir -p "$outdir"',
      'if [ -n "$LATEX_FAKE_ARGV_FILE" ]; then',
      '  : > "$LATEX_FAKE_ARGV_FILE"',
      '  for arg in "$@"; do',
      '    printf "%s\\n" "$arg" >> "$LATEX_FAKE_ARGV_FILE"',
      "  done",
      "fi",
      'if [ -n "$LATEX_FAKE_LOG_FILE" ]; then',
      '  /bin/cp "$LATEX_FAKE_LOG_FILE" "$outdir/main.log"',
      "fi",
      'if [ "${LATEX_FAKE_EXIT_CODE:-0}" = "0" ]; then',
      '  printf "%PDF-1.4\\n" > "$outdir/main.pdf"',
      "fi",
      'exit "${LATEX_FAKE_EXIT_CODE:-0}"',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(join(binPath, "pdflatex"), 0o755);
  await chmod(join(binPath, "latexmk"), 0o755);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await delay(25);
    }
  }

  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 7_000;

  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }

    await delay(50);
  }

  throw new Error(`Process ${pid} did not exit.`);
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
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

function terminateProcess(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function killPidFileProcess(path: string): Promise<void> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort cleanup for a process that may already be gone.
  }
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function disableTexPathDiscovery(): string | undefined {
  const originalValue = process.env.ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY;
  process.env.ZEROLEAF_DISABLE_TEX_PATH_DISCOVERY = "1";
  return originalValue;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
