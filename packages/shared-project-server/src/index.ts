import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Duplex } from "node:stream";
import { dirname, posix } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";

export type SharedProjectRole = "owner" | "editor" | "viewer";
export type SharedProjectCompiler = "pdflatex" | "xelatex" | "lualatex";

export type SharedProjectUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
};

export type SharedProjectSession = {
  readonly id: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly createdAt: string;
};

export type SharedProjectSessionSummary = {
  readonly id: string;
  readonly userId: string;
  readonly current: boolean;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly createdAt: string;
};

export type SharedProjectSessionRevokeResult = {
  readonly sessionId: string;
  readonly revoked: boolean;
};

export type SharedProject = {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly mainFilePath?: string;
  readonly compiler?: SharedProjectCompiler;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SharedProjectListItem = SharedProject & {
  readonly role: SharedProjectRole;
};

export type SharedProjectMember = {
  readonly projectId: string;
  readonly userId: string;
  readonly role: SharedProjectRole;
  readonly joinedAt: string;
};

export type SharedProjectMemberDetails = SharedProjectMember & {
  readonly email: string;
  readonly name: string;
};

export type SharedProjectInvitation = {
  readonly id: string;
  readonly projectId: string;
  readonly email: string;
  readonly role: Exclude<SharedProjectRole, "owner">;
  readonly invitedByUserId: string;
  readonly status: "pending" | "accepted";
  readonly createdAt: string;
  readonly acceptedAt?: string;
};

export type SharedProjectFile = {
  readonly projectId: string;
  readonly path: string;
  readonly latestRevisionId: string;
  readonly updatedAt: string;
};

export type SharedProjectDirectory = {
  readonly projectId: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SharedProjectFileRevision = {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly contents: string;
  readonly contentEncoding?: "utf8" | "base64";
  readonly actorUserId: string;
  readonly createdAt: string;
};

export type SharedProjectFileRevisionSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly actorUserId: string;
  readonly createdAt: string;
  readonly contentEncoding?: "utf8" | "base64";
  readonly byteLength: number;
};

export type SharedProjectFileWriteRequest = {
  readonly contents: string;
  readonly expectedRevisionId?: string;
};

export type SharedProjectFileCreateRequest = {
  readonly path: string;
  readonly contents: string;
  readonly contentEncoding?: "utf8" | "base64";
};

export type SharedProjectDocumentUpdateRequest = {
  readonly updateBase64: string;
  readonly clientOperationId?: string;
  readonly expectedRevisionId?: string;
};

export type SharedProjectRealtimeEvent =
  | {
      readonly type: "tree.updated";
      readonly projectId: string;
    }
  | {
      readonly type: "file.updated";
      readonly projectId: string;
      readonly path: string;
      readonly revisionId: string;
    }
  | {
      readonly type: "document.updated";
      readonly projectId: string;
      readonly path: string;
      readonly updateId: string;
      readonly revisionId: string;
    }
  | {
      readonly type: "presence.updated";
      readonly projectId: string;
      readonly presence: SharedProjectPresence;
    }
  | {
      readonly type: "members.updated";
      readonly projectId: string;
    }
  | {
      readonly type: "comments.updated";
      readonly projectId: string;
    }
  | {
      readonly type: "build-artifact.created";
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly type: "agent.run.updated";
      readonly projectId: string;
      readonly agentRunId: string;
      readonly status: SharedProjectAgentRunStatus;
    }
  | {
      readonly type: "agent.changeset.updated";
      readonly projectId: string;
      readonly changesetId: string;
      readonly status: SharedProjectChangeSetStatus;
    };

type SharedProjectRealtimePublisher = {
  publish(event: SharedProjectRealtimeEvent): void;
  closeProject(projectId: string, reason: string): void;
  closeProjectUser(projectId: string, userId: string, reason: string): void;
  closeSession(sessionId: string, reason: string): void;
};

export type SharedProjectSourceExport = {
  readonly project: SharedProject;
  readonly files: readonly SharedProjectFileRevision[];
  readonly directories: readonly SharedProjectDirectory[];
  readonly exportedAt: string;
};

export type SharedProjectSettingsUpdate = {
  readonly mainFilePath?: string;
  readonly compiler?: SharedProjectCompiler;
};

export type SharedProjectActivityEvent = {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly eventType: string;
  readonly message: string;
  readonly createdAt: string;
};

export type SharedProjectAuditEvent = {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly eventType: string;
  readonly message: string;
  readonly agentRunId?: string;
  readonly changesetId?: string;
  readonly buildArtifactIds?: readonly string[];
  readonly createdAt: string;
};

export type SharedProjectAuditEventCreate = {
  readonly eventType: string;
  readonly message: string;
  readonly agentRunId?: string;
  readonly changesetId?: string;
  readonly buildArtifactIds?: readonly string[];
};

export type SharedProjectComment = {
  readonly id: string;
  readonly projectId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly resolved: boolean;
  readonly resolvedByUserId?: string;
  readonly resolvedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SharedProjectCommentCreate = {
  readonly body: string;
  readonly filePath?: string;
  readonly line?: number;
};

export type SharedProjectBuildArtifact = {
  readonly id: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly desktopClientId: string;
  readonly uploaderUserId: string;
  readonly compiler: string;
  readonly engineVersion?: string;
  readonly latexmkVersion?: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly platform: NodeJS.Platform;
  readonly rawLog: string;
  readonly diagnostics: readonly SharedProjectBuildDiagnostic[];
  readonly pdfBase64?: string;
  readonly pdfByteLength?: number;
  readonly createdAt: string;
};

export type SharedProjectBuildArtifactStatus = "succeeded" | "failed" | "cancelled";

export type SharedProjectBuildDiagnostic = {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
};

export type SharedProjectBuildArtifactUpload = {
  readonly sourceRevisionId: string;
  readonly desktopClientId: string;
  readonly compiler: string;
  readonly engineVersion?: string;
  readonly latexmkVersion?: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly platform: NodeJS.Platform;
  readonly rawLog: string;
  readonly diagnostics?: readonly SharedProjectBuildDiagnostic[];
  readonly pdfBase64?: string;
  readonly pdfByteLength?: number;
};

export type SharedProjectDocumentUpdate = {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly actorUserId: string;
  readonly updateBase64: string;
  readonly clientOperationId?: string;
  readonly createdAt: string;
};

export type SharedProjectDocumentState = {
  readonly projectId: string;
  readonly path: string;
  readonly stateUpdateBase64: string;
  readonly contents: string;
  readonly revisionId?: string;
};

export type SharedProjectDocumentUpdateResult = {
  readonly update: SharedProjectDocumentUpdate;
  readonly state: SharedProjectDocumentState;
  readonly revision: SharedProjectFileRevision;
  readonly replayed?: boolean;
};

export type SharedProjectDocumentUpdateFeed = {
  readonly updates: readonly SharedProjectDocumentUpdate[];
  readonly state: SharedProjectDocumentState;
  readonly latestUpdateId?: string;
};

export type SharedProjectPresence = {
  readonly projectId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly filePath?: string;
  readonly cursorLine?: number;
  readonly cursorColumn?: number;
  readonly updatedAt: string;
};

export type SharedProjectPresenceUpdate = {
  readonly filePath?: string;
  readonly cursorLine?: number;
  readonly cursorColumn?: number;
};

export type SharedProjectAgentRunStatus =
  | "running"
  | "waiting-for-review"
  | "completed"
  | "failed"
  | "cancelled";

export type SharedProjectAgentRun = {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly providerId: string;
  readonly mode: string;
  readonly promptHash: string;
  readonly status: SharedProjectAgentRunStatus;
  readonly changesetIds: readonly string[];
  readonly buildArtifactIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SharedProjectChangeSetStatus =
  | "proposed"
  | "applied"
  | "rejected"
  | "failed";

export type SharedProjectChangeSet = {
  readonly id: string;
  readonly projectId: string;
  readonly agentRunId: string;
  readonly actorUserId: string;
  readonly filePath: string;
  readonly beforeRevisionId?: string;
  readonly beforeContents: string;
  readonly afterContents: string;
  readonly summary: string;
  readonly status: SharedProjectChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly appliedRevisionId?: string;
};

export type SharedProjectAgentRunCreate = {
  readonly providerId: string;
  readonly mode: string;
  readonly prompt: string;
  readonly status?: SharedProjectAgentRunStatus;
  readonly buildArtifactIds?: readonly string[];
};

export type SharedProjectAgentRunStatusUpdate = {
  readonly status: SharedProjectAgentRunStatus;
};

export type SharedProjectAgentRunBuildArtifactAttach = {
  readonly artifactId: string;
};

export type SharedProjectChangeSetCreate = {
  readonly agentRunId: string;
  readonly filePath: string;
  readonly beforeRevisionId?: string;
  readonly beforeContents: string;
  readonly afterContents: string;
  readonly summary: string;
};

export type SharedProjectTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children?: readonly SharedProjectTreeNode[];
};

export type SharedProjectDatabase = {
  readonly users: readonly SharedProjectUser[];
  readonly sessions: readonly SharedProjectSession[];
  readonly projects: readonly SharedProject[];
  readonly members: readonly SharedProjectMember[];
  readonly invitations: readonly SharedProjectInvitation[];
  readonly directories: readonly SharedProjectDirectory[];
  readonly files: readonly SharedProjectFile[];
  readonly revisions: readonly SharedProjectFileRevision[];
  readonly documentUpdates: readonly SharedProjectDocumentUpdate[];
  readonly presence: readonly SharedProjectPresence[];
  readonly buildArtifacts: readonly SharedProjectBuildArtifact[];
  readonly agentRuns: readonly SharedProjectAgentRun[];
  readonly changesets: readonly SharedProjectChangeSet[];
  readonly comments: readonly SharedProjectComment[];
  readonly activity: readonly SharedProjectActivityEvent[];
  readonly auditEvents: readonly SharedProjectAuditEvent[];
};

export type SignInResult = {
  readonly user: SharedProjectUser;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
};

export type CreateProjectRequest = {
  readonly name: string;
  readonly mainFilePath?: string;
  readonly compiler?: SharedProjectCompiler;
  readonly directories?: readonly {
    readonly path: string;
  }[];
  readonly files?: readonly {
    readonly path: string;
    readonly contents: string;
    readonly contentEncoding?: "utf8" | "base64";
  }[];
};

export type SharedProjectDirectoryCreate = {
  readonly path: string;
};

const emptyDatabase: SharedProjectDatabase = {
  users: [],
  sessions: [],
  projects: [],
  members: [],
  invitations: [],
  directories: [],
  files: [],
  revisions: [],
  documentUpdates: [],
  presence: [],
  buildArtifacts: [],
  agentRuns: [],
  changesets: [],
  comments: [],
  activity: [],
  auditEvents: []
};

const sharedAccessTokenTtlMs = 15 * 60 * 1000;
const sharedRefreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

function createSessionTokenPair(now: string): Omit<SignInResult, "user"> {
  return {
    accessToken: randomUUID(),
    refreshToken: randomUUID(),
    accessTokenExpiresAt: expiresAt(now, sharedAccessTokenTtlMs),
    refreshTokenExpiresAt: expiresAt(now, sharedRefreshTokenTtlMs)
  };
}

function expiresAt(now: string, ttlMs: number): string {
  return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

function isExpired(isoDate: string, now: string): boolean {
  return new Date(isoDate).getTime() <= new Date(now).getTime();
}

export class SharedProjectStore {
  constructor(private readonly databasePath: string) {}

  async read(): Promise<SharedProjectDatabase> {
    try {
      return normalizeDatabase(JSON.parse(await readFile(this.databasePath, "utf8")));
    } catch {
      return emptyDatabase;
    }
  }

  async write(database: SharedProjectDatabase): Promise<void> {
    await mkdir(dirname(this.databasePath), { recursive: true });
    await writeFile(this.databasePath, JSON.stringify(database, null, 2), "utf8");
  }

  async update<T>(
    updater: (
      database: SharedProjectDatabase
    ) => DatabaseUpdate<T> | Promise<DatabaseUpdate<T>>
  ): Promise<T> {
    const database = await this.read();
    const result = await updater(database);

    await this.write(result.database);
    return result.value;
  }
}

export class SharedProjectService {
  private realtimePublisher: SharedProjectRealtimePublisher | undefined;

  constructor(private readonly store: SharedProjectStore) {}

  setRealtimePublisher(publisher: SharedProjectRealtimePublisher): void {
    this.realtimePublisher = publisher;
  }

  private publishRealtime(event: SharedProjectRealtimeEvent): void {
    this.realtimePublisher?.publish(event);
  }

  async signIn(email: string, name?: string): Promise<SignInResult> {
    const normalizedEmail = normalizeEmail(email);
    const now = new Date().toISOString();
    const tokenPair = createSessionTokenPair(now);

    return this.store.update(({ users, sessions, ...rest }) => {
      const existingUser = users.find((user) => user.email === normalizedEmail);
      const user =
        existingUser ??
        ({
          id: randomUUID(),
          email: normalizedEmail,
          name: normalizeDisplayName(name, normalizedEmail),
          createdAt: now
        } satisfies SharedProjectUser);
      const session: SharedProjectSession = {
        id: randomUUID(),
        userId: user.id,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        accessTokenExpiresAt: tokenPair.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokenPair.refreshTokenExpiresAt,
        createdAt: now
      };

      return databaseUpdate(
        {
          ...rest,
          users: existingUser === undefined ? [...users, user] : users,
          sessions: [...sessions, session]
        },
        {
          user,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          accessTokenExpiresAt: session.accessTokenExpiresAt,
          refreshTokenExpiresAt: session.refreshTokenExpiresAt
        }
      );
    });
  }

  async refreshSession(refreshToken: string): Promise<SignInResult> {
    const now = new Date().toISOString();

    return this.store.update((database) => {
      const session = database.sessions.find(
        (candidate) => candidate.refreshToken === refreshToken
      );

      if (session === undefined || isExpired(session.refreshTokenExpiresAt, now)) {
        throw new SharedProjectServerError(
          "Invalid refresh token.",
          401,
          "unauthorized"
        );
      }

      const user = database.users.find((candidate) => candidate.id === session.userId);

      if (user === undefined) {
        throw new SharedProjectServerError(
          "Session user was not found.",
          401,
          "unauthorized"
        );
      }

      const nextSession: SharedProjectSession = {
        ...session,
        accessToken: randomUUID(),
        refreshToken: randomUUID(),
        accessTokenExpiresAt: expiresAt(now, sharedAccessTokenTtlMs),
        refreshTokenExpiresAt: expiresAt(now, sharedRefreshTokenTtlMs)
      };

      return databaseUpdate(
        {
          ...database,
          sessions: database.sessions.map((candidate) =>
            candidate.id === session.id ? nextSession : candidate
          )
        },
        {
          user,
          accessToken: nextSession.accessToken,
          refreshToken: nextSession.refreshToken,
          accessTokenExpiresAt: nextSession.accessTokenExpiresAt,
          refreshTokenExpiresAt: nextSession.refreshTokenExpiresAt
        }
      );
    });
  }

  async signOut(refreshToken: string): Promise<{ readonly signedOut: boolean }> {
    const result = await this.store.update((database) => {
      const removedSession = database.sessions.find(
        (candidate) => candidate.refreshToken === refreshToken
      );
      const nextSessions = database.sessions.filter(
        (candidate) => candidate.refreshToken !== refreshToken
      );

      return databaseUpdate(
        {
          ...database,
          sessions: nextSessions
        },
        {
          signedOut: nextSessions.length !== database.sessions.length,
          removedSessionId: removedSession?.id
        }
      );
    });

    if (result.removedSessionId !== undefined) {
      this.realtimePublisher?.closeSession(
        result.removedSessionId,
        "Session was revoked."
      );
    }

    return { signedOut: result.signedOut };
  }

  async listSessions(
    actorUserId: string,
    currentAccessToken: string
  ): Promise<readonly SharedProjectSessionSummary[]> {
    const now = new Date().toISOString();
    const database = await this.store.read();

    return database.sessions
      .filter(
        (session) =>
          session.userId === actorUserId &&
          !isExpired(session.refreshTokenExpiresAt, now)
      )
      .map((session) =>
        toSharedProjectSessionSummary(
          session,
          session.accessToken === currentAccessToken
        )
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async revokeSession(
    actorUserId: string,
    sessionId: string
  ): Promise<SharedProjectSessionRevokeResult> {
    const result = await this.store.update((database) => {
      const session = database.sessions.find(
        (candidate) => candidate.id === sessionId && candidate.userId === actorUserId
      );

      if (session === undefined) {
        throw new SharedProjectServerError(
          "Session was not found.",
          404,
          "session-not-found"
        );
      }

      return databaseUpdate(
        {
          ...database,
          sessions: database.sessions.filter((candidate) => candidate.id !== sessionId)
        },
        { sessionId, revoked: true }
      );
    });

    this.realtimePublisher?.closeSession(sessionId, "Session was revoked.");

    return result;
  }

  async authenticate(accessToken: string): Promise<SharedProjectUser> {
    return (await this.authenticateSession(accessToken)).user;
  }

  async authenticateSession(accessToken: string): Promise<{
    readonly user: SharedProjectUser;
    readonly session: SharedProjectSession;
  }> {
    const now = new Date().toISOString();
    const database = await this.store.read();
    const session = database.sessions.find(
      (candidate) => candidate.accessToken === accessToken
    );

    if (session === undefined || isExpired(session.accessTokenExpiresAt, now)) {
      throw new SharedProjectServerError("Invalid access token.", 401, "unauthorized");
    }

    const user = database.users.find((candidate) => candidate.id === session.userId);

    if (user === undefined) {
      throw new SharedProjectServerError(
        "Session user was not found.",
        401,
        "unauthorized"
      );
    }

    return { user, session };
  }

  async createProject(
    actorUserId: string,
    request: CreateProjectRequest
  ): Promise<SharedProject> {
    const name = normalizeProjectName(request.name);
    const now = new Date().toISOString();
    const mainFilePath =
      request.mainFilePath === undefined
        ? undefined
        : normalizeProjectMainFilePath(request.mainFilePath);
    const compiler =
      request.compiler === undefined
        ? undefined
        : normalizeSharedProjectCompiler(request.compiler);
    const project: SharedProject = {
      id: randomUUID(),
      name,
      ownerUserId: actorUserId,
      ...(mainFilePath === undefined ? {} : { mainFilePath }),
      ...(compiler === undefined ? {} : { compiler }),
      createdAt: now,
      updatedAt: now
    };
    const initialFiles = request.files ?? [];
    const initialDirectories = request.directories ?? [];

    return this.store.update((database) => {
      let nextDatabase: SharedProjectDatabase = {
        ...database,
        projects: [...database.projects, project],
        members: [
          ...database.members,
          {
            projectId: project.id,
            userId: actorUserId,
            role: "owner",
            joinedAt: now
          }
        ],
        activity: [
          ...database.activity,
          createActivity(
            project.id,
            actorUserId,
            "project.created",
            `Created ${name}.`,
            now
          )
        ]
      };

      for (const directory of initialDirectories) {
        nextDatabase = putDirectoryInDatabase(nextDatabase, {
          projectId: project.id,
          path: directory.path,
          now
        });
      }

      for (const file of initialFiles) {
        const contentEncoding = normalizeFileContentEncoding(file.contentEncoding);
        nextDatabase = putFileInDatabase(nextDatabase, {
          projectId: project.id,
          actorUserId,
          path: file.path,
          contents: file.contents,
          ...(contentEncoding === undefined ? {} : { contentEncoding }),
          now
        });
      }

      if (
        mainFilePath !== undefined &&
        !nextDatabase.files.some(
          (file) => file.projectId === project.id && file.path === mainFilePath
        )
      ) {
        throw new SharedProjectServerError(
          "Main file must exist in the shared project.",
          400,
          "invalid-main-file"
        );
      }

      return databaseUpdate(nextDatabase, project);
    });
  }

  async getProject(actorUserId: string, projectId: string): Promise<SharedProject> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);
    return requireProject(database, projectId);
  }

  async updateProjectSettings(
    actorUserId: string,
    projectId: string,
    update: SharedProjectSettingsUpdate
  ): Promise<SharedProject> {
    const now = new Date().toISOString();

    const project = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const currentProject = requireProject(database, projectId);
      const mainFilePath =
        update.mainFilePath === undefined
          ? currentProject.mainFilePath
          : normalizeProjectMainFilePath(update.mainFilePath);
      const compiler =
        update.compiler === undefined
          ? currentProject.compiler
          : normalizeSharedProjectCompiler(update.compiler);

      if (
        mainFilePath !== undefined &&
        !database.files.some(
          (file) => file.projectId === projectId && file.path === mainFilePath
        )
      ) {
        throw new SharedProjectServerError(
          "Main file must exist in the shared project.",
          400,
          "invalid-main-file"
        );
      }

      const nextProject: SharedProject = {
        ...currentProject,
        ...(mainFilePath === undefined ? {} : { mainFilePath }),
        ...(compiler === undefined ? {} : { compiler }),
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          projects: database.projects.map((project) =>
            project.id === projectId ? nextProject : project
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "project.settings.updated",
              "Updated shared project settings.",
              now
            )
          ]
        },
        nextProject
      );
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return project;
  }

  async listProjects(actorUserId: string): Promise<readonly SharedProjectListItem[]> {
    const database = await this.store.read();
    const memberRolesByProjectId = new Map(
      database.members
        .filter((member) => member.userId === actorUserId)
        .map((member) => [member.projectId, member.role])
    );

    return database.projects.flatMap((project) => {
      const role = memberRolesByProjectId.get(project.id);
      return role === undefined ? [] : [{ ...project, role }];
    });
  }

  async deleteProject(actorUserId: string, projectId: string): Promise<SharedProject> {
    const project = await this.store.update((database) => {
      requireProjectOwner(database, projectId, actorUserId);
      const project = requireProject(database, projectId);

      return databaseUpdate(
        {
          ...database,
          projects: database.projects.filter((candidate) => candidate.id !== projectId),
          members: database.members.filter((member) => member.projectId !== projectId),
          invitations: database.invitations.filter(
            (invitation) => invitation.projectId !== projectId
          ),
          files: database.files.filter((file) => file.projectId !== projectId),
          directories: database.directories.filter(
            (directory) => directory.projectId !== projectId
          ),
          revisions: database.revisions.filter(
            (revision) => revision.projectId !== projectId
          ),
          documentUpdates: database.documentUpdates.filter(
            (update) => update.projectId !== projectId
          ),
          presence: database.presence.filter(
            (presence) => presence.projectId !== projectId
          ),
          buildArtifacts: database.buildArtifacts.filter(
            (artifact) => artifact.projectId !== projectId
          ),
          agentRuns: database.agentRuns.filter(
            (agentRun) => agentRun.projectId !== projectId
          ),
          changesets: database.changesets.filter(
            (changeset) => changeset.projectId !== projectId
          ),
          comments: database.comments.filter(
            (comment) => comment.projectId !== projectId
          ),
          activity: database.activity.filter((event) => event.projectId !== projectId)
        },
        project
      );
    });
    this.realtimePublisher?.closeProject(projectId, "Project was deleted.");
    return project;
  }

  async exportProjectSource(
    actorUserId: string,
    projectId: string
  ): Promise<SharedProjectSourceExport> {
    const database = await this.store.read();
    requireProjectOwner(database, projectId, actorUserId);
    const project = requireProject(database, projectId);
    const files = database.files
      .filter((file) => file.projectId === projectId)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => requireLatestFileRevision(database, projectId, file.path));
    const directories = database.directories
      .filter((directory) => directory.projectId === projectId)
      .sort((left, right) => left.path.localeCompare(right.path));

    return { project, files, directories, exportedAt: new Date().toISOString() };
  }

  async getTree(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectTreeNode[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return createTree({
      directories: database.directories.filter(
        (directory) => directory.projectId === projectId
      ),
      files: database.files.filter((file) => file.projectId === projectId)
    });
  }

  async createDirectory(
    actorUserId: string,
    projectId: string,
    request: SharedProjectDirectoryCreate
  ): Promise<SharedProjectDirectory> {
    const now = new Date().toISOString();

    const directory = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const normalizedPath = normalizeProjectPath(request.path);

      const ancestorFile = findAncestorFile(database, projectId, normalizedPath);
      const fileCollision = database.files.find(
        (file) => file.projectId === projectId && file.path === normalizedPath
      );
      const directoryCollision = database.directories.find(
        (directory) =>
          directory.projectId === projectId && directory.path === normalizedPath
      );

      if (ancestorFile !== undefined || fileCollision !== undefined) {
        throw new SharedProjectServerError(
          "A project entry already exists at this path.",
          409,
          "conflict"
        );
      }

      if (directoryCollision !== undefined) {
        return databaseUpdate(database, directoryCollision);
      }

      const directory: SharedProjectDirectory = {
        projectId,
        path: normalizedPath,
        createdAt: now,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          projects: database.projects.map((project) =>
            project.id === projectId ? { ...project, updatedAt: now } : project
          ),
          directories: [...database.directories, directory],
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "directory.created",
              `Created folder ${normalizedPath}.`,
              now
            )
          ]
        },
        directory
      );
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return directory;
  }

  async readFile(
    actorUserId: string,
    projectId: string,
    path: string
  ): Promise<SharedProjectFileRevision> {
    const normalizedPath = normalizeProjectPath(path);
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    const file = database.files.find(
      (candidate) =>
        candidate.projectId === projectId && candidate.path === normalizedPath
    );

    if (file === undefined) {
      throw new SharedProjectServerError(
        "Project file was not found.",
        404,
        "not-found"
      );
    }

    const revision = database.revisions.find(
      (candidate) => candidate.id === file.latestRevisionId
    );

    if (revision === undefined) {
      throw new SharedProjectServerError(
        "Project file revision was not found.",
        500,
        "corrupt"
      );
    }

    return revision;
  }

  async listFileRevisions(
    actorUserId: string,
    projectId: string,
    path: string
  ): Promise<readonly SharedProjectFileRevisionSummary[]> {
    const normalizedPath = normalizeProjectPath(path);
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    const file = database.files.find(
      (candidate) =>
        candidate.projectId === projectId && candidate.path === normalizedPath
    );

    if (file === undefined) {
      throw new SharedProjectServerError(
        "Project file was not found.",
        404,
        "not-found"
      );
    }

    return database.revisions
      .filter(
        (revision) =>
          revision.projectId === projectId && revision.path === normalizedPath
      )
      .map(toSharedProjectFileRevisionSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getFileRevision(
    actorUserId: string,
    projectId: string,
    revisionId: string
  ): Promise<SharedProjectFileRevision> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    const revision = database.revisions.find(
      (candidate) => candidate.projectId === projectId && candidate.id === revisionId
    );

    if (revision === undefined) {
      throw new SharedProjectServerError(
        "Project file revision was not found.",
        404,
        "not-found"
      );
    }

    return revision;
  }

  async restoreFileRevision(
    actorUserId: string,
    projectId: string,
    revisionId: string
  ): Promise<SharedProjectFileRevision> {
    const now = new Date().toISOString();

    const revision = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const sourceRevision = database.revisions.find(
        (candidate) => candidate.projectId === projectId && candidate.id === revisionId
      );

      if (sourceRevision === undefined) {
        throw new SharedProjectServerError(
          "Project file revision was not found.",
          404,
          "not-found"
        );
      }

      const nextDatabase = putFileInDatabase(database, {
        projectId,
        actorUserId,
        path: sourceRevision.path,
        contents: sourceRevision.contents,
        ...(sourceRevision.contentEncoding === undefined
          ? {}
          : { contentEncoding: sourceRevision.contentEncoding }),
        activityEventType: "file.revision.restored",
        activityMessage: `Restored ${sourceRevision.path} from revision ${revisionId.slice(0, 8)}.`,
        now
      });
      const revision = nextDatabase.revisions.at(-1);

      if (revision === undefined) {
        throw new SharedProjectServerError(
          "Restored file revision was not created.",
          500,
          "corrupt"
        );
      }

      return databaseUpdate(nextDatabase, revision);
    });

    this.publishRealtime({
      type: "file.updated",
      projectId,
      path: revision.path,
      revisionId: revision.id
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return revision;
  }

  async createFile(
    actorUserId: string,
    projectId: string,
    request: SharedProjectFileCreateRequest
  ): Promise<SharedProjectFileRevision> {
    const now = new Date().toISOString();

    const revision = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const normalizedPath = normalizeProjectPath(request.path);
      const existingFile = database.files.find(
        (file) => file.projectId === projectId && file.path === normalizedPath
      );

      if (existingFile !== undefined) {
        throw new SharedProjectServerError(
          "A project file already exists at this path.",
          409,
          "conflict"
        );
      }

      const nextDatabase = putFileInDatabase(database, {
        projectId,
        actorUserId,
        path: normalizedPath,
        contents: request.contents,
        ...(request.contentEncoding === undefined
          ? {}
          : { contentEncoding: request.contentEncoding }),
        now
      });
      const revision = nextDatabase.revisions.at(-1);

      if (revision === undefined) {
        throw new SharedProjectServerError(
          "File revision was not created.",
          500,
          "corrupt"
        );
      }

      return databaseUpdate(nextDatabase, revision);
    });
    this.publishRealtime({
      type: "file.updated",
      projectId,
      path: revision.path,
      revisionId: revision.id
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return revision;
  }

  async writeFile(
    actorUserId: string,
    projectId: string,
    path: string,
    request: SharedProjectFileWriteRequest
  ): Promise<SharedProjectFileRevision> {
    const now = new Date().toISOString();

    const revision = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const normalizedPath = normalizeProjectPath(path);
      const existingFile = database.files.find(
        (file) => file.projectId === projectId && file.path === normalizedPath
      );

      if (
        request.expectedRevisionId !== undefined &&
        existingFile?.latestRevisionId !== request.expectedRevisionId
      ) {
        throw new SharedProjectServerError(
          "Project file has changed since this client last synced.",
          409,
          "revision-conflict"
        );
      }

      const nextDatabase = putFileInDatabase(database, {
        projectId,
        actorUserId,
        path: normalizedPath,
        contents: request.contents,
        now
      });
      const revision = nextDatabase.revisions.at(-1);

      if (revision === undefined) {
        throw new SharedProjectServerError(
          "File revision was not created.",
          500,
          "corrupt"
        );
      }

      return databaseUpdate(nextDatabase, revision);
    });
    this.publishRealtime({
      type: "file.updated",
      projectId,
      path: revision.path,
      revisionId: revision.id
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return revision;
  }

  async renameEntry(
    actorUserId: string,
    projectId: string,
    path: string,
    newName: string
  ): Promise<readonly SharedProjectFile[]> {
    const normalizedPath = normalizeProjectPath(path);
    const normalizedNewName = normalizeEntryName(newName);
    const nextPath = getSiblingProjectPath(normalizedPath, normalizedNewName);
    return this.moveEntry(actorUserId, projectId, normalizedPath, nextPath);
  }

  async moveEntry(
    actorUserId: string,
    projectId: string,
    path: string,
    newPath: string
  ): Promise<readonly SharedProjectFile[]> {
    const normalizedPath = normalizeProjectPath(path);
    const normalizedNewPath = normalizeProjectPath(newPath);
    const now = new Date().toISOString();

    if (normalizedPath === normalizedNewPath) {
      return [];
    }

    const movedFiles = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const movedFiles = collectMovedFiles(
        database,
        projectId,
        normalizedPath,
        normalizedNewPath
      );
      const movedDirectories = collectMovedDirectories(
        database,
        projectId,
        normalizedPath,
        normalizedNewPath
      );

      if (movedFiles.length === 0 && movedDirectories.length === 0) {
        throw new SharedProjectServerError(
          "Project entry was not found.",
          404,
          "not-found"
        );
      }

      const movedSourcePaths = new Set(movedFiles.map((file) => file.path));
      const movedTargetPaths = new Set(movedFiles.map((file) => file.toPath));
      const movedDirectorySourcePaths = new Set(
        movedDirectories.map((directory) => directory.path)
      );
      const movedDirectoryTargetPaths = new Set(
        movedDirectories.map((directory) => directory.toPath)
      );
      const targetCollision = database.files.find(
        (file) =>
          file.projectId === projectId &&
          (movedTargetPaths.has(file.path) ||
            movedDirectoryTargetPaths.has(file.path)) &&
          !movedSourcePaths.has(file.path)
      );
      const targetDirectoryCollision = database.directories.find(
        (directory) =>
          directory.projectId === projectId &&
          (movedTargetPaths.has(directory.path) ||
            movedDirectoryTargetPaths.has(directory.path)) &&
          !movedDirectorySourcePaths.has(directory.path)
      );

      if (targetCollision !== undefined || targetDirectoryCollision !== undefined) {
        throw new SharedProjectServerError(
          "A project entry already exists at the destination.",
          409,
          "conflict"
        );
      }

      return databaseUpdate(
        {
          ...database,
          projects: database.projects.map((project) =>
            updateProjectForMovedEntry(project, projectId, movedFiles, now)
          ),
          files: database.files.map((file) => {
            const movedFile = movedFiles.find(
              (candidate) => candidate.path === file.path
            );
            return movedFile === undefined
              ? file
              : { ...file, path: movedFile.toPath, updatedAt: now };
          }),
          directories: database.directories.map((directory) => {
            const movedDirectory = movedDirectories.find(
              (candidate) => candidate.path === directory.path
            );
            return movedDirectory === undefined
              ? directory
              : { ...directory, path: movedDirectory.toPath, updatedAt: now };
          }),
          revisions: database.revisions.map((revision) => {
            const movedFile = movedFiles.find(
              (candidate) =>
                revision.projectId === projectId && candidate.path === revision.path
            );
            return movedFile === undefined
              ? revision
              : { ...revision, path: movedFile.toPath };
          }),
          documentUpdates: database.documentUpdates.map((update) => {
            const movedFile = movedFiles.find(
              (candidate) =>
                update.projectId === projectId && candidate.path === update.path
            );
            return movedFile === undefined
              ? update
              : { ...update, path: movedFile.toPath };
          }),
          presence: database.presence.map((presence) => {
            if (presence.filePath === undefined) {
              return presence;
            }

            const movedFile = movedFiles.find(
              (candidate) =>
                presence.projectId === projectId && candidate.path === presence.filePath
            );
            return movedFile === undefined
              ? presence
              : { ...presence, filePath: movedFile.toPath, updatedAt: now };
          }),
          comments: database.comments.map((comment) => {
            if (comment.filePath === undefined) {
              return comment;
            }

            const movedFile = movedFiles.find(
              (candidate) =>
                comment.projectId === projectId && candidate.path === comment.filePath
            );
            return movedFile === undefined
              ? comment
              : { ...comment, filePath: movedFile.toPath, updatedAt: now };
          }),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "entry.moved",
              `Moved ${normalizedPath} to ${normalizedNewPath}.`,
              now
            )
          ]
        },
        movedFiles.map((file) => ({
          ...file.source,
          path: file.toPath,
          updatedAt: now
        }))
      );
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return movedFiles;
  }

  async deleteEntry(
    actorUserId: string,
    projectId: string,
    path: string
  ): Promise<readonly string[]> {
    const normalizedPath = normalizeProjectPath(path);
    const now = new Date().toISOString();

    const deletedPaths = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const deletedPaths = database.files
        .filter(
          (file) =>
            file.projectId === projectId &&
            isPathOrDescendant(file.path, normalizedPath)
        )
        .map((file) => file.path);
      const deletedDirectoryPaths = database.directories
        .filter(
          (directory) =>
            directory.projectId === projectId &&
            isPathOrDescendant(directory.path, normalizedPath)
        )
        .map((directory) => directory.path);

      if (deletedPaths.length === 0 && deletedDirectoryPaths.length === 0) {
        throw new SharedProjectServerError(
          "Project entry was not found.",
          404,
          "not-found"
        );
      }

      const deletedPathSet = new Set(deletedPaths);
      const deletedDirectoryPathSet = new Set(deletedDirectoryPaths);
      return databaseUpdate(
        {
          ...database,
          projects: database.projects.map((project) =>
            updateProjectForDeletedEntry(project, projectId, deletedPathSet, now)
          ),
          files: database.files.filter(
            (file) => file.projectId !== projectId || !deletedPathSet.has(file.path)
          ),
          directories: database.directories.filter(
            (directory) =>
              directory.projectId !== projectId ||
              !deletedDirectoryPathSet.has(directory.path)
          ),
          documentUpdates: database.documentUpdates.filter(
            (update) =>
              update.projectId !== projectId || !deletedPathSet.has(update.path)
          ),
          presence: database.presence.filter(
            (presence) =>
              presence.projectId !== projectId ||
              presence.filePath === undefined ||
              !deletedPathSet.has(presence.filePath)
          ),
          comments: database.comments.filter(
            (comment) =>
              comment.projectId !== projectId ||
              comment.filePath === undefined ||
              !deletedPathSet.has(comment.filePath)
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "entry.deleted",
              `Deleted ${normalizedPath}.`,
              now
            )
          ]
        },
        [...deletedDirectoryPaths, ...deletedPaths]
      );
    });
    this.publishRealtime({ type: "tree.updated", projectId });
    return deletedPaths;
  }

  async createInvitation(
    actorUserId: string,
    projectId: string,
    email: string,
    role: Exclude<SharedProjectRole, "owner">
  ): Promise<SharedProjectInvitation> {
    const normalizedEmail = normalizeEmail(email);
    const now = new Date().toISOString();

    return this.store.update((database) => {
      requireProjectOwner(database, projectId, actorUserId);
      const invitation: SharedProjectInvitation = {
        id: randomUUID(),
        projectId,
        email: normalizedEmail,
        role,
        invitedByUserId: actorUserId,
        status: "pending",
        createdAt: now
      };

      return databaseUpdate(
        {
          ...database,
          invitations: [...database.invitations, invitation],
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "project.invitation.created",
              `Invited ${normalizedEmail} as ${role}.`,
              now
            )
          ]
        },
        invitation
      );
    });
  }

  async acceptInvitation(
    actorUserId: string,
    invitationId: string
  ): Promise<SharedProjectMember> {
    const now = new Date().toISOString();

    const member = await this.store.update((database) => {
      const actor = requireUser(database, actorUserId);
      const invitation = database.invitations.find(
        (candidate) => candidate.id === invitationId
      );

      if (invitation === undefined || invitation.status !== "pending") {
        throw new SharedProjectServerError(
          "Invitation was not found.",
          404,
          "not-found"
        );
      }

      if (invitation.email !== actor.email) {
        throw new SharedProjectServerError(
          "Invitation belongs to another user.",
          403,
          "forbidden"
        );
      }

      const existingMember = database.members.find(
        (member) =>
          member.projectId === invitation.projectId && member.userId === actorUserId
      );
      const member =
        existingMember ??
        ({
          projectId: invitation.projectId,
          userId: actorUserId,
          role: invitation.role,
          joinedAt: now
        } satisfies SharedProjectMember);

      return databaseUpdate(
        {
          ...database,
          members:
            existingMember === undefined
              ? [...database.members, member]
              : database.members,
          invitations: database.invitations.map((candidate) =>
            candidate.id === invitation.id
              ? { ...candidate, status: "accepted", acceptedAt: now }
              : candidate
          ),
          activity: [
            ...database.activity,
            createActivity(
              invitation.projectId,
              actorUserId,
              "project.invitation.accepted",
              `${actor.email} joined as ${invitation.role}.`,
              now
            )
          ]
        },
        member
      );
    });
    this.publishRealtime({
      type: "members.updated",
      projectId: member.projectId
    });
    return member;
  }

  async listMembers(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectMemberDetails[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return getProjectMemberDetails(database, projectId);
  }

  async updateMemberRole(
    actorUserId: string,
    projectId: string,
    targetUserId: string,
    role: Exclude<SharedProjectRole, "owner">
  ): Promise<SharedProjectMember> {
    const now = new Date().toISOString();

    const updatedMember = await this.store.update((database) => {
      requireProjectOwner(database, projectId, actorUserId);
      const targetMember = requireProjectMember(database, projectId, targetUserId);

      if (targetMember.role === "owner") {
        throw new SharedProjectServerError(
          "Owner role changes are not supported.",
          400,
          "invalid-role-change"
        );
      }

      const updatedMember = { ...targetMember, role };

      return databaseUpdate(
        {
          ...database,
          members: database.members.map((member) =>
            member.projectId === projectId && member.userId === targetUserId
              ? updatedMember
              : member
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "project.member.role.updated",
              `Updated member ${targetUserId} to ${role}.`,
              now
            )
          ]
        },
        updatedMember
      );
    });
    this.publishRealtime({
      type: "members.updated",
      projectId
    });
    return updatedMember;
  }

  async transferOwnership(
    actorUserId: string,
    projectId: string,
    targetUserId: string
  ): Promise<readonly SharedProjectMemberDetails[]> {
    const now = new Date().toISOString();

    const result = await this.store.update((database) => {
      requireProjectOwner(database, projectId, actorUserId);
      const targetMember = requireProjectMember(database, projectId, targetUserId);

      if (targetUserId === actorUserId || targetMember.role === "owner") {
        throw new SharedProjectServerError(
          "Choose a non-owner project member for ownership transfer.",
          400,
          "invalid-ownership-transfer"
        );
      }

      const nextDatabase: SharedProjectDatabase = {
        ...database,
        projects: database.projects.map((project) =>
          project.id === projectId
            ? { ...project, ownerUserId: targetUserId, updatedAt: now }
            : project
        ),
        members: database.members.map((member) => {
          if (member.projectId !== projectId) {
            return member;
          }

          if (member.userId === actorUserId) {
            return { ...member, role: "editor" };
          }

          if (member.userId === targetUserId) {
            return { ...member, role: "owner" };
          }

          return member;
        }),
        activity: [
          ...database.activity,
          createActivity(
            projectId,
            actorUserId,
            "project.ownership.transferred",
            `Transferred ownership to member ${targetUserId}.`,
            now
          )
        ]
      };

      return databaseUpdate(
        nextDatabase,
        getProjectMemberDetails(nextDatabase, projectId)
      );
    });
    this.publishRealtime({
      type: "members.updated",
      projectId
    });
    return result;
  }

  async removeMember(
    actorUserId: string,
    projectId: string,
    targetUserId: string
  ): Promise<SharedProjectMember> {
    const now = new Date().toISOString();

    const member = await this.store.update((database) => {
      requireProjectOwner(database, projectId, actorUserId);
      const targetMember = requireProjectMember(database, projectId, targetUserId);

      if (targetMember.role === "owner") {
        throw new SharedProjectServerError(
          "Owner removal is not supported.",
          400,
          "invalid-member-removal"
        );
      }

      return databaseUpdate(
        {
          ...database,
          members: database.members.filter(
            (member) => member.projectId !== projectId || member.userId !== targetUserId
          ),
          presence: database.presence.filter(
            (presence) =>
              presence.projectId !== projectId || presence.userId !== targetUserId
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "project.member.removed",
              `Removed member ${targetUserId}.`,
              now
            )
          ]
        },
        targetMember
      );
    });
    this.realtimePublisher?.closeProjectUser(
      projectId,
      targetUserId,
      "Project membership was removed."
    );
    this.publishRealtime({
      type: "members.updated",
      projectId
    });
    return member;
  }

  async uploadBuildArtifact(
    actorUserId: string,
    projectId: string,
    upload: SharedProjectBuildArtifactUpload
  ): Promise<SharedProjectBuildArtifact> {
    const now = new Date().toISOString();
    const sourceRevisionId = requireNonEmptyString(
      upload.sourceRevisionId,
      "sourceRevisionId"
    );
    const desktopClientId = normalizeOptionalNonEmptyString(
      upload.desktopClientId,
      "desktopClientId"
    );
    const compiler = requireNonEmptyString(upload.compiler, "compiler");
    const status = normalizeBuildArtifactStatus(upload.status);
    const platform = normalizeBuildArtifactPlatform(upload.platform);
    const rawLog = requireString(upload.rawLog, "rawLog");
    const diagnostics = normalizeBuildDiagnostics(upload.diagnostics);

    const artifact = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const sourceRevision = database.revisions.find(
        (revision) =>
          revision.projectId === projectId && revision.id === sourceRevisionId
      );

      if (sourceRevision === undefined) {
        throw new SharedProjectServerError(
          "Source revision was not found.",
          404,
          "not-found"
        );
      }

      const artifact = withOptionalPdfFields(
        {
          id: randomUUID(),
          projectId,
          sourceRevisionId,
          desktopClientId,
          uploaderUserId: actorUserId,
          compiler,
          ...(upload.engineVersion === undefined
            ? {}
            : {
                engineVersion: normalizeOptionalNonEmptyString(
                  upload.engineVersion,
                  "engineVersion"
                )
              }),
          ...(upload.latexmkVersion === undefined
            ? {}
            : {
                latexmkVersion: normalizeOptionalNonEmptyString(
                  upload.latexmkVersion,
                  "latexmkVersion"
                )
              }),
          status,
          platform,
          rawLog,
          diagnostics,
          createdAt: now
        },
        upload
      );

      return databaseUpdate(
        {
          ...database,
          buildArtifacts: [...database.buildArtifacts, artifact],
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "build-artifact.created",
              `Uploaded ${status} local ${compiler} build artifact.`,
              now
            )
          ]
        },
        artifact
      );
    });
    this.publishRealtime({
      type: "build-artifact.created",
      projectId,
      artifactId: artifact.id
    });
    return artifact;
  }

  async listBuildArtifacts(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectBuildArtifact[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.buildArtifacts.filter(
      (artifact) => artifact.projectId === projectId
    );
  }

  async getBuildArtifact(
    actorUserId: string,
    projectId: string,
    artifactId: string
  ): Promise<SharedProjectBuildArtifact> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);
    const artifact = database.buildArtifacts.find(
      (candidate) => candidate.projectId === projectId && candidate.id === artifactId
    );

    if (artifact === undefined) {
      throw new SharedProjectServerError(
        "Build artifact was not found.",
        404,
        "not-found"
      );
    }

    return artifact;
  }

  async getDocumentState(
    actorUserId: string,
    projectId: string,
    path: string
  ): Promise<SharedProjectDocumentState> {
    const normalizedPath = normalizeProjectPath(path);
    const now = new Date().toISOString();

    return this.store.update((database) => {
      requireProjectMember(database, projectId, actorUserId);
      assertCollaborativeDocumentPath(database, projectId, normalizedPath);
      const nextDatabase = ensureDocumentBaseUpdate(
        database,
        projectId,
        normalizedPath,
        actorUserId,
        now
      );

      return databaseUpdate(
        nextDatabase,
        createDocumentState(nextDatabase, projectId, normalizedPath)
      );
    });
  }

  async applyDocumentUpdate(
    actorUserId: string,
    projectId: string,
    path: string,
    updateBase64: string,
    clientOperationId?: string,
    expectedRevisionId?: string
  ): Promise<SharedProjectDocumentUpdateResult> {
    const normalizedPath = normalizeProjectPath(path);
    const normalizedClientOperationId =
      normalizeOptionalClientOperationId(clientOperationId);
    const now = new Date().toISOString();

    const result: SharedProjectDocumentUpdateResult = await this.store.update(
      (database) => {
        requireProjectEditor(database, projectId, actorUserId);
        assertCollaborativeDocumentPath(database, projectId, normalizedPath);
        const databaseWithBaseUpdate = ensureDocumentBaseUpdate(
          database,
          projectId,
          normalizedPath,
          actorUserId,
          now
        );
        const latestRevision = requireLatestFileRevision(
          databaseWithBaseUpdate,
          projectId,
          normalizedPath
        );

        if (
          expectedRevisionId !== undefined &&
          latestRevision.id !== expectedRevisionId
        ) {
          throw new SharedProjectServerError(
            "Project file has changed since this client last synced.",
            409,
            "revision-conflict"
          );
        }

        const existingUpdate =
          normalizedClientOperationId === undefined
            ? undefined
            : databaseWithBaseUpdate.documentUpdates.find(
                (update) =>
                  update.projectId === projectId &&
                  update.path === normalizedPath &&
                  update.actorUserId === actorUserId &&
                  update.clientOperationId === normalizedClientOperationId
              );

        if (existingUpdate !== undefined) {
          return databaseUpdate(databaseWithBaseUpdate, {
            update: existingUpdate,
            state: createDocumentState(
              databaseWithBaseUpdate,
              projectId,
              normalizedPath
            ),
            revision: latestRevision,
            replayed: true
          });
        }

        const update: SharedProjectDocumentUpdate = {
          id: randomUUID(),
          projectId,
          path: normalizedPath,
          actorUserId,
          updateBase64: validateBase64Update(updateBase64),
          ...(normalizedClientOperationId === undefined
            ? {}
            : { clientOperationId: normalizedClientOperationId }),
          createdAt: now
        };
        const projected = projectDocumentUpdate(databaseWithBaseUpdate, update);
        const nextDatabase = putFileInDatabase(
          {
            ...databaseWithBaseUpdate,
            documentUpdates: [...databaseWithBaseUpdate.documentUpdates, update]
          },
          {
            projectId,
            actorUserId,
            path: normalizedPath,
            contents: projected.contents,
            now
          }
        );
        const revision = nextDatabase.revisions.at(-1);

        if (revision === undefined) {
          throw new SharedProjectServerError(
            "Document update revision was not created.",
            500,
            "corrupt"
          );
        }

        return databaseUpdate(nextDatabase, {
          update,
          state: createDocumentState(nextDatabase, projectId, normalizedPath),
          revision
        });
      }
    );
    if (result.replayed !== true) {
      this.publishRealtime({
        type: "document.updated",
        projectId,
        path: result.revision.path,
        updateId: result.update.id,
        revisionId: result.revision.id
      });
      this.publishRealtime({
        type: "file.updated",
        projectId,
        path: result.revision.path,
        revisionId: result.revision.id
      });
    }
    return result;
  }

  async listDocumentUpdates(
    actorUserId: string,
    projectId: string,
    path: string,
    afterUpdateId?: string
  ): Promise<SharedProjectDocumentUpdateFeed> {
    const normalizedPath = normalizeProjectPath(path);
    const now = new Date().toISOString();

    return this.store.update((database) => {
      requireProjectMember(database, projectId, actorUserId);
      assertCollaborativeDocumentPath(database, projectId, normalizedPath);
      const nextDatabase = ensureDocumentBaseUpdate(
        database,
        projectId,
        normalizedPath,
        actorUserId,
        now
      );
      const allUpdates = nextDatabase.documentUpdates.filter(
        (update) => update.projectId === projectId && update.path === normalizedPath
      );
      const afterIndex =
        afterUpdateId === undefined
          ? -1
          : allUpdates.findIndex((update) => update.id === afterUpdateId);
      const updates = allUpdates.slice(afterIndex + 1);
      const latestUpdateId = allUpdates.at(-1)?.id;
      const feed: SharedProjectDocumentUpdateFeed =
        latestUpdateId === undefined
          ? {
              updates,
              state: createDocumentState(nextDatabase, projectId, normalizedPath)
            }
          : {
              updates,
              state: createDocumentState(nextDatabase, projectId, normalizedPath),
              latestUpdateId
            };

      return databaseUpdate(nextDatabase, feed);
    });
  }

  async updatePresence(
    actorUserId: string,
    projectId: string,
    update: SharedProjectPresenceUpdate
  ): Promise<SharedProjectPresence> {
    const now = new Date().toISOString();

    const presence = await this.store.update((database) => {
      const member = requireProjectMember(database, projectId, actorUserId);
      const actor = requireUser(database, actorUserId);
      const presence = withOptionalPresenceFields(
        {
          projectId,
          userId: actorUserId,
          displayName: actor.name,
          updatedAt: now
        },
        update
      );

      return databaseUpdate(
        {
          ...database,
          presence: [
            ...database.presence.filter(
              (candidate) =>
                candidate.projectId !== projectId || candidate.userId !== member.userId
            ),
            presence
          ]
        },
        presence
      );
    });
    this.publishRealtime({ type: "presence.updated", projectId, presence });
    return presence;
  }

  async listPresence(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectPresence[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.presence.filter((presence) => presence.projectId === projectId);
  }

  async createAgentRun(
    actorUserId: string,
    projectId: string,
    request: SharedProjectAgentRunCreate
  ): Promise<SharedProjectAgentRun> {
    const now = new Date().toISOString();

    const agentRun = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const buildArtifactIds = (request.buildArtifactIds ?? []).map((artifactId) =>
        requireNonEmptyString(artifactId, "buildArtifactId")
      );

      for (const artifactId of buildArtifactIds) {
        const artifact = database.buildArtifacts.find(
          (candidate) =>
            candidate.projectId === projectId && candidate.id === artifactId
        );

        if (artifact === undefined) {
          throw new SharedProjectServerError(
            "Build artifact was not found.",
            404,
            "not-found"
          );
        }
      }

      const agentRun: SharedProjectAgentRun = {
        id: randomUUID(),
        projectId,
        actorUserId,
        providerId: requireNonEmptyString(request.providerId, "providerId"),
        mode: requireNonEmptyString(request.mode, "mode"),
        promptHash: createPromptHash(requireNonEmptyString(request.prompt, "prompt")),
        status: request.status ?? "running",
        changesetIds: [],
        buildArtifactIds,
        createdAt: now,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          agentRuns: [...database.agentRuns, agentRun],
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "agent.run.created",
              `Started ${agentRun.providerId} agent run.`,
              now
            ),
            ...createAgentRunStatusActivities(projectId, actorUserId, agentRun, now)
          ],
          auditEvents: [
            ...database.auditEvents,
            createAuditEvent(
              projectId,
              actorUserId,
              "agent.run.created",
              `Started ${agentRun.providerId} agent run.`,
              now,
              { agentRunId: agentRun.id }
            ),
            ...createAgentRunStatusAuditEvents(projectId, actorUserId, agentRun, now)
          ]
        },
        agentRun
      );
    });
    this.publishRealtime({
      type: "agent.run.updated",
      projectId,
      agentRunId: agentRun.id,
      status: agentRun.status
    });
    return agentRun;
  }

  async listAgentRuns(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectAgentRun[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.agentRuns.filter((agentRun) => agentRun.projectId === projectId);
  }

  async updateAgentRunStatus(
    actorUserId: string,
    projectId: string,
    agentRunId: string,
    request: SharedProjectAgentRunStatusUpdate
  ): Promise<SharedProjectAgentRun> {
    const now = new Date().toISOString();

    const agentRun = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const agentRun = requireAgentRun(database, projectId, agentRunId);

      if (agentRun.actorUserId !== actorUserId) {
        throw new SharedProjectServerError(
          "Agent run belongs to another user.",
          403,
          "forbidden"
        );
      }

      const status = normalizeAgentRunStatus(request.status);
      if (agentRun.status === status) {
        return databaseUpdate(database, agentRun);
      }

      const updatedAgentRun: SharedProjectAgentRun = {
        ...agentRun,
        status,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          agentRuns: database.agentRuns.map((candidate) =>
            candidate.id === agentRun.id ? updatedAgentRun : candidate
          ),
          activity: [
            ...database.activity,
            ...createAgentRunStatusActivities(
              projectId,
              actorUserId,
              updatedAgentRun,
              now
            )
          ],
          auditEvents: [
            ...database.auditEvents,
            ...createAgentRunStatusAuditEvents(
              projectId,
              actorUserId,
              updatedAgentRun,
              now
            )
          ]
        },
        updatedAgentRun
      );
    });
    this.publishRealtime({
      type: "agent.run.updated",
      projectId,
      agentRunId: agentRun.id,
      status: agentRun.status
    });
    return agentRun;
  }

  async attachBuildArtifactToAgentRun(
    actorUserId: string,
    projectId: string,
    agentRunId: string,
    request: SharedProjectAgentRunBuildArtifactAttach
  ): Promise<SharedProjectAgentRun> {
    const now = new Date().toISOString();

    const agentRun = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const artifactId = requireNonEmptyString(request.artifactId, "artifactId");
      const agentRun = database.agentRuns.find(
        (candidate) => candidate.projectId === projectId && candidate.id === agentRunId
      );

      if (agentRun === undefined) {
        throw new SharedProjectServerError(
          "Agent run was not found.",
          404,
          "not-found"
        );
      }

      if (agentRun.actorUserId !== actorUserId) {
        throw new SharedProjectServerError(
          "Agent run belongs to another user.",
          403,
          "forbidden"
        );
      }

      const artifact = database.buildArtifacts.find(
        (candidate) => candidate.projectId === projectId && candidate.id === artifactId
      );

      if (artifact === undefined) {
        throw new SharedProjectServerError(
          "Build artifact was not found.",
          404,
          "not-found"
        );
      }

      if (agentRun.buildArtifactIds.includes(artifactId)) {
        return databaseUpdate(database, agentRun);
      }

      const updatedAgentRun: SharedProjectAgentRun = {
        ...agentRun,
        buildArtifactIds: [...agentRun.buildArtifactIds, artifactId],
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          agentRuns: database.agentRuns.map((candidate) =>
            candidate.id === agentRun.id ? updatedAgentRun : candidate
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "agent.run.build-artifact.attached",
              `Attached ${artifact.status} ${artifact.compiler} compile artifact to ${agentRun.providerId} agent run.`,
              now
            )
          ],
          auditEvents: [
            ...database.auditEvents,
            createAuditEvent(
              projectId,
              actorUserId,
              "agent.run.build-artifact.attached",
              `Attached ${artifact.status} ${artifact.compiler} compile artifact to ${agentRun.providerId} agent run.`,
              now,
              { agentRunId: agentRun.id, buildArtifactIds: [artifact.id] }
            )
          ]
        },
        updatedAgentRun
      );
    });
    this.publishRealtime({
      type: "agent.run.updated",
      projectId,
      agentRunId: agentRun.id,
      status: agentRun.status
    });
    return agentRun;
  }

  async listAuditEvents(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectAuditEvent[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.auditEvents.filter((event) => event.projectId === projectId);
  }

  async recordAuditEvent(
    actorUserId: string,
    projectId: string,
    request: SharedProjectAuditEventCreate
  ): Promise<SharedProjectAuditEvent> {
    const now = new Date().toISOString();

    return this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const agentRunId =
        request.agentRunId === undefined
          ? undefined
          : requireNonEmptyString(request.agentRunId, "agentRunId");
      const changesetId =
        request.changesetId === undefined
          ? undefined
          : requireNonEmptyString(request.changesetId, "changesetId");
      const buildArtifactIds = request.buildArtifactIds?.map((artifactId) =>
        requireNonEmptyString(artifactId, "buildArtifactId")
      );

      if (agentRunId !== undefined) {
        requireAgentRun(database, projectId, agentRunId);
      }

      if (changesetId !== undefined) {
        requireChangeSet(database, projectId, changesetId);
      }

      for (const artifactId of buildArtifactIds ?? []) {
        requireBuildArtifact(database, projectId, artifactId);
      }

      const auditEvent = createAuditEvent(
        projectId,
        actorUserId,
        requireNonEmptyString(request.eventType, "eventType"),
        requireNonEmptyString(request.message, "message"),
        now,
        {
          ...(agentRunId === undefined ? {} : { agentRunId }),
          ...(changesetId === undefined ? {} : { changesetId }),
          ...(buildArtifactIds === undefined ? {} : { buildArtifactIds })
        }
      );

      return databaseUpdate(
        {
          ...database,
          auditEvents: [...database.auditEvents, auditEvent]
        },
        auditEvent
      );
    });
  }

  async createChangeSet(
    actorUserId: string,
    projectId: string,
    request: SharedProjectChangeSetCreate
  ): Promise<SharedProjectChangeSet> {
    const now = new Date().toISOString();

    const changeset = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const agentRun = requireAgentRun(
        database,
        projectId,
        requireNonEmptyString(request.agentRunId, "agentRunId")
      );

      if (agentRun.actorUserId !== actorUserId) {
        throw new SharedProjectServerError(
          "Agent run belongs to another user.",
          403,
          "forbidden"
        );
      }

      const changeset: SharedProjectChangeSet = {
        id: randomUUID(),
        projectId,
        agentRunId: agentRun.id,
        actorUserId,
        filePath: normalizeProjectPath(request.filePath),
        ...(request.beforeRevisionId === undefined
          ? {}
          : {
              beforeRevisionId: requireNonEmptyString(
                request.beforeRevisionId,
                "beforeRevisionId"
              )
            }),
        beforeContents: requireString(request.beforeContents, "beforeContents"),
        afterContents: requireString(request.afterContents, "afterContents"),
        summary: requireNonEmptyString(request.summary, "summary"),
        status: "proposed",
        createdAt: now,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          changesets: [...database.changesets, changeset],
          agentRuns: database.agentRuns.map((candidate) =>
            candidate.id === agentRun.id
              ? {
                  ...candidate,
                  status: "waiting-for-review",
                  changesetIds: [...candidate.changesetIds, changeset.id],
                  updatedAt: now
                }
              : candidate
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "agent.changeset.proposed",
              `Proposed changeset for ${changeset.filePath}.`,
              now
            )
          ],
          auditEvents: [
            ...database.auditEvents,
            createAuditEvent(
              projectId,
              actorUserId,
              "agent.changeset.proposed",
              `Proposed changeset for ${changeset.filePath}.`,
              now,
              { agentRunId: agentRun.id, changesetId: changeset.id }
            )
          ]
        },
        changeset
      );
    });
    this.publishRealtime({
      type: "agent.changeset.updated",
      projectId,
      changesetId: changeset.id,
      status: changeset.status
    });
    return changeset;
  }

  async applyChangeSet(
    actorUserId: string,
    projectId: string,
    changesetId: string
  ): Promise<SharedProjectChangeSet> {
    const now = new Date().toISOString();

    const result = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const changeset = requireChangeSet(database, projectId, changesetId);

      if (changeset.status !== "proposed") {
        throw new SharedProjectServerError(
          "Only proposed changesets can be applied.",
          400,
          "invalid-changeset-state"
        );
      }

      const currentRevision = readLatestRevision(
        database,
        projectId,
        changeset.filePath
      );

      const appliedRevision =
        currentRevision?.contents === changeset.afterContents
          ? currentRevision
          : undefined;

      if (
        appliedRevision === undefined &&
        changeset.beforeRevisionId !== undefined &&
        currentRevision?.id !== changeset.beforeRevisionId
      ) {
        throw new SharedProjectServerError(
          "Changeset base revision no longer matches the current file.",
          409,
          "changeset-conflict"
        );
      }

      if (
        appliedRevision === undefined &&
        changeset.beforeRevisionId === undefined &&
        currentRevision?.contents !== changeset.beforeContents
      ) {
        throw new SharedProjectServerError(
          "Changeset base no longer matches the current file.",
          409,
          "changeset-conflict"
        );
      }

      const databaseWithDocumentBase = ensureDocumentBaseUpdate(
        database,
        projectId,
        changeset.filePath,
        actorUserId,
        now
      );
      const replacementUpdateBase64 = createDocumentReplacementUpdate(
        databaseWithDocumentBase,
        projectId,
        changeset.filePath,
        changeset.afterContents
      );
      const replacementUpdate =
        replacementUpdateBase64 === undefined
          ? undefined
          : {
              id: randomUUID(),
              projectId,
              path: changeset.filePath,
              actorUserId,
              updateBase64: replacementUpdateBase64,
              clientOperationId: `agent-changeset:${changeset.id}`,
              createdAt: now
            };
      const databaseWithDocumentUpdate =
        replacementUpdate === undefined
          ? databaseWithDocumentBase
          : {
              ...databaseWithDocumentBase,
              documentUpdates: [
                ...databaseWithDocumentBase.documentUpdates,
                replacementUpdate
              ]
            };
      const nextDatabase =
        appliedRevision === undefined
          ? putFileInDatabase(databaseWithDocumentUpdate, {
              projectId,
              actorUserId,
              path: changeset.filePath,
              contents: changeset.afterContents,
              now
            })
          : databaseWithDocumentUpdate;
      const revision = appliedRevision ?? nextDatabase.revisions.at(-1);

      if (revision === undefined) {
        throw new SharedProjectServerError(
          "Applied changeset revision was not created.",
          500,
          "corrupt"
        );
      }

      const appliedChangeset = {
        ...changeset,
        status: "applied" as const,
        updatedAt: now,
        appliedAt: now,
        appliedRevisionId: revision.id
      };

      return databaseUpdate(
        {
          ...nextDatabase,
          changesets: nextDatabase.changesets.map((candidate) =>
            candidate.id === changeset.id ? appliedChangeset : candidate
          ),
          agentRuns: nextDatabase.agentRuns.map((agentRun) =>
            agentRun.id === changeset.agentRunId
              ? { ...agentRun, status: "completed", updatedAt: now }
              : agentRun
          ),
          activity: [
            ...nextDatabase.activity,
            createActivity(
              projectId,
              actorUserId,
              "agent.changeset.applied",
              `Applied changeset for ${changeset.filePath}.`,
              now
            )
          ],
          auditEvents: [
            ...nextDatabase.auditEvents,
            createAuditEvent(
              projectId,
              actorUserId,
              "agent.changeset.applied",
              `Applied changeset for ${changeset.filePath}.`,
              now,
              { agentRunId: changeset.agentRunId, changesetId: changeset.id }
            )
          ]
        },
        {
          changeset: appliedChangeset,
          documentUpdateId: replacementUpdate?.id,
          filePath: changeset.filePath,
          revisionId: revision.id
        }
      );
    });
    this.publishRealtime({
      type: "agent.changeset.updated",
      projectId,
      changesetId: result.changeset.id,
      status: result.changeset.status
    });
    if (result.documentUpdateId !== undefined) {
      this.publishRealtime({
        type: "document.updated",
        projectId,
        path: result.filePath,
        updateId: result.documentUpdateId,
        revisionId: result.revisionId
      });
    }
    if (result.changeset.appliedRevisionId !== undefined) {
      this.publishRealtime({
        type: "file.updated",
        projectId,
        path: result.changeset.filePath,
        revisionId: result.changeset.appliedRevisionId
      });
    }
    return result.changeset;
  }

  async rejectChangeSet(
    actorUserId: string,
    projectId: string,
    changesetId: string
  ): Promise<SharedProjectChangeSet> {
    const now = new Date().toISOString();

    const changeset = await this.store.update((database) => {
      requireProjectEditor(database, projectId, actorUserId);
      const changeset = requireChangeSet(database, projectId, changesetId);

      if (changeset.status !== "proposed") {
        throw new SharedProjectServerError(
          "Only proposed changesets can be rejected.",
          400,
          "invalid-changeset-state"
        );
      }

      const rejectedChangeset = {
        ...changeset,
        status: "rejected" as const,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          changesets: database.changesets.map((candidate) =>
            candidate.id === changeset.id ? rejectedChangeset : candidate
          ),
          agentRuns: database.agentRuns.map((agentRun) =>
            agentRun.id === changeset.agentRunId
              ? { ...agentRun, status: "cancelled", updatedAt: now }
              : agentRun
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "agent.changeset.rejected",
              `Rejected changeset for ${changeset.filePath}.`,
              now
            )
          ],
          auditEvents: [
            ...database.auditEvents,
            createAuditEvent(
              projectId,
              actorUserId,
              "agent.changeset.rejected",
              `Rejected changeset for ${changeset.filePath}.`,
              now,
              { agentRunId: changeset.agentRunId, changesetId: changeset.id }
            )
          ]
        },
        rejectedChangeset
      );
    });
    this.publishRealtime({
      type: "agent.changeset.updated",
      projectId,
      changesetId: changeset.id,
      status: changeset.status
    });
    return changeset;
  }

  async listChangeSets(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectChangeSet[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.changesets.filter((changeset) => changeset.projectId === projectId);
  }

  async listActivity(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectActivityEvent[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.activity
      .filter((event) => event.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listComments(
    actorUserId: string,
    projectId: string
  ): Promise<readonly SharedProjectComment[]> {
    const database = await this.store.read();
    requireProjectMember(database, projectId, actorUserId);

    return database.comments
      .filter((comment) => comment.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createComment(
    actorUserId: string,
    projectId: string,
    request: SharedProjectCommentCreate
  ): Promise<SharedProjectComment> {
    const now = new Date().toISOString();
    const body = normalizeCommentBody(request.body);
    const filePath =
      request.filePath === undefined
        ? undefined
        : normalizeProjectPath(request.filePath);
    const line = normalizeOptionalCommentLine(request.line);

    const comment = await this.store.update((database) => {
      requireProjectMember(database, projectId, actorUserId);

      if (
        filePath !== undefined &&
        database.files.find(
          (file) => file.projectId === projectId && file.path === filePath
        ) === undefined
      ) {
        throw new SharedProjectServerError(
          "Comment file anchor was not found.",
          404,
          "not-found"
        );
      }

      const comment: SharedProjectComment = {
        id: randomUUID(),
        projectId,
        authorUserId: actorUserId,
        body,
        ...(filePath === undefined ? {} : { filePath }),
        ...(line === undefined ? {} : { line }),
        resolved: false,
        createdAt: now,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          comments: [comment, ...database.comments],
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "comment.created",
              filePath === undefined
                ? "Commented on the project."
                : `Commented on ${filePath}.`,
              now
            )
          ]
        },
        comment
      );
    });

    this.publishRealtime({ type: "comments.updated", projectId });
    return comment;
  }

  async resolveComment(
    actorUserId: string,
    projectId: string,
    commentId: string
  ): Promise<SharedProjectComment> {
    const now = new Date().toISOString();

    const comment = await this.store.update((database) => {
      const member = requireProjectMember(database, projectId, actorUserId);
      const comment = database.comments.find(
        (candidate) => candidate.projectId === projectId && candidate.id === commentId
      );

      if (comment === undefined) {
        throw new SharedProjectServerError(
          "Project comment was not found.",
          404,
          "not-found"
        );
      }

      if (member.role === "viewer" && comment.authorUserId !== actorUserId) {
        throw new SharedProjectServerError(
          "Only editors, owners, or the comment author can resolve this comment.",
          403,
          "forbidden"
        );
      }

      const resolvedComment: SharedProjectComment = {
        ...comment,
        resolved: true,
        resolvedByUserId: actorUserId,
        resolvedAt: now,
        updatedAt: now
      };

      return databaseUpdate(
        {
          ...database,
          comments: database.comments.map((candidate) =>
            candidate.id === comment.id ? resolvedComment : candidate
          ),
          activity: [
            ...database.activity,
            createActivity(
              projectId,
              actorUserId,
              "comment.resolved",
              `Resolved comment ${comment.id.slice(0, 8)}.`,
              now
            )
          ]
        },
        resolvedComment
      );
    });

    this.publishRealtime({ type: "comments.updated", projectId });
    return comment;
  }
}

export function createSharedProjectHttpServer(service: SharedProjectService): Server {
  const realtimeHub = new SharedProjectRealtimeHub(service);
  service.setRealtimePublisher(realtimeHub);
  const server = createServer((request, response) => {
    void handleRequest(service, request, response);
  });
  realtimeHub.attach(server);
  return server;
}

export class SharedProjectServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "SharedProjectServerError";
  }
}

class SharedProjectRealtimeHub implements SharedProjectRealtimePublisher {
  private readonly socketsByProjectId = new Map<
    string,
    Set<SharedProjectRealtimeSocket>
  >();
  private readonly server = new WebSocketServer({ noServer: true });

  constructor(private readonly service: SharedProjectService) {}

  attach(httpServer: Server): void {
    httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    httpServer.on("close", () => {
      this.server.close();
      this.socketsByProjectId.clear();
    });
  }

  publish(event: SharedProjectRealtimeEvent): void {
    const sockets = this.socketsByProjectId.get(event.projectId);

    if (sockets === undefined) {
      return;
    }

    const payload = JSON.stringify(event);
    for (const realtimeSocket of sockets) {
      if (realtimeSocket.socket.readyState === WebSocket.OPEN) {
        realtimeSocket.socket.send(payload);
      }
    }
  }

  closeProject(projectId: string, reason: string): void {
    const sockets = this.socketsByProjectId.get(projectId);

    if (sockets === undefined) {
      return;
    }

    for (const realtimeSocket of [...sockets]) {
      closeRealtimeSocket(realtimeSocket.socket, reason);
    }
  }

  closeProjectUser(projectId: string, userId: string, reason: string): void {
    const sockets = this.socketsByProjectId.get(projectId);

    if (sockets === undefined) {
      return;
    }

    for (const realtimeSocket of [...sockets]) {
      if (realtimeSocket.userId === userId) {
        closeRealtimeSocket(realtimeSocket.socket, reason);
      }
    }
  }

  closeSession(sessionId: string, reason: string): void {
    for (const sockets of this.socketsByProjectId.values()) {
      for (const realtimeSocket of [...sockets]) {
        if (realtimeSocket.sessionId === sessionId) {
          closeRealtimeSocket(realtimeSocket.socket, reason);
        }
      }
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (
        segments.length !== 3 ||
        segments[0] !== "projects" ||
        segments[1] === undefined ||
        segments[2] !== "realtime"
      ) {
        throw new SharedProjectServerError(
          "Realtime route was not found.",
          404,
          "not-found"
        );
      }

      const projectId = segments[1];
      const authenticated = await this.service.authenticateSession(
        readRealtimeAccessToken(request, url)
      );
      await this.service.getTree(authenticated.user.id, projectId);

      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.addSocket(
          projectId,
          authenticated.user.id,
          authenticated.session.id,
          webSocket
        );
      });
    } catch (error) {
      rejectWebSocketUpgrade(socket, error);
    }
  }

  private addSocket(
    projectId: string,
    userId: string,
    sessionId: string,
    socket: WebSocket
  ): void {
    const sockets =
      this.socketsByProjectId.get(projectId) ?? new Set<SharedProjectRealtimeSocket>();
    const realtimeSocket = { socket, userId, sessionId };
    sockets.add(realtimeSocket);
    this.socketsByProjectId.set(projectId, sockets);

    socket.on("close", () => {
      sockets.delete(realtimeSocket);
      if (sockets.size === 0) {
        this.socketsByProjectId.delete(projectId);
      }
    });
    socket.on("error", () => {
      sockets.delete(realtimeSocket);
      if (sockets.size === 0) {
        this.socketsByProjectId.delete(projectId);
      }
    });
  }
}

type SharedProjectRealtimeSocket = {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly sessionId: string;
};

async function handleRequest(
  service: SharedProjectService,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "POST" && url.pathname === "/auth/sign-in") {
      const body = await readJsonBody<{
        readonly email?: unknown;
        readonly name?: unknown;
      }>(request);
      const result = await service.signIn(
        requireString(body.email, "email"),
        typeof body.name === "string" ? body.name : undefined
      );
      writeJson(response, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/auth/refresh") {
      const body = await readJsonBody<{
        readonly refreshToken?: unknown;
      }>(request);
      writeJson(
        response,
        200,
        await service.refreshSession(requireString(body.refreshToken, "refreshToken"))
      );
      return;
    }

    if (method === "POST" && url.pathname === "/auth/sign-out") {
      const body = await readJsonBody<{
        readonly refreshToken?: unknown;
      }>(request);
      writeJson(
        response,
        200,
        await service.signOut(requireString(body.refreshToken, "refreshToken"))
      );
      return;
    }

    const accessToken = readBearerToken(request);
    const actor = await service.authenticate(accessToken);

    if (method === "GET" && url.pathname === "/auth/session") {
      writeJson(response, 200, { user: actor });
      return;
    }

    if (method === "GET" && url.pathname === "/auth/sessions") {
      writeJson(response, 200, {
        sessions: await service.listSessions(actor.id, accessToken)
      });
      return;
    }

    if (
      method === "POST" &&
      segments[0] === "auth" &&
      segments[1] === "sessions" &&
      segments[2] !== undefined &&
      segments[3] === "revoke"
    ) {
      writeJson(response, 200, {
        result: await service.revokeSession(actor.id, segments[2])
      });
      return;
    }

    if (method === "GET" && url.pathname === "/projects") {
      writeJson(response, 200, { projects: await service.listProjects(actor.id) });
      return;
    }

    if (method === "POST" && url.pathname === "/projects") {
      const body = await readJsonBody<CreateProjectRequest>(request);
      writeJson(response, 201, {
        project: await service.createProject(actor.id, body)
      });
      return;
    }

    if (segments[0] === "projects" && segments[1] !== undefined) {
      await handleProjectRequest(
        service,
        actor,
        method,
        url,
        segments,
        request,
        response
      );
      return;
    }

    if (
      method === "POST" &&
      segments[0] === "invitations" &&
      segments[1] !== undefined &&
      segments[2] === "accept"
    ) {
      writeJson(response, 200, {
        member: await service.acceptInvitation(actor.id, segments[1])
      });
      return;
    }

    writeJson(response, 404, { error: "not-found", message: "Route was not found." });
  } catch (error) {
    writeError(response, error);
  }
}

async function handleProjectRequest(
  service: SharedProjectService,
  actor: SharedProjectUser,
  method: string,
  url: URL,
  segments: readonly string[],
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const projectId = segments[1] ?? "";

  if (method === "GET" && segments.length === 2) {
    writeJson(response, 200, {
      project: await service.getProject(actor.id, projectId)
    });
    return;
  }

  if (method === "PATCH" && segments.length === 3 && segments[2] === "settings") {
    const body = await readJsonBody<SharedProjectSettingsUpdate>(request);
    writeJson(response, 200, {
      project: await service.updateProjectSettings(actor.id, projectId, body)
    });
    return;
  }

  if (method === "DELETE" && segments.length === 2) {
    writeJson(response, 200, {
      project: await service.deleteProject(actor.id, projectId)
    });
    return;
  }

  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[2] === "export" &&
    segments[3] === "source"
  ) {
    writeJson(response, 200, {
      export: await service.exportProjectSource(actor.id, projectId)
    });
    return;
  }

  if (method === "GET" && segments.length === 3 && segments[2] === "tree") {
    writeJson(response, 200, {
      tree: await service.getTree(actor.id, projectId)
    });
    return;
  }

  if (segments[2] === "file-revisions" && segments.length >= 4) {
    const filePath = segments.slice(3).join("/");

    if (method === "GET") {
      writeJson(response, 200, {
        revisions: await service.listFileRevisions(actor.id, projectId, filePath)
      });
      return;
    }
  }

  if (segments[2] === "revisions" && segments.length >= 4) {
    const revisionId = segments[3] ?? "";

    if (method === "GET" && segments.length === 4) {
      writeJson(response, 200, {
        revision: await service.getFileRevision(actor.id, projectId, revisionId)
      });
      return;
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "restore") {
      writeJson(response, 200, {
        revision: await service.restoreFileRevision(actor.id, projectId, revisionId)
      });
      return;
    }
  }

  if (segments[2] === "files" && segments.length === 3 && method === "POST") {
    const body = await readJsonBody<{
      readonly path?: unknown;
      readonly contents?: unknown;
      readonly contentEncoding?: unknown;
    }>(request);
    const contentEncoding = normalizeFileContentEncoding(body.contentEncoding);
    writeJson(response, 201, {
      file: await service.createFile(actor.id, projectId, {
        path: requireString(body.path, "path"),
        contents: requireString(body.contents, "contents"),
        ...(contentEncoding === undefined ? {} : { contentEncoding })
      })
    });
    return;
  }

  if (segments[2] === "files" && segments.length >= 4) {
    const filePath = segments.slice(3).join("/");

    if (method === "GET") {
      writeJson(response, 200, {
        file: await service.readFile(actor.id, projectId, filePath)
      });
      return;
    }

    if (method === "PUT") {
      const body = await readJsonBody<{
        readonly contents?: unknown;
        readonly expectedRevisionId?: unknown;
      }>(request);
      writeJson(response, 200, {
        file: await service.writeFile(actor.id, projectId, filePath, {
          contents: requireString(body.contents, "contents"),
          ...(body.expectedRevisionId === undefined
            ? {}
            : {
                expectedRevisionId: requireString(
                  body.expectedRevisionId,
                  "expectedRevisionId"
                )
              })
        })
      });
      return;
    }

    if (method === "PATCH") {
      const body = await readJsonBody<{
        readonly newName?: unknown;
        readonly newPath?: unknown;
      }>(request);

      if (body.newPath !== undefined) {
        writeJson(response, 200, {
          files: await service.moveEntry(
            actor.id,
            projectId,
            filePath,
            requireString(body.newPath, "newPath")
          )
        });
        return;
      }

      writeJson(response, 200, {
        files: await service.renameEntry(
          actor.id,
          projectId,
          filePath,
          requireString(body.newName, "newName")
        )
      });
      return;
    }

    if (method === "DELETE") {
      writeJson(response, 200, {
        deletedPaths: await service.deleteEntry(actor.id, projectId, filePath)
      });
      return;
    }
  }

  if (segments[2] === "directories" && segments.length >= 4) {
    const directoryPath = segments.slice(3).join("/");

    if (method === "POST") {
      writeJson(response, 201, {
        directory: await service.createDirectory(actor.id, projectId, {
          path: directoryPath
        })
      });
      return;
    }
  }

  if (segments[2] === "entries" && segments.length === 4) {
    const body = await readJsonBody<{
      readonly path?: unknown;
      readonly newName?: unknown;
      readonly newPath?: unknown;
    }>(request);

    if (method === "POST" && segments[3] === "rename") {
      writeJson(response, 200, {
        files: await service.renameEntry(
          actor.id,
          projectId,
          requireString(body.path, "path"),
          requireString(body.newName, "newName")
        )
      });
      return;
    }

    if (method === "POST" && segments[3] === "move") {
      writeJson(response, 200, {
        files: await service.moveEntry(
          actor.id,
          projectId,
          requireString(body.path, "path"),
          requireString(body.newPath, "newPath")
        )
      });
      return;
    }

    if (method === "POST" && segments[3] === "delete") {
      writeJson(response, 200, {
        deletedPaths: await service.deleteEntry(
          actor.id,
          projectId,
          requireString(body.path, "path")
        )
      });
      return;
    }
  }

  if (segments[2] === "build-artifacts") {
    if (method === "GET" && segments.length === 3) {
      writeJson(response, 200, {
        buildArtifacts: await service.listBuildArtifacts(actor.id, projectId)
      });
      return;
    }

    if (method === "GET" && segments[3] !== undefined && segments.length === 4) {
      writeJson(response, 200, {
        buildArtifact: await service.getBuildArtifact(actor.id, projectId, segments[3])
      });
      return;
    }

    if (method === "POST" && segments.length === 3) {
      const body = await readJsonBody<SharedProjectBuildArtifactUpload>(request);
      writeJson(response, 201, {
        buildArtifact: await service.uploadBuildArtifact(actor.id, projectId, body)
      });
      return;
    }
  }

  if (
    segments[2] === "artifacts" &&
    method === "GET" &&
    segments[3] !== undefined &&
    segments.length === 4
  ) {
    writeJson(response, 200, {
      buildArtifact: await service.getBuildArtifact(actor.id, projectId, segments[3])
    });
    return;
  }

  if (segments[2] === "members" && method === "GET" && segments.length === 3) {
    writeJson(response, 200, {
      members: await service.listMembers(actor.id, projectId)
    });
    return;
  }

  if (
    segments[2] === "collaboration" &&
    segments[3] === "files" &&
    segments.length >= 5
  ) {
    const filePath = segments.slice(4).join("/");

    if (method === "GET") {
      if (url.searchParams.get("updates") === "1") {
        writeJson(response, 200, {
          feed: await service.listDocumentUpdates(
            actor.id,
            projectId,
            filePath,
            url.searchParams.get("afterUpdateId") ?? undefined
          )
        });
        return;
      }

      writeJson(response, 200, {
        state: await service.getDocumentState(actor.id, projectId, filePath)
      });
      return;
    }

    if (method === "POST") {
      const body = await readJsonBody<{
        readonly updateBase64?: unknown;
        readonly clientOperationId?: unknown;
        readonly expectedRevisionId?: unknown;
      }>(request);
      writeJson(response, 201, {
        result: await service.applyDocumentUpdate(
          actor.id,
          projectId,
          filePath,
          requireString(body.updateBase64, "updateBase64"),
          body.clientOperationId === undefined
            ? undefined
            : requireString(body.clientOperationId, "clientOperationId"),
          body.expectedRevisionId === undefined
            ? undefined
            : requireString(body.expectedRevisionId, "expectedRevisionId")
        )
      });
      return;
    }
  }

  if (segments[2] === "presence" && segments.length === 3) {
    if (method === "GET") {
      writeJson(response, 200, {
        presence: await service.listPresence(actor.id, projectId)
      });
      return;
    }

    if (method === "PUT") {
      const body = await readJsonBody<SharedProjectPresenceUpdate>(request);
      writeJson(response, 200, {
        presence: await service.updatePresence(actor.id, projectId, body)
      });
      return;
    }
  }

  if (segments[2] === "agent-runs") {
    if (method === "GET" && segments.length === 3) {
      writeJson(response, 200, {
        agentRuns: await service.listAgentRuns(actor.id, projectId)
      });
      return;
    }

    if (method === "POST" && segments.length === 3) {
      const body = await readJsonBody<SharedProjectAgentRunCreate>(request);
      writeJson(response, 201, {
        agentRun: await service.createAgentRun(actor.id, projectId, body)
      });
      return;
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "status") {
      const body = await readJsonBody<SharedProjectAgentRunStatusUpdate>(request);
      writeJson(response, 200, {
        agentRun: await service.updateAgentRunStatus(
          actor.id,
          projectId,
          segments[3] ?? "",
          body
        )
      });
      return;
    }

    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[4] === "build-artifacts"
    ) {
      const body =
        await readJsonBody<SharedProjectAgentRunBuildArtifactAttach>(request);
      writeJson(response, 200, {
        agentRun: await service.attachBuildArtifactToAgentRun(
          actor.id,
          projectId,
          segments[3] ?? "",
          body
        )
      });
      return;
    }
  }

  if (segments[2] === "changesets") {
    if (method === "GET" && segments.length === 3) {
      writeJson(response, 200, {
        changesets: await service.listChangeSets(actor.id, projectId)
      });
      return;
    }

    if (method === "POST" && segments.length === 3) {
      const body = await readJsonBody<SharedProjectChangeSetCreate>(request);
      writeJson(response, 201, {
        changeset: await service.createChangeSet(actor.id, projectId, body)
      });
      return;
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "apply") {
      writeJson(response, 200, {
        changeset: await service.applyChangeSet(actor.id, projectId, segments[3] ?? "")
      });
      return;
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "reject") {
      writeJson(response, 200, {
        changeset: await service.rejectChangeSet(actor.id, projectId, segments[3] ?? "")
      });
      return;
    }
  }

  if (segments[2] === "activity" && method === "GET" && segments.length === 3) {
    writeJson(response, 200, {
      activity: await service.listActivity(actor.id, projectId)
    });
    return;
  }

  if (segments[2] === "comments") {
    if (method === "GET" && segments.length === 3) {
      writeJson(response, 200, {
        comments: await service.listComments(actor.id, projectId)
      });
      return;
    }

    if (method === "POST" && segments.length === 3) {
      const body = await readJsonBody<{
        readonly body?: unknown;
        readonly filePath?: unknown;
        readonly line?: unknown;
      }>(request);
      writeJson(response, 201, {
        comment: await service.createComment(actor.id, projectId, {
          body: requireString(body.body, "body"),
          ...(body.filePath === undefined
            ? {}
            : { filePath: requireString(body.filePath, "filePath") }),
          ...(body.line === undefined ? {} : { line: body.line as number })
        })
      });
      return;
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "resolve") {
      writeJson(response, 200, {
        comment: await service.resolveComment(actor.id, projectId, segments[3] ?? "")
      });
      return;
    }
  }

  if (segments[2] === "audit-events" && method === "GET" && segments.length === 3) {
    writeJson(response, 200, {
      auditEvents: await service.listAuditEvents(actor.id, projectId)
    });
    return;
  }

  if (segments[2] === "audit-events" && method === "POST" && segments.length === 3) {
    const body = await readJsonBody<SharedProjectAuditEventCreate>(request);
    writeJson(response, 201, {
      auditEvent: await service.recordAuditEvent(actor.id, projectId, body)
    });
    return;
  }

  if (method === "POST" && segments.length === 3 && segments[2] === "invitations") {
    const body = await readJsonBody<{
      readonly email?: unknown;
      readonly role?: unknown;
    }>(request);
    const role = body.role === "viewer" ? "viewer" : "editor";

    writeJson(response, 201, {
      invitation: await service.createInvitation(
        actor.id,
        projectId,
        requireString(body.email, "email"),
        role
      )
    });
    return;
  }

  if (segments[2] === "members" && segments.length === 4) {
    const targetUserId = segments[3] ?? "";

    if (method === "PATCH") {
      const body = await readJsonBody<{ readonly role?: unknown }>(request);
      const role = body.role === "viewer" ? "viewer" : "editor";

      writeJson(response, 200, {
        member: await service.updateMemberRole(actor.id, projectId, targetUserId, role)
      });
      return;
    }

    if (method === "DELETE") {
      writeJson(response, 200, {
        member: await service.removeMember(actor.id, projectId, targetUserId)
      });
      return;
    }
  }

  if (
    method === "POST" &&
    segments[2] === "members" &&
    segments.length === 5 &&
    segments[4] === "transfer-ownership"
  ) {
    writeJson(response, 200, {
      members: await service.transferOwnership(actor.id, projectId, segments[3] ?? "")
    });
    return;
  }

  writeJson(response, 404, { error: "not-found", message: "Route was not found." });
}

function putFileInDatabase(
  database: SharedProjectDatabase,
  request: {
    readonly projectId: string;
    readonly actorUserId: string;
    readonly path: string;
    readonly contents: string;
    readonly contentEncoding?: "utf8" | "base64";
    readonly activityEventType?: string;
    readonly activityMessage?: string;
    readonly now: string;
  }
): SharedProjectDatabase {
  const normalizedPath = normalizeProjectPath(request.path);
  const directoryCollision = database.directories.find(
    (directory) =>
      directory.projectId === request.projectId && directory.path === normalizedPath
  );
  const ancestorFile = findAncestorFile(database, request.projectId, normalizedPath);
  const descendantEntry = [
    ...database.files
      .filter((file) => file.projectId === request.projectId)
      .map((file) => file.path),
    ...database.directories
      .filter((directory) => directory.projectId === request.projectId)
      .map((directory) => directory.path)
  ].find((path) => path !== normalizedPath && isPathOrDescendant(path, normalizedPath));

  if (
    directoryCollision !== undefined ||
    ancestorFile !== undefined ||
    descendantEntry !== undefined
  ) {
    throw new SharedProjectServerError(
      "A project entry already exists at this path.",
      409,
      "conflict"
    );
  }
  const revision: SharedProjectFileRevision = {
    id: randomUUID(),
    projectId: request.projectId,
    path: normalizedPath,
    contents: request.contents,
    ...(request.contentEncoding === undefined || request.contentEncoding === "utf8"
      ? {}
      : { contentEncoding: request.contentEncoding }),
    actorUserId: request.actorUserId,
    createdAt: request.now
  };
  const existingFile = database.files.find(
    (file) => file.projectId === request.projectId && file.path === normalizedPath
  );
  const nextFile: SharedProjectFile = {
    projectId: request.projectId,
    path: normalizedPath,
    latestRevisionId: revision.id,
    updatedAt: request.now
  };

  return {
    ...database,
    projects: database.projects.map((project) =>
      project.id === request.projectId
        ? { ...project, updatedAt: request.now }
        : project
    ),
    files:
      existingFile === undefined
        ? [...database.files, nextFile]
        : database.files.map((file) =>
            file.projectId === request.projectId && file.path === normalizedPath
              ? nextFile
              : file
          ),
    revisions: [...database.revisions, revision],
    activity: [
      ...database.activity,
      createActivity(
        request.projectId,
        request.actorUserId,
        request.activityEventType ??
          (existingFile === undefined ? "file.created" : "file.updated"),
        request.activityMessage ??
          `${existingFile === undefined ? "Created" : "Updated"} ${normalizedPath}.`,
        request.now
      )
    ]
  };
}

function toSharedProjectFileRevisionSummary(
  revision: SharedProjectFileRevision
): SharedProjectFileRevisionSummary {
  const byteLength =
    revision.contentEncoding === "base64"
      ? Buffer.from(revision.contents, "base64").byteLength
      : Buffer.byteLength(revision.contents, "utf8");

  return {
    id: revision.id,
    projectId: revision.projectId,
    path: revision.path,
    actorUserId: revision.actorUserId,
    createdAt: revision.createdAt,
    ...(revision.contentEncoding === undefined
      ? {}
      : { contentEncoding: revision.contentEncoding }),
    byteLength
  };
}

function putDirectoryInDatabase(
  database: SharedProjectDatabase,
  request: {
    readonly projectId: string;
    readonly path: string;
    readonly now: string;
  }
): SharedProjectDatabase {
  const normalizedPath = normalizeProjectPath(request.path);
  const ancestorFile = findAncestorFile(database, request.projectId, normalizedPath);
  const fileCollision = database.files.find(
    (file) => file.projectId === request.projectId && file.path === normalizedPath
  );
  const directoryCollision = database.directories.find(
    (directory) =>
      directory.projectId === request.projectId && directory.path === normalizedPath
  );

  if (ancestorFile !== undefined || fileCollision !== undefined) {
    throw new SharedProjectServerError(
      "A project entry already exists at this path.",
      409,
      "conflict"
    );
  }

  if (directoryCollision !== undefined) {
    return database;
  }

  return {
    ...database,
    directories: [
      ...database.directories,
      {
        projectId: request.projectId,
        path: normalizedPath,
        createdAt: request.now,
        updatedAt: request.now
      }
    ]
  };
}

function collectMovedFiles(
  database: SharedProjectDatabase,
  projectId: string,
  path: string,
  newPath: string
): readonly {
  readonly path: string;
  readonly toPath: string;
  readonly source: SharedProjectFile;
}[] {
  return database.files
    .filter(
      (file) => file.projectId === projectId && isPathOrDescendant(file.path, path)
    )
    .map((file) => ({
      path: file.path,
      toPath:
        file.path === path ? newPath : `${newPath}/${file.path.slice(path.length + 1)}`,
      source: file
    }));
}

function collectMovedDirectories(
  database: SharedProjectDatabase,
  projectId: string,
  path: string,
  newPath: string
): readonly {
  readonly path: string;
  readonly toPath: string;
  readonly source: SharedProjectDirectory;
}[] {
  return database.directories
    .filter(
      (directory) =>
        directory.projectId === projectId && isPathOrDescendant(directory.path, path)
    )
    .map((directory) => ({
      path: directory.path,
      toPath:
        directory.path === path
          ? newPath
          : `${newPath}/${directory.path.slice(path.length + 1)}`,
      source: directory
    }));
}

function updateProjectForMovedEntry(
  project: SharedProject,
  projectId: string,
  movedFiles: readonly { readonly path: string; readonly toPath: string }[],
  updatedAt: string
): SharedProject {
  if (project.id !== projectId) {
    return project;
  }

  const movedMainFile =
    project.mainFilePath === undefined
      ? undefined
      : movedFiles.find((file) => file.path === project.mainFilePath);

  return {
    ...project,
    ...(movedMainFile === undefined ? {} : { mainFilePath: movedMainFile.toPath }),
    updatedAt
  };
}

function updateProjectForDeletedEntry(
  project: SharedProject,
  projectId: string,
  deletedPathSet: ReadonlySet<string>,
  updatedAt: string
): SharedProject {
  if (project.id !== projectId) {
    return project;
  }

  if (project.mainFilePath !== undefined && deletedPathSet.has(project.mainFilePath)) {
    const { mainFilePath: _deletedMainFilePath, ...projectWithoutMainFile } = project;
    return { ...projectWithoutMainFile, updatedAt };
  }

  return { ...project, updatedAt };
}

function isPathOrDescendant(candidatePath: string, path: string): boolean {
  return candidatePath === path || candidatePath.startsWith(`${path}/`);
}

function findAncestorFile(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): SharedProjectFile | undefined {
  const parts = path.split("/");
  const ancestorPaths = parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));

  return database.files.find(
    (file) => file.projectId === projectId && ancestorPaths.includes(file.path)
  );
}

function getSiblingProjectPath(path: string, name: string): string {
  const slashIndex = path.lastIndexOf("/");

  return slashIndex === -1 ? name : `${path.slice(0, slashIndex)}/${name}`;
}

function createTree({
  directories,
  files
}: {
  readonly directories: readonly SharedProjectDirectory[];
  readonly files: readonly SharedProjectFile[];
}): readonly SharedProjectTreeNode[] {
  const root = new Map<string, MutableTreeNode>();

  const entries = [
    ...directories.map((directory) => ({
      path: directory.path,
      kind: "directory" as const
    })),
    ...files.map((file) => ({ path: file.path, kind: "file" as const }))
  ].sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let children = root;
    let currentPath = "";

    for (const [index, part] of parts.entries()) {
      currentPath = currentPath.length === 0 ? part : `${currentPath}/${part}`;
      const isFile = entry.kind === "file" && index === parts.length - 1;
      const existing = children.get(part);

      if (existing !== undefined) {
        children = existing.children;
        continue;
      }

      const node: MutableTreeNode = {
        name: part,
        path: currentPath,
        kind: isFile ? "file" : "directory",
        children: new Map()
      };
      children.set(part, node);
      children = node.children;
    }
  }

  return serializeTree(root);
}

function createDocumentState(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): SharedProjectDocumentState {
  const doc = createProjectDocument(database, projectId, path);
  const stateUpdateBase64 = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  const revision = database.files.find(
    (file) => file.projectId === projectId && file.path === path
  );
  const state = {
    projectId,
    path,
    stateUpdateBase64,
    contents: doc.getText("content").toString()
  };

  return revision === undefined
    ? state
    : { ...state, revisionId: revision.latestRevisionId };
}

function ensureDocumentBaseUpdate(
  database: SharedProjectDatabase,
  projectId: string,
  path: string,
  actorUserId: string,
  now: string
): SharedProjectDatabase {
  const hasUpdates = database.documentUpdates.some(
    (update) => update.projectId === projectId && update.path === path
  );

  if (hasUpdates) {
    return database;
  }

  const file = database.files.find(
    (candidate) => candidate.projectId === projectId && candidate.path === path
  );
  const revision =
    file === undefined
      ? undefined
      : database.revisions.find((candidate) => candidate.id === file.latestRevisionId);
  const doc = new Y.Doc();

  if (revision !== undefined && revision.contents.length > 0) {
    doc.getText("content").insert(0, revision.contents);
  }

  const baseUpdate: SharedProjectDocumentUpdate = {
    id: randomUUID(),
    projectId,
    path,
    actorUserId,
    updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    createdAt: now
  };

  return {
    ...database,
    documentUpdates: [...database.documentUpdates, baseUpdate]
  };
}

function projectDocumentUpdate(
  database: SharedProjectDatabase,
  update: SharedProjectDocumentUpdate
): { readonly contents: string } {
  const doc = createProjectDocument(database, update.projectId, update.path);
  Y.applyUpdate(doc, decodeBase64Update(update.updateBase64));
  return {
    contents: doc.getText("content").toString()
  };
}

function createDocumentReplacementUpdate(
  database: SharedProjectDatabase,
  projectId: string,
  path: string,
  contents: string
): string | undefined {
  const doc = createProjectDocument(database, projectId, path);
  const text = doc.getText("content");

  if (text.toString() === contents) {
    return undefined;
  }

  const stateVector = Y.encodeStateVector(doc);
  if (text.length > 0) {
    text.delete(0, text.length);
  }
  if (contents.length > 0) {
    text.insert(0, contents);
  }

  return Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)).toString("base64");
}

function createProjectDocument(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): Y.Doc {
  const doc = new Y.Doc();
  const updates = database.documentUpdates.filter(
    (update) => update.projectId === projectId && update.path === path
  );

  if (updates.length === 0) {
    const file = database.files.find(
      (candidate) => candidate.projectId === projectId && candidate.path === path
    );
    const revision =
      file === undefined
        ? undefined
        : database.revisions.find(
            (candidate) => candidate.id === file.latestRevisionId
          );

    if (revision !== undefined && revision.contents.length > 0) {
      doc.getText("content").insert(0, revision.contents);
    }
  }

  for (const update of updates) {
    Y.applyUpdate(doc, decodeBase64Update(update.updateBase64));
  }

  return doc;
}

function validateBase64Update(updateBase64: string): string {
  decodeBase64Update(updateBase64);
  return updateBase64;
}

function normalizeOptionalClientOperationId(
  clientOperationId: string | undefined
): string | undefined {
  if (clientOperationId === undefined) {
    return undefined;
  }

  const normalizedClientOperationId = clientOperationId.trim();
  if (normalizedClientOperationId.length === 0) {
    throw new SharedProjectServerError(
      "Client operation id is required when provided.",
      400,
      "invalid-client-operation-id"
    );
  }

  return normalizedClientOperationId;
}

function requireLatestFileRevision(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): SharedProjectFileRevision {
  const file = database.files.find(
    (candidate) => candidate.projectId === projectId && candidate.path === path
  );
  const revision =
    file === undefined
      ? undefined
      : database.revisions.find((candidate) => candidate.id === file.latestRevisionId);

  if (revision === undefined) {
    throw new SharedProjectServerError("File revision was not found.", 500, "corrupt");
  }

  return revision;
}

function decodeBase64Update(updateBase64: string): Uint8Array {
  if (updateBase64.trim().length === 0) {
    throw new SharedProjectServerError(
      "Yjs update payload is required.",
      400,
      "invalid-update"
    );
  }

  return Uint8Array.from(Buffer.from(updateBase64, "base64"));
}

function serializeTree(
  nodes: ReadonlyMap<string, MutableTreeNode>
): readonly SharedProjectTreeNode[] {
  return [...nodes.values()].map((node) =>
    node.kind === "directory"
      ? {
          name: node.name,
          path: node.path,
          kind: node.kind,
          children: serializeTree(node.children)
        }
      : {
          name: node.name,
          path: node.path,
          kind: node.kind
        }
  );
}

function normalizeProjectPath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new SharedProjectServerError(
      "Project path is required.",
      400,
      "invalid-path"
    );
  }

  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\/+/u, "");

  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new SharedProjectServerError(
      "Project path must stay inside the project.",
      400,
      "invalid-path"
    );
  }

  return normalized;
}

function normalizeEmail(email: string): string {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new SharedProjectServerError(
      "A valid email is required.",
      400,
      "invalid-email"
    );
  }

  return email.trim().toLowerCase();
}

function normalizeDisplayName(name: string | undefined, email: string): string {
  const normalizedName = name?.trim();
  return normalizedName === undefined || normalizedName.length === 0
    ? (email.split("@")[0] ?? email)
    : normalizedName;
}

function normalizeProjectName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new SharedProjectServerError(
      "Project name is required.",
      400,
      "invalid-name"
    );
  }

  return name.trim();
}

function normalizeProjectMainFilePath(path: string): string {
  const normalizedPath = normalizeProjectPath(path);

  if (!normalizedPath.toLowerCase().endsWith(".tex")) {
    throw new SharedProjectServerError(
      "Main file must be a .tex file.",
      400,
      "invalid-main-file"
    );
  }

  return normalizedPath;
}

function normalizeSharedProjectCompiler(value: unknown): SharedProjectCompiler {
  if (value === "pdflatex" || value === "xelatex" || value === "lualatex") {
    return value;
  }

  throw new SharedProjectServerError(
    "Compiler must be pdflatex, xelatex, or lualatex.",
    400,
    "invalid-compiler"
  );
}

function normalizeEntryName(name: string): string {
  const normalizedName = requireNonEmptyString(name, "newName");

  if (
    normalizedName.includes("/") ||
    normalizedName.includes("\\") ||
    normalizedName === "." ||
    normalizedName === ".."
  ) {
    throw new SharedProjectServerError(
      "Entry name must not contain path separators.",
      400,
      "invalid-name"
    );
  }

  return normalizedName;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new SharedProjectServerError(
      `${name} must be a string.`,
      400,
      "invalid-request"
    );
  }

  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const stringValue = requireString(value, name).trim();

  if (stringValue.length === 0) {
    throw new SharedProjectServerError(`${name} is required.`, 400, "invalid-request");
  }

  return stringValue;
}

function normalizeOptionalNonEmptyString(value: unknown, name: string): string {
  return requireNonEmptyString(value, name);
}

function normalizeCommentBody(value: unknown): string {
  const body = requireNonEmptyString(value, "body");

  if (body.length > 4_000) {
    throw new SharedProjectServerError(
      "body must be 4000 characters or fewer.",
      400,
      "invalid-request"
    );
  }

  return body;
}

function normalizeOptionalCommentLine(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SharedProjectServerError(
      "line must be a positive integer.",
      400,
      "invalid-request"
    );
  }

  return value;
}

function normalizeAgentRunStatus(value: unknown): SharedProjectAgentRunStatus {
  if (
    value === "running" ||
    value === "waiting-for-review" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }

  throw new SharedProjectServerError(
    "Agent run status is invalid.",
    400,
    "invalid-request"
  );
}

function normalizeBuildArtifactStatus(
  value: unknown
): SharedProjectBuildArtifactStatus {
  if (value === "succeeded" || value === "failed" || value === "cancelled") {
    return value;
  }

  throw new SharedProjectServerError(
    "Build artifact status is invalid.",
    400,
    "invalid-request"
  );
}

function toSharedProjectSessionSummary(
  session: SharedProjectSession,
  current: boolean
): SharedProjectSessionSummary {
  return {
    id: session.id,
    userId: session.userId,
    current,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    createdAt: session.createdAt
  };
}

const nodePlatforms = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
  "cygwin"
]);

function normalizeBuildArtifactPlatform(value: unknown): NodeJS.Platform {
  if (typeof value === "string" && nodePlatforms.has(value)) {
    return value as NodeJS.Platform;
  }

  throw new SharedProjectServerError(
    "Build artifact platform is invalid.",
    400,
    "invalid-request"
  );
}

function normalizeBuildDiagnostics(
  diagnostics: unknown
): readonly SharedProjectBuildDiagnostic[] {
  if (diagnostics === undefined) {
    return [];
  }

  if (!Array.isArray(diagnostics)) {
    throw new SharedProjectServerError(
      "Build diagnostics must be an array.",
      400,
      "invalid-request"
    );
  }

  return diagnostics.map((diagnostic, index) => {
    if (typeof diagnostic !== "object" || diagnostic === null) {
      throw new SharedProjectServerError(
        `Build diagnostic ${index + 1} is invalid.`,
        400,
        "invalid-request"
      );
    }

    const candidate = diagnostic as {
      readonly severity?: unknown;
      readonly message?: unknown;
      readonly filePath?: unknown;
      readonly line?: unknown;
    };

    if (candidate.severity !== "error" && candidate.severity !== "warning") {
      throw new SharedProjectServerError(
        `Build diagnostic ${index + 1} has an invalid severity.`,
        400,
        "invalid-request"
      );
    }

    const normalizedDiagnostic: SharedProjectBuildDiagnostic = {
      severity: candidate.severity,
      message: requireNonEmptyString(
        candidate.message,
        `diagnostics[${index}].message`
      ),
      ...(candidate.filePath === undefined
        ? {}
        : {
            filePath: normalizeProjectPath(
              requireNonEmptyString(
                candidate.filePath,
                `diagnostics[${index}].filePath`
              )
            )
          }),
      ...(candidate.line === undefined
        ? {}
        : {
            line: normalizePositiveInteger(candidate.line, `diagnostics[${index}].line`)
          })
    };

    return normalizedDiagnostic;
  });
}

function normalizePositiveInteger(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  throw new SharedProjectServerError(
    `${name} must be a positive integer.`,
    400,
    "invalid-request"
  );
}

function normalizeFileContentEncoding(value: unknown): "utf8" | "base64" | undefined {
  if (value === undefined || value === "utf8") {
    return undefined;
  }

  if (value === "base64") {
    return "base64";
  }

  throw new SharedProjectServerError(
    "contentEncoding must be utf8 or base64.",
    400,
    "invalid-request"
  );
}

const collaborativeDocumentExtensions = new Set([
  ".bib",
  ".cls",
  ".ltx",
  ".markdown",
  ".md",
  ".sty",
  ".tex",
  ".txt"
]);

function assertCollaborativeDocumentPath(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): void {
  if (!collaborativeDocumentExtensions.has(posix.extname(path).toLowerCase())) {
    throw new SharedProjectServerError(
      "Realtime collaboration is supported only for LaTeX and plain-text project files.",
      415,
      "unsupported-collaboration-path"
    );
  }

  const file = database.files.find(
    (candidate) => candidate.projectId === projectId && candidate.path === path
  );
  const revision =
    file === undefined
      ? undefined
      : database.revisions.find((candidate) => candidate.id === file.latestRevisionId);

  if (revision?.contentEncoding === "base64") {
    throw new SharedProjectServerError(
      "Binary project files use whole-file replacement, not realtime collaboration.",
      415,
      "unsupported-collaboration-path"
    );
  }
}

function roleSortOrder(role: SharedProjectRole): number {
  switch (role) {
    case "owner":
      return 0;
    case "editor":
      return 1;
    case "viewer":
      return 2;
  }
}

function getProjectMemberDetails(
  database: SharedProjectDatabase,
  projectId: string
): readonly SharedProjectMemberDetails[] {
  return database.members
    .filter((member) => member.projectId === projectId)
    .map((member) => {
      const user = requireUser(database, member.userId);
      return {
        ...member,
        email: user.email,
        name: user.name
      };
    })
    .sort((left, right) => {
      const roleOrder = roleSortOrder(left.role) - roleSortOrder(right.role);
      return roleOrder === 0 ? left.email.localeCompare(right.email) : roleOrder;
    });
}

function requireUser(
  database: SharedProjectDatabase,
  userId: string
): SharedProjectUser {
  const user = database.users.find((candidate) => candidate.id === userId);

  if (user === undefined) {
    throw new SharedProjectServerError("User was not found.", 401, "unauthorized");
  }

  return user;
}

function requireProject(
  database: SharedProjectDatabase,
  projectId: string
): SharedProject {
  const project = database.projects.find((candidate) => candidate.id === projectId);

  if (project === undefined) {
    throw new SharedProjectServerError("Project was not found.", 404, "not-found");
  }

  return project;
}

function requireProjectMember(
  database: SharedProjectDatabase,
  projectId: string,
  userId: string
): SharedProjectMember {
  requireProject(database, projectId);

  const member = database.members.find(
    (candidate) => candidate.projectId === projectId && candidate.userId === userId
  );

  if (member === undefined) {
    throw new SharedProjectServerError("Project access denied.", 403, "forbidden");
  }

  return member;
}

function requireProjectEditor(
  database: SharedProjectDatabase,
  projectId: string,
  userId: string
): SharedProjectMember {
  const member = requireProjectMember(database, projectId, userId);

  if (member.role === "viewer") {
    throw new SharedProjectServerError(
      "Project is read-only for this user.",
      403,
      "forbidden"
    );
  }

  return member;
}

function requireProjectOwner(
  database: SharedProjectDatabase,
  projectId: string,
  userId: string
): SharedProjectMember {
  const member = requireProjectMember(database, projectId, userId);

  if (member.role !== "owner") {
    throw new SharedProjectServerError(
      "Only owners can perform this action.",
      403,
      "forbidden"
    );
  }

  return member;
}

function requireAgentRun(
  database: SharedProjectDatabase,
  projectId: string,
  agentRunId: string
): SharedProjectAgentRun {
  const agentRun = database.agentRuns.find(
    (candidate) => candidate.projectId === projectId && candidate.id === agentRunId
  );

  if (agentRun === undefined) {
    throw new SharedProjectServerError("Agent run was not found.", 404, "not-found");
  }

  return agentRun;
}

function requireChangeSet(
  database: SharedProjectDatabase,
  projectId: string,
  changesetId: string
): SharedProjectChangeSet {
  const changeset = database.changesets.find(
    (candidate) => candidate.projectId === projectId && candidate.id === changesetId
  );

  if (changeset === undefined) {
    throw new SharedProjectServerError("Changeset was not found.", 404, "not-found");
  }

  return changeset;
}

function requireBuildArtifact(
  database: SharedProjectDatabase,
  projectId: string,
  buildArtifactId: string
): SharedProjectBuildArtifact {
  const artifact = database.buildArtifacts.find(
    (candidate) => candidate.projectId === projectId && candidate.id === buildArtifactId
  );

  if (artifact === undefined) {
    throw new SharedProjectServerError(
      "Build artifact was not found.",
      404,
      "not-found"
    );
  }

  return artifact;
}

function readLatestRevision(
  database: SharedProjectDatabase,
  projectId: string,
  path: string
): SharedProjectFileRevision | undefined {
  const file = database.files.find(
    (candidate) => candidate.projectId === projectId && candidate.path === path
  );

  return file === undefined
    ? undefined
    : database.revisions.find((revision) => revision.id === file.latestRevisionId);
}

function createPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function createActivity(
  projectId: string,
  actorUserId: string,
  eventType: string,
  message: string,
  createdAt: string
): SharedProjectActivityEvent {
  return {
    id: randomUUID(),
    projectId,
    actorUserId,
    eventType,
    message,
    createdAt
  };
}

function createAuditEvent(
  projectId: string,
  actorUserId: string,
  eventType: string,
  message: string,
  createdAt: string,
  options: {
    readonly agentRunId?: string;
    readonly changesetId?: string;
    readonly buildArtifactIds?: readonly string[];
  } = {}
): SharedProjectAuditEvent {
  return {
    id: randomUUID(),
    projectId,
    actorUserId,
    eventType,
    message,
    ...(options.agentRunId === undefined ? {} : { agentRunId: options.agentRunId }),
    ...(options.changesetId === undefined ? {} : { changesetId: options.changesetId }),
    ...(options.buildArtifactIds === undefined
      ? {}
      : { buildArtifactIds: options.buildArtifactIds }),
    createdAt
  };
}

function createAgentRunStatusActivities(
  projectId: string,
  actorUserId: string,
  agentRun: SharedProjectAgentRun,
  createdAt: string
): readonly SharedProjectActivityEvent[] {
  if (agentRun.status === "running") {
    return [];
  }

  return [
    createActivity(
      projectId,
      actorUserId,
      `agent.run.${agentRun.status}`,
      formatAgentRunStatusMessage(agentRun),
      createdAt
    )
  ];
}

function createAgentRunStatusAuditEvents(
  projectId: string,
  actorUserId: string,
  agentRun: SharedProjectAgentRun,
  createdAt: string
): readonly SharedProjectAuditEvent[] {
  if (agentRun.status === "running") {
    return [];
  }

  return [
    createAuditEvent(
      projectId,
      actorUserId,
      `agent.run.${agentRun.status}`,
      formatAgentRunStatusMessage(agentRun),
      createdAt,
      {
        agentRunId: agentRun.id,
        buildArtifactIds: agentRun.buildArtifactIds
      }
    )
  ];
}

function formatAgentRunStatusMessage(agentRun: SharedProjectAgentRun): string {
  const artifactLabel =
    agentRun.buildArtifactIds.length === 0
      ? "without compile artifacts"
      : `with ${agentRun.buildArtifactIds.length} compile ${agentRun.buildArtifactIds.length === 1 ? "artifact" : "artifacts"}`;

  switch (agentRun.status) {
    case "completed":
      return `Completed ${agentRun.providerId} agent run ${artifactLabel}.`;
    case "failed":
      return `Failed ${agentRun.providerId} agent run ${artifactLabel}.`;
    case "cancelled":
      return `Cancelled ${agentRun.providerId} agent run ${artifactLabel}.`;
    case "waiting-for-review":
      return `Waiting for review from ${agentRun.providerId} agent run ${artifactLabel}.`;
    case "running":
      return `Started ${agentRun.providerId} agent run.`;
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function readBearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;

  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new SharedProjectServerError(
      "Bearer token is required.",
      401,
      "unauthorized"
    );
  }

  return authorization.slice("Bearer ".length);
}

function readRealtimeAccessToken(request: IncomingMessage, url: URL): string {
  const queryToken = url.searchParams.get("accessToken");

  if (queryToken !== null && queryToken.length > 0) {
    return queryToken;
  }

  return readBearerToken(request);
}

function rejectWebSocketUpgrade(socket: Duplex, error: unknown): void {
  const status = error instanceof SharedProjectServerError ? error.status : 500;
  const body = JSON.stringify({
    error: error instanceof SharedProjectServerError ? error.code : "internal-error",
    message: error instanceof Error ? error.message : "Unknown error."
  });

  socket.write(
    [
      `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Unauthorized"}`,
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body
    ].join("\r\n")
  );
  socket.destroy();
}

function closeRealtimeSocket(socket: WebSocket, reason: string): void {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return;
  }

  if (socket.readyState === WebSocket.OPEN) {
    socket.close(4003, reason);
    return;
  }

  socket.terminate();
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof SharedProjectServerError) {
    writeJson(response, error.status, {
      error: error.code,
      message: error.message
    });
    return;
  }

  writeJson(response, 500, {
    error: "internal-error",
    message: error instanceof Error ? error.message : "Unknown error."
  });
}

function normalizeDatabase(value: unknown): SharedProjectDatabase {
  if (typeof value !== "object" || value === null) {
    return emptyDatabase;
  }

  const candidate = value as Partial<SharedProjectDatabase>;

  return {
    users: Array.isArray(candidate.users) ? candidate.users : [],
    sessions: Array.isArray(candidate.sessions)
      ? candidate.sessions.flatMap((session) => normalizeSession(session))
      : [],
    projects: Array.isArray(candidate.projects)
      ? candidate.projects.flatMap((project) => normalizeProject(project))
      : [],
    members: Array.isArray(candidate.members) ? candidate.members : [],
    invitations: Array.isArray(candidate.invitations) ? candidate.invitations : [],
    directories: Array.isArray(candidate.directories) ? candidate.directories : [],
    files: Array.isArray(candidate.files) ? candidate.files : [],
    revisions: Array.isArray(candidate.revisions) ? candidate.revisions : [],
    documentUpdates: Array.isArray(candidate.documentUpdates)
      ? candidate.documentUpdates
      : [],
    presence: Array.isArray(candidate.presence) ? candidate.presence : [],
    buildArtifacts: Array.isArray(candidate.buildArtifacts)
      ? candidate.buildArtifacts
      : [],
    agentRuns: Array.isArray(candidate.agentRuns) ? candidate.agentRuns : [],
    changesets: Array.isArray(candidate.changesets) ? candidate.changesets : [],
    comments: Array.isArray(candidate.comments) ? candidate.comments : [],
    activity: Array.isArray(candidate.activity) ? candidate.activity : [],
    auditEvents: Array.isArray(candidate.auditEvents) ? candidate.auditEvents : []
  };
}

function normalizeProject(value: unknown): readonly SharedProject[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const candidate = value as Partial<SharedProject>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.ownerUserId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return [];
  }

  return [
    {
      id: candidate.id,
      name: candidate.name,
      ownerUserId: candidate.ownerUserId,
      ...(typeof candidate.mainFilePath === "string"
        ? { mainFilePath: candidate.mainFilePath }
        : {}),
      ...(candidate.compiler === "pdflatex" ||
      candidate.compiler === "xelatex" ||
      candidate.compiler === "lualatex"
        ? { compiler: candidate.compiler }
        : {}),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt
    }
  ];
}

function normalizeSession(value: unknown): readonly SharedProjectSession[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const candidate = value as Partial<SharedProjectSession>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.accessToken !== "string"
  ) {
    return [];
  }

  const createdAt =
    typeof candidate.createdAt === "string"
      ? candidate.createdAt
      : new Date().toISOString();

  return [
    {
      id: candidate.id,
      userId: candidate.userId,
      accessToken: candidate.accessToken,
      refreshToken:
        typeof candidate.refreshToken === "string"
          ? candidate.refreshToken
          : randomUUID(),
      accessTokenExpiresAt:
        typeof candidate.accessTokenExpiresAt === "string"
          ? candidate.accessTokenExpiresAt
          : expiresAt(new Date().toISOString(), sharedAccessTokenTtlMs),
      refreshTokenExpiresAt:
        typeof candidate.refreshTokenExpiresAt === "string"
          ? candidate.refreshTokenExpiresAt
          : expiresAt(createdAt, sharedRefreshTokenTtlMs),
      createdAt
    }
  ];
}

function withOptionalPresenceFields<T extends object>(
  presence: T,
  update: SharedProjectPresenceUpdate
): T & {
  readonly filePath?: string;
  readonly cursorLine?: number;
  readonly cursorColumn?: number;
} {
  return {
    ...presence,
    ...(update.filePath === undefined
      ? {}
      : { filePath: normalizeProjectPath(update.filePath) }),
    ...(update.cursorLine === undefined ? {} : { cursorLine: update.cursorLine }),
    ...(update.cursorColumn === undefined ? {} : { cursorColumn: update.cursorColumn })
  };
}

function withOptionalPdfFields<T extends object>(
  artifact: T,
  upload: Pick<SharedProjectBuildArtifactUpload, "pdfBase64" | "pdfByteLength">
): T & {
  readonly pdfBase64?: string;
  readonly pdfByteLength?: number;
} {
  return {
    ...artifact,
    ...(upload.pdfBase64 === undefined
      ? {}
      : { pdfBase64: requireString(upload.pdfBase64, "pdfBase64") }),
    ...(upload.pdfByteLength === undefined
      ? {}
      : {
          pdfByteLength: normalizePositiveInteger(upload.pdfByteLength, "pdfByteLength")
        })
  };
}

function databaseUpdate<T>(
  database: SharedProjectDatabase,
  value: T
): DatabaseUpdate<T> {
  return {
    database,
    value,
    __databaseUpdate: true
  };
}

type DatabaseUpdate<T> = {
  readonly database: SharedProjectDatabase;
  readonly value: T;
  readonly __databaseUpdate: true;
};

type MutableTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: Map<string, MutableTreeNode>;
};
