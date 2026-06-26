import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ProjectFileTreeNode,
  ProjectMetadataStore,
  openProject,
  validateProjectRoot
} from "./index.js";
import {
  LocalProjectAdapter,
  ProjectGateway,
  ProjectGatewayError,
  createLocalProjectHandle,
  type SharedProjectHandle
} from "./project-gateway.js";

let sandboxPath: string;
let projectPath: string;
let metadataPath: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "latex-project-gateway-"));
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

describe("project gateway", () => {
  it("maps recent filesystem projects to local project handles", async () => {
    const metadataStore = new ProjectMetadataStore(metadataPath);
    await openProject(projectPath, metadataStore);
    const adapter = new LocalProjectAdapter(metadataStore);

    const handles = await adapter.listRecentProjects();
    const rootPath = await validateProjectRoot(projectPath);

    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({
      id: `local:${rootPath}`,
      backend: "local",
      displayName: "paper",
      rootPath,
      mainFilePath: "main.tex",
      syncState: "local-only"
    });
  });

  it("opens a local project session and delegates file operations", async () => {
    const metadataStore = new ProjectMetadataStore(metadataPath);
    const gateway = new ProjectGateway([new LocalProjectAdapter(metadataStore)]);
    const handle = await createLocalProjectHandle({
      rootPath: projectPath,
      displayName: "paper"
    });

    const opened = await gateway.openProject(handle);

    expect(opened.session.handle.backend).toBe("local");
    expect(opened.project.mainFilePath).toBe("main.tex");
    expect(opened.tree.map((node) => node.path)).toContain("main.tex");

    const original = await gateway.readFile(opened.session.id, "main.tex");
    expect(original.contents).toContain("Hello");

    await gateway.writeFile(opened.session.id, "sections/intro.tex", "Updated intro");
    await expect(
      readFile(join(projectPath, "sections", "intro.tex"), "utf8")
    ).resolves.toBe("Updated intro");
  });

  it("delegates local project tree mutations through a session", async () => {
    const metadataStore = new ProjectMetadataStore(metadataPath);
    const gateway = new ProjectGateway([new LocalProjectAdapter(metadataStore)]);
    const handle = await createLocalProjectHandle({
      rootPath: projectPath,
      displayName: "paper"
    });
    const opened = await gateway.openProject(handle);

    const created = await gateway.createEntry(
      opened.session.id,
      "sections",
      "method.tex",
      "file"
    );
    expect(flattenTree(created.tree).map((node) => node.path)).toContain(
      "sections/method.tex"
    );

    const renamed = await gateway.renameEntry(
      opened.session.id,
      "sections/method.tex",
      "methods.tex"
    );
    expect(flattenTree(renamed.tree).map((node) => node.path)).toContain(
      "sections/methods.tex"
    );

    const deleted = await gateway.deleteEntry(
      opened.session.id,
      "sections/methods.tex"
    );
    expect(deleted.deletedEntry.deletedPath).toBe("sections/methods.tex");
    expect(flattenTree(deleted.tree).map((node) => node.path)).not.toContain(
      "sections/methods.tex"
    );
  });

  it("requires a registered adapter before opening shared project handles", async () => {
    const gateway = new ProjectGateway([]);
    const handle: SharedProjectHandle = {
      id: "shared:paper-1",
      backend: "shared",
      displayName: "Shared Paper",
      sharedProjectId: "paper-1",
      syncState: "syncing"
    };

    await expect(gateway.openProject(handle)).rejects.toMatchObject({
      code: "missing-adapter"
    } satisfies Partial<ProjectGatewayError>);
  });

  it("rejects operations for unknown project sessions", async () => {
    const gateway = new ProjectGateway([
      new LocalProjectAdapter(new ProjectMetadataStore(metadataPath))
    ]);

    await expect(gateway.readFile("missing-session", "main.tex")).rejects.toMatchObject(
      {
        code: "missing-session"
      } satisfies Partial<ProjectGatewayError>
    );
  });
});

function flattenTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children ?? [])]);
}
