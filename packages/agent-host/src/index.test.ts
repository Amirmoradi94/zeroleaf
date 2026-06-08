import { describe, expect, it } from "vitest";

import {
  MockAgentProvider,
  getAgentToolRisk,
  isAgentToolAllowed,
  type AgentToolBroker
} from "./index.js";

describe("MockAgentProvider", () => {
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

  it("enforces agent mode tool allowlists", () => {
    expect(isAgentToolAllowed("read-only", "read-file", false)).toBe(true);
    expect(isAgentToolAllowed("read-only", "propose-patch", false)).toBe(false);
    expect(isAgentToolAllowed("suggest", "propose-patch", false)).toBe(true);
    expect(isAgentToolAllowed("suggest", "apply-patch", true)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "apply-patch", false)).toBe(false);
    expect(isAgentToolAllowed("apply-with-review", "apply-patch", true)).toBe(true);
  });

  it("marks provider-local model calls as medium risk and broker-blocked", () => {
    expect(getAgentToolRisk("codex-exec")).toBe("medium");
    expect(getAgentToolRisk("claude-code")).toBe("medium");
    expect(isAgentToolAllowed("apply-with-review", "claude-code", true)).toBe(false);
  });
});
