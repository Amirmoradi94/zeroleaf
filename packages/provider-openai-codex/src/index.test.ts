import { describe, expect, it } from "vitest";
import type { BuildResult } from "@latex-agent/ipc-contracts";

import {
  CodexCliProvider,
  createCodexExecArgs,
  parseCodexLoginStatus,
  type CodexCliToolBroker
} from "./index.js";

describe("CodexCliProvider", () => {
  it("reports needs-auth when the Codex CLI is logged out", async () => {
    const provider = new CodexCliProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: false })
    });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "openai-codex",
      state: "needs-auth",
      message: "Run `codex login` in a terminal to connect Codex CLI."
    });
  });

  it("reports an error when the Codex CLI binary is missing", async () => {
    const provider = new CodexCliProvider({
      codexBinary: "/tmp/latex-agent-no-such-codex-binary"
    });

    const status = await provider.getAuthStatus();

    expect(status.providerId).toBe("openai-codex");
    expect(status.state).toBe("error");
    expect(status.message).toContain("no-such-codex-binary");
  });

  it("reports connected when the Codex CLI login is available", async () => {
    const provider = new CodexCliProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true, authMethod: "ChatGPT" })
    });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "openai-codex",
      state: "connected",
      message: "Codex CLI is logged in using ChatGPT."
    });
  });

  it("parses Codex CLI login status output", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      authMethod: "ChatGPT"
    });
    expect(parseCodexLoginStatus("Not logged in. Run `codex login`.")).toEqual({
      loggedIn: false
    });
  });

  it("runs Codex exec with an isolated read-only planner configuration", () => {
    expect(
      createCodexExecArgs("/tmp/schema.json", "/tmp/output.json", "/tmp/project")
    ).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-c",
      'model_reasoning_effort="low"',
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/output.json",
      "-C",
      "/tmp/project",
      "-"
    ]);
  });

  it("runs read-only tasks through Codex exec and returns the model answer", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer("The active file is a short article with one warning.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Summarize the active file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 3,
          message: "Citation `knuth1984` undefined"
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
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
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

  it("delegates thesis summaries in read-only mode to Codex", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve(
          createCodexAnswer(
            "Structure: Introduction, Method, Conclusion.\n\nBuild health: not verified by this answer."
          )
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Summarize this thesis project structure, main claims, missing sections, and build health.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": [
            "\\documentclass{report}",
            "\\begin{document}",
            "\\chapter{Introduction}",
            "We demonstrate that local-first editing improves review.",
            "\\input{chapters/method}",
            "\\input{chapters/conclusion}",
            "\\end{document}",
            ""
          ].join("\n"),
          "chapters/method.tex":
            "\\chapter{Method}\nOur contributions are a scoped agent workflow.",
          "chapters/conclusion.tex":
            "\\chapter{Conclusion}\nThis thesis argues for reviewable patches."
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(providerPrompt).toContain("Use your own judgment");
    expect(providerPrompt).toContain('Set action to "answer"');
    expect(
      result.events.some(
        (event) => event.type === "message" && event.content.includes("Structure:")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "message" && event.content.includes("Build health:")
      )
    ).toBe(true);
  });

  it("delegates final formatting review prompts to Codex", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer("Priority 1 blockers: Missing local figure asset.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
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
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
  });

  it("lets Codex answer autonomous no-edit questions without proposing patches", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer(
            "The paper studies autonomous vehicle perception under covert spoofing."
          )
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "What is this TSMC paper about?",
        activeFilePath: "IEEE_TSMC.tex",
        mainFilePath: "IEEE_TSMC.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "IEEE_TSMC.tex": [
            "\\documentclass{IEEEtran}",
            "\\begin{document}",
            "\\title{Vision-Aligned Video Diffusion and Doppler-Consistent GNSS Spoofing}",
            "\\begin{abstract}",
            "This paper studies autonomous vehicle perception under covert spoofing.",
            "\\end{abstract}",
            "\\section{Introduction}",
            "The manuscript proposes a hybrid attack and evaluates detection.",
            "\\end{document}",
            ""
          ].join("\n")
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:IEEE_TSMC.tex"]);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("autonomous vehicle perception")
      )
    ).toBe(true);
  });

  it("turns installed-Codex output into a reviewable changeset", async () => {
    let providerPrompt = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a minimal patch.",
          notes: "Generated by fake Codex runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
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
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
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
    expect(providerPrompt).toContain('Set action to "patch" when');
    expect(providerPrompt).toContain(
      'return the concrete action whenever safe: "patch" for source edits'
    );
    expect(providerPrompt).toContain('"move-entry" for moving or renaming files');
    expect(providerPrompt).toContain(
      '"set-main-file" for changing the project main TeX file'
    );
    expect(providerPrompt).toContain('"run-compile" for builds');
    expect(providerPrompt).toContain("\\citep{smith2024}");
  });

  it("retries concrete fix answers once to request a reviewable patch", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "Add the missing \\end{document} line at the end of main.tex."
            )
          );
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a reviewable patch.",
          notes: "Retry produced patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Read the terminal log and fix the compile error.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add missing document end");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Retry instruction:");
    expect(prompts[1]).toContain('return action "patch"');
    expect(prompts[1]).toContain('return action "move-entry"');
    expect(prompts[1]).toContain('return action "set-main-file"');
    expect(prompts[1]).toContain('return action "run-compile"');
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
  });

  it("retries interrupted Codex planner runs once with focused context", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          throw new Error("codex was terminated by SIGTERM: stdio transport closed");
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a reviewable patch after retrying.",
          notes: "Focused retry produced patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 3,
          message: "Emergency stop"
        }
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add missing document end");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous Codex planner attempt was interrupted");
    expect(prompts[1]).toContain("avoid broad project scans");
    expect(prompts[1]).toContain("Emergency stop");
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.status === "failed" &&
          event.summary.includes("SIGTERM") &&
          event.summary.includes("Retrying")
      )
    ).toBe(true);
  });

  it("rejects overbroad large-file patches and retries for a complete file", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const largeFile = [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      ...Array.from({ length: 180 }, (_, index) => `Paragraph ${index}.`),
      "\\bibliography{references.bib}",
      "\\end{document}",
      ""
    ].join("\n");
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "patch",
            targetFilePath: "main.tex",
            summary: "Add graphics path",
            afterContents:
              "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n",
            message: "I added the graphics path.",
            notes: "Returned an incomplete patch"
          });
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add graphics path",
          afterContents: largeFile.replace(
            "\\usepackage{graphicx}",
            "\\usepackage{graphicx}\n\\graphicspath{{figures/}}"
          ),
          message: "I added the graphics path while preserving the full file.",
          notes: "Returned a complete patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the root-relative graphics path.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, { readFiles: { "main.tex": largeFile } })
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add graphics path");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous patch removed most of a large file");
    expect(prompts[1]).toContain("complete target file");
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.status === "running" &&
          event.summary.includes("removed most of a large file")
      )
    ).toBe(true);
  });

  it("does not retry non-transient Codex planner failures", async () => {
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        throw new Error(
          "Codex output did not match the expected agent response schema."
        );
      }
    });

    await expect(
      provider.startSession(
        {
          providerId: "openai-codex",
          mode: "apply-with-review",
          projectRoot: "/tmp/project",
          prompt: "Fix the compile error.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        createBroker()
      )
    ).rejects.toThrow("expected agent response schema");
    expect(prompts).toHaveLength(1);
  });

  it("applies Codex patches and compiles in autonomous-local mode", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I fixed the missing document terminator.",
          notes: "Generated by fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error and recompile.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset?.status).toBe("applied");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(calls).toEqual([
      "read-file:main.tex",
      "propose-patch",
      "apply-patch:changeset-1",
      "run-compile"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "apply-patch" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.status === "passed" &&
          event.buildJobId === "build-1"
      )
    ).toBe(true);
  });

  it("turns file move requests into a project-scoped app tool call", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          action: "move-entry",
          targetFilePath: "fig1.png",
          summary: "Move figure next to manuscript path",
          afterContents: "figures/fig1.png",
          message: "I moved `fig1.png` to `figures/fig1.png`.",
          notes: "Generated by fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Move fig1.png into figures/fig1.png",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.moveEntries).toEqual([
      { fromPath: "fig1.png", toPath: "figures/fig1.png" }
    ]);
    expect(calls).toEqual([
      "read-file:main.tex",
      "move-entry:fig1.png->figures/fig1.png"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "move-entry" &&
          event.status === "succeeded"
      )
    ).toBe(true);
  });

  it("turns main-file change requests into an app tool call", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "The project already appears to use an IEEE Transactions file."
            )
          );
        }

        return Promise.resolve({
          action: "set-main-file",
          targetFilePath: "IEEE trans journal.tex",
          summary: "Set IEEE Transactions file as main",
          afterContents: "",
          message: "I set the project main TeX file to `IEEE trans journal.tex`.",
          notes: "Retry produced app tool action"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "change the main tex to ieee trans journal file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(calls).toEqual([
      "read-file:main.tex",
      "set-main-file:IEEE trans journal.tex"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "set-main-file" &&
          event.status === "succeeded"
      )
    ).toBe(true);
  });

  it("turns compile requests into an app build tool call", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "I attempted to recompile, but the read-only environment prevented LaTeX from writing main.aux."
            )
          );
        }

        return Promise.resolve({
          action: "run-compile",
          targetFilePath: "main.tex",
          summary: "Run project compile",
          afterContents: "",
          message: "I ran the project compile.",
          notes: "Retry produced app build action"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "recompile to make sure there is no error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(prompts).toHaveLength(2);
    expect(calls).toEqual(["read-file:main.tex", "run-compile"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "run-compile" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.status === "passed" &&
          event.buildJobId === "build-1"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("Compile succeeded.")
      )
    ).toBe(true);
  });

  it("repairs a failed autonomous compile and recompiles before answering", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "run-compile",
            targetFilePath: "main.tex",
            summary: "Run project compile",
            afterContents: "",
            message: "I will compile the project.",
            notes: "Initial compile action"
          });
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Fix missing input path",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\n\\input{tracked.tex}\n\\end{document}\n",
          message: "I fixed the missing input path.",
          notes: "Repair patch produced from compile log"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "compile again the main tex file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        compileResults: [
          createBuildResult({
            diagnostics: [
              {
                severity: "error",
                filePath: "main.tex",
                line: 1,
                message: "File `tracked.tex' not found."
              }
            ],
            jobId: "build-failed",
            rawLog: "! LaTeX Error: File `tracked.tex' not found.",
            status: "failed"
          }),
          createBuildResult({
            artifact: {
              byteLength: 1234,
              pdfPath: "main.pdf",
              updatedAt: "2026-06-08T00:00:02.000Z"
            },
            jobId: "build-fixed",
            rawLog: "Output written on main.pdf",
            status: "succeeded"
          })
        ],
        readFiles: {
          "main.tex":
            "\\documentclass{article}\n\\begin{document}\n\\input{missing.tex}\n"
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset?.status).toBe("applied");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Compile repair instruction:");
    expect(prompts[1]).toContain("File `tracked.tex' not found.");
    expect(prompts[1]).toContain("! LaTeX Error: File `tracked.tex' not found.");
    expect(calls).toEqual([
      "read-file:main.tex",
      "run-compile",
      "propose-patch",
      "apply-patch:changeset-1",
      "run-compile",
      "read-file:main.tex"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.summary.includes("Compile failed; asking Codex to repair")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes(
            "I fixed the compile issue and recompiled successfully"
          )
      )
    ).toBe(true);
  });

  it("reports a failed compile when Codex cannot produce a safe repair patch", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "run-compile",
            targetFilePath: "main.tex",
            summary: "Run project compile",
            afterContents: "",
            message: "I will compile the project.",
            notes: "Initial compile action"
          });
        }

        return Promise.resolve(
          createCodexAnswer("The compile failure requires a missing external file.")
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "compile again the main tex file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        compileResults: [
          createBuildResult({
            diagnostics: [
              {
                severity: "error",
                filePath: "main.tex",
                line: 1,
                message: "File `outside.tex' not found."
              }
            ],
            jobId: "build-failed",
            rawLog: "! LaTeX Error: File `outside.tex' not found.",
            status: "failed"
          })
        ]
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.buildResult?.status).toBe("failed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Compile repair instruction:");
    expect(calls).toEqual(["read-file:main.tex", "run-compile"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("did not return a safe source patch")
      )
    ).toBe(true);
  });

  it("does not retry answer-only questions in autonomous mode", async () => {
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve(createCodexAnswer("This paper is about local editing."));
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "What is this paper about?",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker()
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(prompts).toHaveLength(1);
  });
});

function createCodexAnswer(message: string) {
  return {
    action: "answer" as const,
    targetFilePath: "main.tex",
    summary: "Answer user question",
    afterContents: "\\documentclass{article}\n\\begin{document}\nHello\n",
    message,
    notes: "Answered by fake Codex runner"
  };
}

function createBuildResult(
  overrides: Partial<BuildResult> & Pick<BuildResult, "jobId" | "status">
): BuildResult {
  return {
    jobId: overrides.jobId,
    status: overrides.status,
    compiler: overrides.compiler ?? "pdflatex",
    command: overrides.command ?? ["latexmk", "-pdf", "main.tex"],
    securityPolicy: overrides.securityPolicy ?? {
      shellEscape: {
        enabled: false,
        commandFlag: "-no-shell-escape",
        approvalRequiredToEnable: true,
        agentMayEnable: false,
        message:
          "Shell escape is disabled for LaTeX builds. Enabling it requires explicit user approval."
      }
    },
    startedAt: overrides.startedAt ?? "2026-06-08T00:00:00.000Z",
    finishedAt: overrides.finishedAt ?? "2026-06-08T00:00:01.000Z",
    durationMs: overrides.durationMs ?? 1000,
    ...(overrides.exitCode === undefined ? {} : { exitCode: overrides.exitCode }),
    diagnostics: overrides.diagnostics ?? [],
    rawLog:
      overrides.rawLog ??
      (overrides.status === "succeeded" ? "Output written on main.pdf" : ""),
    ...(overrides.rawLogTruncated === undefined
      ? {}
      : { rawLogTruncated: overrides.rawLogTruncated }),
    ...(overrides.rawLogBytes === undefined
      ? {}
      : { rawLogBytes: overrides.rawLogBytes }),
    ...(overrides.rawLogOriginalBytes === undefined
      ? {}
      : { rawLogOriginalBytes: overrides.rawLogOriginalBytes }),
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    ...(overrides.artifact === undefined ? {} : { artifact: overrides.artifact })
  };
}

function createBroker(
  calls: string[] = [],
  options: {
    readonly compileResults?: readonly BuildResult[];
    readonly readFiles?: Readonly<Record<string, string>>;
    readonly searchResults?: Readonly<
      Record<string, readonly { readonly path: string; readonly contents: string }[]>
    >;
  } = {}
): CodexCliToolBroker {
  let compileRunCount = 0;

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
    setMainFile: (path) => {
      calls.push(`set-main-file:${path}`);
      return Promise.resolve({ path });
    },
    moveEntry: (fromPath, toPath) => {
      calls.push(`move-entry:${fromPath}->${toPath}`);
      return Promise.resolve({ fromPath, toPath });
    },
    runCompile: () => {
      calls.push("run-compile");
      const result =
        options.compileResults?.[
          Math.min(compileRunCount, options.compileResults.length - 1)
        ] ?? createBuildResult({ jobId: "build-1", status: "succeeded" });
      compileRunCount += 1;
      return Promise.resolve(result);
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
    },
    applyPatch: (changesetId) => {
      calls.push(`apply-patch:${changesetId}`);
      return Promise.resolve({
        id: changesetId,
        projectRoot: "/tmp/project",
        filePath: "main.tex",
        summary: "Add missing document end",
        patch: "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
        status: "applied",
        baseSnapshotId: "snapshot-1",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:01.000Z"
      });
    }
  };
}
