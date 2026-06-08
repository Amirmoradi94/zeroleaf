import { describe, expect, it } from "vitest";

import {
  parseLatexDiagnostics,
  parseSyncTexForwardOutput,
  parseSyncTexReverseOutput
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
});
