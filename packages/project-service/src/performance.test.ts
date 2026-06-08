import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listProjectTree, readProjectFile } from "./index.js";

let sandboxPath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-project-perf-"));
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("project-service performance guardrails", () => {
  it("lists a large project tree and reads a large source file within MVP bounds", async () => {
    const projectRoot = join(sandboxPath, "large-project");
    await mkdir(join(projectRoot, "sections"), { recursive: true });

    await Promise.all(
      Array.from({ length: 600 }, async (_value, index) => {
        await writeFile(
          join(projectRoot, "sections", `section-${index}.tex`),
          `\\section{Section ${index}}\nText ${index}\n`,
          "utf8"
        );
      })
    );
    await writeFile(
      join(projectRoot, "main.tex"),
      `${"A".repeat(750_000)}\n\\end{document}\n`,
      "utf8"
    );

    const treeStart = performance.now();
    const tree = await listProjectTree(projectRoot);
    const treeDurationMs = performance.now() - treeStart;

    const readStart = performance.now();
    const snapshot = await readProjectFile(projectRoot, "main.tex");
    const readDurationMs = performance.now() - readStart;

    expect(tree.length).toBeGreaterThan(0);
    expect(snapshot.contents.length).toBeGreaterThan(700_000);
    expect(treeDurationMs).toBeLessThan(2_500);
    expect(readDurationMs).toBeLessThan(1_000);
  });
});
