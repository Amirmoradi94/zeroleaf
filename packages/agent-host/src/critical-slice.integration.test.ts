import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HistoryStore } from "@latex-agent/history-service";
import { detectLatexToolchain, runLatexBuild } from "@latex-agent/latex-service";
import {
  ProjectMetadataStore,
  openProject,
  readProjectFile
} from "@latex-agent/project-service";

import { MockAgentProvider, type AgentToolBroker } from "./index.js";

let sandboxPath: string;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-critical-slice-"));
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("critical vertical slice", () => {
  it("opens, edits, compiles, gets an agent patch, applies it, and recompiles", async () => {
    const toolchain = await detectLatexToolchain();
    expect(toolchain.latexmkAvailable).toBe(true);

    const projectRoot = join(sandboxPath, "broken-project");
    await cp(join(repoRoot, "samples", "broken-compile"), projectRoot, {
      recursive: true
    });
    const metadata = new ProjectMetadataStore(join(sandboxPath, "metadata.json"));
    const history = new HistoryStore(join(sandboxPath, "history.sqlite"));

    try {
      const openedProject = await openProject(projectRoot, metadata);
      expect(openedProject.project.mainFilePath).toBe("main.tex");

      const firstBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(firstBuild.status).toBe("failed");

      const provider = new MockAgentProvider();
      const broker: AgentToolBroker = {
        readFile: (path) => readProjectFile(projectRoot, path),
        searchProject: () => Promise.resolve([]),
        proposePatch: (filePath, beforeContents, afterContents, summary) =>
          history.createChangeSet({
            projectRoot,
            filePath,
            beforeContents,
            afterContents,
            summary
          }),
        applyPatch: (changesetId) => history.applyChangeSet(changesetId),
        runCompile: () =>
          runLatexBuild({
            projectRoot,
            mainFilePath: "main.tex",
            compiler: "pdflatex",
            timeoutMs: 60_000
          })
      };

      const agentResult = await provider.startSession(
        {
          providerId: "mock",
          mode: "apply-with-review",
          projectRoot,
          prompt: "Fix the compile error",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        broker
      );

      expect(agentResult.status).toBe("awaiting-approval");
      expect(agentResult.changeset?.status).toBe("proposed");

      const applied = await history.applyChangeSet(agentResult.changeset?.id ?? "");
      expect(applied.status).toBe("applied");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toContain(
        "\\end{document}"
      );

      const secondBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 60_000
      });
      expect(secondBuild.status).toBe("succeeded");
      expect(secondBuild.artifact?.pdfPath).toContain("main.pdf");
    } finally {
      history.close();
    }
  }, 90_000);
});
