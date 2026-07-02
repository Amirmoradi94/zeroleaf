import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

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

export type HistoryChangeSetWithContents = HistoryChangeSet & {
  readonly beforeContents: string;
  readonly afterContents: string;
};

export type WordDocumentBlockKind = "paragraph";

export type WordDocumentBlock = {
  readonly id: string;
  readonly kind: WordDocumentBlockKind;
  readonly text: string;
};

export type WordParagraphBlockOperation =
  | {
      readonly type: "replace-block";
      readonly blockId: string;
      readonly afterText: string;
    }
  | {
      readonly type: "insert-block-after";
      readonly afterBlockId?: string;
      readonly block: WordDocumentBlock;
    }
  | {
      readonly type: "delete-block";
      readonly blockId: string;
    }
  | {
      readonly type: "move-block";
      readonly blockId: string;
      readonly afterBlockId?: string;
    }
  | {
      readonly type: "replace-selection";
      readonly blockId: string;
      readonly startOffset: number;
      readonly endOffset: number;
      readonly replacementText: string;
    };

export type WordTableCellRef = {
  readonly rowIndex: number;
  readonly columnIndex: number;
};

export type WordTableOperation =
  | {
      readonly type: "replace-table-cell";
      readonly tableId: string;
      readonly rowIndex: number;
      readonly columnIndex: number;
      readonly afterText: string;
    }
  | {
      readonly type: "insert-table-row";
      readonly tableId: string;
      readonly anchorRowIndex: number;
      readonly position: "before" | "after";
    }
  | {
      readonly type: "delete-table-row";
      readonly tableId: string;
      readonly rowIndex: number;
    }
  | {
      readonly type: "insert-table-column";
      readonly tableId: string;
      readonly anchorColumnIndex: number;
      readonly position: "before" | "after";
    }
  | {
      readonly type: "delete-table-column";
      readonly tableId: string;
      readonly columnIndex: number;
    }
  | {
      readonly type: "merge-table-cells";
      readonly tableId: string;
      readonly cells: readonly WordTableCellRef[];
    };

export type WordBlockOperation = WordParagraphBlockOperation | WordTableOperation;

export type WordChangeSetStatus =
  | "proposed"
  | "applied"
  | "rejected"
  | "reverted"
  | "failed";

export type WordChangeSet = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly summary: string;
  readonly baseBlocks: readonly WordDocumentBlock[];
  readonly operations: readonly WordBlockOperation[];
  readonly status: WordChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly revertedAt?: string;
  readonly beforeSnapshotId?: string;
  readonly appliedContentHash?: string;
};

export type WordDocumentSnapshot = {
  readonly id: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly createdAt: string;
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

export type CreateAppliedChangeSetRequest = CreateChangeSetRequest;

export type ApplyChangeSetHunksRequest = {
  readonly changesetId: string;
  readonly acceptedHunkIndexes: readonly number[];
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
      | "invalid-hunk"
      | "rollback-conflict"
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

type WordChangeSetRow = {
  readonly id: string;
  readonly project_root: string;
  readonly file_path: string;
  readonly summary: string;
  readonly base_blocks_json: string;
  readonly operations_json: string;
  readonly status: WordChangeSetStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly applied_at: string | null;
  readonly reverted_at: string | null;
  readonly before_snapshot_id: string | null;
  readonly applied_content_hash: string | null;
};

type WordDocumentSnapshotRow = {
  readonly id: string;
  readonly project_root: string;
  readonly file_path: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly contents_base64: string;
  readonly created_at: string;
};

type SqliteStatement = {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): readonly unknown[];
};

type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

const requireRuntimeModule = createRequire(import.meta.url);

function openHistoryDatabase(dbPath: string): SqliteDatabase {
  try {
    const sqlite = requireRuntimeModule("node:sqlite") as {
      readonly DatabaseSync: new (path: string) => SqliteDatabase;
    };
    return new sqlite.DatabaseSync(dbPath);
  } catch (error) {
    if (!isMissingRuntimeModuleError(error)) {
      throw error;
    }
  }

  const betterSqliteModule = requireRuntimeModule("better-sqlite3") as
    | (new (path: string) => SqliteDatabase)
    | { readonly default?: new (path: string) => SqliteDatabase };
  const BetterSqliteDatabase =
    typeof betterSqliteModule === "function"
      ? betterSqliteModule
      : betterSqliteModule.default;

  if (BetterSqliteDatabase === undefined) {
    throw new Error("better-sqlite3 did not export a database constructor.");
  }

  return new BetterSqliteDatabase(dbPath);
}

function isMissingRuntimeModuleError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
      (error as { readonly code?: unknown }).code === "MODULE_NOT_FOUND")
  );
}

export class HistoryStore {
  private readonly db: SqliteDatabase;

  constructor(readonly dbPath: string) {
    this.db = openHistoryDatabase(dbPath);
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
    return await this.createChangeSetRecord(request, "proposed");
  }

  async createAppliedChangeSet(
    request: CreateAppliedChangeSetRequest
  ): Promise<HistoryChangeSet> {
    return await this.createChangeSetRecord(request, "applied");
  }

  private async createChangeSetRecord(
    request: CreateChangeSetRequest,
    status: "proposed" | "applied"
  ): Promise<HistoryChangeSet> {
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
      status,
      baseSnapshotId: baseSnapshot.id,
      createdAt: now,
      updatedAt: now,
      ...(status === "applied" ? { appliedAt: now } : {})
    };

    this.db
      .prepare(
        `insert into changesets
          (
            id, project_id, project_root, file_path, summary, patch, status,
            before_snapshot_id, before_contents, after_contents, created_at,
            updated_at, applied_at
          )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        changeset.updatedAt,
        changeset.appliedAt ?? null
      );
    this.recordAudit(
      projectId,
      root,
      changeset.id,
      "changeset.created",
      changeset.summary
    );
    if (status === "applied") {
      this.recordAudit(
        projectId,
        root,
        changeset.id,
        "changeset.applied",
        `Saved ${filePath}`
      );
    }

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

  async listWordChangeSets(projectRoot: string): Promise<readonly WordChangeSet[]> {
    const root = await validateProjectRoot(projectRoot);
    this.upsertProject(root);
    const rows = this.db
      .prepare(
        `select id, project_root, file_path, summary, base_blocks_json,
                operations_json, status, created_at, updated_at, applied_at,
                reverted_at, before_snapshot_id, applied_content_hash
           from word_changesets
          where project_root = ?
          order by created_at desc`
      )
      .all(root) as WordChangeSetRow[];

    return rows.map(toWordChangeSet);
  }

  async createWordChangeSet(changeset: WordChangeSet): Promise<WordChangeSet> {
    const root = await validateProjectRoot(changeset.projectRoot);
    const filePath = normalizeProjectPath(root, changeset.filePath);
    const normalizedChangeSet = normalizeWordChangeSet({
      ...changeset,
      projectRoot: root,
      filePath,
      status: "proposed"
    });
    const projectId = this.upsertProject(root);

    this.db
      .prepare(
        `insert into word_changesets
          (
            id, project_id, project_root, file_path, summary, base_blocks_json,
            operations_json, status, created_at, updated_at, applied_at
          )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do nothing`
      )
      .run(
        normalizedChangeSet.id,
        projectId,
        normalizedChangeSet.projectRoot,
        normalizedChangeSet.filePath,
        normalizedChangeSet.summary,
        JSON.stringify(normalizedChangeSet.baseBlocks),
        JSON.stringify(normalizedChangeSet.operations),
        normalizedChangeSet.status,
        normalizedChangeSet.createdAt,
        normalizedChangeSet.updatedAt,
        normalizedChangeSet.appliedAt ?? null
      );
    this.recordAudit(
      projectId,
      root,
      null,
      "word-changeset.created",
      `Created Word changeset ${normalizedChangeSet.summary}`
    );

    return this.getWordChangeSet(normalizedChangeSet.id);
  }

  async createWordDocumentSnapshot(
    projectRoot: string,
    filePath: string
  ): Promise<WordDocumentSnapshot> {
    const root = await validateProjectRoot(projectRoot);
    const normalizedFilePath = normalizeProjectPath(root, filePath);
    const bytes = await readFile(
      await resolveExistingProjectPath(root, normalizedFilePath)
    );
    const projectId = this.upsertProject(root);
    const snapshot = {
      id: randomUUID(),
      projectRoot: root,
      filePath: normalizedFilePath,
      contentHash: hashBytes(bytes),
      byteLength: bytes.byteLength,
      createdAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `insert into word_document_snapshots
          (
            id, project_id, project_root, file_path, content_hash, byte_length,
            contents_base64, created_at
          )
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        projectId,
        snapshot.projectRoot,
        snapshot.filePath,
        snapshot.contentHash,
        snapshot.byteLength,
        bytes.toString("base64"),
        snapshot.createdAt
      );
    this.recordAudit(
      projectId,
      root,
      null,
      "word-snapshot.created",
      `Snapshotted ${normalizedFilePath}`
    );

    return snapshot;
  }

  async markWordChangeSetApplied(
    changeset: WordChangeSet,
    beforeSnapshotId?: string
  ): Promise<WordChangeSet> {
    const existing = this.getWordChangeSetRow(changeset.id);

    if (existing.status !== "proposed") {
      throw new HistoryServiceError(
        "Only proposed Word changesets can be applied.",
        "invalid-state"
      );
    }

    const appliedAt = changeset.appliedAt ?? new Date().toISOString();
    const normalizedChangeSet = normalizeWordChangeSet({
      ...changeset,
      projectRoot: existing.project_root,
      filePath: existing.file_path,
      status: "applied",
      appliedAt
    });
    const appliedContentHash = await hashProjectFile(
      existing.project_root,
      existing.file_path
    );
    this.db
      .prepare(
        `update word_changesets
            set status = ?,
                base_blocks_json = ?,
                operations_json = ?,
                updated_at = ?,
                applied_at = coalesce(?, applied_at),
                before_snapshot_id = coalesce(?, before_snapshot_id),
                applied_content_hash = ?
          where id = ?`
      )
      .run(
        "applied",
        JSON.stringify(normalizedChangeSet.baseBlocks),
        JSON.stringify(normalizedChangeSet.operations),
        normalizedChangeSet.updatedAt,
        appliedAt,
        beforeSnapshotId ?? normalizedChangeSet.beforeSnapshotId ?? null,
        appliedContentHash,
        changeset.id
      );
    this.recordAuditForWordChangeSet(
      existing,
      "word-changeset.applied",
      `Applied Word changeset ${existing.summary}`
    );

    return this.getWordChangeSet(changeset.id);
  }

  async rollbackWordChangeSet(changesetId: string): Promise<WordChangeSet> {
    const changeset = this.getWordChangeSetRow(changesetId);

    if (changeset.status !== "applied") {
      throw new HistoryServiceError(
        "Only applied Word changesets can be rolled back.",
        "invalid-state"
      );
    }

    if (changeset.before_snapshot_id === null) {
      throw new HistoryServiceError(
        "Word changeset has no binary snapshot to restore.",
        "invalid-state"
      );
    }

    if (changeset.applied_content_hash === null) {
      throw new HistoryServiceError(
        "Word changeset has no applied document hash.",
        "invalid-state"
      );
    }

    const currentHash = await hashProjectFile(
      changeset.project_root,
      changeset.file_path
    );

    if (currentHash !== changeset.applied_content_hash) {
      throw new HistoryServiceError(
        "Cannot roll back Word changeset because the document changed after the edit was applied.",
        "rollback-conflict"
      );
    }

    const snapshot = this.getWordDocumentSnapshotRow(changeset.before_snapshot_id);
    const snapshotBytes = Buffer.from(snapshot.contents_base64, "base64");

    if (hashBytes(snapshotBytes) !== snapshot.content_hash) {
      throw new HistoryServiceError(
        "Stored Word snapshot failed integrity verification.",
        "invalid-state"
      );
    }

    await writeProjectFileBytes(
      changeset.project_root,
      changeset.file_path,
      snapshotBytes
    );

    const revertedAt = new Date().toISOString();
    this.db
      .prepare(
        `update word_changesets
            set status = ?,
                updated_at = ?,
                reverted_at = ?
          where id = ?`
      )
      .run("reverted", revertedAt, revertedAt, changeset.id);
    this.recordAuditForWordChangeSet(
      changeset,
      "word-changeset.reverted",
      `Rolled back Word changeset ${changeset.summary}`
    );

    return this.getWordChangeSet(changeset.id);
  }

  rejectWordChangeSet(changesetId: string): WordChangeSet {
    const changeset = this.getWordChangeSetRow(changesetId);

    if (changeset.status !== "proposed") {
      throw new HistoryServiceError(
        "Only proposed Word changesets can be rejected.",
        "invalid-state"
      );
    }

    this.updateWordChangeSetStatus(changeset.id, "rejected", null);
    this.recordAuditForWordChangeSet(
      changeset,
      "word-changeset.rejected",
      `Rejected Word changeset ${changeset.summary}`
    );

    return this.getWordChangeSet(changeset.id);
  }

  getWordChangeSet(changesetId: string): WordChangeSet {
    return toWordChangeSet(this.getWordChangeSetRow(changesetId));
  }

  getChangeSet(changesetId: string): HistoryChangeSet {
    return toChangeSet(this.getChangeSetRow(changesetId));
  }

  getChangeSetWithContents(changesetId: string): HistoryChangeSetWithContents {
    const row = this.getChangeSetRowWithContents(changesetId);

    return {
      ...toChangeSet(row),
      beforeContents: row.before_contents,
      afterContents: row.after_contents
    };
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

  async applyChangeSetHunks(
    request: ApplyChangeSetHunksRequest
  ): Promise<HistoryChangeSet> {
    const changeset = this.getChangeSetRowWithContents(request.changesetId);

    if (changeset.status !== "proposed") {
      throw new HistoryServiceError(
        "Only proposed changesets can be applied.",
        "invalid-state"
      );
    }

    const hunks = getDiffHunkRanges(
      splitDiffLines(changeset.before_contents),
      splitDiffLines(changeset.after_contents)
    );
    const acceptedHunkIndexes = [...new Set(request.acceptedHunkIndexes)].sort(
      (left, right) => left - right
    );

    if (acceptedHunkIndexes.length === 0) {
      throw new HistoryServiceError(
        "At least one hunk must be accepted before applying.",
        "empty-change"
      );
    }

    if (
      acceptedHunkIndexes.some(
        (hunkIndex) =>
          !Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length
      )
    ) {
      throw new HistoryServiceError("Accepted hunk index is invalid.", "invalid-hunk");
    }

    const acceptedContents =
      acceptedHunkIndexes.length === hunks.length
        ? changeset.after_contents
        : buildContentsFromAcceptedHunks(
            changeset.before_contents,
            changeset.after_contents,
            acceptedHunkIndexes
          );

    if (acceptedContents === changeset.before_contents) {
      throw new HistoryServiceError(
        "Accepted hunks do not change the file.",
        "empty-change"
      );
    }

    await writeProjectFile(
      changeset.project_root,
      changeset.file_path,
      acceptedContents
    );

    const appliedAt = new Date().toISOString();
    const patch = generateUnifiedDiff(
      changeset.file_path,
      changeset.before_contents,
      acceptedContents
    );
    this.db
      .prepare(
        `update changesets
            set patch = ?,
                after_contents = ?,
                status = ?,
                updated_at = ?,
                applied_at = coalesce(?, applied_at)
          where id = ?`
      )
      .run(
        patch,
        acceptedContents,
        "applied",
        new Date().toISOString(),
        appliedAt,
        changeset.id
      );
    this.recordAuditForChangeSet(
      changeset,
      "changeset.applied",
      `Applied ${acceptedHunkIndexes.length} of ${hunks.length} hunks from ${changeset.summary}`
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

    if (currentContents !== changeset.after_contents) {
      throw new HistoryServiceError(
        "Cannot roll back changeset because the file changed after the patch was applied.",
        "rollback-conflict"
      );
    }

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
      snapshotCount:
        this.countRows("snapshots") + this.countRows("word_document_snapshots"),
      changesetCount: this.countRows("changesets") + this.countRows("word_changesets"),
      auditEventCount: this.countRows("audit_events"),
      buildJobCount: this.countRows("build_jobs"),
      agentSessionCount: this.countRows("agent_sessions")
    };
  }

  clearAll(): HistoryPrivacySummary {
    this.db.exec(`
      delete from audit_events;
      delete from word_changesets;
      delete from word_document_snapshots;
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

      create table if not exists word_document_snapshots (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        project_root text not null,
        file_path text not null,
        content_hash text not null,
        byte_length integer not null,
        contents_base64 text not null,
        created_at text not null
      );

      create table if not exists word_changesets (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        project_root text not null,
        file_path text not null,
        summary text not null,
        base_blocks_json text not null,
        operations_json text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        applied_at text,
        reverted_at text,
        before_snapshot_id text references word_document_snapshots(id),
        applied_content_hash text
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
    this.ensureColumn("word_changesets", "reverted_at", "text");
    this.ensureColumn(
      "word_changesets",
      "before_snapshot_id",
      "text references word_document_snapshots(id)"
    );
    this.ensureColumn("word_changesets", "applied_content_hash", "text");
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

  private getWordChangeSetRow(changesetId: string): WordChangeSetRow {
    const row = this.db
      .prepare(
        `select id, project_root, file_path, summary, base_blocks_json,
                operations_json, status, created_at, updated_at, applied_at,
                reverted_at, before_snapshot_id, applied_content_hash
           from word_changesets
          where id = ?`
      )
      .get(changesetId) as WordChangeSetRow | undefined;

    if (row === undefined) {
      throw new HistoryServiceError("Word changeset not found.", "missing-changeset");
    }

    return row;
  }

  private getWordDocumentSnapshotRow(snapshotId: string): WordDocumentSnapshotRow {
    const row = this.db
      .prepare(
        `select id, project_root, file_path, content_hash, byte_length,
                contents_base64, created_at
           from word_document_snapshots
          where id = ?`
      )
      .get(snapshotId) as WordDocumentSnapshotRow | undefined;

    if (row === undefined) {
      throw new HistoryServiceError(
        "Word document snapshot not found.",
        "invalid-state"
      );
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

  private updateWordChangeSetStatus(
    changesetId: string,
    status: WordChangeSetStatus,
    appliedAt: string | null
  ): void {
    this.db
      .prepare(
        `update word_changesets
            set status = ?,
                updated_at = ?,
                applied_at = coalesce(?, applied_at)
          where id = ?`
      )
      .run(status, new Date().toISOString(), appliedAt, changesetId);
  }

  private recordAuditForWordChangeSet(
    changeset: WordChangeSetRow,
    eventType: string,
    message: string
  ): void {
    const projectId = this.upsertProject(changeset.project_root);
    this.recordAudit(projectId, changeset.project_root, null, eventType, message);
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

  private ensureColumn(
    tableName: string,
    columnName: string,
    definition: string
  ): void {
    const columns = this.db
      .prepare(`pragma table_info(${tableName})`)
      .all() as unknown as readonly { readonly name: string }[] | undefined;

    if (columns?.some((column) => column.name === columnName) === true) {
      return;
    }

    this.db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}

export function generateUnifiedDiff(
  filePath: string,
  beforeContents: string,
  afterContents: string
): string {
  const beforeLines = splitDiffLines(beforeContents);
  const afterLines = splitDiffLines(afterContents);
  const ops = diffLineOps(beforeLines, afterLines);
  const hunks = getDiffHunks(beforeLines, afterLines);
  const diffLines =
    hunks.length === 0
      ? [
          `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
          " "
        ]
      : hunks.flatMap((hunk) => [
          `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
          ...ops.slice(hunk.startIndex, hunk.endIndex + 1).map(formatDiffOp)
        ]);

  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...diffLines].join("\n");
}

type DiffLineOp = {
  readonly kind: "context" | "delete" | "insert";
  readonly line: string;
};

type DiffHunk = {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
};

function diffLineOps(
  beforeLines: readonly string[],
  afterLines: readonly string[]
): readonly DiffLineOp[] {
  const table = buildLcsTable(beforeLines, afterLines);
  const output: DiffLineOp[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      output.push({ kind: "context", line: beforeLines[beforeIndex] ?? "" });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      getTableScore(table, beforeIndex + 1, afterIndex) >=
      getTableScore(table, beforeIndex, afterIndex + 1)
    ) {
      output.push({ kind: "delete", line: beforeLines[beforeIndex] ?? "" });
      beforeIndex += 1;
    } else {
      output.push({ kind: "insert", line: afterLines[afterIndex] ?? "" });
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    output.push({ kind: "delete", line: beforeLines[beforeIndex] ?? "" });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    output.push({ kind: "insert", line: afterLines[afterIndex] ?? "" });
    afterIndex += 1;
  }

  return output.length === 0 ? [{ kind: "context", line: "" }] : output;
}

function getDiffHunks(
  beforeLines: readonly string[],
  afterLines: readonly string[]
): readonly DiffHunk[] {
  const ops = diffLineOps(beforeLines, afterLines);
  return getDiffHunkRanges(beforeLines, afterLines, ops);
}

function getDiffHunkRanges(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  ops: readonly DiffLineOp[] = diffLineOps(beforeLines, afterLines)
): readonly DiffHunk[] {
  const contextRadius = 2;
  const changeIndexes = ops
    .map((op, index) => (op.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);

  if (changeIndexes.length === 0) {
    return [];
  }

  const ranges: { startIndex: number; endIndex: number }[] = [];
  let startIndex = Math.max(0, (changeIndexes[0] ?? 0) - contextRadius);
  let endIndex = Math.min(ops.length - 1, (changeIndexes[0] ?? 0) + contextRadius);

  for (const changeIndex of changeIndexes.slice(1)) {
    const nextStart = Math.max(0, changeIndex - contextRadius);
    const nextEnd = Math.min(ops.length - 1, changeIndex + contextRadius);

    if (nextStart <= endIndex + 1) {
      endIndex = Math.max(endIndex, nextEnd);
      continue;
    }

    ranges.push({ startIndex, endIndex });
    startIndex = nextStart;
    endIndex = nextEnd;
  }

  ranges.push({ startIndex, endIndex });

  return ranges.map((range) => {
    const beforeConsumedBeforeRange = countOps(
      ops.slice(0, range.startIndex),
      "before"
    );
    const afterConsumedBeforeRange = countOps(ops.slice(0, range.startIndex), "after");
    const rangeOps = ops.slice(range.startIndex, range.endIndex + 1);

    return {
      ...range,
      oldStart: beforeConsumedBeforeRange + 1,
      oldCount: Math.max(countOps(rangeOps, "before"), 1),
      newStart: afterConsumedBeforeRange + 1,
      newCount: Math.max(countOps(rangeOps, "after"), 1)
    };
  });
}

function countOps(ops: readonly DiffLineOp[], side: "before" | "after"): number {
  return ops.filter((op) =>
    side === "before" ? op.kind !== "insert" : op.kind !== "delete"
  ).length;
}

function formatDiffOp(op: DiffLineOp): string {
  switch (op.kind) {
    case "context":
      return ` ${op.line}`;
    case "delete":
      return `-${op.line}`;
    case "insert":
      return `+${op.line}`;
  }
}

function buildContentsFromAcceptedHunks(
  beforeContents: string,
  afterContents: string,
  acceptedHunkIndexes: readonly number[]
): string {
  const beforeLines = splitDiffLines(beforeContents);
  const afterLines = splitDiffLines(afterContents);
  const ops = diffLineOps(beforeLines, afterLines);
  const hunks = getDiffHunkRanges(beforeLines, afterLines, ops);
  const acceptedIndexes = new Set(acceptedHunkIndexes);
  const hunkIndexByOpIndex = new Map<number, number>();

  hunks.forEach((hunk, hunkIndex) => {
    for (let opIndex = hunk.startIndex; opIndex <= hunk.endIndex; opIndex += 1) {
      hunkIndexByOpIndex.set(opIndex, hunkIndex);
    }
  });

  const output: string[] = [];

  ops.forEach((op, opIndex) => {
    if (op.kind === "context") {
      output.push(op.line);
      return;
    }

    const hunkIndex = hunkIndexByOpIndex.get(opIndex);
    const accepted = hunkIndex !== undefined && acceptedIndexes.has(hunkIndex);

    if (accepted && op.kind === "insert") {
      output.push(op.line);
    }

    if (!accepted && op.kind === "delete") {
      output.push(op.line);
    }
  });

  return `${output.join("\n")}${beforeContents.endsWith("\n") || afterContents.endsWith("\n") ? "\n" : ""}`;
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

function toWordChangeSet(row: WordChangeSetRow): WordChangeSet {
  const baseBlocks = parseJsonField(row.base_blocks_json, "base blocks");
  const operations = parseJsonField(row.operations_json, "Word operations");

  return normalizeWordChangeSet({
    id: row.id,
    projectRoot: row.project_root,
    filePath: row.file_path,
    summary: row.summary,
    baseBlocks: parseWordBlocks(baseBlocks),
    operations: parseWordOperations(operations),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
    ...(row.reverted_at === null ? {} : { revertedAt: row.reverted_at }),
    ...(row.before_snapshot_id === null
      ? {}
      : { beforeSnapshotId: row.before_snapshot_id }),
    ...(row.applied_content_hash === null
      ? {}
      : { appliedContentHash: row.applied_content_hash })
  });
}

function normalizeWordChangeSet(changeset: WordChangeSet): WordChangeSet {
  const baseBlocks = normalizeWordBlocks(changeset.baseBlocks);
  const operations = normalizeWordOperations(changeset.operations);

  if (baseBlocks.length === 0) {
    throw new HistoryServiceError(
      "Word changeset requires a base block snapshot.",
      "empty-change"
    );
  }

  if (operations.length === 0) {
    throw new HistoryServiceError(
      "Word changeset requires at least one operation.",
      "empty-change"
    );
  }

  const normalized = {
    id: changeset.id.trim().length > 0 ? changeset.id : randomUUID(),
    projectRoot: changeset.projectRoot,
    filePath: changeset.filePath,
    summary: normalizeSummary(changeset.summary),
    baseBlocks,
    operations,
    status: changeset.status,
    createdAt: changeset.createdAt,
    updatedAt: changeset.updatedAt,
    appliedAt: changeset.appliedAt,
    revertedAt: changeset.revertedAt,
    beforeSnapshotId: changeset.beforeSnapshotId,
    appliedContentHash: changeset.appliedContentHash
  };

  return {
    id: normalized.id,
    projectRoot: normalized.projectRoot,
    filePath: normalized.filePath,
    summary: normalized.summary,
    baseBlocks: normalized.baseBlocks,
    operations: normalized.operations,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    ...(normalized.appliedAt === undefined ? {} : { appliedAt: normalized.appliedAt }),
    ...(normalized.revertedAt === undefined
      ? {}
      : { revertedAt: normalized.revertedAt }),
    ...(normalized.beforeSnapshotId === undefined
      ? {}
      : { beforeSnapshotId: normalized.beforeSnapshotId }),
    ...(normalized.appliedContentHash === undefined
      ? {}
      : { appliedContentHash: normalized.appliedContentHash })
  };
}

function normalizeWordBlocks(
  blocks: readonly WordDocumentBlock[]
): readonly WordDocumentBlock[] {
  return blocks.map((block, index) => ({
    id: block.id.trim().length > 0 ? block.id : `p-${index + 1}`,
    kind: "paragraph",
    text: block.text
  }));
}

function normalizeWordOperations(
  operations: readonly WordBlockOperation[]
): readonly WordBlockOperation[] {
  return operations.map((operation) => {
    switch (operation.type) {
      case "replace-block":
        return {
          type: "replace-block",
          blockId: operation.blockId,
          afterText: operation.afterText
        };
      case "insert-block-after":
        return {
          type: "insert-block-after",
          ...(operation.afterBlockId === undefined
            ? {}
            : { afterBlockId: operation.afterBlockId }),
          block: normalizeWordBlocks([operation.block])[0]!
        };
      case "delete-block":
        return {
          type: "delete-block",
          blockId: operation.blockId
        };
      case "move-block":
        return {
          type: "move-block",
          blockId: operation.blockId,
          ...(operation.afterBlockId === undefined
            ? {}
            : { afterBlockId: operation.afterBlockId })
        };
      case "replace-selection":
        return {
          type: "replace-selection",
          blockId: operation.blockId,
          startOffset: operation.startOffset,
          endOffset: operation.endOffset,
          replacementText: operation.replacementText
        };
      case "replace-table-cell":
        return {
          type: "replace-table-cell",
          tableId: operation.tableId,
          rowIndex: operation.rowIndex,
          columnIndex: operation.columnIndex,
          afterText: operation.afterText
        };
      case "insert-table-row":
        return {
          type: "insert-table-row",
          tableId: operation.tableId,
          anchorRowIndex: operation.anchorRowIndex,
          position: operation.position
        };
      case "delete-table-row":
        return {
          type: "delete-table-row",
          tableId: operation.tableId,
          rowIndex: operation.rowIndex
        };
      case "insert-table-column":
        return {
          type: "insert-table-column",
          tableId: operation.tableId,
          anchorColumnIndex: operation.anchorColumnIndex,
          position: operation.position
        };
      case "delete-table-column":
        return {
          type: "delete-table-column",
          tableId: operation.tableId,
          columnIndex: operation.columnIndex
        };
      case "merge-table-cells":
        return {
          type: "merge-table-cells",
          tableId: operation.tableId,
          cells: operation.cells.map((cell) => ({
            rowIndex: cell.rowIndex,
            columnIndex: cell.columnIndex
          }))
        };
    }
  });
}

function parseJsonField(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new HistoryServiceError(
      `Stored Word changeset ${label} are invalid JSON.`,
      "invalid-state"
    );
  }
}

function parseWordBlocks(value: unknown): readonly WordDocumentBlock[] {
  if (!Array.isArray(value) || !value.every(isWordDocumentBlock)) {
    throw new HistoryServiceError(
      "Stored Word changeset base blocks are invalid.",
      "invalid-state"
    );
  }

  return normalizeWordBlocks(value);
}

function parseWordOperations(value: unknown): readonly WordBlockOperation[] {
  if (!Array.isArray(value) || !value.every(isWordBlockOperation)) {
    throw new HistoryServiceError(
      "Stored Word changeset operations are invalid.",
      "invalid-state"
    );
  }

  return normalizeWordOperations(value);
}

function isWordDocumentBlock(value: unknown): value is WordDocumentBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const block = value as Partial<WordDocumentBlock>;
  return (
    typeof block.id === "string" &&
    block.kind === "paragraph" &&
    typeof block.text === "string"
  );
}

function isWordBlockOperation(value: unknown): value is WordBlockOperation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const operation = value as Partial<WordBlockOperation>;

  switch (operation.type) {
    case "replace-block":
      return (
        typeof operation.blockId === "string" && typeof operation.afterText === "string"
      );
    case "insert-block-after":
      return (
        (operation.afterBlockId === undefined ||
          typeof operation.afterBlockId === "string") &&
        isWordDocumentBlock(operation.block)
      );
    case "delete-block":
      return typeof operation.blockId === "string";
    case "move-block":
      return (
        typeof operation.blockId === "string" &&
        (operation.afterBlockId === undefined ||
          typeof operation.afterBlockId === "string")
      );
    case "replace-selection":
      return (
        typeof operation.blockId === "string" &&
        typeof operation.startOffset === "number" &&
        typeof operation.endOffset === "number" &&
        typeof operation.replacementText === "string"
      );
    case "replace-table-cell":
      return (
        typeof operation.tableId === "string" &&
        typeof operation.rowIndex === "number" &&
        typeof operation.columnIndex === "number" &&
        typeof operation.afterText === "string"
      );
    case "insert-table-row":
      return (
        typeof operation.tableId === "string" &&
        typeof operation.anchorRowIndex === "number" &&
        (operation.position === "before" || operation.position === "after")
      );
    case "delete-table-row":
      return typeof operation.tableId === "string" && typeof operation.rowIndex === "number";
    case "insert-table-column":
      return (
        typeof operation.tableId === "string" &&
        typeof operation.anchorColumnIndex === "number" &&
        (operation.position === "before" || operation.position === "after")
      );
    case "delete-table-column":
      return (
        typeof operation.tableId === "string" && typeof operation.columnIndex === "number"
      );
    case "merge-table-cells":
      return (
        typeof operation.tableId === "string" &&
        Array.isArray(operation.cells) &&
        operation.cells.every(
          (cell) =>
            typeof cell === "object" &&
            cell !== null &&
            typeof (cell as Partial<WordTableCellRef>).rowIndex === "number" &&
            typeof (cell as Partial<WordTableCellRef>).columnIndex === "number"
        )
      );
    default:
      return false;
  }
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

async function writeProjectFileBytes(
  projectRoot: string,
  projectPath: string,
  contents: Uint8Array
): Promise<void> {
  const root = await validateProjectRoot(projectRoot);
  const targetPath = await resolveWritableProjectPath(root, projectPath);

  await writeFile(targetPath, contents);
}

async function hashProjectFile(
  projectRoot: string,
  projectPath: string
): Promise<string> {
  const root = await validateProjectRoot(projectRoot);
  const bytes = await readFile(await resolveExistingProjectPath(root, projectPath));

  return hashBytes(bytes);
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
  const parentPath = await ensureWritableParentPath(rootPath, dirname(lexicalPath));

  if (!isInsideRoot(rootPath, parentPath) || !isInsideRoot(rootPath, lexicalPath)) {
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
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
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
  }

  await mkdir(parentPath, { recursive: true });
  const resolvedParent = await realpath(parentPath);

  if (!isInsideRoot(rootPath, resolvedParent)) {
    throw new HistoryServiceError("Path resolves outside root.", "outside-root");
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
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

function hashBytes(contents: Uint8Array): string {
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
