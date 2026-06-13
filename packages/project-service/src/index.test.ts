import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ProjectFileTreeNode,
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

  it("stores recent project metadata without document contents", async () => {
    const store = new ProjectMetadataStore(metadataPath);
    await writeFile(
      join(projectPath, "references.bib"),
      "@article{private,title={Private Study}}\n",
      "utf8"
    );

    await openProject(projectPath, store);
    const metadataJson = await readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataJson) as {
      readonly recentProjects?: readonly unknown[];
    };

    expect(metadata.recentProjects).toHaveLength(1);
    expect(metadataJson).toContain("main.tex");
    expect(metadataJson).not.toContain("\\documentclass");
    expect(metadataJson).not.toContain("Hello");
    expect(metadataJson).not.toContain("Private Study");
    expect(metadataJson).not.toContain("@article");
  });

  it("opens and reopens the valid article sample from recent metadata", async () => {
    const store = new ProjectMetadataStore(metadataPath);
    const samplePath = join(sandboxPath, "valid-article");
    await cp("samples/valid-article", samplePath, { recursive: true });

    const opened = await openProject(samplePath, store);
    const recentRoot = opened.recentProjects[0]?.rootPath;

    expect(opened.project.displayName).toBe("valid-article");
    expect(opened.project.mainFilePath).toBe("main.tex");
    expect(recentRoot).toBe(await validateProjectRoot(samplePath));

    const reopened = await openProject(recentRoot ?? "", store);

    expect(reopened.project.displayName).toBe("valid-article");
    expect(reopened.project.mainFilePath).toBe("main.tex");
    expect(reopened.recentProjects[0]?.rootPath).toBe(recentRoot);
    expect(reopened.tree.some((node) => node.path === "references.bib")).toBe(true);
  });

  it("opens a downloaded journal template and exposes its assets", async () => {
    const templatePath = join(sandboxPath, "journal-template");
    await mkdir(join(templatePath, "figures"), { recursive: true });
    await writeFile(
      join(templatePath, "main.tex"),
      [
        "\\documentclass{journal}",
        "\\bibliographystyle{journal}",
        "\\begin{document}",
        "\\includegraphics{figures/results.pdf}",
        "\\bibliography{references}",
        "\\end{document}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(templatePath, "journal.cls"), "\\NeedsTeXFormat{LaTeX2e}\n");
    await writeFile(join(templatePath, "journal.bst"), "ENTRY{}{}{}\n");
    await writeFile(join(templatePath, "references.bib"), "@article{demo}\n");
    await writeFile(join(templatePath, "figures", "results.pdf"), "placeholder");

    const project = await openProject(
      templatePath,
      new ProjectMetadataStore(metadataPath)
    );
    const paths = flattenTree(project.tree).map((node) => node.path);

    expect(project.project.displayName).toBe("journal-template");
    expect(project.project.mainFilePath).toBe("main.tex");
    expect(paths).toEqual(
      expect.arrayContaining([
        "main.tex",
        "journal.cls",
        "journal.bst",
        "references.bib",
        "figures/results.pdf"
      ])
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

  it("rejects folders that do not contain a tex source file", async () => {
    const notesPath = join(sandboxPath, "notes");
    await mkdir(notesPath, { recursive: true });
    await writeFile(join(notesPath, "readme.md"), "not a LaTeX project", "utf8");

    await expect(
      openProject(notesPath, new ProjectMetadataStore(metadataPath))
    ).rejects.toMatchObject({
      code: "unsupported-project",
      message: "Choose a folder that contains at least one .tex file."
    });
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

  it("detects and persists the selected main file in a multi-main template", async () => {
    const templatePath = join(sandboxPath, "conference-template");
    const store = new ProjectMetadataStore(metadataPath);
    await mkdir(templatePath, { recursive: true });
    await writeFile(
      join(templatePath, "sample.tex"),
      "\\documentclass{article}\n\\begin{document}\nSample\n\\end{document}\n",
      "utf8"
    );
    await writeFile(
      join(templatePath, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nMain\n\\end{document}\n",
      "utf8"
    );
    await writeFile(
      join(templatePath, "supplement.tex"),
      "\\section{Supplement}\n",
      "utf8"
    );

    const openedProject = await openProject(templatePath, store);
    expect(openedProject.project.mainFilePath).toBe("main.tex");

    const sampleProject = await setProjectMainFile(templatePath, store, "sample.tex");
    const reopenedSampleProject = await openProject(templatePath, store);
    expect(sampleProject.project.mainFilePath).toBe("sample.tex");
    expect(reopenedSampleProject.project.mainFilePath).toBe("sample.tex");

    const mainProject = await setProjectMainFile(templatePath, store, "main.tex");
    const reopenedMainProject = await openProject(templatePath, store);
    expect(mainProject.project.mainFilePath).toBe("main.tex");
    expect(reopenedMainProject.project.mainFilePath).toBe("main.tex");
  });

  it("reports a moved recent project folder without dropping recent metadata", async () => {
    const store = new ProjectMetadataStore(metadataPath);
    const openedProject = await openProject(projectPath, store);

    await rm(projectPath, { recursive: true, force: true });

    await expect(
      openProject(openedProject.project.rootPath, store)
    ).rejects.toMatchObject({
      code: "invalid-root",
      message: "Project folder is missing or inaccessible."
    });
    await expect(store.listRecentProjects()).resolves.toHaveLength(1);
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

    const deletedEntry = await deleteProjectEntry(projectPath, "sections/draft.tex");
    const tree = await listProjectTree(projectPath);

    expect(deletedEntry.deletedPath).toBe("sections/draft.tex");
    expect(deletedEntry.backupPath).toMatch(
      /^\.latex-agent\/backups\/deleted\/.+\/sections\/draft\.tex$/u
    );
    expect(tree.some((node) => node.path === "sections/draft.tex")).toBe(false);
    expect(tree.some((node) => node.path === ".latex-agent")).toBe(false);
    await expect(
      readFile(join(projectPath, deletedEntry.backupPath), "utf8")
    ).resolves.toBe("");
  });

  it("rejects deleting outside-root paths and app metadata", async () => {
    await expect(
      deleteProjectEntry(projectPath, "../outside.tex")
    ).rejects.toMatchObject({
      code: "outside-root"
    });
    await mkdir(join(projectPath, ".latex-agent"), { recursive: true });
    await expect(deleteProjectEntry(projectPath, ".latex-agent")).rejects.toMatchObject(
      {
        code: "invalid-name",
        message: "Cannot delete app metadata."
      }
    );
  });

  it("rejects moving over an existing file with a clear error", async () => {
    await writeFile(join(projectPath, "plot1.pdf"), "source", "utf8");
    await writeFile(join(projectPath, "sections", "plot1.pdf"), "existing", "utf8");

    await expect(
      moveProjectEntry(projectPath, "plot1.pdf", "sections/plot1.pdf")
    ).rejects.toMatchObject({
      code: "invalid-name",
      message: "Target path already exists."
    });
    await expect(readFile(join(projectPath, "plot1.pdf"), "utf8")).resolves.toBe(
      "source"
    );
    await expect(
      readFile(join(projectPath, "sections", "plot1.pdf"), "utf8")
    ).resolves.toBe("existing");
  });
});

function flattenTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children === undefined ? [] : flattenTree(node.children))
  ]);
}
