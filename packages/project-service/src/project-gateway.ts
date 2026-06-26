import { randomUUID } from "node:crypto";

import {
  type ProjectDeleteBackup,
  type ProjectEntryKind,
  type ProjectFileSnapshot,
  type ProjectFileTreeNode,
  ProjectMetadataStore,
  type ProjectOpenResult,
  type RecentProject,
  createProjectEntry,
  deleteProjectEntry,
  listProjectTree,
  moveProjectEntry,
  openProject,
  readProjectFile,
  refreshProject,
  renameProjectEntry,
  setProjectMainFile,
  validateProjectRoot,
  writeProjectFile
} from "./index.js";

export type ProjectBackendKind = "local" | "shared";

export type ProjectSyncState =
  | "local-only"
  | "synced"
  | "syncing"
  | "offline"
  | "conflict"
  | "read-only";

export type LocalProjectHandle = {
  readonly id: string;
  readonly backend: "local";
  readonly displayName: string;
  readonly rootPath: string;
  readonly mainFilePath?: string;
  readonly syncState: "local-only";
};

export type SharedProjectHandle = {
  readonly id: string;
  readonly backend: "shared";
  readonly displayName: string;
  readonly sharedProjectId: string;
  readonly localCachePath?: string;
  readonly mainFilePath?: string;
  readonly syncState: Exclude<ProjectSyncState, "local-only">;
};

export type ProjectHandle = LocalProjectHandle | SharedProjectHandle;

export type ProjectSession = {
  readonly id: string;
  readonly handle: ProjectHandle;
  readonly openedAt: string;
};

export type ProjectGatewayOpenResult = ProjectOpenResult & {
  readonly session: ProjectSession;
};

export type ProjectWriteResult = {
  readonly saved: true;
  readonly mtimeMs: number;
};

export type ProjectBackendAdapter<THandle extends ProjectHandle = ProjectHandle> = {
  readonly backend: THandle["backend"];
  listRecentProjects(): Promise<readonly THandle[]>;
  openProject(handle: THandle): Promise<ProjectOpenResult>;
  refreshProject(handle: THandle): Promise<ProjectOpenResult>;
  listFiles(handle: THandle): Promise<readonly ProjectFileTreeNode[]>;
  readFile(handle: THandle, path: string): Promise<ProjectFileSnapshot>;
  writeFile(
    handle: THandle,
    path: string,
    contents: string
  ): Promise<ProjectWriteResult>;
  createEntry(
    handle: THandle,
    parentPath: string,
    name: string,
    kind: ProjectEntryKind
  ): Promise<ProjectOpenResult>;
  renameEntry(
    handle: THandle,
    path: string,
    newName: string
  ): Promise<ProjectOpenResult>;
  moveEntry(handle: THandle, path: string, newPath: string): Promise<ProjectOpenResult>;
  deleteEntry(
    handle: THandle,
    path: string
  ): Promise<ProjectOpenResult & { readonly deletedEntry: ProjectDeleteBackup }>;
  setMainFile(handle: THandle, path: string): Promise<ProjectOpenResult>;
};

export class ProjectGateway {
  private readonly adapters: ReadonlyMap<ProjectBackendKind, ProjectBackendAdapter>;
  private readonly sessions = new Map<string, ProjectGatewaySessionRecord>();

  constructor(adapters: readonly ProjectBackendAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.backend, adapter]));
  }

  async listRecentProjects(): Promise<readonly ProjectHandle[]> {
    const projectLists = await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.listRecentProjects())
    );

    return projectLists.flat();
  }

  async openProject(handle: ProjectHandle): Promise<ProjectGatewayOpenResult> {
    const adapter = this.getAdapter(handle.backend);
    const openedProject = await adapter.openProject(handle);
    const session: ProjectSession = {
      id: randomUUID(),
      handle: normalizeOpenedHandle(handle, openedProject),
      openedAt: new Date().toISOString()
    };

    this.sessions.set(session.id, {
      adapter,
      session
    });

    return {
      ...openedProject,
      session
    };
  }

  async refreshProject(sessionId: string): Promise<ProjectOpenResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.refreshProject(record.session.handle);
  }

  async listFiles(sessionId: string): Promise<readonly ProjectFileTreeNode[]> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.listFiles(record.session.handle);
  }

  async readFile(sessionId: string, path: string): Promise<ProjectFileSnapshot> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.readFile(record.session.handle, path);
  }

  async writeFile(
    sessionId: string,
    path: string,
    contents: string
  ): Promise<ProjectWriteResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.writeFile(record.session.handle, path, contents);
  }

  async createEntry(
    sessionId: string,
    parentPath: string,
    name: string,
    kind: ProjectEntryKind
  ): Promise<ProjectOpenResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.createEntry(record.session.handle, parentPath, name, kind);
  }

  async renameEntry(
    sessionId: string,
    path: string,
    newName: string
  ): Promise<ProjectOpenResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.renameEntry(record.session.handle, path, newName);
  }

  async moveEntry(
    sessionId: string,
    path: string,
    newPath: string
  ): Promise<ProjectOpenResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.moveEntry(record.session.handle, path, newPath);
  }

  async deleteEntry(
    sessionId: string,
    path: string
  ): Promise<ProjectOpenResult & { readonly deletedEntry: ProjectDeleteBackup }> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.deleteEntry(record.session.handle, path);
  }

  async setMainFile(sessionId: string, path: string): Promise<ProjectOpenResult> {
    const record = this.getSessionRecord(sessionId);
    return record.adapter.setMainFile(record.session.handle, path);
  }

  private getAdapter(backend: ProjectBackendKind): ProjectBackendAdapter {
    const adapter = this.adapters.get(backend);

    if (adapter === undefined) {
      throw new ProjectGatewayError(
        `No project adapter is registered for ${backend} projects.`,
        "missing-adapter"
      );
    }

    return adapter;
  }

  private getSessionRecord(sessionId: string): ProjectGatewaySessionRecord {
    const record = this.sessions.get(sessionId);

    if (record === undefined) {
      throw new ProjectGatewayError(
        "Project session was not found.",
        "missing-session"
      );
    }

    return record;
  }
}

export class LocalProjectAdapter implements ProjectBackendAdapter<LocalProjectHandle> {
  readonly backend = "local" as const;

  constructor(private readonly metadataStore: ProjectMetadataStore) {}

  async listRecentProjects(): Promise<readonly LocalProjectHandle[]> {
    return Promise.all(
      (await this.metadataStore.listRecentProjects()).map((project) =>
        createLocalProjectHandle(project)
      )
    );
  }

  async openProject(handle: LocalProjectHandle): Promise<ProjectOpenResult> {
    return openProject(handle.rootPath, this.metadataStore);
  }

  async refreshProject(handle: LocalProjectHandle): Promise<ProjectOpenResult> {
    return refreshProject(handle.rootPath, this.metadataStore);
  }

  async listFiles(handle: LocalProjectHandle): Promise<readonly ProjectFileTreeNode[]> {
    return listProjectTree(handle.rootPath);
  }

  async readFile(
    handle: LocalProjectHandle,
    path: string
  ): Promise<ProjectFileSnapshot> {
    return readProjectFile(handle.rootPath, path);
  }

  async writeFile(
    handle: LocalProjectHandle,
    path: string,
    contents: string
  ): Promise<ProjectWriteResult> {
    return writeProjectFile(handle.rootPath, path, contents);
  }

  async createEntry(
    handle: LocalProjectHandle,
    parentPath: string,
    name: string,
    kind: ProjectEntryKind
  ): Promise<ProjectOpenResult> {
    await createProjectEntry(handle.rootPath, parentPath, name, kind);
    return refreshProject(handle.rootPath, this.metadataStore);
  }

  async renameEntry(
    handle: LocalProjectHandle,
    path: string,
    newName: string
  ): Promise<ProjectOpenResult> {
    await renameProjectEntry(handle.rootPath, path, newName);
    return refreshProject(handle.rootPath, this.metadataStore);
  }

  async moveEntry(
    handle: LocalProjectHandle,
    path: string,
    newPath: string
  ): Promise<ProjectOpenResult> {
    await moveProjectEntry(handle.rootPath, path, newPath);
    return refreshProject(handle.rootPath, this.metadataStore);
  }

  async deleteEntry(
    handle: LocalProjectHandle,
    path: string
  ): Promise<ProjectOpenResult & { readonly deletedEntry: ProjectDeleteBackup }> {
    const deletedEntry = await deleteProjectEntry(handle.rootPath, path);
    const result = await refreshProject(handle.rootPath, this.metadataStore);
    return { ...result, deletedEntry };
  }

  async setMainFile(
    handle: LocalProjectHandle,
    path: string
  ): Promise<ProjectOpenResult> {
    return setProjectMainFile(handle.rootPath, this.metadataStore, path);
  }
}

export class ProjectGatewayError extends Error {
  constructor(
    message: string,
    readonly code: "missing-adapter" | "missing-session"
  ) {
    super(message);
    this.name = "ProjectGatewayError";
  }
}

export async function createLocalProjectHandle(
  project: Pick<RecentProject, "rootPath" | "displayName" | "mainFilePath">
): Promise<LocalProjectHandle> {
  const rootPath = await validateProjectRoot(project.rootPath);
  return withOptionalMainFile(
    {
      id: `local:${rootPath}`,
      backend: "local",
      displayName: project.displayName,
      rootPath,
      syncState: "local-only"
    },
    project.mainFilePath
  );
}

type ProjectGatewaySessionRecord = {
  readonly adapter: ProjectBackendAdapter;
  readonly session: ProjectSession;
};

function normalizeOpenedHandle(
  handle: ProjectHandle,
  openedProject: ProjectOpenResult
): ProjectHandle {
  if (handle.backend === "local") {
    return withOptionalMainFile(
      {
        ...handle,
        displayName: openedProject.project.displayName,
        rootPath: openedProject.project.rootPath
      },
      openedProject.project.mainFilePath
    );
  }

  return withOptionalMainFile(
    {
      ...handle,
      localCachePath: openedProject.project.rootPath
    },
    openedProject.project.mainFilePath
  );
}

function withOptionalMainFile<T extends object>(
  target: T,
  mainFilePath: string | undefined
): T & { readonly mainFilePath?: string } {
  return mainFilePath === undefined ? target : { ...target, mainFilePath };
}
