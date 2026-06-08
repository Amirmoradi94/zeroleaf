import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChangeSetStatus =
  | "proposed"
  | "applied"
  | "rejected"
  | "reverted"
  | "failed";

export type HistorySnapshot = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly contentHash: string;
  readonly createdAt: string;
};

export type HistoryChangeSet = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly summary: string;
  readonly patch: string;
  readonly status: ChangeSetStatus;
  readonly baseSnapshotId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly revertedAt?: string;
};

export type AuditEvent = {
  readonly id: string;
  readonly projectRoot: string;
  readonly eventType: string;
  readonly message: string;
  readonly createdAt: string;
  readonly changesetId?: string;
};

export type SnapshotFileRequest = {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly contents?: string;
};

export type CreateChangeSetRequest = {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly beforeContents: string;
  readonly afterContents: string;
  readonly summary: string;
};

export type RecordAuditEventRequest = {
  readonly projectRoot: string;
  readonly eventType: string;
  readonly message: string;
  readonly changesetId?: string;
};

export type HistoryPrivacySummary = {
  readonly projectCount: number;
  readonly snapshotCount: number;
  readonly changesetCount: number;
  readonly auditEventCount: number;
  readonly buildJobCount: number;
  readonly agentSessionCount: number;
};

export class HistoryServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "empty-change"
      | "invalid-root"
      | "missing-changeset"
      | "outside-root"
      | "not-directory"
      | "not-file"
      | "invalid-state"
  ) {
    super(message);
    this.name = "HistoryServiceError";
  }
}

type ProjectRow = {
  readonly id: string;
  readonly root_path: string;
};

type ChangeSetRow = {
  readonly id: string;
  readonly project_root: string;
  readonly file_path: string;
  readonly summary: string;
  readonly patch: string;
  readonly status: ChangeSetStatus;
  readonly before_snapshot_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly applied_at: string | null;
  readonly reverted_at: string | null;
};

type ChangeSetContentsRow = ChangeSetRow & {
  readonly before_contents: string;
  readonly after_contents: string;
};

type AuditEventRow = {
  readonly id: string;
  readonly project_root: string;
  readonly changeset_id: string | null;
  readonly event_type: string;
  readonly message: string;
  readonly created_at: string;
};

export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async snapshotFile(request: SnapshotFileRequest): Promise<HistorySnapshot> {
    const root = await validateProjectRoot(request.projectRoot);
    const filePath =
      request.contents === undefined
        ? toProjectPath(root, await resolveExistingProjectPath(root, request.filePath))
        : normalizeProjectPath(root, request.filePath);
    const contents =
      request.contents === undefined
        ? await readFile(await resolveExistingProjectPath(root, filePath), "utf8")
        : request.contents;
    const projectId = this.upsertProject(root);
    const snapshot = {
      id: randomUUID(),
      projectRoot: root,
      filePath,
      contentHash: hashContents(contents),
      createdAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `insert into snapshots
          (id, project_id, project_root, file_path, content_hash, contents, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        projectId,
        snapshot.projectRoot,
        snapshot.filePath,
        snapshot.contentHash,
        contents,
        snapshot.createdAt
      );
    this.recordAudit(
      projectId,
      root,
      null,
      "snapshot.created",
      `Snapshotted ${filePath}`
    );

    return snapshot;
  }

  async createChangeSet(request: CreateChangeSetRequest): Promise<HistoryChangeSet> {
    const root = await validateProjectRoot(request.projectRoot);
    const filePath = normalizeProjectPath(root, request.filePath);

    if (request.beforeContents === request.afterContents) {
      throw new HistoryServiceError("Changeset cannot be empty.", "empty-change");
    }

    const projectId = this.upsertProject(root);
    const baseSnapshot = await this.snapshotFile({
      projectRoot: root,
      filePath,
      contents: request.beforeContents
    });
    const now = new Date().toISOString();
    const changeset = {
      id: randomUUID(),
      projectRoot: root,
      filePath,
      summary: normalizeSummary(request.summary),
      patch: generateUnifiedDiff(
        filePath,
        request.beforeContents,
        request.afterContents
      ),
      status: "proposed" as const,
      baseSnapshotId: baseSnapshot.id,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `insert into changesets
          (
            id, project_id, project_root, file_path, summary, patch, status,
            before_snapshot_id, before_contents, after_contents, created_at, updated_at
          )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        changeset.id,
        projectId,
        changeset.projectRoot,
        changeset.filePath,
        changeset.summary,
        changeset.patch,
        changeset.status,
        changeset.baseSnapshotId,
        request.beforeContents,
        request.afterContents,
        changeset.createdAt,
        changeset.updatedAt
      );
    this.recordAudit(
      projectId,
      root,
      changeset.id,
      "changeset.created",
      changeset.summary
    );

    return changeset;
  }

  async listChangeSets(projectRoot: string): Promise<readonly HistoryChangeSet[]> {
    const root = await validateProjectRoot(projectRoot);
    this.upsertProject(root);
    const rows = this.db
      .prepare(
        `select id, project_root, file_path, summary, patch, status,
                before_snapshot_id, created_at, updated_at, applied_at, reverted_at
           from changesets
          where project_root = ?
          order by created_at desc`
      )
      .all(root) as ChangeSetRow[];

    return rows.map(toChangeSet);
  }

  getChangeSet(changesetId: string): HistoryChangeSet {
    return toChangeSet(this.getChangeSetRow(changesetId));
  }

  async applyChangeSet(changesetId: string): Promise<HistoryChangeSet> {
    const changeset = this.getChangeSetRowWithContents(changesetId);

    if (changeset.status !== "proposed") {
      throw new HistoryServiceError(
        "Only proposed changesets can be applied.",
        "invalid-state"
      );
    }

    await writeProjectFile(
      changeset.project_root,
      changeset.file_path,
      changeset.after_contents
    );

    const appliedAt = new Date().toISOString();
    this.updateChangeSetStatus(changeset.id, "applied", appliedAt, null);
    this.recordAuditForChangeSet(
      changeset,
      "changeset.applied",
      `Applied ${changeset.summary}`
    );

    return this.getChangeSet(changeset.id);
  }

  rejectChangeSet(changesetId: string): HistoryChangeSet {
    const changeset = this.getChangeSetRowWithContents(changesetId);

    if (changeset.status !== "proposed") {
      throw new HistoryServiceError(
        "Only proposed changesets can be rejected.",
        "invalid-state"
      );
    }

    this.updateChangeSetStatus(changeset.id, "rejected", null, null);
    this.recordAuditForChangeSet(
      changeset,
      "changeset.rejected",
      `Rejected ${changeset.summary}`
    );

    return this.getChangeSet(changeset.id);
  }

  async rollbackChangeSet(changesetId: string): Promise<HistoryChangeSet> {
    const changeset = this.getChangeSetRowWithContents(changesetId);

    if (changeset.status !== "applied") {
      throw new HistoryServiceError(
        "Only applied changesets can be rolled back.",
        "invalid-state"
      );
    }

    const currentContents = await readFile(
      await resolveExistingProjectPath(changeset.project_root, changeset.file_path),
      "utf8"
    );
    await this.snapshotFile({
      projectRoot: changeset.project_root,
      filePath: changeset.file_path,
      contents: currentContents
    });
    await writeProjectFile(
      changeset.project_root,
      changeset.file_path,
      changeset.before_contents
    );

    const revertedAt = new Date().toISOString();
    this.updateChangeSetStatus(changeset.id, "reverted", null, revertedAt);
    this.recordAuditForChangeSet(
      changeset,
      "changeset.reverted",
      `Rolled back ${changeset.summary}`
    );

    return this.getChangeSet(changeset.id);
  }

  async listAuditEvents(projectRoot: string): Promise<readonly AuditEvent[]> {
    const root = await validateProjectRoot(projectRoot);
    this.upsertProject(root);
    const rows = this.db
      .prepare(
        `select id, project_root, changeset_id, event_type, message, created_at
           from audit_events
          where project_root = ?
          order by created_at desc
          limit 200`
      )
      .all(root) as AuditEventRow[];

    return rows.map((row) => {
      const event = {
        id: row.id,
        projectRoot: row.project_root,
        eventType: row.event_type,
        message: row.message,
        createdAt: row.created_at
      };

      return row.changeset_id === null
        ? event
        : {
            ...event,
            changesetId: row.changeset_id
          };
    });
  }

  async recordAuditEvent(request: RecordAuditEventRequest): Promise<AuditEvent> {
    const root = await validateProjectRoot(request.projectRoot);
    const projectId = this.upsertProject(root);
    const event = {
      id: randomUUID(),
      projectRoot: root,
      eventType: normalizeAuditText(request.eventType),
      message: normalizeAuditText(request.message),
      createdAt: new Date().toISOString(),
      ...(request.changesetId === undefined ? {} : { changesetId: request.changesetId })
    };

    this.db
      .prepare(
        `insert into audit_events
          (id, project_id, project_root, changeset_id, event_type, message, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        projectId,
        event.projectRoot,
        event.changesetId ?? null,
        event.eventType,
        event.message,
        event.createdAt
      );

    return event;
  }

  getPrivacySummary(): HistoryPrivacySummary {
    return {
      projectCount: this.countRows("projects"),
      snapshotCount: this.countRows("snapshots"),
      changesetCount: this.countRows("changesets"),
      auditEventCount: this.countRows("audit_events"),
      buildJobCount: this.countRows("build_jobs"),
      agentSessionCount: this.countRows("agent_sessions")
    };
  }

  clearAll(): HistoryPrivacySummary {
    this.db.exec(`
      delete from audit_events;
      delete from changesets;
      delete from snapshots;
      delete from agent_sessions;
      delete from build_jobs;
      delete from projects;
      vacuum;
    `);
    return this.getPrivacySummary();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists projects (
        id text primary key,
        root_path text not null unique,
        display_name text not null,
        created_at text not null,
        last_opened_at text not null
      );

      create table if not exists build_jobs (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        status text not null,
        main_file_path text not null,
        compiler text not null,
        started_at text not null,
        finished_at text
      );

      create table if not exists agent_sessions (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        provider_id text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists snapshots (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        project_root text not null,
        file_path text not null,
        content_hash text not null,
        contents text not null,
        created_at text not null
      );

      create table if not exists changesets (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        project_root text not null,
        file_path text not null,
        summary text not null,
        patch text not null,
        status text not null,
        before_snapshot_id text not null references snapshots(id),
        before_contents text not null,
        after_contents text not null,
        created_at text not null,
        updated_at text not null,
        applied_at text,
        reverted_at text
      );

      create table if not exists audit_events (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        project_root text not null,
        changeset_id text references changesets(id),
        event_type text not null,
        message text not null,
        created_at text not null
      );
    `);
  }

  private upsertProject(projectRoot: string): string {
    const existing = this.db
      .prepare("select id, root_path from projects where root_path = ?")
      .get(projectRoot) as ProjectRow | undefined;
    const now = new Date().toISOString();

    if (existing !== undefined) {
      this.db
        .prepare("update projects set last_opened_at = ? where id = ?")
        .run(now, existing.id);
      return existing.id;
    }

    const projectId = randomUUID();
    const displayName = projectRoot.split(/[\\/]/).at(-1) ?? projectRoot;
    this.db
      .prepare(
        `insert into projects (id, root_path, display_name, created_at, last_opened_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(projectId, projectRoot, displayName, now, now);

    return projectId;
  }

  private getChangeSetRow(changesetId: string): ChangeSetRow {
    const row = this.db
      .prepare(
        `select id, project_root, file_path, summary, patch, status,
                before_snapshot_id, created_at, updated_at, applied_at, reverted_at
           from changesets
          where id = ?`
      )
      .get(changesetId) as ChangeSetRow | undefined;

    if (row === undefined) {
      throw new HistoryServiceError("Changeset not found.", "missing-changeset");
    }

    return row;
  }

  private getChangeSetRowWithContents(changesetId: string): ChangeSetContentsRow {
    const row = this.db
      .prepare(
        `select id, project_root, file_path, summary, patch, status,
                before_snapshot_id, before_contents, after_contents,
                created_at, updated_at, applied_at, reverted_at
           from changesets
          where id = ?`
      )
      .get(changesetId) as ChangeSetContentsRow | undefined;

    if (row === undefined) {
      throw new HistoryServiceError("Changeset not found.", "missing-changeset");
    }

    return row;
  }

  private updateChangeSetStatus(
    changesetId: string,
    status: ChangeSetStatus,
    appliedAt: string | null,
    revertedAt: string | null
  ): void {
    this.db
      .prepare(
        `update changesets
            set status = ?,
                updated_at = ?,
                applied_at = coalesce(?, applied_at),
                reverted_at = coalesce(?, reverted_at)
          where id = ?`
      )
      .run(status, new Date().toISOString(), appliedAt, revertedAt, changesetId);
  }

  private recordAuditForChangeSet(
    changeset: ChangeSetContentsRow,
    eventType: string,
    message: string
  ): void {
    const projectId = this.upsertProject(changeset.project_root);
    this.recordAudit(
      projectId,
      changeset.project_root,
      changeset.id,
      eventType,
      message
    );
  }

  private recordAudit(
    projectId: string,
    projectRoot: string,
    changesetId: string | null,
    eventType: string,
    message: string
  ): void {
    this.db
      .prepare(
        `insert into audit_events
          (id, project_id, project_root, changeset_id, event_type, message, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        projectId,
        projectRoot,
        changesetId,
        eventType,
        message,
        new Date().toISOString()
      );
  }

  private countRows(tableName: string): number {
    const row = this.db.prepare(`select count(*) as count from ${tableName}`).get() as
      | { readonly count: number }
      | undefined;
    return row?.count ?? 0;
  }
}

export function generateUnifiedDiff(
  filePath: string,
  beforeContents: string,
  afterContents: string
): string {
  const beforeLines = splitDiffLines(beforeContents);
  const afterLines = splitDiffLines(afterContents);
  const diffLines = diffLineEntries(beforeLines, afterLines);
  const oldCount = Math.max(beforeLines.length, 1);
  const newCount = Math.max(afterLines.length, 1);

  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...diffLines
  ].join("\n");
}

function diffLineEntries(
  beforeLines: readonly string[],
  afterLines: readonly string[]
): readonly string[] {
  const table = buildLcsTable(beforeLines, afterLines);
  const output: string[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      output.push(` ${beforeLines[beforeIndex] ?? ""}`);
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      getTableScore(table, beforeIndex + 1, afterIndex) >=
      getTableScore(table, beforeIndex, afterIndex + 1)
    ) {
      output.push(`-${beforeLines[beforeIndex] ?? ""}`);
      beforeIndex += 1;
    } else {
      output.push(`+${afterLines[afterIndex] ?? ""}`);
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    output.push(`-${beforeLines[beforeIndex] ?? ""}`);
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    output.push(`+${afterLines[afterIndex] ?? ""}`);
    afterIndex += 1;
  }

  return output.length === 0 ? [" "] : output;
}

function buildLcsTable(
  beforeLines: readonly string[],
  afterLines: readonly string[]
): number[][] {
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0)
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const currentRow = table[beforeIndex];

      if (currentRow === undefined) {
        continue;
      }

      currentRow[afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? 1 + (table[beforeIndex + 1]?.[afterIndex + 1] ?? 0)
          : Math.max(
              table[beforeIndex + 1]?.[afterIndex] ?? 0,
              table[beforeIndex]?.[afterIndex + 1] ?? 0
            );
    }
  }

  return table;
}

function getTableScore(
  table: readonly (readonly number[])[],
  rowIndex: number,
  columnIndex: number
): number {
  return table[rowIndex]?.[columnIndex] ?? 0;
}

function splitDiffLines(contents: string): readonly string[] {
  if (contents.length === 0) {
    return [];
  }

  return contents.replace(/\n$/, "").split("\n");
}

function toChangeSet(row: ChangeSetRow): HistoryChangeSet {
  const changeset = {
    id: row.id,
    projectRoot: row.project_root,
    filePath: row.file_path,
    summary: row.summary,
    patch: row.patch,
    status: row.status,
    baseSnapshotId: row.before_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? undefined,
    revertedAt: row.reverted_at ?? undefined
  };

  return {
    id: changeset.id,
    projectRoot: changeset.projectRoot,
    filePath: changeset.filePath,
    summary: changeset.summary,
    patch: changeset.patch,
    status: changeset.status,
    baseSnapshotId: changeset.baseSnapshotId,
    createdAt: changeset.createdAt,
    updatedAt: changeset.updatedAt,
    ...(changeset.appliedAt === undefined ? {} : { appliedAt: changeset.appliedAt }),
    ...(changeset.revertedAt === undefined ? {} : { revertedAt: changeset.revertedAt })
  };
}

async function validateProjectRoot(rootPath: string): Promise<string> {
  if (rootPath.length === 0) {
    throw new HistoryServiceError("Project root is required.", "invalid-root");
  }

  const resolvedRoot = await realpath(rootPath);
  const rootStats = await stat(resolvedRoot);

  if (!rootStats.isDirectory()) {
    throw new HistoryServiceError("Project root must be a directory.", "not-directory");
  }

  return resolvedRoot;
}

async function writeProjectFile(
  projectRoot: string,
  projectPath: string,
  contents: string
): Promise<void> {
  const root = await validateProjectRoot(projectRoot);
  const targetPath = await resolveWritableProjectPath(root, projectPath);

  await writeFile(targetPath, contents, "utf8");
}

async function resolveExistingProjectPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  const lexicalPath = resolveLexicalProjectPath(rootPath, projectPath);
  const resolvedPath = await realpath(lexicalPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
  }

  const fileStats = await stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new HistoryServiceError("Path must resolve to a file.", "not-file");
  }

  return resolvedPath;
}

async function resolveWritableProjectPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  const lexicalPath = resolveLexicalProjectPath(rootPath, projectPath);
  const parentPath = await realpath(dirname(lexicalPath));

  if (!isInsideRoot(rootPath, parentPath) || !isInsideRoot(rootPath, lexicalPath)) {
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
  }

  return lexicalPath;
}

function normalizeProjectPath(rootPath: string, projectPath: string): string {
  return toProjectPath(rootPath, resolveLexicalProjectPath(rootPath, projectPath));
}

function resolveLexicalProjectPath(rootPath: string, projectPath: string): string {
  if (projectPath.length === 0 || isAbsolute(projectPath)) {
    throw new HistoryServiceError("Project path must be relative.", "outside-root");
  }

  const normalizedPath = normalize(projectPath);

  if (normalizedPath === ".." || normalizedPath.startsWith(`..${sep}`)) {
    throw new HistoryServiceError("Project path cannot leave root.", "outside-root");
  }

  const resolvedPath = resolve(rootPath, normalizedPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
  }

  return resolvedPath;
}

function toProjectPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

function isInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(rootPath, absolutePath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length === 0 ? "Unsaved editor changes" : trimmed.slice(0, 160);
}

function normalizeAuditText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "agent.event" : trimmed.slice(0, 500);
}
