import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ProjectSummary = {
  readonly rootPath: string;
  readonly displayName: string;
  readonly mainFilePath?: string;
};

export type RecentProject = ProjectSummary & {
  readonly lastOpenedAt: string;
};

export type ProjectFileKind = "directory" | "file";

export type ProjectFileTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly kind: ProjectFileKind;
  readonly children?: readonly ProjectFileTreeNode[];
};

export type ProjectOpenResult = {
  readonly project: ProjectSummary;
  readonly tree: readonly ProjectFileTreeNode[];
  readonly recentProjects: readonly RecentProject[];
};

export type ProjectDeleteBackup = {
  readonly deletedPath: string;
  readonly backupPath: string;
  readonly deletedAt: string;
};

export type ProjectEntryKind = "directory" | "file";

export type ProjectFileSnapshot = {
  readonly path: string;
  readonly contents: string;
  readonly mtimeMs: number;
};

type ProjectMetadata = {
  readonly recentProjects: readonly RecentProject[];
  readonly projectSettingsByRoot: Readonly<Record<string, ProjectSettings>>;
};

type ProjectSettings = {
  readonly mainFilePath?: string;
};

const emptyMetadata: ProjectMetadata = {
  recentProjects: [],
  projectSettingsByRoot: {}
};

const ignoredDirectories = new Set([
  ".git",
  ".latex-agent",
  ".latexmk",
  "dist",
  "node_modules",
  "out"
]);

const maxTreeDepth = 8;
const maxTreeEntries = 2500;
const mainFileReadLimit = 80_000;
const internalMetadataPath = ".latex-agent";
const transientReadRetryDelaysMs = [120, 240, 480, 960, 1_500] as const;

export class ProjectServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-name"
      | "invalid-root"
      | "outside-root"
      | "not-directory"
      | "not-file"
      | "not-readable"
      | "unsupported-project"
  ) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

export class ProjectMetadataStore {
  constructor(private readonly metadataPath: string) {}

  async read(): Promise<ProjectMetadata> {
    try {
      const contents = await readFile(this.metadataPath, "utf8");
      const parsed = JSON.parse(contents) as Partial<ProjectMetadata>;

      return {
        recentProjects: Array.isArray(parsed.recentProjects)
          ? parsed.recentProjects.filter(isRecentProject)
          : [],
        projectSettingsByRoot: isProjectSettingsRecord(parsed.projectSettingsByRoot)
          ? parsed.projectSettingsByRoot
          : {}
      };
    } catch {
      return emptyMetadata;
    }
  }

  async listRecentProjects(): Promise<readonly RecentProject[]> {
    return (await this.read()).recentProjects;
  }

  async clearRecentProjects(): Promise<readonly RecentProject[]> {
    const metadata = await this.read();

    await this.write({ ...metadata, recentProjects: [] });

    return [];
  }

  async removeRecentProject(rootPath: string): Promise<readonly RecentProject[]> {
    const metadata = await this.read();
    const recentProjects = metadata.recentProjects.filter(
      (storedProject) => storedProject.rootPath !== rootPath
    );

    await this.write({ ...metadata, recentProjects });

    return recentProjects;
  }

  async recordProjectOpened(
    project: ProjectSummary
  ): Promise<readonly RecentProject[]> {
    const metadata = await this.read();
    const recentProject: RecentProject = {
      ...project,
      lastOpenedAt: new Date().toISOString()
    };
    const recentProjects = [
      recentProject,
      ...metadata.recentProjects.filter(
        (storedProject) => storedProject.rootPath !== project.rootPath
      )
    ].slice(0, 12);

    await this.write({ ...metadata, recentProjects });

    return recentProjects;
  }

  async readProjectSettings(rootPath: string): Promise<ProjectSettings> {
    return (await this.read()).projectSettingsByRoot[rootPath] ?? {};
  }

  async setProjectSettings(rootPath: string, settings: ProjectSettings): Promise<void> {
    const metadata = await this.read();
    await this.write({
      ...metadata,
      projectSettingsByRoot: {
        ...metadata.projectSettingsByRoot,
        [rootPath]: settings
      }
    });
  }

  private async write(metadata: ProjectMetadata): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true });
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  }
}

export async function openProject(
  rootPath: string,
  metadataStore: ProjectMetadataStore
): Promise<ProjectOpenResult> {
  const root = await validateProjectRoot(rootPath);
  const tree = await listProjectTree(root);
  const texPaths = getTexFilePaths(tree);
  const storedSettings = await metadataStore.readProjectSettings(root);
  const mainFilePath =
    getAvailableMainFilePath(tree, storedSettings.mainFilePath) ??
    (await detectMainTexFile(root, tree, texPaths));
  const project = withOptionalMainFile(
    {
      rootPath: root,
      displayName: basename(root) || root
    },
    mainFilePath
  );
  const recentProjects = await metadataStore.recordProjectOpened(project);

  return {
    project,
    tree,
    recentProjects
  };
}

export async function refreshProject(
  rootPath: string,
  metadataStore: ProjectMetadataStore
): Promise<ProjectOpenResult> {
  return openProject(rootPath, metadataStore);
}

export async function setProjectMainFile(
  rootPath: string,
  metadataStore: ProjectMetadataStore,
  mainFilePath: string
): Promise<ProjectOpenResult> {
  const root = await validateProjectRoot(rootPath);
  const targetPath = await resolveExistingProjectPath(root, mainFilePath);
  const fileStats = await stat(targetPath);
  const projectPath = toProjectPath(root, targetPath);

  if (!fileStats.isFile() || !projectPath.endsWith(".tex")) {
    throw new ProjectServiceError("Main file must be a .tex file.", "not-file");
  }

  await metadataStore.setProjectSettings(root, { mainFilePath: projectPath });
  return openProject(root, metadataStore);
}

export async function validateProjectRoot(rootPath: string): Promise<string> {
  if (!isNonEmptyString(rootPath)) {
    throw new ProjectServiceError("Project root is required.", "invalid-root");
  }

  let resolvedRoot: string;

  try {
    resolvedRoot = await realpath(rootPath);
  } catch {
    throw new ProjectServiceError(
      "Project folder is missing or inaccessible.",
      "invalid-root"
    );
  }

  const rootStats = await stat(resolvedRoot);

  if (!rootStats.isDirectory()) {
    throw new ProjectServiceError("Project root must be a directory.", "not-directory");
  }

  try {
    await access(resolvedRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new ProjectServiceError(
      "Project root must be readable and writable.",
      "not-readable"
    );
  }

  return resolvedRoot;
}

export async function listProjectTree(
  rootPath: string
): Promise<readonly ProjectFileTreeNode[]> {
  const root = await validateProjectRoot(rootPath);
  let entryCount = 0;

  async function visit(
    directoryPath: string,
    depth: number
  ): Promise<readonly ProjectFileTreeNode[]> {
    if (depth > maxTreeDepth || entryCount >= maxTreeEntries) {
      return [];
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const nodes: ProjectFileTreeNode[] = [];

    for (const entry of entries.sort(compareDirectoryEntries)) {
      if (entryCount >= maxTreeEntries) {
        break;
      }

      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }

      const absolutePath = join(directoryPath, entry.name);
      const relativePath = toProjectPath(root, absolutePath);

      entryCount += 1;

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          kind: "directory",
          children: await visit(absolutePath, depth + 1)
        });
      } else {
        nodes.push({
          name: entry.name,
          path: relativePath,
          kind: "file"
        });
      }
    }

    return nodes;
  }

  return visit(root, 0);
}

export async function readProjectFile(
  rootPath: string,
  path: string
): Promise<ProjectFileSnapshot> {
  const root = await validateProjectRoot(rootPath);
  const absolutePath = await resolveExistingProjectPath(root, path);
  const fileStats = await stat(absolutePath);

  if (!fileStats.isFile()) {
    throw new ProjectServiceError("Path must resolve to a file.", "not-file");
  }

  return {
    path: toProjectPath(root, absolutePath),
    contents: await readProjectFileContents(absolutePath),
    mtimeMs: fileStats.mtimeMs
  };
}

async function readProjectFileContents(absolutePath: string): Promise<string> {
  for (let attempt = 0; attempt <= transientReadRetryDelaysMs.length; attempt += 1) {
    try {
      return await readUtf8FileStream(absolutePath);
    } catch (error) {
      const retryDelay = transientReadRetryDelaysMs[attempt];

      if (!isTransientReadError(error)) {
        throw error;
      }

      if (retryDelay === undefined) {
        throw new ProjectServiceError(
          "Project file is temporarily unavailable. Wait for the file to finish downloading locally, then try again.",
          "not-readable"
        );
      }

      await delay(retryDelay);
    }
  }

  throw new ProjectServiceError("Unable to read project file.", "not-readable");
}

function readUtf8FileStream(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let contents = "";
    const stream = createReadStream(absolutePath, { encoding: "utf8" });
    const timeout = setTimeout(() => {
      const error = new Error("Timed out while reading project file.") as Error & {
        code: string;
      };
      error.code = "ETIMEDOUT";
      stream.destroy(error);
    }, 5_000);

    stream.on("data", (chunk) => {
      contents += chunk;
    });
    stream.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.once("end", () => {
      clearTimeout(timeout);
      resolve(contents);
    });
  });
}

function isTransientReadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: unknown; readonly errno?: unknown };
  return (
    candidate.code === "EAGAIN" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.errno === -11
  );
}

export async function writeProjectFile(
  rootPath: string,
  path: string,
  contents: string
): Promise<{ readonly saved: true; readonly mtimeMs: number }> {
  const root = await validateProjectRoot(rootPath);
  const absolutePath = await resolveWritableProjectPath(root, path);

  await writeFile(absolutePath, contents, "utf8");
  const fileStats = await stat(absolutePath);

  return {
    saved: true,
    mtimeMs: fileStats.mtimeMs
  };
}

export async function createProjectEntry(
  rootPath: string,
  parentPath: string,
  name: string,
  kind: ProjectEntryKind
): Promise<void> {
  const root = await validateProjectRoot(rootPath);
  const safeName = validateEntryName(name);
  const parentAbsolutePath = await resolveExistingProjectPath(root, parentPath);
  const parentStats = await stat(parentAbsolutePath);

  if (!parentStats.isDirectory()) {
    throw new ProjectServiceError("Parent path must be a directory.", "not-directory");
  }

  const targetPath = await resolveWritableProjectPath(
    root,
    join(toProjectPath(root, parentAbsolutePath), safeName)
  );

  if (kind === "directory") {
    await mkdir(targetPath);
  } else {
    await writeFile(targetPath, "", { flag: "wx" });
  }
}

export async function renameProjectEntry(
  rootPath: string,
  path: string,
  newName: string
): Promise<void> {
  const root = await validateProjectRoot(rootPath);
  const sourcePath = await resolveExistingProjectPath(root, path);
  const safeName = validateEntryName(newName);
  const targetPath = await resolveWritableProjectPath(
    root,
    join(dirname(toProjectPath(root, sourcePath)), safeName)
  );

  await rename(sourcePath, targetPath);
}

export async function moveProjectEntry(
  rootPath: string,
  path: string,
  newPath: string
): Promise<void> {
  const root = await validateProjectRoot(rootPath);
  const sourcePath = await resolveExistingProjectPath(root, path);
  const targetPath = await resolveWritableProjectPath(root, newPath);

  if (sourcePath === root || targetPath === root) {
    throw new ProjectServiceError("Cannot move the project root.", "outside-root");
  }

  await assertPathDoesNotExist(targetPath);
  await rename(sourcePath, targetPath);
}

export async function deleteProjectEntry(
  rootPath: string,
  path: string
): Promise<ProjectDeleteBackup> {
  const root = await validateProjectRoot(rootPath);
  const targetPath = await resolveExistingProjectPath(root, path);
  const deletedPath = toProjectPath(root, targetPath);

  if (targetPath === root) {
    throw new ProjectServiceError("Cannot delete the project root.", "outside-root");
  }

  if (
    deletedPath === internalMetadataPath ||
    deletedPath.startsWith(`${internalMetadataPath}/`)
  ) {
    throw new ProjectServiceError("Cannot delete app metadata.", "invalid-name");
  }

  const deletedAt = new Date().toISOString();
  const backupRoot = join(
    root,
    internalMetadataPath,
    "backups",
    "deleted",
    `${deletedAt.replaceAll(":", "-")}-${randomUUID()}`
  );
  const backupPath = join(backupRoot, deletedPath);

  if (!isInsideRoot(root, backupPath)) {
    throw new ProjectServiceError(
      "Backup path resolves outside the project root.",
      "outside-root"
    );
  }

  await mkdir(dirname(backupPath), { recursive: true });
  await rename(targetPath, backupPath);

  return {
    deletedPath,
    backupPath: toProjectPath(root, backupPath),
    deletedAt
  };
}

export async function detectMainTexFile(
  rootPath: string,
  tree?: readonly ProjectFileTreeNode[],
  texFilePaths?: readonly string[]
): Promise<string | undefined> {
  const root = await validateProjectRoot(rootPath);
  const nodes = tree ?? (await listProjectTree(root));
  const texPaths = texFilePaths ?? getTexFilePaths(nodes);

  if (texPaths.includes("main.tex")) {
    return "main.tex";
  }

  for (const texPath of texPaths) {
    const absolutePath = await resolveExistingProjectPath(root, texPath);
    const contents = await readProjectFileContents(absolutePath);

    if (contents.slice(0, mainFileReadLimit).includes("\\documentclass")) {
      return texPath;
    }
  }

  return texPaths[0];
}

async function resolveExistingProjectPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  const lexicalPath = resolveLexicalProjectPath(rootPath, projectPath);
  const resolvedPath = await realpath(lexicalPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new ProjectServiceError(
      "Path resolves outside the project root.",
      "outside-root"
    );
  }

  return resolvedPath;
}

async function resolveWritableProjectPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  const lexicalPath = resolveLexicalProjectPath(rootPath, projectPath);
  const parentPath = await ensureWritableParentPath(rootPath, dirname(lexicalPath));

  if (!isInsideRoot(rootPath, parentPath) || !isInsideRoot(rootPath, lexicalPath)) {
    throw new ProjectServiceError(
      "Path resolves outside the project root.",
      "outside-root"
    );
  }

  return lexicalPath;
}

async function ensureWritableParentPath(
  rootPath: string,
  parentPath: string
): Promise<string> {
  try {
    return await realpath(parentPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const existingAncestor = await findExistingAncestor(parentPath);

  if (!isInsideRoot(rootPath, existingAncestor)) {
    throw new ProjectServiceError(
      "Path resolves outside the project root.",
      "outside-root"
    );
  }

  await mkdir(parentPath, { recursive: true });
  const resolvedParent = await realpath(parentPath);

  if (!isInsideRoot(rootPath, resolvedParent)) {
    throw new ProjectServiceError(
      "Path resolves outside the project root.",
      "outside-root"
    );
  }

  return resolvedParent;
}

async function findExistingAncestor(path: string): Promise<string> {
  let currentPath = path;

  for (;;) {
    try {
      return await realpath(currentPath);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw error;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      currentPath = parentPath;
    }
  }
}

function resolveLexicalProjectPath(rootPath: string, projectPath: string): string {
  if (!isNonEmptyString(projectPath) || isAbsolute(projectPath)) {
    throw new ProjectServiceError("Project path must be relative.", "outside-root");
  }

  const normalizedPath = normalize(projectPath);

  if (normalizedPath === ".." || normalizedPath.startsWith(`..${sep}`)) {
    throw new ProjectServiceError(
      "Project path cannot traverse outside root.",
      "outside-root"
    );
  }

  const resolvedPath = resolve(rootPath, normalizedPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new ProjectServiceError(
      "Path resolves outside the project root.",
      "outside-root"
    );
  }

  return resolvedPath;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function assertPathDoesNotExist(absolutePath: string): Promise<void> {
  try {
    await stat(absolutePath);
  } catch {
    return;
  }

  throw new ProjectServiceError("Target path already exists.", "invalid-name");
}

function validateEntryName(name: string): string {
  if (
    !isNonEmptyString(name) ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new ProjectServiceError("Entry name is invalid.", "invalid-name");
  }

  return name;
}

function compareDirectoryEntries(
  left: { readonly isDirectory: () => boolean; readonly name: string },
  right: { readonly isDirectory: () => boolean; readonly name: string }
) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function flattenTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children === undefined ? [] : flattenTree(node.children))
  ]);
}

function getTexFilePaths(nodes: readonly ProjectFileTreeNode[]): readonly string[] {
  return flattenTree(nodes)
    .filter((node) => node.kind === "file" && node.path.endsWith(".tex"))
    .map((node) => node.path);
}

function getAvailableMainFilePath(
  nodes: readonly ProjectFileTreeNode[],
  mainFilePath: string | undefined
): string | undefined {
  if (mainFilePath === undefined) {
    return undefined;
  }

  return flattenTree(nodes).some(
    (node) => node.kind === "file" && node.path === mainFilePath
  )
    ? mainFilePath
    : undefined;
}

function toProjectPath(rootPath: string, absolutePath: string): string {
  const projectPath = relative(rootPath, absolutePath);
  return projectPath === "" ? "." : projectPath.split(sep).join("/");
}

function isInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RecentProject>;
  return (
    isNonEmptyString(candidate.rootPath) &&
    isNonEmptyString(candidate.displayName) &&
    isNonEmptyString(candidate.lastOpenedAt) &&
    (candidate.mainFilePath === undefined || isNonEmptyString(candidate.mainFilePath))
  );
}

function isProjectSettingsRecord(
  value: unknown
): value is Readonly<Record<string, ProjectSettings>> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every((settings) => {
    if (typeof settings !== "object" || settings === null) {
      return false;
    }

    const candidate = settings as Partial<ProjectSettings>;
    return (
      candidate.mainFilePath === undefined || isNonEmptyString(candidate.mainFilePath)
    );
  });
}

function withOptionalMainFile(
  project: Omit<ProjectSummary, "mainFilePath">,
  mainFilePath: string | undefined
): ProjectSummary {
  return mainFilePath === undefined ? project : { ...project, mainFilePath };
}
