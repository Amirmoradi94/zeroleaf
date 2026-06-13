import { describe, expect, it } from "vitest";

import { ClaudeProvider } from "@latex-agent/provider-anthropic-claude";
import { CodexCliProvider } from "@latex-agent/provider-openai-codex";
import type { AgentEvent, AgentProviderId } from "@latex-agent/ipc-contracts";
import type { ClaudeCodeToolBroker } from "@latex-agent/provider-anthropic-claude";
import type { CodexCliToolBroker } from "@latex-agent/provider-openai-codex";

import {
  MockAgentProvider,
  getAgentToolRisk,
  isAgentToolAllowed,
  type AgentToolBroker
} from "./index.js";

describe("MockAgentProvider", () => {
  it("uses the supplied session id for same-project follow-up turns", async () => {
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "sections/method.tex",
          contents: "\\section{Method}\n",
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "sections/method.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        }),
      applyPatch: () => {
        throw new Error("Follow-up start should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Follow-up start should not compile directly.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        sessionId: "session-project-1",
        prompt: "Follow up after switching files",
        activeFilePath: "sections/method.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.sessionId).toBe("session-project-1");
    expect(
      result.events.every((event) => event.sessionId === "session-project-1")
    ).toBe(true);
  });

  it("explains a build warning in read-only mode without patch or compile tools", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path: "main.tex",
          contents:
            "\\documentclass{article}\n\\begin{document}\nA very long inline expression.\n",
          mtimeMs: 1
        });
      },
      searchProject: () => {
        calls.push("search-project");
        return Promise.resolve([]);
      },
      proposePatch: () => {
        calls.push("propose-patch");
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        calls.push("apply-patch");
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        calls.push("run-compile");
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Explain this warning",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 3,
          message: "Overfull \\hbox (12.0pt too wide) in paragraph at lines 3--4"
        }
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some((event) => event.type === "patch" || event.type === "approval")
    ).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" ||
          (event.type === "tool-call" && event.toolName === "run-compile")
      )
    ).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("No patch, file write, approval, or compile action")
      )
    ).toBe(false);
  });

  it("explains only the selected align block in read-only mode", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const selectedText = [
      "\\begin{align}",
      "a &= b + c \\\\",
      "  &= d",
      "\\end{align}"
    ].join("\n");
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: [
            "Unrelated theorem should not appear in the answer.",
            selectedText,
            "Unrelated proof should not appear in the answer."
          ].join("\n"),
          mtimeMs: 1
        });
      },
      searchProject: () => {
        calls.push("search-project");
        return Promise.resolve([]);
      },
      proposePatch: () => {
        calls.push("propose-patch");
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        calls.push("apply-patch");
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        calls.push("run-compile");
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Explain this selected equation",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText
      },
      broker
    );
    const assistantMessages = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .map((event) => event.content)
      .join("\n");

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(result.events.some((event) => event.type === "patch")).toBe(false);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(assistantMessages).toContain("Selected LaTeX:");
    expect(assistantMessages).toContain("\\begin{align}");
    expect(assistantMessages).toContain("aligned equation block");
    expect(assistantMessages).not.toContain("Unrelated theorem");
    expect(assistantMessages).not.toContain("Unrelated proof");
  });

  it("blocks prompts that request writes outside the active project root", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: "\\documentclass{article}\n\\begin{document}\nHello\n",
          mtimeMs: 1
        });
      },
      searchProject: () => {
        calls.push("search-project");
        return Promise.resolve([]);
      },
      proposePatch: () => {
        calls.push("propose-patch");
        throw new Error("Blocked outside-root request must not propose patches.");
      },
      applyPatch: () => {
        calls.push("apply-patch");
        throw new Error("Blocked outside-root request must not apply patches.");
      },
      runCompile: () => {
        calls.push("run-compile");
        throw new Error("Blocked outside-root request must not compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Create /tmp/notes.txt with a summary of this manuscript.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(result.changeset).toBeUndefined();
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("/tmp/notes.txt is outside the active project root")
      )
    ).toBe(true);
  });

  it("requests approval before any network fetch prompt and offers local-only fallback on denial", async () => {
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: "\\documentclass{article}\n\\begin{document}\nHello\n",
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: () => {
        throw new Error("Network approval prompt should not propose patches.");
      },
      applyPatch: () => {
        throw new Error("Network approval prompt should not apply patches.");
      },
      runCompile: () => {
        throw new Error("Network approval prompt should not compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fetch DOI metadata for 10.1000/example and insert the BibTeX entry.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(
      result.events.some(
        (event) =>
          event.type === "approval" &&
          event.toolName === "network-fetch" &&
          event.status === "requested"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "If you deny it, I will continue with a local-only alternative"
          )
      )
    ).toBe(true);
  });

  it("runs a bounded autonomous local repair loop until compile succeeds", async () => {
    const provider = new MockAgentProvider();
    let currentContents = "\\documentclass{article}\n\\begin{document}\nHello\n";
    let compileRuns = 0;
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: currentContents,
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: `changeset-${compileRuns + 1}`,
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: `snapshot-${compileRuns + 1}`,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        }),
      applyPatch: (changesetId) => {
        currentContents = currentContents.includes("\\end{document}")
          ? currentContents
          : `${currentContents}\\end{document}\n`;
        return Promise.resolve({
          id: changesetId,
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary: "Apply missing document end fix",
          patch: currentContents,
          status: "applied",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:01.000Z"
        });
      },
      runCompile: () => {
        compileRuns += 1;
        return Promise.resolve({
          jobId: `job-${compileRuns}`,
          status: compileRuns === 1 ? "succeeded" : "failed",
          compiler: "pdflatex",
          command: ["latexmk"],
          securityPolicy: {
            shellEscape: {
              enabled: false,
              commandFlag: "-no-shell-escape",
              approvalRequiredToEnable: true,
              agentMayEnable: false,
              message: "disabled"
            }
          },
          startedAt: "2026-06-10T00:00:00.000Z",
          finishedAt: "2026-06-10T00:00:01.000Z",
          durationMs: 1000,
          diagnostics: [],
          rawLog: "",
          stdout: "",
          stderr: "",
          artifact: {
            pdfPath: "/tmp/project/main.pdf",
            updatedAt: "2026-06-10T00:00:01.000Z",
            byteLength: 42
          }
        });
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Repair the local compile error autonomously.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        maxTurns: 2
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(currentContents).toContain("\\end{document}");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("Autonomous repair completed successfully in 1 turn")
      )
    ).toBe(true);
  });

  it("stops autonomous local repair at the configured turn limit", async () => {
    const provider = new MockAgentProvider();
    let currentContents = "\\documentclass{article}\n\\begin{document}\nHello\n";
    let compileRuns = 0;
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: currentContents,
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: `changeset-${compileRuns + 1}`,
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: `snapshot-${compileRuns + 1}`,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        }),
      applyPatch: (changesetId) => {
        currentContents = currentContents.includes("\\end{document}")
          ? currentContents.replace("Hello", "Hello\n\\undefinedcommand")
          : `${currentContents}\\end{document}\n`;
        return Promise.resolve({
          id: changesetId,
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary: "Apply autonomous repair",
          patch: currentContents,
          status: "applied",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:01.000Z"
        });
      },
      runCompile: () => {
        compileRuns += 1;
        return Promise.resolve({
          jobId: `job-${compileRuns}`,
          status: "failed",
          compiler: "pdflatex",
          command: ["latexmk"],
          securityPolicy: {
            shellEscape: {
              enabled: false,
              commandFlag: "-no-shell-escape",
              approvalRequiredToEnable: true,
              agentMayEnable: false,
              message: "disabled"
            }
          },
          startedAt: "2026-06-10T00:00:00.000Z",
          finishedAt: "2026-06-10T00:00:01.000Z",
          durationMs: 1000,
          diagnostics: [
            {
              severity: "error",
              filePath: "main.tex",
              line: 4,
              message: "Undefined control sequence"
            }
          ],
          rawLog: "Undefined control sequence",
          stdout: "",
          stderr: ""
        });
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Repair the local compile error autonomously.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        maxTurns: 1
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.buildResult?.status).toBe("failed");
    expect(compileRuns).toBe(1);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "stopped after reaching the configured limit of 1 turn"
          )
      )
    ).toBe(true);
  });

  it("cancels autonomous local repair between turns without leaving a partial second write", async () => {
    const provider = new MockAgentProvider();
    let currentContents = "\\documentclass{article}\n\\begin{document}\nHello\n";
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: currentContents,
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        }),
      applyPatch: (changesetId) => {
        currentContents = `${currentContents}\\end{document}\n`;
        return Promise.resolve({
          id: changesetId,
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary: "Apply missing document end fix",
          patch: currentContents,
          status: "applied",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:01.000Z"
        });
      },
      runCompile: async () => {
        await provider.cancelSession("session-cancel");
        return {
          jobId: "job-1",
          status: "failed",
          compiler: "pdflatex",
          command: ["latexmk"],
          securityPolicy: {
            shellEscape: {
              enabled: false,
              commandFlag: "-no-shell-escape",
              approvalRequiredToEnable: true,
              agentMayEnable: false,
              message: "disabled"
            }
          },
          startedAt: "2026-06-10T00:00:00.000Z",
          finishedAt: "2026-06-10T00:00:01.000Z",
          durationMs: 1000,
          diagnostics: [
            {
              severity: "error",
              filePath: "main.tex",
              line: 4,
              message: "Undefined control sequence"
            }
          ],
          rawLog: "Undefined control sequence",
          stdout: "",
          stderr: ""
        };
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        sessionId: "session-cancel",
        prompt: "Repair the local compile error autonomously.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        maxTurns: 3
      },
      broker
    );

    expect(result.status).toBe("cancelled");
    expect(currentContents.match(/\\end\{document\}/gu)).toHaveLength(1);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("cancelled before the next turn started")
      )
    ).toBe(true);
  });

  it("summarizes a thesis project in read-only mode from scoped chapter files", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents:
            path === "main.tex"
              ? [
                  "\\documentclass{report}",
                  "\\begin{document}",
                  "\\chapter{Introduction}",
                  "We demonstrate that local-first editing improves review.",
                  "\\input{chapters/method}",
                  "\\input{chapters/conclusion}",
                  "\\end{document}",
                  ""
                ].join("\n")
              : path === "chapters/method.tex"
                ? "\\chapter{Method}\nOur contributions are a scoped agent workflow."
                : "\\chapter{Conclusion}\nThis thesis argues for reviewable patches.",
          mtimeMs: 1
        });
      },
      searchProject: () => {
        calls.push("search-project");
        return Promise.resolve([]);
      },
      proposePatch: () => {
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Summarize this thesis project structure, main claims, missing sections, and build health.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );
    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "read-file:main.tex",
      "read-file:chapters/method.tex",
      "read-file:chapters/conclusion.tex"
    ]);
    expect(assistantMessage).toContain("Structure:");
    expect(assistantMessage).toContain("Main claims:");
    expect(assistantMessage).toContain("Missing sections:");
    expect(assistantMessage).toContain("Build health:");
  });

  it("finds TODO and placeholder markers across project files in read-only mode", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: "\\section{Intro}\nBody text.\n",
          mtimeMs: 1
        });
      },
      searchProject: (query) => {
        calls.push(`search-project:${query}`);
        return Promise.resolve(
          query === "TODO"
            ? [
                {
                  path: "chapters/introduction.tex",
                  contents: "Line one\n% TODO: add motivation cite\n",
                  mtimeMs: 1
                }
              ]
            : query === "citation needed"
              ? [
                  {
                    path: "chapters/related.tex",
                    contents: "Prior work discussion. citation needed\n",
                    mtimeMs: 1
                  }
                ]
              : []
        );
      },
      proposePatch: () => {
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Find TODOs and citation needed markers in this draft.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );
    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(calls).toContain("search-project:TODO");
    expect(calls).toContain("search-project:citation needed");
    expect(assistantMessage).toContain("chapters/introduction.tex:2 [TODO]");
    expect(assistantMessage).toContain("chapters/related.tex:1 [citation needed]");
  });

  it("explains figure numbering mismatch from label placement in read-only mode", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{figure}[ht]",
            "\\label{fig:overview}",
            "\\caption{Overview}",
            "\\includegraphics{figures/overview.png}",
            "\\end{figure}",
            "\\begin{figure}[ht]",
            "\\caption{Results}",
            "\\label{fig:results}",
            "\\includegraphics{figures/results.png}",
            "\\end{figure}",
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        });
      },
      searchProject: (query) => {
        calls.push(`search-project:${query}`);
        return Promise.resolve([]);
      },
      proposePatch: () => {
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Explain why Figure 3 is referenced before Figure 2.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );
    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(assistantMessage).toContain("Source order:");
    expect(assistantMessage).toContain("Label placement issue:");
    expect(assistantMessage).toContain("\\label before \\caption");
    expect(assistantMessage).toContain("previous figure number");
  });

  it("produces a prioritized final formatting review checklist in read-only mode", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: [
            "\\documentclass{article}",
            "\\usepackage{graphicx}",
            "\\begin{document}",
            "\\begin{figure}[ht]",
            "\\includegraphics{figures/missing.png}",
            "\\caption{System overview}",
            "\\end{figure}",
            "\\begin{table}[ht]",
            "\\centering",
            "\\begin{tabular}{lrrrrrr}",
            "A & 1 & 2 & 3 & 4 & 5 & 6 \\\\",
            "\\end{tabular}",
            "\\end{table}",
            "% TODO: verify final appendix order",
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        });
      },
      searchProject: (query) => {
        calls.push(`search-project:${query}`);
        return Promise.resolve([]);
      },
      proposePatch: () => {
        throw new Error("Read-only mode must not propose patches.");
      },
      applyPatch: () => {
        throw new Error("Read-only mode must not apply patches.");
      },
      runCompile: () => {
        throw new Error("Read-only mode must not run compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Final PDF formatting review before submission.",
          "- warning: Generated build artifact is present in the source tree. (.latex-agent/build/main.log)",
          "- info: No submission issues found in the local bundle check."
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );
    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex", "search-project:figures/missing.png"]);
    expect(assistantMessage).toContain("Evidence basis:");
    expect(assistantMessage).toContain("Priority 1 blockers:");
    expect(assistantMessage).toContain(
      "Missing local figure asset referenced by source"
    );
    expect(assistantMessage).toContain("Priority 2 warnings:");
    expect(assistantMessage).toContain("Wide table may need width review");
    expect(assistantMessage).toContain("Priority 3 polish:");
    expect(assistantMessage).toContain("review checklist only");
  });

  it("proposes a multi-file split for a monolithic main.tex", async () => {
    const provider = new MockAgentProvider();
    const proposed: { filePath: string; afterContents: string; summary: string }[] = [];
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\section{Introduction}",
            "Intro text with \\label{sec:intro}.",
            "\\section{Method}",
            "Method text that references \\ref{sec:intro}.",
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (filePath, _beforeContents, afterContents, summary) => {
        proposed.push({ filePath, afterContents, summary });
        return Promise.resolve({
          id: `changeset-${proposed.length}`,
          projectRoot: "/tmp/project",
          filePath,
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: `snapshot-${proposed.length}`,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        });
      },
      applyPatch: () => {
        throw new Error("Split proposal test should not apply patches.");
      },
      runCompile: () => {
        throw new Error("Split proposal test should not compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Split this monolithic main.tex into separate files and propose the input structure.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changesets?.length).toBe(3);
    expect(proposed[0]?.filePath).toBe("main.tex");
    expect(proposed[0]?.afterContents).toContain("\\input{introduction}");
    expect(proposed[0]?.afterContents).toContain("\\input{method}");
    expect(proposed.some((item) => item.filePath === "introduction.tex")).toBe(true);
    expect(proposed.some((item) => item.filePath === "method.tex")).toBe(true);
    expect(
      proposed.find((item) => item.filePath === "method.tex")?.afterContents
    ).toContain("\\ref{sec:intro}");
  });

  it("proposes a safe rename plan that updates \\input references", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const proposed: { filePath: string; afterContents: string }[] = [];
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: "\\input{old_method}\n",
          mtimeMs: 1
        }),
      searchProject: (query) => {
        calls.push(`search-project:${query}`);
        return Promise.resolve([
          {
            path: "old_method.tex",
            contents: "\\section{Method}\n\\label{sec:method}\n",
            mtimeMs: 1
          },
          {
            path: "main.tex",
            contents: "\\input{old_method}\n",
            mtimeMs: 1
          }
        ]);
      },
      moveEntry: (fromPath, toPath) => Promise.resolve({ fromPath, toPath }),
      proposePatch: (filePath, _beforeContents, afterContents, summary) => {
        proposed.push({ filePath, afterContents });
        return Promise.resolve({
          id: `changeset-${proposed.length}`,
          projectRoot: "/tmp/project",
          filePath,
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: `snapshot-${proposed.length}`,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z"
        });
      },
      applyPatch: () => {
        throw new Error("Rename proposal test should not apply patches.");
      },
      runCompile: () => {
        throw new Error("Rename proposal test should not compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Rename old_method.tex to method.tex and update references.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(calls).toContain("search-project:old_method");
    expect(result.moveEntries).toEqual([
      { fromPath: "old_method.tex", toPath: "method.tex" }
    ]);
    expect(proposed[0]?.filePath).toBe("main.tex");
    expect(proposed[0]?.afterContents).toContain("\\input{method}");
  });

  it("proposes a reviewable changeset for a compile-fix task", async () => {
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: "\\documentclass{article}\n\\begin{document}\nHello\n",
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z"
        }),
      applyPatch: () => {
        throw new Error("Mock provider should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Mock provider should not compile before review.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.status).toBe("proposed");
    expect(result.events.some((event) => event.type === "approval")).toBe(true);
    expect(result.changeset?.patch).toContain("\\end{document}");
  });

  it("repairs a likely citation-key typo using only local bibliography entries", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "Foundational guidance appears in \\citep{lamprt1994}.",
        "\\bibliography{references}",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Fix the missing citation key lamprt1994.",
          "Use only the local bibliography context below.",
          "If a likely local reference exists, replace the missing key with that key.",
          "",
          "Local bibliography entries:",
          "lamport1994 | title=LaTeX: A Document Preparation System | author=Lamport, Leslie | year=1994",
          "knuth1984 | title=The TeXbook | author=Knuth, Donald | year=1984"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Repair missing citation key in main.tex");
    expect(broker.proposedAfterContents).toContain("\\citep{lamport1994}");
    expect(broker.proposedAfterContents).not.toContain("lamprt1994");
  });

  it("asks for confirmation when multiple bibliography keys are similarly close", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: "See \\cite{lamprt1994}.\n"
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Fix the missing citation key lamprt1994.",
          "Use only the local bibliography context below.",
          "",
          "Local bibliography entries:",
          "lamport1994 | title=LaTeX: A Document Preparation System | author=Lamport, Leslie | year=1994",
          "lamperti1994 | title=Local Approximation Methods | author=Lamperti, John | year=1994"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(broker.proposedAfterContents).toBe("");
    expect(assistantMessage).toContain("multiple similar local keys");
    expect(assistantMessage).toContain("lamport1994");
    expect(assistantMessage).toContain("lamperti1994");
  });

  it("asks for source details when no likely local bibliography match exists", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: "See \\cite{unknown2026}.\n"
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Fix the missing citation key unknown2026.",
          "Use only the local bibliography context below.",
          "",
          "Local bibliography entries:",
          "lamport1994 | title=LaTeX: A Document Preparation System | author=Lamport, Leslie | year=1994",
          "knuth1984 | title=The TeXbook | author=Knuth, Donald | year=1984"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(broker.proposedAfterContents).toBe("");
    expect(assistantMessage).toContain("provide source details");
  });

  it("cleans a malformed BibTeX entry while preserving DOI and URL fields", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      filePath: "references.bib",
      contents: [
        "@article{smith2024,",
        "title={a study of LATEX workflows},",
        "author={ada smith and BYRON LEE},",
        "doi={ 10.1000/example },",
        "url={ https://example.com/paper },",
        "year={2024}",
        "}"
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Clean this malformed BibTeX entry without dropping important fields.",
        activeFilePath: "references.bib",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain(
      "title = {A Study Of {LATEX} Workflows}"
    );
    expect(broker.proposedAfterContents).toContain(
      "author = {Ada Smith and Byron Lee}"
    );
    expect(broker.proposedAfterContents).toContain("doi = {10.1000/example}");
    expect(broker.proposedAfterContents).toContain("url = {https://example.com/paper}");
  });

  it("adapts unsupported citation commands to natbib-compatible forms", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage{natbib}",
        "\\begin{document}",
        "As \\textcite{lamport1994} explains, prior work exists.",
        "Later discussion uses \\parencite{knuth1984}.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Adapt citation commands to natbib style.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\citet{lamport1994}");
    expect(broker.proposedAfterContents).toContain("\\citep{knuth1984}");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" && event.content.includes("natbib is present")
      )
    ).toBe(true);
  });

  it("does not rewrite citation commands blindly when natbib is absent", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "As \\textcite{lamport1994} explains, prior work exists.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Adapt citation commands to natbib style.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" && event.content.includes("did not find natbib")
      )
    ).toBe(true);
  });

  it("explains whether an attached unused reference still fits the manuscript", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents:
        "This related work section discusses robust local editing workflows and reviewable patches."
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Use only the attached bibliography entry below.",
          "Suggest where this source fits in the active LaTeX file, preferably in related work if that context is present.",
          "Use the citation command \\cite{unused2026} unless the project style clearly requires a local variant.",
          "Do not invent or mention unavailable bibliography keys; the only attached key is unused2026.",
          "",
          "Attached bibliography entry:",
          "title=Robust Local Editing",
          "author=Smith, Ada",
          "year=2026"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    const assistantMessage = result.events
      .filter(
        (event): event is Extract<AgentEvent, { readonly type: "message" }> =>
          event.type === "message" && event.role === "assistant"
      )
      .at(-1)?.content;

    expect(result.status).toBe("completed");
    expect(assistantMessage).toContain("Unused-reference review for unused2026");
    expect(assistantMessage).toContain("related work");
  });

  it("identifies a missing document terminator in the patch summary", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: "\\documentclass{article}\n\\begin{document}\nHello\n"
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the top compile error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 2,
          message:
            "Missing \\end{document}; TeX reached the end of the main file without a legal \\end."
        }
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add missing \\end{document} to main.tex");
    expect(broker.proposedAfterContents).toContain("\\end{document}");
  });

  it("repairs a deterministic undefined command only when that error is surfaced", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "The hidden error is \\undefinedcommand.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the undefined control sequence",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 3,
          message: "Undefined control sequence."
        }
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe(
      "Remove undefined control sequence in main.tex"
    );
    expect(broker.proposedAfterContents).toContain(
      "The hidden error is undefinedcommand."
    );
    expect(broker.proposedAfterContents).not.toContain("\\undefinedcommand");
  });

  it("explains a missing local style file without proposing a patch", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker: AgentToolBroker = {
      readFile: (path) => {
        calls.push(`read-file:${path}`);
        return Promise.resolve({
          path,
          contents: [
            "\\documentclass{article}",
            "\\usepackage{customstyle}",
            "\\begin{document}",
            "Body.",
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        });
      },
      searchProject: (query) => {
        calls.push(`search-project:${query}`);
        return Promise.resolve([]);
      },
      proposePatch: () => {
        calls.push("propose-patch");
        throw new Error("Missing local package should not propose a patch.");
      },
      applyPatch: () => {
        calls.push("apply-patch");
        throw new Error("Missing local package should not apply a patch.");
      },
      runCompile: () => {
        calls.push("run-compile");
        throw new Error("Missing local package should not compile.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 2,
          message: "LaTeX Error: File `customstyle.sty' not found."
        }
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:main.tex", "search-project:customstyle.sty"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("customstyle.sty") &&
          event.content.includes("will not fetch files from the network")
      )
    ).toBe(true);
  });

  it("can propose separated syntax and prose hunks for hunk-level review", async () => {
    const provider = new MockAgentProvider();
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            "This prose should stay original.",
            "Filler one.",
            "Filler two.",
            "Filler three.",
            "Filler four.",
            "\\section{Results}",
            "Syntax fix belongs below.",
            ""
          ].join("\n"),
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) =>
        Promise.resolve({
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z"
        }),
      applyPatch: () => {
        throw new Error("Mock provider should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Mock provider should not compile before review.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix syntax and prose",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.changeset?.patch).toContain("This prose was rewritten by the agent.");
    expect(result.changeset?.patch).toContain("\\end{document}");
  });

  it("improves only selected prose while preserving LaTeX commands and citations", async () => {
    const provider = new MockAgentProvider();
    const selectedText =
      "This is a bit rough, but we show that our method works well in \\autoref{sec:method} and follows \\citep{smith2024}.";
    const unrelatedParagraph =
      "This unrelated paragraph with \\label{sec:method} must remain exactly the same.";
    let proposedAfterContents = "";
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            unrelatedParagraph,
            selectedText,
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) => {
        proposedAfterContents = afterContents;
        return Promise.resolve({
          id: "changeset-1",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        });
      },
      applyPatch: () => {
        throw new Error("Mock provider should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Mock provider should not compile before review.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Improve academic tone of the selected paragraph",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Mock rewrite for selection in main.tex");
    expect(proposedAfterContents).toContain(unrelatedParagraph);
    expect(proposedAfterContents).not.toContain(selectedText);
    expect(proposedAfterContents).toContain("preliminary");
    expect(proposedAfterContents).toContain("we demonstrate that");
    expect(proposedAfterContents).toContain("performs effectively");
    expect(proposedAfterContents).toContain("\\autoref{sec:method}");
    expect(proposedAfterContents).toContain("\\citep{smith2024}");
    expect(proposedAfterContents).not.toContain("\\citep{invented2026}");
    expect(proposedAfterContents).not.toContain("previously unreported");
    expect(
      result.events.some(
        (event) =>
          event.type === "approval" &&
          event.prompt ===
            "Review the proposed patch before applying it to the project."
      )
    ).toBe(true);
  });

  it("shortens a selected abstract while preserving environment and contribution statements", async () => {
    const provider = new MockAgentProvider();
    const selectedText = [
      "\\begin{abstract}",
      "This paper studies local-first LaTeX editing workflows for researchers who need reliable compilation, reviewable changes, and predictable source control during collaborative writing. The prototype combines project navigation, PDF feedback, and constrained agent assistance so authors can inspect errors and improve drafts without sending the entire project to an unrestricted tool. Related systems motivate the workflow \\citep{doe2025}. We evaluate the approach with representative thesis-like projects, citation-heavy manuscripts, and broken builds that expose common editing failures. Our contributions are a scoped agent workflow, a review-first patch model, and compile verification after approved changes. The remaining discussion describes future work, optional integrations, deployment notes, interface alternatives, and additional implementation details that are not required for the core claim.",
      "\\end{abstract}"
    ].join("\n");
    let proposedAfterContents = "";
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            selectedText,
            "\\section{Introduction}",
            "Unrelated body text must remain.",
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) => {
        proposedAfterContents = afterContents;
        return Promise.resolve({
          id: "changeset-abstract",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        });
      },
      applyPatch: () => {
        throw new Error("Mock provider should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Mock provider should not compile before review.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Shorten the selected abstract to 150 words",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText
      },
      broker
    );
    const revisedAbstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/u.exec(
      proposedAfterContents
    )?.[1];

    expect(result.status).toBe("awaiting-approval");
    expect(proposedAfterContents).toContain("\\begin{abstract}");
    expect(proposedAfterContents).toContain("\\end{abstract}");
    expect(proposedAfterContents).toContain("\\citep{doe2025}");
    expect(proposedAfterContents).toContain("Our contributions are");
    expect(proposedAfterContents).toContain("Unrelated body text must remain.");
    expect(proposedAfterContents).not.toContain("optional integrations");
    expect(countWords(revisedAbstract ?? "")).toBeLessThanOrEqual(150);
  });

  it("keeps required contribution statements when earlier abstract context exceeds the word budget", async () => {
    const provider = new MockAgentProvider();
    const longOpening = [
      "This paper studies local-first LaTeX editing workflows for researchers, instructors, students, and laboratory teams who need reliable compilation, reviewable changes, reproducible source control, local privacy boundaries, careful file handling, and predictable editing support during long scholarly writing projects.",
      "The prototype combines project navigation, PDF feedback, constrained agent assistance, structured histories, reference checks, diagnostics, and submission preparation so authors can inspect errors, revise drafts, and continue writing without granting an unrestricted external tool access to every project on the machine.",
      "Related systems motivate the workflow \\citep{doe2025}.",
      "Our contributions are a scoped agent workflow, a review-first patch model, and compile verification after approved changes.",
      "Additional background material describes onboarding examples, annotation details, configuration choices, interface alternatives, and classroom deployment notes that are useful for planning but unnecessary for the concise abstract.",
      "A longer discussion also compares packaging options, offline usage patterns, writing-center feedback, student revision habits, and examples from multi-file manuscripts with figures and bibliographies.",
      "The remaining discussion describes optional integrations, deployment notes, interface alternatives, and additional implementation details."
    ].join(" ");
    const selectedText = `\\begin{abstract}\n${longOpening}\n\\end{abstract}`;
    let proposedAfterContents = "";
    const broker: AgentToolBroker = {
      readFile: () =>
        Promise.resolve({
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            selectedText,
            "\\end{document}",
            ""
          ].join("\n"),
          mtimeMs: 1
        }),
      searchProject: () => Promise.resolve([]),
      proposePatch: (_filePath, _beforeContents, afterContents, summary) => {
        proposedAfterContents = afterContents;
        return Promise.resolve({
          id: "changeset-long-abstract",
          projectRoot: "/tmp/project",
          filePath: "main.tex",
          summary,
          patch: afterContents,
          status: "proposed",
          baseSnapshotId: "snapshot-1",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z"
        });
      },
      applyPatch: () => {
        throw new Error("Mock provider should not apply patches directly.");
      },
      runCompile: () => {
        throw new Error("Mock provider should not compile before review.");
      }
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Shorten the selected abstract to 150 words",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText
      },
      broker
    );
    const revisedAbstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/u.exec(
      proposedAfterContents
    )?.[1];

    expect(countWords(longOpening)).toBeGreaterThan(150);
    expect(result.status).toBe("awaiting-approval");
    expect(revisedAbstract).toContain("Our contributions are");
    expect(revisedAbstract).toContain("\\citep{doe2025}");
    expect(revisedAbstract).not.toContain("optional integrations");
    expect(countWords(revisedAbstract ?? "")).toBeLessThanOrEqual(150);
  });

  it("expands selected rough notes into prose while preserving user TODOs", async () => {
    const provider = new MockAgentProvider();
    const selectedText = [
      "- recruited 24 participants from writing lab",
      "- compared draft time & compile recovery",
      "- observed 12% fewer unresolved errors",
      "- TODO: confirm participant exclusion criteria"
    ].join("\n");
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Method}",
        selectedText,
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Expand the selected rough notes into polished method prose",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain(
      "TODO: confirm participant exclusion criteria"
    );
    expect(broker.proposedAfterContents).toContain(
      "recruited 24 participants from writing lab."
    );
    expect(broker.proposedAfterContents).toContain("draft time \\& compile recovery");
    expect(broker.proposedAfterContents).toContain("12\\% fewer unresolved errors");
    expect(broker.proposedAfterContents).not.toContain("- recruited");
  });

  it("normalizes terminology in prose without changing citations or labels", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Dataset}",
        "\\label{sec:corpus}",
        "The dataset includes a small data set from the camera corpus.",
        "We compare the corpus with prior work \\citep{corpus2024}.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Run a consistency audit and normalize terminology for dataset, data set, and corpus.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\label{sec:corpus}");
    expect(broker.proposedAfterContents).toContain("\\citep{corpus2024}");
    expect(broker.proposedAfterContents).toContain(
      "The dataset includes a small dataset from the camera dataset."
    );
    expect(broker.proposedAfterContents).toContain(
      "We compare the dataset with prior work"
    );
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes('Domain-specific terms for confirmation: "corpus"')
      )
    ).toBe(true);
  });

  it("drafts title and keywords as suggestions without applying source edits", async () => {
    const provider = new MockAgentProvider();
    const originalContents = [
      "\\documentclass{article}",
      "\\title{A Weak Title}",
      "\\begin{document}",
      "This paper studies local-first LaTeX editing with reviewable agent patches and compile verification for scholarly workflows.",
      "\\end{document}",
      ""
    ].join("\n");
    const broker = createMockBroker({ contents: originalContents });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Summarize the paper and propose a stronger title and keywords.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "Suggested title: Reviewable Agent Assistance for Local-First LaTeX Editing"
          ) &&
          event.content.includes("Suggested keywords:") &&
          event.content.includes("Basis:") &&
          event.content.includes("No source edits were applied")
      )
    ).toBe(true);
  });

  it("applies an explicit title and keywords patch only when requested", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\title{A Weak Title}",
        "\\begin{document}",
        "This paper studies local-first LaTeX editing with reviewable agent patches and compile verification.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Apply a title and keywords patch based on the manuscript.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain(
      "\\title{Reviewable Agent Assistance for Local-First LaTeX Editing}"
    );
    expect(broker.proposedAfterContents).toContain("% Keywords:");
  });

  it("repairs unbalanced caption braces without rewriting the caption", async () => {
    const provider = new MockAgentProvider();
    const brokenCaption = "\\caption{Accuracy for \\textbf{best run}";
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{figure}",
        brokenCaption,
        "\\label{fig:accuracy}",
        "\\end{figure}",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the unbalanced brace in the caption only.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 4,
          message: "Runaway argument in \\caption"
        }
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain(
      "\\caption{Accuracy for \\textbf{best run}}"
    );
    expect(broker.proposedAfterContents).toContain("\\label{fig:accuracy}");
    expect(broker.proposedAfterContents).not.toContain("This prose was rewritten");
  });

  it("generates a LaTeX table from pasted CSV rows and warns about wide layouts", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage{booktabs}",
        "\\begin{document}",
        "Results go here.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Generate a LaTeX table from this pasted data.",
          "caption: Ablation results",
          "label: tab:ablation",
          "Model,Accuracy,F1,Latency,Memory,Params,Notes",
          "Baseline,0.81,0.78,42,512,10M,fast",
          "Full,0.89,0.86,55,640,12M,best"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\begin{table}[ht]");
    expect(broker.proposedAfterContents).toContain("\\caption{Ablation results}");
    expect(broker.proposedAfterContents).toContain("\\label{tab:ablation}");
    expect(broker.proposedAfterContents).toContain("\\toprule");
    expect(broker.proposedAfterContents).toContain(
      "Model & Accuracy & F1 & Latency & Memory & Params & Notes \\\\"
    );
    expect(broker.proposedAfterContents).toContain(
      "Baseline & 0.81 & 0.78 & 42 & 512 & 10M & fast \\\\"
    );
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("Table layout advice") &&
          event.content.includes("7 columns")
      )
    ).toBe(true);
  });

  it("fixes an overfull hbox caused by a long URL with a reviewable xurl patch", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage{hyperref}",
        "\\begin{document}",
        "\\url{https://example.com/really/long/path/with/many/segments/that/should/break/across/lines/in/the/final/pdf/output}",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix this overfull hbox warning without hiding warnings globally.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 4,
          message: "Overfull \\hbox (18.0pt too wide) in paragraph at lines 4--4"
        }
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\usepackage{xurl}");
    expect(broker.proposedAfterContents).toContain(
      "\\url{https://example.com/really/long/path"
    );
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "line-breaking package instead of suppressing box warnings globally"
          )
      )
    ).toBe(true);
  });

  it("stops on overfull hbox warnings when no deterministic safe patch is found", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "This paragraph is slightly awkward but does not contain a long URL or table.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix this overfull hbox warning.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 3,
          message: "Overfull \\hbox (4.2pt too wide) in paragraph at lines 3--3"
        }
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes(
            "Please confirm whether the problem is a URL, inline math, or table layout"
          )
      )
    ).toBe(true);
  });

  it("improves an existing wide table layout without changing numeric values", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{table}[ht]",
        "\\centering",
        "\\caption{Wide results}",
        "\\label{tab:wide-results}",
        "\\begin{tabular}{lrrrrrr}",
        "\\hline",
        "Model & Accuracy & F1 & Latency & Memory & Params & Notes \\\\",
        "\\hline",
        "Baseline & 0.81 & 0.78 & 42 & 512 & 10M & fast \\\\",
        "Full & 0.89 & 0.86 & 55 & 640 & 12M & best \\\\",
        "\\hline",
        "\\end{tabular}",
        "\\end{table}",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Improve table layout so it fits page width without changing numeric values.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\usepackage{graphicx}");
    expect(broker.proposedAfterContents).toContain("\\resizebox{\\linewidth}{!}{%");
    expect(broker.proposedAfterContents).toContain("\\begin{tabular}{lrrrrrr}");
    expect(broker.proposedAfterContents).toContain(
      "Baseline & 0.81 & 0.78 & 42 & 512 & 10M & fast \\\\"
    );
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("preserve the current numeric values")
      )
    ).toBe(true);
  });

  it("repairs a missing figure path when a single local asset candidate exists", async () => {
    const provider = new MockAgentProvider();
    const calls: string[] = [];
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\includegraphics[width=0.6\\linewidth]{figures/model.png}",
        "\\end{document}",
        ""
      ].join("\n")
    }) as AgentToolBroker & {
      proposedAfterContents: string;
      searchProject: AgentToolBroker["searchProject"];
    };
    broker.searchProject = (query) => {
      calls.push(`search-project:${query}`);
      return Promise.resolve(
        query === "figures/model.png"
          ? []
          : query === "model"
            ? [{ path: "assets/model.png", contents: "", mtimeMs: 1 }]
            : []
      );
    };

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the missing figure in the PDF for figures/model.png.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(calls).toContain("search-project:figures/model.png");
    expect(calls).toContain("search-project:model");
    expect(broker.proposedAfterContents).toContain(
      "\\includegraphics[width=0.6\\linewidth]{assets/model.png}"
    );
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("single local candidate at assets/model.png")
      )
    ).toBe(true);
  });

  it("does not rewrite a missing figure path when no deterministic local candidate exists", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\includegraphics{figures/model.png}",
        "\\end{document}",
        ""
      ].join("\n")
    }) as AgentToolBroker & {
      proposedAfterContents: string;
      searchProject: AgentToolBroker["searchProject"];
    };
    broker.searchProject = () => Promise.resolve([]);

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the missing figure in the PDF for figures/model.png.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("I will not invent or fetch an image path")
      )
    ).toBe(true);
  });

  it("inserts a figure environment only after finding the requested project asset", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "The accuracy trend is summarized below.",
        "\\end{document}",
        ""
      ].join("\n"),
      searchResults: [{ path: "figures/accuracy.pdf", contents: "", mtimeMs: 1 }]
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Insert a figure environment after this paragraph.",
          "file: figures/accuracy.pdf",
          "caption: Accuracy by epoch",
          "label: fig:accuracy"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\usepackage{graphicx}");
    expect(broker.proposedAfterContents).toContain("\\begin{figure}[ht]");
    expect(broker.proposedAfterContents).toContain(
      "\\includegraphics[width=0.8\\linewidth]{figures/accuracy.pdf}"
    );
    expect(broker.proposedAfterContents).toContain("\\caption{Accuracy by epoch}");
    expect(broker.proposedAfterContents).toContain("\\label{fig:accuracy}");
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "search-project"
      )
    ).toBe(true);
  });

  it("does not propose a figure patch when the requested asset is missing", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "The accuracy trend is summarized below.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: [
          "Insert a figure environment after this paragraph.",
          "file: figures/missing.pdf",
          "caption: Missing figure",
          "label: fig:missing"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("I could not find figures/missing.pdf")
      )
    ).toBe(true);
  });

  it("converts a plain-language loss request into a labelled display equation", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Model}",
        "The objective is defined below.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Create a display equation for mean squared error loss and label: eq:mse-loss",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain("\\begin{equation}");
    expect(broker.proposedAfterContents).toContain("\\label{eq:mse-loss}");
    expect(broker.proposedAfterContents).toContain(
      "\\mathcal{L} = \\frac{1}{N} \\sum_{i=1}^{N}"
    );
    expect(broker.proposedAfterContents).toContain("\\end{equation}");
  });

  it("asks for confirmation instead of patching ambiguous equation notation", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: "\\documentclass{article}\n\\begin{document}\nModel.\n\\end{document}\n"
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Create an equation for the loss with the ambiguous terms from notes.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(broker.proposedAfterContents).toBe("");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("equation notation is ambiguous")
      )
    ).toBe(true);
  });

  it("cleans duplicate package declarations while flagging risky preamble changes for review", async () => {
    const provider = new MockAgentProvider();
    const broker = createMockBroker({
      contents: [
        "\\documentclass{article}",
        "\\usepackage[dvipsnames]{xcolor}",
        "\\usepackage[table]{xcolor}",
        "\\usepackage{hyperref}",
        "\\usepackage{hyperref}",
        "\\begin{document}",
        "Body.",
        "\\end{document}",
        ""
      ].join("\n")
    });

    const result = await provider.startSession(
      {
        providerId: "mock",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Clean up the preamble by removing duplicate packages.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      broker
    );

    expect(result.status).toBe("awaiting-approval");
    expect(broker.proposedAfterContents).toContain(
      "\\usepackage[dvipsnames,table]{xcolor}"
    );
    expect(
      broker.proposedAfterContents.match(/\\usepackage(?:\[[^\]]*\])?\{xcolor\}/gu)
    ).toHaveLength(1);
    expect(
      broker.proposedAfterContents.match(/\\usepackage\{hyperref\}/gu)
    ).toHaveLength(1);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("Risky package changes require review")
      )
    ).toBe(true);
  });

  it("enforces agent mode tool allowlists", () => {
    expect(isAgentToolAllowed("read-only", "read-file", false)).toBe(true);
    expect(isAgentToolAllowed("read-only", "search-project", false)).toBe(true);
    expect(isAgentToolAllowed("read-only", "propose-patch", false)).toBe(false);
    expect(isAgentToolAllowed("read-only", "set-main-file", true)).toBe(false);
    expect(isAgentToolAllowed("read-only", "reject-patch", false)).toBe(false);
    expect(isAgentToolAllowed("read-only", "apply-patch", true)).toBe(false);
    expect(isAgentToolAllowed("read-only", "run-compile", true)).toBe(false);
    expect(isAgentToolAllowed("suggest", "propose-patch", false)).toBe(true);
    expect(isAgentToolAllowed("suggest", "set-main-file", true)).toBe(false);
    expect(isAgentToolAllowed("suggest", "reject-patch", false)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "set-main-file", false)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "set-main-file", true)).toBe(true);
    expect(isAgentToolAllowed("autonomous-local", "set-main-file", false)).toBe(true);
    expect(isAgentToolAllowed("apply-with-review", "reject-patch", false)).toBe(true);
    expect(isAgentToolAllowed("suggest", "apply-patch", true)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "apply-patch", false)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "apply-patch", true)).toBe(true);
    expect(isAgentToolAllowed("apply-with-review", "run-compile", false)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "run-compile", true)).toBe(true);
  });

  it("marks provider-local model calls as medium risk and broker-blocked", () => {
    expect(getAgentToolRisk("codex-exec")).toBe("medium");
    expect(getAgentToolRisk("claude-code")).toBe("medium");
    expect(isAgentToolAllowed("apply-with-review", "claude-code", true)).toBe(false);
  });
});

describe("real provider event normalization", () => {
  it("maps Codex and Claude compile repairs into the same review event contract", async () => {
    const providerCases = [
      {
        providerId: "openai-codex" as const,
        provider: new CodexCliProvider({
          runCodexExec: (request) => {
            expect(request.prompt).toContain("Fix the LaTeX compile error");
            expect(request.prompt).toContain("Target file: main.tex");
            return Promise.resolve({
              action: "patch",
              targetFilePath: "main.tex",
              summary: "Add document end",
              afterContents:
                "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
              message: "I prepared a minimal compile repair.",
              notes: "Generated by parity test Codex runner"
            });
          }
        })
      },
      {
        providerId: "anthropic-claude" as const,
        provider: new ClaudeProvider({
          getCliAuthStatus: () => Promise.resolve({ loggedIn: true }),
          runClaudeCode: (request) => {
            expect(request.prompt).toContain("Fix the LaTeX compile error");
            expect(request.prompt).toContain("Target file: main.tex");
            return Promise.resolve({
              action: "patch",
              targetFilePath: "main.tex",
              summary: "Add document end",
              afterContents:
                "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
              message: "I prepared a minimal compile repair.",
              notes: "Generated by parity test Claude runner"
            });
          }
        })
      }
    ];

    const normalizedResults = [];

    for (const providerCase of providerCases) {
      const broker = createProviderParityBroker(providerCase.providerId);
      const result = await providerCase.provider.startSession(
        {
          providerId: providerCase.providerId,
          mode: "apply-with-review",
          projectRoot: "/tmp/provider-parity",
          prompt:
            "Fix the LaTeX compile error with the smallest correct edit. Do not change unrelated content.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(result.providerId).toBe(providerCase.providerId);
      expect(result.status).toBe("awaiting-approval");
      expect(result.changeset).toMatchObject({
        filePath: "main.tex",
        summary: "Add document end",
        status: "proposed"
      });
      expect(broker.calls).toEqual(["read-file:main.tex", "propose-patch:main.tex"]);

      normalizedResults.push(normalizeProviderEvents(result.events));
    }

    expect(normalizedResults[0]).toEqual(normalizedResults[1]);
    expect(normalizedResults[0]).toEqual([
      "message:user",
      "message:assistant",
      "tool-call:read-file:running:low",
      "tool-call:read-file:succeeded:low",
      "tool-call:provider-local:running:medium",
      "tool-call:provider-local:succeeded:medium",
      "tool-call:propose-patch:running:medium",
      "tool-call:propose-patch:succeeded:medium",
      "patch:proposed",
      "approval:apply-patch:requested:high",
      "verification:pending"
    ]);
  });
});

type ProviderParityBroker = CodexCliToolBroker &
  ClaudeCodeToolBroker & {
    readonly calls: string[];
  };

function createMockBroker({
  contents,
  filePath = "main.tex",
  searchResults = []
}: {
  readonly contents: string;
  readonly filePath?: string;
  readonly searchResults?: readonly {
    readonly path: string;
    readonly contents: string;
    readonly mtimeMs: number;
  }[];
}): AgentToolBroker & { proposedAfterContents: string } {
  let proposedAfterContents = "";

  return {
    get proposedAfterContents() {
      return proposedAfterContents;
    },
    readFile: (path) =>
      Promise.resolve({
        path,
        contents,
        mtimeMs: 1
      }),
    searchProject: () => Promise.resolve(searchResults),
    proposePatch: (_filePath, _beforeContents, afterContents, summary) => {
      proposedAfterContents = afterContents;
      return Promise.resolve({
        id: "changeset-1",
        projectRoot: "/tmp/project",
        filePath,
        summary,
        patch: afterContents,
        status: "proposed",
        baseSnapshotId: "snapshot-1",
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z"
      });
    },
    applyPatch: () => {
      throw new Error("Mock provider should not apply patches directly.");
    },
    runCompile: () => {
      throw new Error("Mock provider should not compile before review.");
    }
  };
}

function createProviderParityBroker(providerId: AgentProviderId): ProviderParityBroker {
  const calls: string[] = [];

  return {
    calls,
    readFile: (path) => {
      calls.push(`read-file:${path}`);
      return Promise.resolve({
        path: "main.tex",
        contents: "\\documentclass{article}\n\\begin{document}\nHello\n",
        mtimeMs: 1
      });
    },
    searchProject: () => Promise.resolve([]),
    proposePatch: (filePath, _beforeContents, afterContents, summary) => {
      calls.push(`propose-patch:${filePath}`);
      return Promise.resolve({
        id: `${providerId}-changeset-1`,
        projectRoot: "/tmp/provider-parity",
        filePath,
        summary,
        patch: afterContents,
        status: "proposed",
        baseSnapshotId: `${providerId}-snapshot-1`,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z"
      });
    }
  };
}

function normalizeProviderEvents(events: readonly AgentEvent[]): readonly string[] {
  return events.map((event) => {
    switch (event.type) {
      case "message":
        return `message:${event.role}`;
      case "tool-call":
        return `tool-call:${normalizeProviderToolName(event.toolName)}:${event.status}:${event.risk}`;
      case "patch":
        return `patch:${event.status}`;
      case "approval":
        return `approval:${event.toolName}:${event.status}:${event.risk}`;
      case "verification":
        return `verification:${event.status}`;
      case "error":
        return `error:${event.recoverable}`;
    }
  });
}

function normalizeProviderToolName(toolName: string): string {
  return toolName === "codex-exec" || toolName === "claude-code"
    ? "provider-local"
    : toolName;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}
