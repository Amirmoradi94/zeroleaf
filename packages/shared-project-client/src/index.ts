import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { posix } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";

import {
  type ProjectDeleteBackup,
  type ProjectEntryKind,
  type ProjectFileSnapshot,
  type ProjectFileTreeNode,
  type ProjectOpenResult,
  ProjectMetadataStore,
  listProjectTree,
  openProject,
  readProjectFile,
  setProjectMainFile
} from "@latex-agent/project-service";
import {
  type ProjectBackendAdapter,
  type ProjectWriteResult,
  type SharedProjectHandle
} from "@latex-agent/project-service/project-gateway";
import type {
  CreateProjectRequest,
  SharedProject,
  SharedProjectActivityEvent,
  SharedProjectAuditEvent,
  SharedProjectAuditEventCreate,
  SharedProjectAgentRun,
  SharedProjectAgentRunBuildArtifactAttach,
  SharedProjectAgentRunCreate,
  SharedProjectAgentRunStatusUpdate,
  SharedProjectBuildArtifact,
  SharedProjectBuildArtifactUpload,
  SharedProjectChangeSet,
  SharedProjectChangeSetCreate,
  SharedProjectComment,
  SharedProjectCommentCreate,
  SharedProjectDirectory,
  SharedProjectDocumentState,
  SharedProjectDocumentUpdateRequest,
  SharedProjectDocumentUpdateFeed,
  SharedProjectDocumentUpdateResult,
  SharedProjectFile,
  SharedProjectFileCreateRequest,
  SharedProjectFileRevisionSummary,
  SharedProjectFileRevision,
  SharedProjectFileWriteRequest,
  SharedProjectInvitation,
  SharedProjectListItem,
  SharedProjectMember,
  SharedProjectMemberDetails,
  SharedProjectPresence,
  SharedProjectPresenceUpdate,
  SharedProjectRealtimeEvent,
  SharedProjectRole,
  SharedProjectSessionRevokeResult,
  SharedProjectSessionSummary,
  SharedProjectSettingsUpdate,
  SharedProjectSourceExport,
  SharedProjectTreeNode,
  SignInResult
} from "@latex-agent/shared-project-server";

export type SharedProjectClientOptions = {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly onSessionRefreshed?: (session: SignInResult) => void | Promise<void>;
};

const sharedProjectCollaborativeDocumentExtensions = new Set([
  ".bib",
  ".cls",
  ".ltx",
  ".markdown",
  ".md",
  ".sty",
  ".tex",
  ".txt"
]);

export function isSharedProjectCollaborativeDocumentPath(path: string): boolean {
  return sharedProjectCollaborativeDocumentExtensions.has(
    posix.extname(path).toLowerCase()
  );
}

export type SharedProjectCacheMaterializeResult = {
  readonly projectId: string;
  readonly cachePath: string;
  readonly workingPath: string;
  readonly directories: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly revisionId: string;
  }[];
};

export type SharedProjectDocumentTextOperation = {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
};

export type SharedProjectRealtimeSessionOptions = {
  readonly onEvent?: (event: SharedProjectRealtimeEvent) => void;
  readonly onError?: (error: Error) => void;
  readonly onClose?: (event: SharedProjectRealtimeCloseEvent) => void;
};

export type SharedProjectRealtimeCloseEvent = {
  readonly code: number;
  readonly reason: string;
};

export class SharedProjectHttpClient {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;

  constructor(private readonly options: SharedProjectClientOptions) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
  }

  setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
  }

  setRefreshToken(refreshToken: string): void {
    this.refreshToken = refreshToken;
  }

  async signIn(email: string, name?: string): Promise<SignInResult> {
    const result = await this.request<SignInResult>("/auth/sign-in", {
      method: "POST",
      body: withOptionalName({ email }, name)
    });
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
    return result;
  }

  async refreshSession(
    refreshToken = this.requireRefreshToken()
  ): Promise<SignInResult> {
    const result = await this.request<SignInResult>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
      refreshOnUnauthorized: false
    });
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
    await this.options.onSessionRefreshed?.(result);
    return result;
  }

  async signOut(refreshToken = this.requireRefreshToken()): Promise<{
    readonly signedOut: boolean;
  }> {
    const result = await this.request<{ readonly signedOut: boolean }>(
      "/auth/sign-out",
      {
        method: "POST",
        body: { refreshToken }
      }
    );
    this.accessToken = undefined;
    this.refreshToken = undefined;
    return result;
  }

  async getSession(): Promise<SignInResult["user"]> {
    return (
      await this.request<{ readonly user: SignInResult["user"] }>("/auth/session")
    ).user;
  }

  async listSessions(): Promise<readonly SharedProjectSessionSummary[]> {
    return (
      await this.request<{ readonly sessions: readonly SharedProjectSessionSummary[] }>(
        "/auth/sessions"
      )
    ).sessions;
  }

  async revokeSession(sessionId: string): Promise<SharedProjectSessionRevokeResult> {
    return (
      await this.request<{ readonly result: SharedProjectSessionRevokeResult }>(
        `/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
        { method: "POST" }
      )
    ).result;
  }

  async listProjects(): Promise<readonly SharedProjectListItem[]> {
    return (
      await this.request<{ readonly projects: readonly SharedProjectListItem[] }>(
        "/projects"
      )
    ).projects;
  }

  async createProject(request: CreateProjectRequest): Promise<SharedProject> {
    return (
      await this.request<{ readonly project: SharedProject }>("/projects", {
        method: "POST",
        body: request
      })
    ).project;
  }

  async getProject(projectId: string): Promise<SharedProject> {
    return (
      await this.request<{ readonly project: SharedProject }>(
        `/projects/${encodeURIComponent(projectId)}`
      )
    ).project;
  }

  async updateProjectSettings(
    projectId: string,
    update: SharedProjectSettingsUpdate
  ): Promise<SharedProject> {
    return (
      await this.request<{ readonly project: SharedProject }>(
        `/projects/${encodeURIComponent(projectId)}/settings`,
        {
          method: "PATCH",
          body: update
        }
      )
    ).project;
  }

  async deleteProject(projectId: string): Promise<SharedProject> {
    return (
      await this.request<{ readonly project: SharedProject }>(
        `/projects/${encodeURIComponent(projectId)}`,
        { method: "DELETE" }
      )
    ).project;
  }

  async exportProjectSource(projectId: string): Promise<SharedProjectSourceExport> {
    return (
      await this.request<{ readonly export: SharedProjectSourceExport }>(
        `/projects/${encodeURIComponent(projectId)}/export/source`
      )
    ).export;
  }

  async getTree(projectId: string): Promise<readonly SharedProjectTreeNode[]> {
    return (
      await this.request<{ readonly tree: readonly SharedProjectTreeNode[] }>(
        `/projects/${encodeURIComponent(projectId)}/tree`
      )
    ).tree;
  }

  async readFile(projectId: string, path: string): Promise<SharedProjectFileRevision> {
    return (
      await this.request<{ readonly file: SharedProjectFileRevision }>(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeProjectPath(path)}`
      )
    ).file;
  }

  async listFileRevisions(
    projectId: string,
    path: string
  ): Promise<readonly SharedProjectFileRevisionSummary[]> {
    return (
      await this.request<{
        readonly revisions: readonly SharedProjectFileRevisionSummary[];
      }>(
        `/projects/${encodeURIComponent(projectId)}/file-revisions/${encodeProjectPath(
          path
        )}`
      )
    ).revisions;
  }

  async getFileRevision(
    projectId: string,
    revisionId: string
  ): Promise<SharedProjectFileRevision> {
    return (
      await this.request<{ readonly revision: SharedProjectFileRevision }>(
        `/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(
          revisionId
        )}`
      )
    ).revision;
  }

  async restoreFileRevision(
    projectId: string,
    revisionId: string
  ): Promise<SharedProjectFileRevision> {
    return (
      await this.request<{ readonly revision: SharedProjectFileRevision }>(
        `/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(
          revisionId
        )}/restore`,
        { method: "POST" }
      )
    ).revision;
  }

  async writeFile(
    projectId: string,
    path: string,
    contents: string,
    expectedRevisionId?: string
  ): Promise<SharedProjectFileRevision> {
    const body: SharedProjectFileWriteRequest = {
      contents,
      ...(expectedRevisionId === undefined ? {} : { expectedRevisionId })
    };

    return (
      await this.request<{ readonly file: SharedProjectFileRevision }>(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeProjectPath(path)}`,
        {
          method: "PUT",
          body
        }
      )
    ).file;
  }

  async createFile(
    projectId: string,
    path: string,
    contents: string,
    contentEncoding?: "utf8" | "base64"
  ): Promise<SharedProjectFileRevision> {
    const body: SharedProjectFileCreateRequest = {
      path,
      contents,
      ...(contentEncoding === undefined || contentEncoding === "utf8"
        ? {}
        : { contentEncoding })
    };

    return (
      await this.request<{ readonly file: SharedProjectFileRevision }>(
        `/projects/${encodeURIComponent(projectId)}/files`,
        {
          method: "POST",
          body
        }
      )
    ).file;
  }

  async createDirectory(
    projectId: string,
    path: string
  ): Promise<SharedProjectDirectory> {
    return (
      await this.request<{ readonly directory: SharedProjectDirectory }>(
        `/projects/${encodeURIComponent(projectId)}/directories/${encodeProjectPath(
          path
        )}`,
        { method: "POST" }
      )
    ).directory;
  }

  async renameFile(
    projectId: string,
    path: string,
    newName: string
  ): Promise<readonly SharedProjectFile[]> {
    return (
      await this.request<{ readonly files: readonly SharedProjectFile[] }>(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeProjectPath(path)}`,
        {
          method: "PATCH",
          body: { newName }
        }
      )
    ).files;
  }

  async moveFile(
    projectId: string,
    path: string,
    newPath: string
  ): Promise<readonly SharedProjectFile[]> {
    return (
      await this.request<{ readonly files: readonly SharedProjectFile[] }>(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeProjectPath(path)}`,
        {
          method: "PATCH",
          body: { newPath }
        }
      )
    ).files;
  }

  async deleteFile(projectId: string, path: string): Promise<readonly string[]> {
    return (
      await this.request<{ readonly deletedPaths: readonly string[] }>(
        `/projects/${encodeURIComponent(projectId)}/files/${encodeProjectPath(path)}`,
        { method: "DELETE" }
      )
    ).deletedPaths;
  }

  async renameEntry(
    projectId: string,
    path: string,
    newName: string
  ): Promise<readonly SharedProjectFile[]> {
    return (
      await this.request<{ readonly files: readonly SharedProjectFile[] }>(
        `/projects/${encodeURIComponent(projectId)}/entries/rename`,
        {
          method: "POST",
          body: { path, newName }
        }
      )
    ).files;
  }

  async moveEntry(
    projectId: string,
    path: string,
    newPath: string
  ): Promise<readonly SharedProjectFile[]> {
    return (
      await this.request<{ readonly files: readonly SharedProjectFile[] }>(
        `/projects/${encodeURIComponent(projectId)}/entries/move`,
        {
          method: "POST",
          body: { path, newPath }
        }
      )
    ).files;
  }

  async deleteEntry(projectId: string, path: string): Promise<readonly string[]> {
    return (
      await this.request<{ readonly deletedPaths: readonly string[] }>(
        `/projects/${encodeURIComponent(projectId)}/entries/delete`,
        {
          method: "POST",
          body: { path }
        }
      )
    ).deletedPaths;
  }

  async invite(
    projectId: string,
    email: string,
    role: Exclude<SharedProjectRole, "owner">
  ): Promise<SharedProjectInvitation> {
    return (
      await this.request<{ readonly invitation: SharedProjectInvitation }>(
        `/projects/${encodeURIComponent(projectId)}/invitations`,
        {
          method: "POST",
          body: { email, role }
        }
      )
    ).invitation;
  }

  async acceptInvitation(invitationId: string): Promise<SharedProjectMember> {
    return (
      await this.request<{ readonly member: SharedProjectMember }>(
        `/invitations/${encodeURIComponent(invitationId)}/accept`,
        { method: "POST" }
      )
    ).member;
  }

  async listMembers(projectId: string): Promise<readonly SharedProjectMemberDetails[]> {
    return (
      await this.request<{ readonly members: readonly SharedProjectMemberDetails[] }>(
        `/projects/${encodeURIComponent(projectId)}/members`
      )
    ).members;
  }

  async updateMemberRole(
    projectId: string,
    userId: string,
    role: Exclude<SharedProjectRole, "owner">
  ): Promise<SharedProjectMember> {
    return (
      await this.request<{ readonly member: SharedProjectMember }>(
        `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(
          userId
        )}`,
        {
          method: "PATCH",
          body: { role }
        }
      )
    ).member;
  }

  async transferOwnership(
    projectId: string,
    userId: string
  ): Promise<readonly SharedProjectMemberDetails[]> {
    return (
      await this.request<{ readonly members: readonly SharedProjectMemberDetails[] }>(
        `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(
          userId
        )}/transfer-ownership`,
        { method: "POST" }
      )
    ).members;
  }

  async removeMember(projectId: string, userId: string): Promise<SharedProjectMember> {
    return (
      await this.request<{ readonly member: SharedProjectMember }>(
        `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(
          userId
        )}`,
        { method: "DELETE" }
      )
    ).member;
  }

  async uploadBuildArtifact(
    projectId: string,
    upload: SharedProjectBuildArtifactUpload
  ): Promise<SharedProjectBuildArtifact> {
    return (
      await this.request<{ readonly buildArtifact: SharedProjectBuildArtifact }>(
        `/projects/${encodeURIComponent(projectId)}/build-artifacts`,
        {
          method: "POST",
          body: upload
        }
      )
    ).buildArtifact;
  }

  async listBuildArtifacts(
    projectId: string
  ): Promise<readonly SharedProjectBuildArtifact[]> {
    return (
      await this.request<{
        readonly buildArtifacts: readonly SharedProjectBuildArtifact[];
      }>(`/projects/${encodeURIComponent(projectId)}/build-artifacts`)
    ).buildArtifacts;
  }

  async getBuildArtifact(
    projectId: string,
    artifactId: string
  ): Promise<SharedProjectBuildArtifact> {
    return (
      await this.request<{ readonly buildArtifact: SharedProjectBuildArtifact }>(
        `/projects/${encodeURIComponent(projectId)}/build-artifacts/${encodeURIComponent(
          artifactId
        )}`
      )
    ).buildArtifact;
  }

  async getDocumentState(
    projectId: string,
    path: string
  ): Promise<SharedProjectDocumentState> {
    return (
      await this.request<{ readonly state: SharedProjectDocumentState }>(
        `/projects/${encodeURIComponent(projectId)}/collaboration/files/${encodeProjectPath(
          path
        )}`
      )
    ).state;
  }

  async listDocumentUpdates(
    projectId: string,
    path: string,
    afterUpdateId?: string
  ): Promise<SharedProjectDocumentUpdateFeed> {
    const searchParams = new URLSearchParams({ updates: "1" });
    if (afterUpdateId !== undefined) {
      searchParams.set("afterUpdateId", afterUpdateId);
    }

    return (
      await this.request<{ readonly feed: SharedProjectDocumentUpdateFeed }>(
        `/projects/${encodeURIComponent(projectId)}/collaboration/files/${encodeProjectPath(
          path
        )}?${searchParams.toString()}`
      )
    ).feed;
  }

  async applyDocumentUpdate(
    projectId: string,
    path: string,
    updateBase64: string,
    clientOperationId?: string,
    expectedRevisionId?: string
  ): Promise<SharedProjectDocumentUpdateResult> {
    const body: SharedProjectDocumentUpdateRequest = {
      updateBase64,
      ...(clientOperationId === undefined ? {} : { clientOperationId }),
      ...(expectedRevisionId === undefined ? {} : { expectedRevisionId })
    };

    return (
      await this.request<{ readonly result: SharedProjectDocumentUpdateResult }>(
        `/projects/${encodeURIComponent(projectId)}/collaboration/files/${encodeProjectPath(
          path
        )}`,
        {
          method: "POST",
          body
        }
      )
    ).result;
  }

  async applyDocumentTextOperations(
    projectId: string,
    path: string,
    operations: readonly SharedProjectDocumentTextOperation[],
    clientOperationId?: string
  ): Promise<SharedProjectDocumentUpdateResult> {
    const session = await SharedProjectDocumentSession.open(this, projectId, path);
    return session.applyTextOperations(operations, clientOperationId);
  }

  async replaceDocumentContents(
    projectId: string,
    path: string,
    contents: string,
    expectedRevisionId?: string
  ): Promise<SharedProjectDocumentUpdateResult> {
    const state = await this.getDocumentState(projectId, path);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(state.stateUpdateBase64, "base64")));
    const stateVector = Y.encodeStateVector(doc);
    const text = doc.getText("content");
    text.delete(0, text.length);
    if (contents.length > 0) {
      text.insert(0, contents);
    }
    const updateBase64 = Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)).toString(
      "base64"
    );

    return this.applyDocumentUpdate(
      projectId,
      path,
      updateBase64,
      undefined,
      expectedRevisionId
    );
  }

  async updatePresence(
    projectId: string,
    update: SharedProjectPresenceUpdate
  ): Promise<SharedProjectPresence> {
    return (
      await this.request<{ readonly presence: SharedProjectPresence }>(
        `/projects/${encodeURIComponent(projectId)}/presence`,
        {
          method: "PUT",
          body: update
        }
      )
    ).presence;
  }

  async listPresence(projectId: string): Promise<readonly SharedProjectPresence[]> {
    return (
      await this.request<{ readonly presence: readonly SharedProjectPresence[] }>(
        `/projects/${encodeURIComponent(projectId)}/presence`
      )
    ).presence;
  }

  async createAgentRun(
    projectId: string,
    request: SharedProjectAgentRunCreate
  ): Promise<SharedProjectAgentRun> {
    return (
      await this.request<{ readonly agentRun: SharedProjectAgentRun }>(
        `/projects/${encodeURIComponent(projectId)}/agent-runs`,
        {
          method: "POST",
          body: request
        }
      )
    ).agentRun;
  }

  async updateAgentRunStatus(
    projectId: string,
    agentRunId: string,
    request: SharedProjectAgentRunStatusUpdate
  ): Promise<SharedProjectAgentRun> {
    return (
      await this.request<{ readonly agentRun: SharedProjectAgentRun }>(
        `/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(
          agentRunId
        )}/status`,
        {
          method: "POST",
          body: request
        }
      )
    ).agentRun;
  }

  async listAgentRuns(projectId: string): Promise<readonly SharedProjectAgentRun[]> {
    return (
      await this.request<{ readonly agentRuns: readonly SharedProjectAgentRun[] }>(
        `/projects/${encodeURIComponent(projectId)}/agent-runs`
      )
    ).agentRuns;
  }

  async attachBuildArtifactToAgentRun(
    projectId: string,
    agentRunId: string,
    request: SharedProjectAgentRunBuildArtifactAttach
  ): Promise<SharedProjectAgentRun> {
    return (
      await this.request<{ readonly agentRun: SharedProjectAgentRun }>(
        `/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(
          agentRunId
        )}/build-artifacts`,
        {
          method: "POST",
          body: request
        }
      )
    ).agentRun;
  }

  async createChangeSet(
    projectId: string,
    request: SharedProjectChangeSetCreate
  ): Promise<SharedProjectChangeSet> {
    return (
      await this.request<{ readonly changeset: SharedProjectChangeSet }>(
        `/projects/${encodeURIComponent(projectId)}/changesets`,
        {
          method: "POST",
          body: request
        }
      )
    ).changeset;
  }

  async applyChangeSet(
    projectId: string,
    changesetId: string
  ): Promise<SharedProjectChangeSet> {
    return (
      await this.request<{ readonly changeset: SharedProjectChangeSet }>(
        `/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(
          changesetId
        )}/apply`,
        { method: "POST" }
      )
    ).changeset;
  }

  async rejectChangeSet(
    projectId: string,
    changesetId: string
  ): Promise<SharedProjectChangeSet> {
    return (
      await this.request<{ readonly changeset: SharedProjectChangeSet }>(
        `/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(
          changesetId
        )}/reject`,
        { method: "POST" }
      )
    ).changeset;
  }

  async listChangeSets(projectId: string): Promise<readonly SharedProjectChangeSet[]> {
    return (
      await this.request<{ readonly changesets: readonly SharedProjectChangeSet[] }>(
        `/projects/${encodeURIComponent(projectId)}/changesets`
      )
    ).changesets;
  }

  async listActivity(
    projectId: string
  ): Promise<readonly SharedProjectActivityEvent[]> {
    return (
      await this.request<{ readonly activity: readonly SharedProjectActivityEvent[] }>(
        `/projects/${encodeURIComponent(projectId)}/activity`
      )
    ).activity;
  }

  async listComments(projectId: string): Promise<readonly SharedProjectComment[]> {
    return (
      await this.request<{ readonly comments: readonly SharedProjectComment[] }>(
        `/projects/${encodeURIComponent(projectId)}/comments`
      )
    ).comments;
  }

  async createComment(
    projectId: string,
    request: SharedProjectCommentCreate
  ): Promise<SharedProjectComment> {
    return (
      await this.request<{ readonly comment: SharedProjectComment }>(
        `/projects/${encodeURIComponent(projectId)}/comments`,
        {
          method: "POST",
          body: request
        }
      )
    ).comment;
  }

  async resolveComment(
    projectId: string,
    commentId: string
  ): Promise<SharedProjectComment> {
    return (
      await this.request<{ readonly comment: SharedProjectComment }>(
        `/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(
          commentId
        )}/resolve`,
        { method: "POST" }
      )
    ).comment;
  }

  async listAuditEvents(
    projectId: string
  ): Promise<readonly SharedProjectAuditEvent[]> {
    return (
      await this.request<{
        readonly auditEvents: readonly SharedProjectAuditEvent[];
      }>(`/projects/${encodeURIComponent(projectId)}/audit-events`)
    ).auditEvents;
  }

  async recordAuditEvent(
    projectId: string,
    request: SharedProjectAuditEventCreate
  ): Promise<SharedProjectAuditEvent> {
    return (
      await this.request<{ readonly auditEvent: SharedProjectAuditEvent }>(
        `/projects/${encodeURIComponent(projectId)}/audit-events`,
        {
          method: "POST",
          body: request
        }
      )
    ).auditEvent;
  }

  async openRealtimeSession(
    projectId: string,
    options: SharedProjectRealtimeSessionOptions = {}
  ): Promise<SharedProjectRealtimeSession> {
    const accessToken = await this.getRealtimeAccessToken();
    try {
      return await SharedProjectRealtimeSession.open(
        this.options.baseUrl,
        projectId,
        accessToken,
        options
      );
    } catch (error) {
      if (
        error instanceof SharedProjectClientError &&
        error.status === 401 &&
        this.refreshToken !== undefined
      ) {
        const session = await this.refreshSession();
        return SharedProjectRealtimeSession.open(
          this.options.baseUrl,
          projectId,
          session.accessToken,
          options
        );
      }

      throw error;
    }
  }

  private async request<T>(
    path: string,
    options: SharedProjectRequestOptions = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };

    if (this.accessToken !== undefined) {
      headers.authorization = `Bearer ${this.accessToken}`;
    }

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(new URL(path, this.options.baseUrl), init);
    const json = (await response.json()) as unknown;

    if (!response.ok) {
      if (
        response.status === 401 &&
        options.refreshOnUnauthorized !== false &&
        this.refreshToken !== undefined
      ) {
        await this.refreshSession();
        return this.request(path, {
          ...options,
          refreshOnUnauthorized: false
        });
      }

      throw new SharedProjectClientError(
        getErrorMessage(json),
        response.status,
        getErrorCode(json)
      );
    }

    return json as T;
  }

  private requireAccessToken(): string {
    if (this.accessToken === undefined) {
      throw new SharedProjectClientError(
        "Sign in before opening a realtime shared project session.",
        401,
        "unauthorized"
      );
    }

    return this.accessToken;
  }

  private async getRealtimeAccessToken(): Promise<string> {
    if (this.accessToken !== undefined) {
      return this.accessToken;
    }

    if (this.refreshToken !== undefined) {
      return (await this.refreshSession()).accessToken;
    }

    return this.requireAccessToken();
  }

  private requireRefreshToken(): string {
    if (this.refreshToken === undefined) {
      throw new SharedProjectClientError(
        "Sign in before refreshing a shared project session.",
        401,
        "unauthorized"
      );
    }

    return this.refreshToken;
  }
}

export class SharedProjectRealtimeSession {
  private constructor(private readonly socket: WebSocket) {}

  static async open(
    baseUrl: string,
    projectId: string,
    accessToken: string,
    options: SharedProjectRealtimeSessionOptions
  ): Promise<SharedProjectRealtimeSession> {
    const socket = new WebSocket(createRealtimeUrl(baseUrl, projectId, accessToken));
    const session = new SharedProjectRealtimeSession(socket);

    await session.waitForOpen();

    socket.on("message", (data) => {
      try {
        options.onEvent?.(JSON.parse(data.toString()) as SharedProjectRealtimeEvent);
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error : new Error("Invalid realtime event payload.")
        );
      }
    });
    socket.on("error", (error) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", (code, reason) => {
      options.onClose?.({ code, reason: reason.toString() });
    });

    return session;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close();
    });
  }

  private async waitForOpen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.socket.off("open", handleOpen);
        this.socket.off("error", handleError);
        this.socket.off("unexpected-response", handleUnexpectedResponse);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const handleUnexpectedResponse = (
        _request: unknown,
        response: { readonly statusCode?: number }
      ): void => {
        cleanup();
        reject(
          new SharedProjectClientError(
            `Realtime session rejected with status ${response.statusCode ?? "unknown"}.`,
            response.statusCode ?? 500,
            "realtime-upgrade-failed"
          )
        );
      };

      this.socket.once("open", handleOpen);
      this.socket.once("error", handleError);
      this.socket.once("unexpected-response", handleUnexpectedResponse);
    });
  }
}

export class SharedProjectDocumentSession {
  private constructor(
    private readonly client: SharedProjectHttpClient,
    readonly projectId: string,
    readonly path: string,
    private readonly doc: Y.Doc,
    private lastUpdateId: string | undefined
  ) {}

  static async open(
    client: SharedProjectHttpClient,
    projectId: string,
    path: string
  ): Promise<SharedProjectDocumentSession> {
    const feed = await client.listDocumentUpdates(projectId, path);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBase64Update(feed.state.stateUpdateBase64));

    return new SharedProjectDocumentSession(
      client,
      projectId,
      path,
      doc,
      feed.latestUpdateId
    );
  }

  get contents(): string {
    return this.doc.getText("content").toString();
  }

  get updateCursor(): string | undefined {
    return this.lastUpdateId;
  }

  async applyTextOperations(
    operations: readonly SharedProjectDocumentTextOperation[],
    clientOperationId?: string
  ): Promise<SharedProjectDocumentUpdateResult> {
    if (operations.length === 0) {
      throw new Error("At least one document text operation is required.");
    }

    const pendingDoc = new Y.Doc();
    Y.applyUpdate(pendingDoc, Y.encodeStateAsUpdate(this.doc));
    const stateVector = Y.encodeStateVector(pendingDoc);
    applyTextOperationsToYText(pendingDoc.getText("content"), operations);
    const updateBase64 = Buffer.from(
      Y.encodeStateAsUpdate(pendingDoc, stateVector)
    ).toString("base64");
    const result = await this.client.applyDocumentUpdate(
      this.projectId,
      this.path,
      updateBase64,
      clientOperationId
    );

    this.applyServerState(result.state.stateUpdateBase64, result.update.id);
    return result;
  }

  async pullRemoteUpdates(
    afterUpdateId = this.lastUpdateId
  ): Promise<SharedProjectDocumentUpdateFeed> {
    const feed = await this.client.listDocumentUpdates(
      this.projectId,
      this.path,
      afterUpdateId
    );

    for (const update of feed.updates) {
      Y.applyUpdate(this.doc, decodeBase64Update(update.updateBase64));
    }

    if (feed.latestUpdateId !== undefined) {
      this.lastUpdateId = feed.latestUpdateId;
    }

    return feed;
  }

  private applyServerState(stateUpdateBase64: string, lastUpdateId: string): void {
    Y.applyUpdate(this.doc, decodeBase64Update(stateUpdateBase64));
    this.lastUpdateId = lastUpdateId;
  }
}

function applyTextOperationsToYText(
  text: Y.Text,
  operations: readonly SharedProjectDocumentTextOperation[]
): void {
  const sortedOperations = [...operations].sort(
    (left, right) => right.rangeOffset - left.rangeOffset
  );

  for (const operation of sortedOperations) {
    const rangeOffset = normalizeOperationNumber(operation.rangeOffset, "rangeOffset");
    const rangeLength = normalizeOperationNumber(operation.rangeLength, "rangeLength");
    if (rangeOffset > text.length || rangeOffset + rangeLength > text.length) {
      throw new Error("Document text operation is outside the current document.");
    }

    if (rangeLength > 0) {
      text.delete(rangeOffset, rangeLength);
    }
    if (operation.text.length > 0) {
      text.insert(rangeOffset, operation.text);
    }
  }
}

function normalizeOperationNumber(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
}

function decodeBase64Update(updateBase64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(updateBase64, "base64"));
}

function createRealtimeUrl(
  baseUrl: string,
  projectId: string,
  accessToken: string
): string {
  const url = new URL(`/projects/${encodeURIComponent(projectId)}/realtime`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("accessToken", accessToken);
  return url.toString();
}

export class SharedProjectCache {
  constructor(private readonly cacheRoot: string) {}

  getProjectCachePath(projectId: string): string {
    return resolve(this.cacheRoot, "shared-projects", safeCacheSegment(projectId));
  }

  getProjectWorkingPath(projectId: string): string {
    return resolve(this.getProjectCachePath(projectId), "working");
  }

  async materializeProject(
    client: SharedProjectHttpClient,
    projectId: string
  ): Promise<SharedProjectCacheMaterializeResult> {
    const workingPath = this.getProjectWorkingPath(projectId);
    await rm(workingPath, { recursive: true, force: true });
    await mkdir(workingPath, { recursive: true });

    const tree = await client.getTree(projectId);
    const files: { path: string; revisionId: string }[] = [];
    const directories = flattenDirectoryPaths(tree);

    for (const directoryPath of directories) {
      await mkdir(resolveCachePath(workingPath, directoryPath), { recursive: true });
    }

    for (const filePath of flattenFilePaths(tree)) {
      const file = await client.readFile(projectId, filePath);
      await writeCacheFile(workingPath, file);
      files.push({ path: file.path, revisionId: file.id });
    }

    const metadata = {
      projectId,
      materializedAt: new Date().toISOString(),
      directories,
      files
    };
    await writeFile(
      resolve(this.getProjectCachePath(projectId), "metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf8"
    );

    return {
      projectId,
      cachePath: this.getProjectCachePath(projectId),
      workingPath,
      directories,
      files
    };
  }

  async getCachedRevisionId(
    projectId: string,
    path: string
  ): Promise<string | undefined> {
    return readCachedRevisionId(this.getProjectCachePath(projectId), path);
  }

  async recordFileRevision(
    projectId: string,
    path: string,
    revisionId: string
  ): Promise<void> {
    const cachePath = this.getProjectCachePath(projectId);
    const metadata = await readCacheMetadata(cachePath);
    const normalizedPath = normalizeProjectPath(path);
    const files = metadata.files ?? [];
    const nextFile = { path: normalizedPath, revisionId };
    const existingFile = files.find((file) => file.path === normalizedPath);
    const nextMetadata: SharedProjectCacheMetadata = {
      ...metadata,
      projectId,
      files:
        existingFile === undefined
          ? [...files, nextFile]
          : files.map((file) => (file.path === normalizedPath ? nextFile : file))
    };

    await writeCacheMetadata(cachePath, nextMetadata);
  }

  async recordDirectory(projectId: string, path: string): Promise<void> {
    const cachePath = this.getProjectCachePath(projectId);
    const metadata = await readCacheMetadata(cachePath);
    const normalizedPath = normalizeProjectPath(path);
    const directories = metadata.directories ?? [];

    if (directories.includes(normalizedPath)) {
      return;
    }

    await writeCacheMetadata(cachePath, {
      ...metadata,
      projectId,
      directories: [...directories, normalizedPath].sort((left, right) =>
        left.localeCompare(right)
      )
    });
  }

  async recordEntryMove(
    projectId: string,
    fromPath: string,
    toPath: string
  ): Promise<void> {
    const cachePath = this.getProjectCachePath(projectId);
    const metadata = await readCacheMetadata(cachePath);
    const normalizedFromPath = normalizeProjectPath(fromPath);
    const normalizedToPath = normalizeProjectPath(toPath);

    await writeCacheMetadata(cachePath, {
      ...metadata,
      projectId,
      directories: (metadata.directories ?? [])
        .map((path) => moveProjectPath(path, normalizedFromPath, normalizedToPath))
        .sort((left, right) => left.localeCompare(right)),
      files: (metadata.files ?? [])
        .map((file) => ({
          ...file,
          path: moveProjectPath(file.path, normalizedFromPath, normalizedToPath)
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    });
  }

  async recordEntryDelete(projectId: string, path: string): Promise<void> {
    const cachePath = this.getProjectCachePath(projectId);
    const metadata = await readCacheMetadata(cachePath);
    const normalizedPath = normalizeProjectPath(path);

    await writeCacheMetadata(cachePath, {
      ...metadata,
      projectId,
      directories: (metadata.directories ?? []).filter(
        (directoryPath) => !isProjectPathOrDescendant(directoryPath, normalizedPath)
      ),
      files: (metadata.files ?? []).filter(
        (file) => !isProjectPathOrDescendant(file.path, normalizedPath)
      )
    });
  }
}

export type SharedProjectGatewayAdapterOptions = {
  readonly client: SharedProjectHttpClient;
  readonly cache: SharedProjectCache;
  readonly metadataStore: ProjectMetadataStore;
};

export class SharedProjectGatewayAdapter implements ProjectBackendAdapter<SharedProjectHandle> {
  readonly backend = "shared" as const;

  constructor(private readonly options: SharedProjectGatewayAdapterOptions) {}

  async listRecentProjects(): Promise<readonly SharedProjectHandle[]> {
    return (await this.options.client.listProjects()).map((project) =>
      createSharedProjectHandle(project)
    );
  }

  async openProject(handle: SharedProjectHandle): Promise<ProjectOpenResult> {
    const [materialized, project] = await Promise.all([
      this.options.cache.materializeProject(
        this.options.client,
        handle.sharedProjectId
      ),
      this.options.client.getProject(handle.sharedProjectId)
    ]);

    if (project.mainFilePath !== undefined) {
      await setProjectMainFile(
        materialized.workingPath,
        this.options.metadataStore,
        project.mainFilePath
      );
    }

    return openProject(materialized.workingPath, this.options.metadataStore);
  }

  async refreshProject(handle: SharedProjectHandle): Promise<ProjectOpenResult> {
    return this.openProject(handle);
  }

  async listFiles(
    handle: SharedProjectHandle
  ): Promise<readonly ProjectFileTreeNode[]> {
    return listProjectTree(this.requireCachePath(handle));
  }

  async readFile(
    handle: SharedProjectHandle,
    path: string
  ): Promise<ProjectFileSnapshot> {
    return readProjectFile(this.requireCachePath(handle), path);
  }

  async writeFile(
    handle: SharedProjectHandle,
    path: string,
    contents: string
  ): Promise<ProjectWriteResult> {
    const expectedRevisionId = await this.options.cache.getCachedRevisionId(
      handle.sharedProjectId,
      path
    );
    const revision = isSharedProjectCollaborativeDocumentPath(path)
      ? (
          await this.options.client.replaceDocumentContents(
            handle.sharedProjectId,
            path,
            contents,
            expectedRevisionId
          )
        ).revision
      : await this.options.client.writeFile(
          handle.sharedProjectId,
          path,
          contents,
          expectedRevisionId
        );
    await this.options.cache.recordFileRevision(
      handle.sharedProjectId,
      revision.path,
      revision.id
    );
    const materialized = await this.options.cache.materializeProject(
      this.options.client,
      handle.sharedProjectId
    );
    const snapshot = await readProjectFile(materialized.workingPath, path);

    return {
      saved: true,
      mtimeMs: snapshot.mtimeMs
    };
  }

  async createEntry(
    handle: SharedProjectHandle,
    parentPath: string,
    name: string,
    kind: ProjectEntryKind
  ): Promise<ProjectOpenResult> {
    const path = joinProjectPath(parentPath, name);

    if (kind === "directory") {
      await this.options.client.createDirectory(handle.sharedProjectId, path);
      await this.options.cache.recordDirectory(handle.sharedProjectId, path);
      return this.refreshProject(handle);
    }

    const file = await this.options.client.createFile(handle.sharedProjectId, path, "");
    await this.options.cache.recordFileRevision(
      handle.sharedProjectId,
      file.path,
      file.id
    );
    return this.refreshProject(handle);
  }

  async renameEntry(
    handle: SharedProjectHandle,
    path: string,
    newName: string
  ): Promise<ProjectOpenResult> {
    await this.options.client.renameEntry(handle.sharedProjectId, path, newName);
    await this.options.cache.recordEntryMove(
      handle.sharedProjectId,
      path,
      getSiblingProjectPath(path, newName)
    );
    return this.refreshProject(handle);
  }

  async moveEntry(
    handle: SharedProjectHandle,
    path: string,
    newPath: string
  ): Promise<ProjectOpenResult> {
    await this.options.client.moveEntry(handle.sharedProjectId, path, newPath);
    await this.options.cache.recordEntryMove(handle.sharedProjectId, path, newPath);
    return this.refreshProject(handle);
  }

  async deleteEntry(
    handle: SharedProjectHandle,
    path: string
  ): Promise<ProjectOpenResult & { readonly deletedEntry: ProjectDeleteBackup }> {
    const deletedPaths = await this.options.client.deleteEntry(
      handle.sharedProjectId,
      path
    );
    await this.options.cache.recordEntryDelete(handle.sharedProjectId, path);
    const result = await this.refreshProject(handle);

    return {
      ...result,
      deletedEntry: {
        deletedPath: path,
        backupPath: `shared-project:${handle.sharedProjectId}:${deletedPaths.join(",")}`,
        deletedAt: new Date().toISOString()
      }
    };
  }

  async setMainFile(
    handle: SharedProjectHandle,
    path: string
  ): Promise<ProjectOpenResult> {
    const project = await this.options.client.updateProjectSettings(
      handle.sharedProjectId,
      {
        mainFilePath: path
      }
    );

    if (project.mainFilePath === undefined) {
      return this.refreshProject(handle);
    }

    return setProjectMainFile(
      this.requireCachePath(handle),
      this.options.metadataStore,
      project.mainFilePath
    );
  }

  private requireCachePath(handle: SharedProjectHandle): string {
    if (handle.localCachePath === undefined) {
      throw new SharedProjectClientError(
        "Open the shared project before using its local cache.",
        400,
        "missing-cache"
      );
    }

    return handle.localCachePath;
  }
}

export class SharedProjectClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "SharedProjectClientError";
  }
}

type SharedProjectCacheMetadata = {
  readonly projectId?: string;
  readonly materializedAt?: string;
  readonly directories?: readonly string[];
  readonly files?: readonly SharedProjectCacheMetadataFile[];
};

type SharedProjectCacheMetadataFile = {
  readonly path: string;
  readonly revisionId: string;
};

async function readCachedRevisionId(
  cachePath: string,
  projectPath: string
): Promise<string | undefined> {
  const metadata = await readCacheMetadata(cachePath);
  const normalizedPath = normalizeProjectPath(projectPath);
  const file = metadata.files?.find((candidate) => candidate.path === normalizedPath);

  return file?.revisionId;
}

async function readCacheMetadata(
  cachePath: string
): Promise<SharedProjectCacheMetadata> {
  try {
    const candidate = JSON.parse(
      await readFile(resolve(cachePath, "metadata.json"), "utf8")
    ) as SharedProjectCacheMetadata;

    return {
      ...(typeof candidate.projectId === "string"
        ? { projectId: candidate.projectId }
        : {}),
      ...(typeof candidate.materializedAt === "string"
        ? { materializedAt: candidate.materializedAt }
        : {}),
      directories: Array.isArray(candidate.directories)
        ? candidate.directories.filter(
            (path): path is string => typeof path === "string"
          )
        : [],
      files: Array.isArray(candidate.files)
        ? candidate.files.flatMap((file) =>
            typeof file.path === "string" && typeof file.revisionId === "string"
              ? [{ path: file.path, revisionId: file.revisionId }]
              : []
          )
        : []
    };
  } catch {
    return { files: [], directories: [] };
  }
}

async function writeCacheMetadata(
  cachePath: string,
  metadata: SharedProjectCacheMetadata
): Promise<void> {
  const metadataPath = resolve(cachePath, "metadata.json");

  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

function moveProjectPath(path: string, fromPath: string, toPath: string): string {
  return path === fromPath || path.startsWith(`${fromPath}/`)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

function isProjectPathOrDescendant(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}/`);
}

async function writeCacheFile(
  workingPath: string,
  file: Pick<SharedProjectFileRevision, "path" | "contents" | "contentEncoding">
): Promise<void> {
  const targetPath = resolveCachePath(workingPath, file.path);
  const data =
    file.contentEncoding === "base64"
      ? Buffer.from(file.contents, "base64")
      : file.contents;
  await mkdir(dirname(targetPath), { recursive: true });
  if (file.contentEncoding === "base64") {
    await writeFile(targetPath, data);
  } else {
    await writeFile(targetPath, data, "utf8");
  }
}

export async function readCacheFile(
  workingPath: string,
  projectPath: string
): Promise<string> {
  return readFile(resolveCachePath(workingPath, projectPath), "utf8");
}

function resolveCachePath(workingPath: string, projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  const targetPath = resolve(workingPath, ...normalized.split("/"));
  const rootWithSeparator = workingPath.endsWith(sep)
    ? workingPath
    : `${workingPath}${sep}`;

  if (targetPath !== workingPath && !targetPath.startsWith(rootWithSeparator)) {
    throw new SharedProjectClientError(
      "Shared project cache path resolved outside the cache.",
      400,
      "invalid-path"
    );
  }

  return targetPath;
}

function flattenFilePaths(nodes: readonly SharedProjectTreeNode[]): readonly string[] {
  return nodes.flatMap((node) =>
    node.kind === "file" ? [node.path] : flattenFilePaths(node.children ?? [])
  );
}

function flattenDirectoryPaths(
  nodes: readonly SharedProjectTreeNode[]
): readonly string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory"
      ? [node.path, ...flattenDirectoryPaths(node.children ?? [])]
      : []
  );
}

function normalizeProjectPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\/+/u, "");

  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new SharedProjectClientError(
      "Project path must stay inside the cache.",
      400,
      "invalid-path"
    );
  }

  return normalized;
}

function encodeProjectPath(path: string): string {
  return normalizeProjectPath(path).split("/").map(encodeURIComponent).join("/");
}

function joinProjectPath(parentPath: string, name: string): string {
  const parent = parentPath.trim().length === 0 ? "." : parentPath;
  return normalizeProjectPath(posix.join(parent.replaceAll("\\", "/"), name));
}

function getSiblingProjectPath(path: string, name: string): string {
  const normalizedPath = normalizeProjectPath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");

  return slashIndex === -1
    ? normalizeProjectPath(name)
    : normalizeProjectPath(`${normalizedPath.slice(0, slashIndex)}/${name}`);
}

function createSharedProjectHandle(project: SharedProject): SharedProjectHandle {
  return {
    id: `shared:${project.id}`,
    backend: "shared",
    displayName: project.name,
    sharedProjectId: project.id,
    ...(project.mainFilePath === undefined
      ? {}
      : { mainFilePath: project.mainFilePath }),
    syncState: "synced"
  };
}

function safeCacheSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

function withOptionalName(
  body: { readonly email: string },
  name: string | undefined
): { readonly email: string; readonly name?: string } {
  return name === undefined ? body : { ...body, name };
}

function getErrorMessage(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const message = (value as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return "Shared project request failed.";
}

function getErrorCode(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const error = (value as { readonly error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
  }

  return "request-failed";
}

type SharedProjectRequestOptions = {
  readonly method?: string;
  readonly body?: unknown;
  readonly refreshOnUnauthorized?: boolean;
};
