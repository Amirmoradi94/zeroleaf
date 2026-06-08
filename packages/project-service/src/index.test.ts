import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProjectMetadataStore,
  ProjectServiceError,
  createProjectEntry,
  deleteProjectEntry,
  detectMainTexFile,
  listProjectTree,
  moveProjectEntry,
  openProject,
  readProjectFile,
  renameProjectEntry,
  setProjectMainFile,
  validateProjectRoot,
  writeProjectFile
} from "./index.js";

let sandboxPath: string;
let projectPath: string;
let metadataPath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-project-service-"));
  projectPath = join(sandboxPath, "paper");
  metadataPath = join(sandboxPath, "metadata", "projects.json");
  await mkdir(join(projectPath, "sections"), { recursive: true });
  await writeFile(
    join(projectPath, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );
  await writeFile(join(projectPath, "sections", "intro.tex"), "Intro", "utf8");
});

afterEach(async () => {
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("project-service", () => {
  it("opens a valid project and records metadata", async () => {
    const store = new ProjectMetadataStore(metadataPath);
    const project = await openProject(projectPath, store);

    expect(project.project.displayName).toBe("paper");
    expect(project.project.mainFilePath).toBe("main.tex");
    expect(project.tree.map((node) => node.name)).toContain("main.tex");
    expect(project.recentProjects[0]?.rootPath).toBe(
      await validateProjectRoot(projectPath)
    );
  });

  it("hides generated LaTeX build output from the project tree", async () => {
    await mkdir(join(projectPath, ".latex-agent", "build"), { recursive: true });
    await writeFile(join(projectPath, ".latex-agent", "build", "main.pdf"), "");

    const tree = await listProjectTree(projectPath);

    expect(tree.map((node) => node.name)).not.toContain(".latex-agent");
  });

  it("detects a likely main tex file without requiring main.tex", async () => {
    await rm(join(projectPath, "main.tex"));
    await writeFile(
      join(projectPath, "article.tex"),
      "\\documentclass{article}\n\\begin{document}\nBody\n\\end{document}\n",
      "utf8"
    );

    await expect(detectMainTexFile(projectPath)).resolves.toBe("article.tex");
  });

  it("persists an overridden main tex file", async () => {
    const store = new ProjectMetadataStore(metadataPath);
    await writeFile(
      join(projectPath, "sections", "appendix.tex"),
      "\\documentclass{article}\n\\begin{document}\nAppendix\n\\end{document}\n",
      "utf8"
    );

    const updatedProject = await setProjectMainFile(
      projectPath,
      store,
      "sections/appendix.tex"
    );
    const reopenedProject = await openProject(projectPath, store);

    expect(updatedProject.project.mainFilePath).toBe("sections/appendix.tex");
    expect(reopenedProject.project.mainFilePath).toBe("sections/appendix.tex");
  });

  it("rejects traversal for reads and writes", async () => {
    await expect(readProjectFile(projectPath, "../outside.tex")).rejects.toBeInstanceOf(
      ProjectServiceError
    );
    await expect(
      writeProjectFile(projectPath, "../outside.tex", "bad")
    ).rejects.toBeInstanceOf(ProjectServiceError);
  });

  it("rejects symlinks that resolve outside the project root", async () => {
    const outsidePath = join(sandboxPath, "outside.tex");
    await writeFile(outsidePath, "outside", "utf8");
    await symlink(outsidePath, join(projectPath, "linked.tex"));

    await expect(readProjectFile(projectPath, "linked.tex")).rejects.toBeInstanceOf(
      ProjectServiceError
    );
  });

  it("reads and writes files inside the project root", async () => {
    const snapshot = await readProjectFile(projectPath, "main.tex");
    expect(snapshot.path).toBe("main.tex");
    expect(snapshot.contents).toContain("\\documentclass");

    await writeProjectFile(projectPath, "main.tex", "Updated");
    await expect(readFile(join(projectPath, "main.tex"), "utf8")).resolves.toBe(
      "Updated"
    );
  });

  it("creates, renames, and deletes project entries", async () => {
    await createProjectEntry(projectPath, ".", "notes.tex", "file");
    await renameProjectEntry(projectPath, "notes.tex", "draft.tex");
    await moveProjectEntry(projectPath, "draft.tex", "sections/draft.tex");
    await expect(
      readFile(join(projectPath, "sections", "draft.tex"), "utf8")
    ).resolves.toBe("");

    await deleteProjectEntry(projectPath, "sections/draft.tex");
    const tree = await listProjectTree(projectPath);

    expect(tree.some((node) => node.path === "sections/draft.tex")).toBe(false);
  });
});
