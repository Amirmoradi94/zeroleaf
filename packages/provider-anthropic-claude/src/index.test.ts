import { describe, expect, it } from "vitest";

import {
  ClaudeProvider,
  getClaudeToolsForMode,
  parseClaudeAgentResponseFromCli,
  parseClaudeAgentResponse,
  type ClaudeCodeToolBroker
} from "./index.js";

describe("ClaudeProvider", () => {
  it("reports needs-auth when the Claude Code CLI is logged out", async () => {
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: false })
    });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "anthropic-claude",
      state: "needs-auth"
    });
  });

  it("runs read-only tasks through Claude Code and returns the model answer", async () => {
    const calls: string[] = [];
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: () =>
        Promise.resolve(
          createClaudeAnswer("The active file is a short article with one warning.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Summarize the active file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 7,
          message: "LaTeX Warning: Reference `fig:missing` undefined"
        }
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "read-file"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "claude-code"
      )
    ).toBe(true);
    expect(result.events.some((event) => event.type === "patch")).toBe(false);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("The active file is a short article")
      )
    ).toBe(true);
  });

  it("configures Claude project tools by agent mode", () => {
    expect(getClaudeToolsForMode("read-only")).toBe("Read,Grep,Glob,LS");
    expect(getClaudeToolsForMode("apply-with-review")).toBe("Read,Grep,Glob,LS");
    expect(getClaudeToolsForMode("autonomous-local")).toBe(
      "Read,Grep,Glob,LS,Edit,MultiEdit,Write"
    );
  });

  it("delegates TODO and placeholder reviews in read-only mode to Claude Code", async () => {
    const calls: string[] = [];
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: () =>
        Promise.resolve(
          createClaudeAnswer("chapters/introduction.tex:2 [TODO] verify dataset count")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Find TODOs, citation needed notes, and placeholders in this draft.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        searchResults: {
          TODO: [
            {
              path: "chapters/introduction.tex",
              contents: "Intro text\n% TODO: verify dataset count\n"
            }
          ],
          "citation needed": [
            {
              path: "chapters/related.tex",
              contents: "This claim still has citation needed\n"
            }
          ],
          placeholder: [
            {
              path: "chapters/results.tex",
              contents: "Placeholder figure caption\n"
            }
          ]
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("chapters/introduction.tex:2 [TODO]")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "claude-code"
      )
    ).toBe(true);
  });

  it("delegates final formatting review prompts to Claude Code", async () => {
    const calls: string[] = [];
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: () =>
        Promise.resolve(
          createClaudeAnswer("Priority 1 blockers: Missing local figure asset.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Final PDF formatting review before submission.",
          "- warning: Generated build artifact is present in the source tree. (.latex-agent/build/main.log)"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": [
            "\\documentclass{article}",
            "\\usepackage{graphicx}",
            "\\begin{document}",
            "\\begin{figure}[ht]",
            "\\includegraphics{figures/missing.png}",
            "\\caption{System overview}",
            "\\end{figure}",
            "\\end{document}",
            ""
          ].join("\n")
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("Priority 1 blockers:") &&
          event.content.includes("Missing local figure asset")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "claude-code"
      )
    ).toBe(true);
  });

  it("turns Claude output into a reviewable changeset", async () => {
    let providerPrompt = "";
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a minimal patch.",
          notes: "Generated by fake Claude runner"
        });
      }
    });
    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText:
          "This is a bit rough, but we show that results follow \\citep{smith2024}."
      },
      createBroker()
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add document end");
    expect(result.events.some((event) => event.type === "approval")).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "claude-code"
      )
    ).toBe(true);
    expect(providerPrompt).toContain("Change only that exact selected span");
    expect(providerPrompt).toContain("preserve all unrelated paragraphs");
    expect(providerPrompt).toContain("labels, references, and citations");
    expect(providerPrompt).toContain("do not add new claims or citations");
    expect(providerPrompt).toContain("preserve TODO lines that require user input");
    expect(providerPrompt).toContain("preserve required contribution statements");
    expect(providerPrompt).toContain("make the smallest syntax-only edit");
    expect(providerPrompt).toContain("balance the caption braces without rewriting");
    expect(providerPrompt).toContain(
      "produce valid LaTeX using the project's existing table conventions"
    );
    expect(providerPrompt).toContain("mention width/layout advice in notes");
    expect(providerPrompt).toContain("preserve citation keys, labels, file paths");
    expect(providerPrompt).toContain('Use action "answer" for planning');
    expect(providerPrompt).toContain(
      "A user mentioning a PDF, paper, thesis, manuscript, or active document as source context does not by itself require a file edit"
    );
    expect(providerPrompt).toContain("Requests to merge, combine, consolidate");
    expect(providerPrompt).toContain("Write message like a person reporting back");
    expect(providerPrompt).toContain("In message, always explain the result");
    expect(providerPrompt).toContain('Set action to "patch" only when');
    expect(providerPrompt).toContain("\\citep{smith2024}");
  });

  it("runs autonomous Claude sessions with project-scoped edit access", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    let requestMode = "";
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: (request) => {
        providerPrompt = request.prompt;
        requestMode = request.mode;
        return Promise.resolve(
          createClaudeAnswer("Edited main.tex directly inside the project.")
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Edit main.tex directly.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(requestMode).toBe("autonomous-local");
    expect(providerPrompt).toContain("direct project-scoped access");
    expect(providerPrompt).toContain(
      "inspect, create, edit, overwrite, move, and delete"
    );
    expect(providerPrompt).toContain("Do not write outside the project root");
    expect(providerPrompt).toContain("If a search command or pattern fails");
    expect(calls).toEqual(["read-file:main.tex"]);
  });

  it("turns Claude Word edit output into a reviewable Word changeset", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    const wordBlocks = [
      { id: "w1", kind: "paragraph" as const, text: "Old abstract text." },
      { id: "w2", kind: "paragraph" as const, text: "Keep this paragraph." }
    ];
    const provider = new ClaudeProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
      runClaudeCode: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "word-edit",
          targetFilePath: "proposal.docx",
          summary: "Rewrite abstract",
          afterContents: "",
          wordChangesets: [
            {
              filePath: "proposal.docx",
              summary: "Rewrite abstract",
              operations: [
                {
                  type: "replace-block",
                  blockId: "w1",
                  afterText: "Clearer abstract text."
                }
              ]
            }
          ],
          message: "I prepared a Word changeset.",
          notes: "Generated by fake Claude runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "anthropic-claude",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Rewrite the abstract in the Word document.",
        activeFilePath: "proposal.docx",
        activeDocument: {
          kind: "word",
          path: "proposal.docx",
          plainText: "Old abstract text.\n\nKeep this paragraph.",
          blocks: wordBlocks,
          warnings: []
        },
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.wordChangeset).toMatchObject({
      projectRoot: "/tmp/project",
      filePath: "proposal.docx",
      summary: "Rewrite abstract",
      baseBlocks: wordBlocks,
      operations: [
        {
          type: "replace-block",
          blockId: "w1",
          afterText: "Clearer abstract text."
        }
      ],
      status: "proposed"
    });
    expect(result.wordChangesets).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(result.events.some((event) => event.type === "patch")).toBe(true);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(providerPrompt).toContain("Microsoft Word .docx");
    expect(providerPrompt).toContain('set action "word-edit"');
    expect(providerPrompt).toContain("populate wordChangesets");
  });

  it("parses Claude Code structured output", () => {
    expect(
      parseClaudeAgentResponseFromCli(
        JSON.stringify({
          structured_output: {
            action: "patch",
            targetFilePath: "main.tex",
            summary: "Fix",
            afterContents: "ok",
            message: "patched",
            notes: "done"
          }
        })
      )
    ).toEqual({
      action: "patch",
      targetFilePath: "main.tex",
      summary: "Fix",
      afterContents: "ok",
      message: "patched",
      notes: "done"
    });
  });

  it("parses Claude Word changeset structured output", () => {
    expect(
      parseClaudeAgentResponse({
        action: "word-edit",
        targetFilePath: "proposal.docx",
        summary: "Rewrite abstract",
        afterContents: "",
        wordChangesets: [
          {
            filePath: "proposal.docx",
            summary: "Rewrite abstract",
            operations: [
              {
                type: "replace-selection",
                blockId: "w1",
                startOffset: 0,
                endOffset: 3,
                replacementText: "New"
              }
            ]
          }
        ],
        message: "Prepared Word edits.",
        notes: "done"
      })
    ).toEqual({
      action: "word-edit",
      targetFilePath: "proposal.docx",
      summary: "Rewrite abstract",
      afterContents: "",
      wordChangesets: [
        {
          filePath: "proposal.docx",
          summary: "Rewrite abstract",
          operations: [
            {
              type: "replace-selection",
              blockId: "w1",
              startOffset: 0,
              endOffset: 3,
              replacementText: "New"
            }
          ]
        }
      ],
      message: "Prepared Word edits.",
      notes: "done"
    });
  });

  it("parses fenced JSON responses", () => {
    expect(
      parseClaudeAgentResponse(`\`\`\`json
{"action":"answer","targetFilePath":"main.tex","summary":"Answer","afterContents":"ok","message":"done","notes":"done"}
\`\`\``)
    ).toEqual({
      action: "answer",
      targetFilePath: "main.tex",
      summary: "Answer",
      afterContents: "ok",
      message: "done",
      notes: "done"
    });
  });

  it("reports empty Claude Code print results clearly", () => {
    expect(() =>
      parseClaudeAgentResponseFromCli(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 0,
          result: ""
        })
      )
    ).toThrow("Claude Code returned an empty result");
  });
});

function createClaudeAnswer(message: string) {
  return {
    action: "answer" as const,
    targetFilePath: "main.tex",
    summary: "Answer user question",
    afterContents: "\\documentclass{article}\n\\begin{document}\nHello\n",
    message,
    notes: "Answered by fake Claude runner"
  };
}

function createBroker(
  calls: string[] = [],
  options: {
    readonly readFiles?: Readonly<Record<string, string>>;
    readonly searchResults?: Readonly<
      Record<string, readonly { readonly path: string; readonly contents: string }[]>
    >;
  } = {}
): ClaudeCodeToolBroker {
  return {
    readFile: (path) => {
      calls.push(`read-file:${path}`);
      return Promise.resolve({
        path,
        contents:
          options.readFiles?.[path] ??
          "\\documentclass{article}\n\\begin{document}\nHello\n",
        mtimeMs: 1
      });
    },
    searchProject: (query) => {
      calls.push(`search-project:${query}`);
      return Promise.resolve(
        (options.searchResults?.[query] ?? []).map((result) => ({
          path: result.path,
          contents: result.contents,
          mtimeMs: 1
        }))
      );
    },
    proposePatch: (_filePath, _beforeContents, afterContents, summary) => {
      calls.push("propose-patch");
      return Promise.resolve({
        id: "changeset-1",
        projectRoot: "/tmp/project",
        filePath: "main.tex",
        summary,
        patch: afterContents,
        status: "proposed",
        baseSnapshotId: "snapshot-1",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z"
      });
    }
  };
}
