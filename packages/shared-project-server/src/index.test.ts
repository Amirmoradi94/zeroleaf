import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SharedProjectService,
  SharedProjectStore,
  createSharedProjectHttpServer,
  type SharedProjectRealtimeEvent,
  type SharedProjectRole,
  type SignInResult
} from "./index.js";

let sandboxPath: string;
let server: ReturnType<typeof createSharedProjectHttpServer>;
let baseUrl: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "zeroleaf-shared-server-"));
  const store = new SharedProjectStore(join(sandboxPath, "db", "shared-projects.json"));
  const service = new SharedProjectService(store);
  server = createSharedProjectHttpServer(service);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await rm(sandboxPath, { recursive: true, force: true });
});

describe("shared project server", () => {
  it("revokes refresh-backed sessions when signing out", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Signed Out Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const socket = await openRealtime(projectId, owner.accessToken);

    let signOutResponse: Response;
    try {
      const closed = nextRealtimeClose(socket);
      signOutResponse = await fetch(`${baseUrl}/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: owner.refreshToken })
      });

      await expect(closed).resolves.toMatchObject({
        code: 4003,
        reason: "Session was revoked."
      });
    } finally {
      await closeRealtime(socket);
    }

    expect(signOutResponse.status).toBe(200);
    await expect(signOutResponse.json()).resolves.toEqual({ signedOut: true });
    await expect(rawApi(owner.accessToken, "/auth/session")).resolves.toMatchObject({
      status: 401
    });

    const refreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: owner.refreshToken })
    });
    expect(refreshResponse.status).toBe(401);

    const repeatedSignOutResponse = await fetch(`${baseUrl}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: owner.refreshToken })
    });
    expect(repeatedSignOutResponse.status).toBe(200);
    await expect(repeatedSignOutResponse.json()).resolves.toEqual({
      signedOut: false
    });
  });

  it("lists and revokes only the authenticated user's sessions", async () => {
    const firstDevice = await signIn("owner@example.com", "Owner");
    const secondDevice = await signIn("owner@example.com", "Owner");
    const outsider = await signIn("outsider@example.com", "Outsider");

    const sessions = await api(firstDevice.accessToken, "/auth/sessions");
    expect(sessions.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: firstDevice.user.id,
          current: true,
          accessTokenExpiresAt: expect.any(String),
          refreshTokenExpiresAt: expect.any(String)
        }),
        expect.objectContaining({
          userId: firstDevice.user.id,
          current: false
        })
      ])
    );
    expect(sessions.sessions).toHaveLength(2);

    const outsiderSessions = await api(outsider.accessToken, "/auth/sessions");
    expect(outsiderSessions.sessions).toHaveLength(1);

    const secondDeviceSession = (sessions.sessions as readonly any[]).find(
      (session) => session.current === false
    );
    expect(secondDeviceSession).toBeDefined();

    const outsiderRevoke = await rawApi(
      outsider.accessToken,
      `/auth/sessions/${secondDeviceSession.id}/revoke`,
      { method: "POST" }
    );
    expect(outsiderRevoke.status).toBe(404);

    const revoke = await api(
      firstDevice.accessToken,
      `/auth/sessions/${secondDeviceSession.id}/revoke`,
      { method: "POST" }
    );
    expect(revoke.result).toEqual({
      sessionId: secondDeviceSession.id,
      revoked: true
    });
    await expect(
      rawApi(secondDevice.accessToken, "/auth/session")
    ).resolves.toMatchObject({
      status: 401
    });
    await expect(api(firstDevice.accessToken, "/auth/sessions")).resolves.toMatchObject(
      {
        sessions: [expect.objectContaining({ current: true })]
      }
    );
  });

  it("closes realtime sockets for revoked authenticated sessions", async () => {
    const firstDevice = await signIn("owner@example.com", "Owner");
    const secondDevice = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(firstDevice.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Revoked Session Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const sessions = await api(firstDevice.accessToken, "/auth/sessions");
    const secondDeviceSession = (sessions.sessions as readonly any[]).find(
      (session) => session.current === false
    );
    expect(secondDeviceSession).toBeDefined();
    const secondDeviceSocket = await openRealtime(projectId, secondDevice.accessToken);

    try {
      const closed = nextRealtimeClose(secondDeviceSocket);
      await api(
        firstDevice.accessToken,
        `/auth/sessions/${secondDeviceSession.id}/revoke`,
        { method: "POST" }
      );

      await expect(closed).resolves.toMatchObject({
        code: 4003,
        reason: "Session was revoked."
      });
    } finally {
      await closeRealtime(secondDeviceSocket);
    }
  });

  it("stores shared project settings for main file and compiler", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const viewer = await signIn("viewer@example.com", "Viewer");
    const createResponse = await api(owner.accessToken, "/projects", {
      method: "POST",
      body: {
        name: "Settings Paper",
        files: [
          { path: "main.tex", contents: "Main" },
          { path: "appendix.tex", contents: "Appendix" }
        ],
        mainFilePath: "main.tex",
        compiler: "xelatex"
      }
    });
    const projectId = createResponse.project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "viewer@example.com",
      "viewer"
    );
    await api(viewer.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    await expect(
      api(owner.accessToken, `/projects/${projectId}`)
    ).resolves.toMatchObject({
      project: {
        mainFilePath: "main.tex",
        compiler: "xelatex"
      }
    });

    const updated = await api(owner.accessToken, `/projects/${projectId}/settings`, {
      method: "PATCH",
      body: { mainFilePath: "appendix.tex", compiler: "lualatex" }
    });
    expect(updated.project).toMatchObject({
      mainFilePath: "appendix.tex",
      compiler: "lualatex"
    });
    await expect(
      api(viewer.accessToken, `/projects/${projectId}`)
    ).resolves.toMatchObject({
      project: {
        mainFilePath: "appendix.tex",
        compiler: "lualatex"
      }
    });

    const viewerUpdate = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/settings`,
      {
        method: "PATCH",
        body: { mainFilePath: "main.tex" }
      }
    );
    expect(viewerUpdate.status).toBe(403);

    const missingMain = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/settings`,
      {
        method: "PATCH",
        body: { mainFilePath: "missing.tex" }
      }
    );
    expect(missingMain.status).toBe(400);
  });

  it("creates a shared project and stores whole-file revisions over HTTP", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    expect(owner.refreshToken).toEqual(expect.any(String));
    expect(new Date(owner.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(owner.refreshTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(api(owner.accessToken, "/auth/session")).resolves.toMatchObject({
      user: {
        id: owner.user.id,
        email: "owner@example.com",
        name: "Owner"
      }
    });

    const refreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: owner.refreshToken })
    });
    expect(refreshResponse.status).toBe(200);
    const refreshedOwner = (await refreshResponse.json()) as SignInResult;
    expect(refreshedOwner.accessToken).not.toBe(owner.accessToken);
    expect(refreshedOwner.refreshToken).not.toBe(owner.refreshToken);
    expect(new Date(refreshedOwner.refreshTokenExpiresAt).getTime()).toBeGreaterThan(
      Date.now()
    );
    await expect(rawApi(owner.accessToken, "/auth/session")).resolves.toMatchObject({
      status: 401
    });
    await expect(
      api(refreshedOwner.accessToken, "/auth/session")
    ).resolves.toMatchObject({
      user: {
        id: owner.user.id
      }
    });

    const reusedRefreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: owner.refreshToken })
    });
    expect(reusedRefreshResponse.status).toBe(401);

    const secondRefreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshedOwner.refreshToken })
    });
    expect(secondRefreshResponse.status).toBe(200);
    const secondRefreshedOwner = (await secondRefreshResponse.json()) as SignInResult;

    const invalidRefreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "not-a-real-refresh-token" })
    });
    expect(invalidRefreshResponse.status).toBe(401);

    const accessToken = secondRefreshedOwner.accessToken;
    const createResponse = await api(accessToken, "/projects", {
      method: "POST",
      body: {
        name: "Shared Paper",
        files: [
          {
            path: "main.tex",
            contents:
              "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n"
          }
        ]
      }
    });
    const projectId = createResponse.project.id as string;
    const listResponse = await api(accessToken, "/projects");
    expect(listResponse.projects).toContainEqual(
      expect.objectContaining({
        id: projectId,
        role: "owner"
      })
    );

    const treeResponse = await api(accessToken, `/projects/${projectId}/tree`);
    expect(treeResponse.tree).toEqual([
      {
        name: "main.tex",
        path: "main.tex",
        kind: "file"
      }
    ]);

    const readResponse = await api(
      accessToken,
      `/projects/${projectId}/files/main.tex`
    );
    expect(readResponse.file.contents).toContain("Hi");

    const writeResponse = await api(
      accessToken,
      `/projects/${projectId}/files/main.tex`,
      {
        method: "PUT",
        body: {
          contents:
            "\\documentclass{article}\n\\begin{document}\nUpdated\n\\end{document}\n",
          expectedRevisionId: readResponse.file.id
        }
      }
    );
    expect(writeResponse.file.path).toBe("main.tex");
    expect(writeResponse.file.id).not.toBe(readResponse.file.id);

    const staleWrite = await rawApi(
      accessToken,
      `/projects/${projectId}/files/main.tex`,
      {
        method: "PUT",
        body: {
          contents: "Stale overwrite",
          expectedRevisionId: readResponse.file.id
        }
      }
    );
    expect(staleWrite.status).toBe(409);
    expect(await staleWrite.json()).toMatchObject({ error: "revision-conflict" });

    const documentStateResponse = await api(
      accessToken,
      `/projects/${projectId}/collaboration/files/main.tex`
    );
    const staleDocumentReplace = await rawApi(
      accessToken,
      `/projects/${projectId}/collaboration/files/main.tex`,
      {
        method: "POST",
        body: {
          updateBase64: createReplaceDocumentUpdateBase64(
            documentStateResponse.state.stateUpdateBase64 as string,
            "Stale document replacement"
          ),
          expectedRevisionId: readResponse.file.id
        }
      }
    );
    expect(staleDocumentReplace.status).toBe(409);
    expect(await staleDocumentReplace.json()).toMatchObject({
      error: "revision-conflict"
    });

    const rereadResponse = await api(
      accessToken,
      `/projects/${projectId}/files/main.tex`
    );
    expect(rereadResponse.file.contents).toContain("Updated");

    const revisionsResponse = await api(
      accessToken,
      `/projects/${projectId}/file-revisions/main.tex`
    );
    expect(revisionsResponse.revisions).toEqual([
      expect.objectContaining({
        id: writeResponse.file.id,
        path: "main.tex",
        actorUserId: owner.user.id,
        byteLength: Buffer.byteLength(writeResponse.file.contents, "utf8")
      }),
      expect.objectContaining({
        id: readResponse.file.id,
        path: "main.tex",
        actorUserId: owner.user.id,
        byteLength: Buffer.byteLength(readResponse.file.contents, "utf8")
      })
    ]);
    expect(revisionsResponse.revisions[0]).not.toHaveProperty("contents");

    const oldRevisionResponse = await api(
      accessToken,
      `/projects/${projectId}/revisions/${readResponse.file.id}`
    );
    expect(oldRevisionResponse.revision.contents).toContain("Hi");

    const restoreResponse = await api(
      accessToken,
      `/projects/${projectId}/revisions/${readResponse.file.id}/restore`,
      { method: "POST" }
    );
    expect(restoreResponse.revision.id).not.toBe(readResponse.file.id);
    expect(restoreResponse.revision.contents).toBe(readResponse.file.contents);

    const restoredReadResponse = await api(
      accessToken,
      `/projects/${projectId}/files/main.tex`
    );
    expect(restoredReadResponse.file.id).toBe(restoreResponse.revision.id);
    expect(restoredReadResponse.file.contents).toContain("Hi");
  });

  it("stores base64 binary asset revisions for shared project caches", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString("base64");
    const createResponse = await api(owner.accessToken, "/projects", {
      method: "POST",
      body: {
        name: "Asset Paper",
        files: [
          {
            path: "figures/plot.png",
            contents: pngBase64,
            contentEncoding: "base64"
          }
        ]
      }
    });
    const projectId = createResponse.project.id as string;

    const readResponse = await api(
      owner.accessToken,
      `/projects/${projectId}/files/figures/plot.png`
    );

    expect(readResponse.file).toMatchObject({
      path: "figures/plot.png",
      contents: pngBase64,
      contentEncoding: "base64"
    });
  });

  it("keeps binary assets on whole-file APIs instead of realtime collaboration", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 3, 4, 5]).toString("base64");
    const createResponse = await api(owner.accessToken, "/projects", {
      method: "POST",
      body: {
        name: "Binary Collaboration Boundary",
        files: [
          {
            path: "figures/plot.png",
            contents: pngBase64,
            contentEncoding: "base64"
          }
        ]
      }
    });
    const projectId = createResponse.project.id as string;

    const documentState = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/collaboration/files/figures/plot.png`
    );
    expect(documentState.status).toBe(415);
    expect(await documentState.json()).toMatchObject({
      error: "unsupported-collaboration-path"
    });

    const documentUpdate = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/collaboration/files/figures/plot.png`,
      {
        method: "POST",
        body: {
          updateBase64: createStandaloneTextUpdateBase64("not image data")
        }
      }
    );
    expect(documentUpdate.status).toBe(415);
    expect(await documentUpdate.json()).toMatchObject({
      error: "unsupported-collaboration-path"
    });

    await expect(
      api(owner.accessToken, `/projects/${projectId}/files/figures/plot.png`)
    ).resolves.toMatchObject({
      file: {
        contents: pngBase64,
        contentEncoding: "base64"
      }
    });
  });

  it("exports latest shared source revisions for project owners only", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]).toString("base64");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Export Paper",
          directories: [{ path: "notes" }, { path: "figures" }],
          files: [
            { path: "main.tex", contents: "First" },
            {
              path: "figures/plot.png",
              contents: pngBase64,
              contentEncoding: "base64"
            }
          ]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });
    await api(editor.accessToken, `/projects/${projectId}/files/main.tex`, {
      method: "PUT",
      body: { contents: "Latest" }
    });

    const editorExport = await rawApi(
      editor.accessToken,
      `/projects/${projectId}/export/source`
    );
    expect(editorExport.status).toBe(403);

    const sourceExport = await api(
      owner.accessToken,
      `/projects/${projectId}/export/source`
    );

    expect(sourceExport.export.project).toMatchObject({
      id: projectId,
      name: "Export Paper"
    });
    expect(sourceExport.export.directories).toEqual([
      expect.objectContaining({ path: "figures" }),
      expect.objectContaining({ path: "notes" })
    ]);
    expect(sourceExport.export.files).toEqual([
      expect.objectContaining({
        path: "figures/plot.png",
        contents: pngBase64,
        contentEncoding: "base64"
      }),
      expect.objectContaining({
        path: "main.tex",
        contents: "Latest"
      })
    ]);
  });

  it("enforces invitation membership and editor/viewer permissions", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const viewer = await signIn("viewer@example.com", "Viewer");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Permissions Paper",
          files: [{ path: "main.tex", contents: "A" }]
        }
      })
    ).project.id as string;

    const editorInvitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    const viewerInvitation = await invite(
      owner.accessToken,
      projectId,
      "viewer@example.com",
      "viewer"
    );

    await api(editor.accessToken, `/invitations/${editorInvitation.id}/accept`, {
      method: "POST"
    });
    await api(viewer.accessToken, `/invitations/${viewerInvitation.id}/accept`, {
      method: "POST"
    });
    await expect(api(viewer.accessToken, "/projects")).resolves.toMatchObject({
      projects: [
        {
          id: projectId,
          role: "viewer"
        }
      ]
    });

    await api(editor.accessToken, `/projects/${projectId}/files/main.tex`, {
      method: "PUT",
      body: { contents: "Editor update" }
    });

    const viewerRead = await api(
      viewer.accessToken,
      `/projects/${projectId}/files/main.tex`
    );
    expect(viewerRead.file.contents).toBe("Editor update");

    const viewerWrite = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/files/main.tex`,
      {
        method: "PUT",
        body: { contents: "Viewer should fail" }
      }
    );
    expect(viewerWrite.status).toBe(403);
    expect(await viewerWrite.json()).toMatchObject({ error: "forbidden" });

    const viewerDelete = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/files/main.tex`,
      {
        method: "DELETE"
      }
    );
    expect(viewerDelete.status).toBe(403);
    expect(await viewerDelete.json()).toMatchObject({ error: "forbidden" });

    const viewerPatch = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/files/main.tex`,
      {
        method: "PATCH",
        body: { newName: "viewer-new.tex" }
      }
    );
    expect(viewerPatch.status).toBe(403);
    expect(await viewerPatch.json()).toMatchObject({ error: "forbidden" });

    const viewerCreate = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/files`,
      {
        method: "POST",
        body: { path: "viewer-new.tex", contents: "Viewer should fail" }
      }
    );
    expect(viewerCreate.status).toBe(403);
    expect(await viewerCreate.json()).toMatchObject({ error: "forbidden" });

    const editorRoleUpdate = await rawApi(
      editor.accessToken,
      `/projects/${projectId}/members/${viewer.user.id}`,
      {
        method: "PATCH",
        body: { role: "editor" }
      }
    );
    expect(editorRoleUpdate.status).toBe(403);

    const promotedViewer = await api(
      owner.accessToken,
      `/projects/${projectId}/members/${viewer.user.id}`,
      {
        method: "PATCH",
        body: { role: "editor" }
      }
    );
    expect(promotedViewer.member).toMatchObject({
      userId: viewer.user.id,
      role: "editor"
    });

    await api(viewer.accessToken, `/projects/${projectId}/files/main.tex`, {
      method: "PUT",
      body: { contents: "Promoted viewer update" }
    });

    const removedViewer = await api(
      owner.accessToken,
      `/projects/${projectId}/members/${viewer.user.id}`,
      { method: "DELETE" }
    );
    expect(removedViewer.member).toMatchObject({
      userId: viewer.user.id,
      role: "editor"
    });

    const removedViewerRead = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/files/main.tex`
    );
    expect(removedViewerRead.status).toBe(403);

    const ownerRemoval = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/members/${owner.user.id}`,
      { method: "DELETE" }
    );
    expect(ownerRemoval.status).toBe(400);
  });

  it("renames, moves, and deletes shared project entries over HTTP", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Path Ops Paper",
          files: [
            { path: "main.tex", contents: "Main" },
            { path: "sections/intro.tex", contents: "Intro" },
            { path: "sections/body.tex", contents: "Body" },
            { path: "appendix/raw.tex", contents: "Raw" }
          ],
          mainFilePath: "main.tex"
        }
      })
    ).project.id as string;

    const renamed = await api(
      owner.accessToken,
      `/projects/${projectId}/entries/rename`,
      {
        method: "POST",
        body: { path: "main.tex", newName: "paper.tex" }
      }
    );
    expect(renamed.files).toEqual([expect.objectContaining({ path: "paper.tex" })]);
    await expect(
      api(owner.accessToken, `/projects/${projectId}`)
    ).resolves.toMatchObject({
      project: expect.objectContaining({ mainFilePath: "paper.tex" })
    });

    await expect(
      api(owner.accessToken, `/projects/${projectId}/settings`, {
        method: "PATCH",
        body: { mainFilePath: "sections/body.tex" }
      })
    ).resolves.toMatchObject({
      project: expect.objectContaining({ mainFilePath: "sections/body.tex" })
    });

    const createdDirectory = await api(
      owner.accessToken,
      `/projects/${projectId}/directories/figures`,
      {
        method: "POST"
      }
    );
    expect(createdDirectory.directory).toMatchObject({ path: "figures" });

    const treeWithEmptyFolder = await api(
      owner.accessToken,
      `/projects/${projectId}/tree`
    );
    expect(JSON.stringify(treeWithEmptyFolder.tree)).toContain('"path":"figures"');

    await api(owner.accessToken, `/projects/${projectId}/entries/move`, {
      method: "POST",
      body: { path: "sections", newPath: "chapters" }
    });
    await api(owner.accessToken, `/projects/${projectId}/entries/move`, {
      method: "POST",
      body: { path: "figures", newPath: "assets/figures" }
    });

    const movedTree = await api(owner.accessToken, `/projects/${projectId}/tree`);
    expect(JSON.stringify(movedTree.tree)).toContain("chapters/intro.tex");
    expect(JSON.stringify(movedTree.tree)).toContain("assets/figures");
    expect(JSON.stringify(movedTree.tree)).not.toContain("sections/intro.tex");
    await expect(
      api(owner.accessToken, `/projects/${projectId}`)
    ).resolves.toMatchObject({
      project: expect.objectContaining({ mainFilePath: "chapters/body.tex" })
    });
    await expect(
      api(owner.accessToken, `/projects/${projectId}/files/chapters/body.tex`)
    ).resolves.toMatchObject({
      file: expect.objectContaining({ contents: "Body" })
    });

    const renamedFileAlias = await api(
      owner.accessToken,
      `/projects/${projectId}/files/chapters/intro.tex`,
      {
        method: "PATCH",
        body: { newName: "opening.tex" }
      }
    );
    expect(renamedFileAlias.files).toEqual([
      expect.objectContaining({ path: "chapters/opening.tex" })
    ]);
    const movedFileAlias = await api(
      owner.accessToken,
      `/projects/${projectId}/files/chapters/opening.tex`,
      {
        method: "PATCH",
        body: { newPath: "chapters/preface.tex" }
      }
    );
    expect(movedFileAlias.files).toEqual([
      expect.objectContaining({ path: "chapters/preface.tex" })
    ]);
    const patchedFileAliasRead = await api(
      owner.accessToken,
      `/projects/${projectId}/files/chapters/preface.tex`
    );
    expect(patchedFileAliasRead.file.contents).toBe("Intro");

    const createdFileAliasResponse = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/files`,
      {
        method: "POST",
        body: { path: "chapters/conclusion.tex", contents: "Conclusion" }
      }
    );
    expect(createdFileAliasResponse.status).toBe(201);
    await expect(createdFileAliasResponse.json()).resolves.toMatchObject({
      file: expect.objectContaining({
        path: "chapters/conclusion.tex",
        contents: "Conclusion"
      })
    });
    await expect(
      api(owner.accessToken, `/projects/${projectId}/files/chapters/conclusion.tex`)
    ).resolves.toMatchObject({
      file: expect.objectContaining({ contents: "Conclusion" })
    });
    const createConflictResponse = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/files`,
      {
        method: "POST",
        body: { path: "chapters/conclusion.tex", contents: "Overwrite?" }
      }
    );
    expect(createConflictResponse.status).toBe(409);
    expect(await createConflictResponse.json()).toMatchObject({ error: "conflict" });

    const deletedFileAlias = await api(
      owner.accessToken,
      `/projects/${projectId}/files/chapters/body.tex`,
      {
        method: "DELETE"
      }
    );
    expect(deletedFileAlias.deletedPaths).toEqual(["chapters/body.tex"]);
    const deletedFileAliasRead = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/files/chapters/body.tex`
    );
    expect(deletedFileAliasRead.status).toBe(404);
    const projectAfterMainDelete = await api(
      owner.accessToken,
      `/projects/${projectId}`
    );
    expect(projectAfterMainDelete.project).not.toHaveProperty("mainFilePath");

    const deleted = await api(
      owner.accessToken,
      `/projects/${projectId}/entries/delete`,
      {
        method: "POST",
        body: { path: "appendix" }
      }
    );
    expect(deleted.deletedPaths).toEqual(["appendix/raw.tex"]);
    const deletedEmptyFolder = await api(
      owner.accessToken,
      `/projects/${projectId}/entries/delete`,
      {
        method: "POST",
        body: { path: "assets" }
      }
    );
    expect(deletedEmptyFolder.deletedPaths).toEqual(["assets/figures"]);

    const deletedRead = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/files/appendix/raw.tex`
    );
    expect(deletedRead.status).toBe(404);
  });

  it("rejects project path traversal at the server boundary", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: { name: "Safe Paper" }
      })
    ).project.id as string;

    const response = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/files/%2e%2e%2fsecret.tex`,
      {
        method: "PUT",
        body: { contents: "nope" }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid-path" });
  });

  it("converges concurrent Yjs text updates from two collaborators", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Realtime Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });
    const initialState = (
      await api(
        owner.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex`
      )
    ).state as { readonly stateUpdateBase64: string };
    const initialFeed = (
      await api(
        owner.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex?updates=1`
      )
    ).feed as {
      readonly latestUpdateId: string;
      readonly updates: readonly { readonly id: string }[];
    };
    const ownerDoc = createDocFromState(initialState.stateUpdateBase64);
    const editorDoc = createDocFromState(initialState.stateUpdateBase64);
    const ownerBefore = Y.encodeStateVector(ownerDoc);
    const editorBefore = Y.encodeStateVector(editorDoc);

    expect(initialFeed.updates).toHaveLength(1);

    ownerDoc.getText("content").insert(4, " from owner");
    editorDoc.getText("content").insert(0, "Editor + ");

    await api(
      owner.accessToken,
      `/projects/${projectId}/collaboration/files/main.tex`,
      {
        method: "POST",
        body: {
          updateBase64: Buffer.from(
            Y.encodeStateAsUpdate(ownerDoc, ownerBefore)
          ).toString("base64")
        }
      }
    );
    const ownerUpdateFeed = (
      await api(
        owner.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex?updates=1&afterUpdateId=${initialFeed.latestUpdateId}`
      )
    ).feed as {
      readonly latestUpdateId: string;
      readonly updates: readonly { readonly id: string }[];
    };
    const editorUpdateResponse = await api(
      editor.accessToken,
      `/projects/${projectId}/collaboration/files/main.tex`,
      {
        method: "POST",
        body: {
          updateBase64: Buffer.from(
            Y.encodeStateAsUpdate(editorDoc, editorBefore)
          ).toString("base64")
        }
      }
    );

    expect(ownerUpdateFeed.updates).toHaveLength(1);
    expect(editorUpdateResponse.result.revision.contents).toContain("from owner");
    expect(editorUpdateResponse.result.revision.contents).toContain("Editor + ");
    const editorUpdateFeed = (
      await api(
        owner.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex?updates=1&afterUpdateId=${ownerUpdateFeed.latestUpdateId}`
      )
    ).feed as {
      readonly latestUpdateId: string;
      readonly updates: readonly { readonly id: string }[];
    };
    expect(editorUpdateFeed.updates).toHaveLength(1);

    const finalState = (
      await api(
        owner.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex`
      )
    ).state as { readonly stateUpdateBase64: string };
    const finalOwnerDoc = createDocFromState(finalState.stateUpdateBase64);
    const finalEditorDoc = createDocFromState(finalState.stateUpdateBase64);
    const finalContents = finalOwnerDoc.getText("content").toString();

    expect(finalEditorDoc.getText("content").toString()).toBe(finalContents);
    expect(finalContents).toContain("Base");
    expect(finalContents).toContain("from owner");
    expect(finalContents).toContain("Editor + ");

    const file = await api(owner.accessToken, `/projects/${projectId}/files/main.tex`);
    expect(file.file.contents).toBe(finalContents);
  });

  it("broadcasts authenticated realtime project events over WebSocket", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Realtime Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    await expect(openRealtime(projectId, "not-a-real-token")).rejects.toThrow();

    const ownerSocket = await openRealtime(projectId, owner.accessToken);
    const editorSocket = await openRealtime(projectId, editor.accessToken);

    try {
      const ownerPresenceEvent = nextRealtimeEvent(ownerSocket);
      const editorPresenceEvent = nextRealtimeEvent(editorSocket);
      await api(editor.accessToken, `/projects/${projectId}/presence`, {
        method: "PUT",
        body: { filePath: "main.tex", cursorLine: 2, cursorColumn: 4 }
      });

      await expect(ownerPresenceEvent).resolves.toMatchObject({
        type: "presence.updated",
        projectId,
        presence: {
          displayName: "Editor",
          filePath: "main.tex",
          cursorLine: 2,
          cursorColumn: 4
        }
      });
      await expect(editorPresenceEvent).resolves.toMatchObject({
        type: "presence.updated",
        projectId
      });

      const initialState = (
        await api(
          editor.accessToken,
          `/projects/${projectId}/collaboration/files/main.tex`
        )
      ).state as { readonly stateUpdateBase64: string };
      const doc = createDocFromState(initialState.stateUpdateBase64);
      const before = Y.encodeStateVector(doc);
      doc.getText("content").insert(4, " via socket");

      const ownerDocumentEvent = nextRealtimeEvent(ownerSocket);
      const editorDocumentEvent = nextRealtimeEvent(editorSocket);
      await api(
        editor.accessToken,
        `/projects/${projectId}/collaboration/files/main.tex`,
        {
          method: "POST",
          body: {
            updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString(
              "base64"
            )
          }
        }
      );

      await expect(ownerDocumentEvent).resolves.toMatchObject({
        type: "document.updated",
        projectId,
        path: "main.tex"
      });
      await expect(editorDocumentEvent).resolves.toMatchObject({
        type: "document.updated",
        projectId,
        path: "main.tex"
      });
    } finally {
      await Promise.allSettled([
        closeRealtime(ownerSocket),
        closeRealtime(editorSocket)
      ]);
    }
  });

  it("broadcasts applied agent changesets as collaborative document updates", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const viewer = await signIn("viewer@example.com", "Viewer");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Realtime Agent Paper",
          files: [{ path: "main.tex", contents: "Before" }]
        }
      })
    ).project.id as string;
    const editorInvitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${editorInvitation.id}/accept`, {
      method: "POST"
    });
    const viewerInvitation = await invite(
      owner.accessToken,
      projectId,
      "viewer@example.com",
      "viewer"
    );
    await api(viewer.accessToken, `/invitations/${viewerInvitation.id}/accept`, {
      method: "POST"
    });

    const viewerAgentRun = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/agent-runs`,
      {
        method: "POST",
        body: {
          providerId: "openai-codex",
          mode: "apply-with-review",
          prompt: "Viewer should not mutate shared files."
        }
      }
    );
    expect(viewerAgentRun.status).toBe(403);

    const agentRun = (
      await api(editor.accessToken, `/projects/${projectId}/agent-runs`, {
        method: "POST",
        body: {
          providerId: "openai-codex",
          mode: "apply-with-review",
          prompt: "Change Before to After."
        }
      })
    ).agentRun as { readonly id: string };
    const initialRevision = (
      await api(editor.accessToken, `/projects/${projectId}/files/main.tex`)
    ).file as { readonly id: string };
    const changeset = (
      await api(editor.accessToken, `/projects/${projectId}/changesets`, {
        method: "POST",
        body: {
          agentRunId: agentRun.id,
          filePath: "main.tex",
          beforeRevisionId: initialRevision.id,
          beforeContents: "Before",
          afterContents: "After",
          summary: "Replace placeholder text."
        }
      })
    ).changeset as { readonly id: string };

    const ownerSocket = await openRealtime(projectId, owner.accessToken);

    try {
      const events = await collectRealtimeEvents(ownerSocket, 3, async () => {
        await api(
          editor.accessToken,
          `/projects/${projectId}/changesets/${changeset.id}/apply`,
          { method: "POST" }
        );
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent.changeset.updated",
            projectId,
            changesetId: changeset.id,
            status: "applied"
          }),
          expect.objectContaining({
            type: "document.updated",
            projectId,
            path: "main.tex",
            revisionId: expect.any(String),
            updateId: expect.any(String)
          }),
          expect.objectContaining({
            type: "file.updated",
            projectId,
            path: "main.tex",
            revisionId: expect.any(String)
          })
        ])
      );
      await expect(
        api(owner.accessToken, `/projects/${projectId}/files/main.tex`)
      ).resolves.toMatchObject({
        file: {
          contents: "After"
        }
      });
    } finally {
      await closeRealtime(ownerSocket);
    }
  });

  it("only lets the originating editor attach compile artifacts to their agent run", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Agent Artifact Permissions Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    const sourceRevision = (
      await api(editor.accessToken, `/projects/${projectId}/files/main.tex`)
    ).file as { readonly id: string };
    const agentRun = (
      await api(editor.accessToken, `/projects/${projectId}/agent-runs`, {
        method: "POST",
        body: {
          providerId: "openai-codex",
          mode: "apply-with-review",
          prompt: "Fix the compile error."
        }
      })
    ).agentRun as { readonly id: string };
    const buildArtifact = (
      await api(editor.accessToken, `/projects/${projectId}/build-artifacts`, {
        method: "POST",
        body: {
          sourceRevisionId: sourceRevision.id,
          desktopClientId: "editor-desktop",
          compiler: "pdflatex",
          status: "succeeded",
          platform: process.platform,
          rawLog: "Compile succeeded"
        }
      })
    ).buildArtifact as { readonly id: string };

    const ownerAttach = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/agent-runs/${agentRun.id}/build-artifacts`,
      {
        method: "POST",
        body: { artifactId: buildArtifact.id }
      }
    );
    expect(ownerAttach.status).toBe(403);
    expect(await ownerAttach.json()).toMatchObject({ error: "forbidden" });

    const attached = await api(
      editor.accessToken,
      `/projects/${projectId}/agent-runs/${agentRun.id}/build-artifacts`,
      {
        method: "POST",
        body: { artifactId: buildArtifact.id }
      }
    );
    expect(attached.agentRun).toMatchObject({
      id: agentRun.id,
      actorUserId: editor.user.id,
      buildArtifactIds: [buildArtifact.id]
    });
    await expect(
      api(owner.accessToken, `/projects/${projectId}/audit-events`)
    ).resolves.toMatchObject({
      auditEvents: expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent.run.build-artifact.attached",
          agentRunId: agentRun.id,
          buildArtifactIds: [buildArtifact.id]
        })
      ])
    });
  });

  it("closes realtime sockets when project access is revoked", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Revoked Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    const editorSocket = await openRealtime(projectId, editor.accessToken);

    try {
      const closed = nextRealtimeClose(editorSocket);
      await api(owner.accessToken, `/projects/${projectId}/members/${editor.user.id}`, {
        method: "DELETE"
      });

      await expect(closed).resolves.toMatchObject({
        code: 4003,
        reason: "Project membership was removed."
      });
    } finally {
      await closeRealtime(editorSocket);
    }
  });

  it("broadcasts realtime membership changes as roles and ownership change", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Membership Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    const ownerSocket = await openRealtime(projectId, owner.accessToken);

    try {
      const joinedEvent = nextRealtimeEvent(ownerSocket);
      await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
        method: "POST"
      });
      await expect(joinedEvent).resolves.toMatchObject({
        type: "members.updated",
        projectId
      });

      const editorSocket = await openRealtime(projectId, editor.accessToken);

      try {
        const ownerRoleEvent = nextRealtimeEvent(ownerSocket);
        const editorRoleEvent = nextRealtimeEvent(editorSocket);
        await api(
          owner.accessToken,
          `/projects/${projectId}/members/${editor.user.id}`,
          {
            method: "PATCH",
            body: { role: "viewer" }
          }
        );

        await expect(ownerRoleEvent).resolves.toMatchObject({
          type: "members.updated",
          projectId
        });
        await expect(editorRoleEvent).resolves.toMatchObject({
          type: "members.updated",
          projectId
        });
        await expect(
          rawApi(editor.accessToken, `/projects/${projectId}/files/main.tex`, {
            method: "PUT",
            body: { contents: "Viewer socket should not keep edit access" }
          })
        ).resolves.toMatchObject({ status: 403 });

        const ownerTransferEvent = nextRealtimeEvent(ownerSocket);
        const editorTransferEvent = nextRealtimeEvent(editorSocket);
        await api(
          owner.accessToken,
          `/projects/${projectId}/members/${editor.user.id}/transfer-ownership`,
          { method: "POST" }
        );

        await expect(ownerTransferEvent).resolves.toMatchObject({
          type: "members.updated",
          projectId
        });
        await expect(editorTransferEvent).resolves.toMatchObject({
          type: "members.updated",
          projectId
        });

        const ownerClosed = nextRealtimeClose(ownerSocket);
        const editorRemovalEvent = nextRealtimeEvent(editorSocket);
        await api(
          editor.accessToken,
          `/projects/${projectId}/members/${owner.user.id}`,
          { method: "DELETE" }
        );

        await expect(ownerClosed).resolves.toMatchObject({
          code: 4003,
          reason: "Project membership was removed."
        });
        await expect(editorRemovalEvent).resolves.toMatchObject({
          type: "members.updated",
          projectId
        });
      } finally {
        await closeRealtime(editorSocket);
      }
    } finally {
      await closeRealtime(ownerSocket);
    }
  });

  it("closes realtime sockets when the project is deleted", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Deleted Socket Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const ownerSocket = await openRealtime(projectId, owner.accessToken);

    try {
      const closed = nextRealtimeClose(ownerSocket);
      await api(owner.accessToken, `/projects/${projectId}`, { method: "DELETE" });

      await expect(closed).resolves.toMatchObject({
        code: 4003,
        reason: "Project was deleted."
      });
    } finally {
      await closeRealtime(ownerSocket);
    }
  });

  it("tracks collaborator presence with server-side permission checks", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Presence Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    await api(owner.accessToken, `/projects/${projectId}/presence`, {
      method: "PUT",
      body: { filePath: "main.tex", cursorLine: 1, cursorColumn: 5 }
    });
    await api(editor.accessToken, `/projects/${projectId}/presence`, {
      method: "PUT",
      body: { filePath: "sections/intro.tex", cursorLine: 3, cursorColumn: 1 }
    });

    const presence = await api(owner.accessToken, `/projects/${projectId}/presence`);
    expect(presence.presence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Owner",
          filePath: "main.tex",
          cursorLine: 1,
          cursorColumn: 5
        }),
        expect.objectContaining({
          displayName: "Editor",
          filePath: "sections/intro.tex",
          cursorLine: 3,
          cursorColumn: 1
        })
      ])
    );

    const denied = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/presence`
    );
    expect(denied.status).toBe(403);
  });

  it("validates local build artifact evidence before storing it", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Artifact Validation Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const sourceRevision = (
      await api(owner.accessToken, `/projects/${projectId}/files/main.tex`)
    ).file as { readonly id: string };

    const invalidStatus = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/build-artifacts`,
      {
        method: "POST",
        body: {
          sourceRevisionId: sourceRevision.id,
          desktopClientId: "desktop-1",
          compiler: "pdflatex",
          status: "maybe",
          platform: process.platform,
          rawLog: ""
        }
      }
    );
    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.json()).toMatchObject({ error: "invalid-request" });

    const invalidDiagnostic = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/build-artifacts`,
      {
        method: "POST",
        body: {
          sourceRevisionId: sourceRevision.id,
          desktopClientId: "desktop-1",
          compiler: "pdflatex",
          status: "failed",
          platform: process.platform,
          rawLog: "bad compile",
          diagnostics: [{ severity: "notice", message: "not allowed" }]
        }
      }
    );
    expect(invalidDiagnostic.status).toBe(400);
    expect(await invalidDiagnostic.json()).toMatchObject({ error: "invalid-request" });

    const uploaded = await api(
      owner.accessToken,
      `/projects/${projectId}/build-artifacts`,
      {
        method: "POST",
        body: {
          sourceRevisionId: sourceRevision.id,
          desktopClientId: "desktop-1",
          compiler: "pdflatex",
          status: "failed",
          platform: process.platform,
          rawLog: "Missing brace",
          diagnostics: [
            {
              severity: "error",
              message: "Missing brace",
              filePath: "main.tex",
              line: 4
            }
          ]
        }
      }
    );
    expect(uploaded.buildArtifact).toMatchObject({
      status: "failed",
      rawLog: "Missing brace",
      diagnostics: [
        {
          severity: "error",
          message: "Missing brace",
          filePath: "main.tex",
          line: 4
        }
      ]
    });
    await expect(
      api(owner.accessToken, `/projects/${projectId}/build-artifacts`)
    ).resolves.toMatchObject({
      buildArtifacts: [expect.objectContaining({ id: uploaded.buildArtifact.id })]
    });
    await expect(
      api(
        owner.accessToken,
        `/projects/${projectId}/artifacts/${uploaded.buildArtifact.id}`
      )
    ).resolves.toMatchObject({
      buildArtifact: expect.objectContaining({
        id: uploaded.buildArtifact.id,
        rawLog: "Missing brace"
      })
    });

    const outsider = await signIn("outsider@example.com", "Outsider");
    const outsiderRead = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/artifacts/${uploaded.buildArtifact.id}`
    );
    expect(outsiderRead.status).toBe(403);
    expect(await outsiderRead.json()).toMatchObject({ error: "forbidden" });
  });

  it("lists durable project members with server-side permission checks", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Member Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    const members = await api(owner.accessToken, `/projects/${projectId}/members`);

    expect(members.members).toEqual([
      expect.objectContaining({
        email: "owner@example.com",
        name: "Owner",
        role: "owner"
      }),
      expect.objectContaining({
        email: "editor@example.com",
        name: "Editor",
        role: "editor"
      })
    ]);

    const denied = await rawApi(outsider.accessToken, `/projects/${projectId}/members`);
    expect(denied.status).toBe(403);
  });

  it("transfers project ownership to another member with server-side permission checks", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Transfer Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    const outsiderTransfer = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/members/${editor.user.id}/transfer-ownership`,
      { method: "POST" }
    );
    expect(outsiderTransfer.status).toBe(403);

    const transferred = await api(
      owner.accessToken,
      `/projects/${projectId}/members/${editor.user.id}/transfer-ownership`,
      { method: "POST" }
    );
    expect(transferred.members).toEqual([
      expect.objectContaining({
        userId: editor.user.id,
        email: "editor@example.com",
        role: "owner"
      }),
      expect.objectContaining({
        userId: owner.user.id,
        email: "owner@example.com",
        role: "editor"
      })
    ]);

    await expect(api(owner.accessToken, "/projects")).resolves.toMatchObject({
      projects: [
        {
          id: projectId,
          ownerUserId: editor.user.id,
          role: "editor"
        }
      ]
    });
    await expect(api(editor.accessToken, "/projects")).resolves.toMatchObject({
      projects: [
        {
          id: projectId,
          ownerUserId: editor.user.id,
          role: "owner"
        }
      ]
    });

    const oldOwnerInvite = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/invitations`,
      {
        method: "POST",
        body: { email: "new@example.com", role: "viewer" }
      }
    );
    expect(oldOwnerInvite.status).toBe(403);

    const selfTransfer = await rawApi(
      editor.accessToken,
      `/projects/${projectId}/members/${editor.user.id}/transfer-ownership`,
      { method: "POST" }
    );
    expect(selfTransfer.status).toBe(400);
  });

  it("lets only project owners delete the shared server copy and scoped data", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const editor = await signIn("editor@example.com", "Editor");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Deletion Paper",
          files: [{ path: "main.tex", contents: "Base" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "editor@example.com",
      "editor"
    );
    await api(editor.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });
    await api(editor.accessToken, `/projects/${projectId}/files/main.tex`, {
      method: "PUT",
      body: { contents: "Editor revision" }
    });
    await api(editor.accessToken, `/projects/${projectId}/presence`, {
      method: "PUT",
      body: { filePath: "main.tex", cursorLine: 2, cursorColumn: 4 }
    });

    const outsiderDelete = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}`,
      { method: "DELETE" }
    );
    expect(outsiderDelete.status).toBe(403);

    const editorDelete = await rawApi(editor.accessToken, `/projects/${projectId}`, {
      method: "DELETE"
    });
    expect(editorDelete.status).toBe(403);

    const deleted = await api(owner.accessToken, `/projects/${projectId}`, {
      method: "DELETE"
    });
    expect(deleted.project).toMatchObject({
      id: projectId,
      name: "Deletion Paper"
    });

    await expect(api(owner.accessToken, "/projects")).resolves.toMatchObject({
      projects: []
    });
    const deletedTree = await rawApi(owner.accessToken, `/projects/${projectId}/tree`);
    expect(deletedTree.status).toBe(404);
    const databaseJson = await readFile(
      join(sandboxPath, "db", "shared-projects.json"),
      "utf8"
    );
    expect(databaseJson).not.toContain(projectId);
  });

  it("lists project activity with server-side permission checks", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Activity Paper",
          files: [{ path: "main.tex", contents: "Before" }]
        }
      })
    ).project.id as string;

    await api(owner.accessToken, `/projects/${projectId}/files/main.tex`, {
      method: "PUT",
      body: { contents: "After" }
    });
    await api(owner.accessToken, `/projects/${projectId}/agent-runs`, {
      method: "POST",
      body: {
        providerId: "openai-codex",
        mode: "apply-with-review",
        prompt: "Fix the introduction.",
        status: "completed"
      }
    });

    const activity = await api(owner.accessToken, `/projects/${projectId}/activity`);
    expect(activity.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "project.created",
          message: "Created Activity Paper."
        }),
        expect.objectContaining({
          eventType: "file.updated",
          message: "Updated main.tex."
        }),
        expect.objectContaining({
          eventType: "agent.run.created",
          message: "Started openai-codex agent run."
        }),
        expect.objectContaining({
          eventType: "agent.run.completed",
          message: "Completed openai-codex agent run without compile artifacts."
        })
      ])
    );
    expect(activity.activity[0].createdAt >= activity.activity.at(-1).createdAt).toBe(
      true
    );

    const auditEvents = await api(
      owner.accessToken,
      `/projects/${projectId}/audit-events`
    );
    expect(auditEvents.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent.run.created",
          message: "Started openai-codex agent run."
        }),
        expect.objectContaining({
          eventType: "agent.run.completed",
          message: "Completed openai-codex agent run without compile artifacts."
        })
      ])
    );

    const denied = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/activity`
    );
    expect(denied.status).toBe(403);
    const deniedAudit = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/audit-events`
    );
    expect(deniedAudit.status).toBe(403);
  });

  it("restricts manually recorded audit evidence to editors and valid project artifacts", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const viewer = await signIn("viewer@example.com", "Viewer");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Audit Evidence Paper",
          files: [{ path: "main.tex", contents: "Before" }]
        }
      })
    ).project.id as string;
    const invitation = await invite(
      owner.accessToken,
      projectId,
      "viewer@example.com",
      "viewer"
    );
    await api(viewer.accessToken, `/invitations/${invitation.id}/accept`, {
      method: "POST"
    });

    const viewerAuditWrite = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/audit-events`,
      {
        method: "POST",
        body: {
          eventType: "agent.run.completed",
          message: "Viewer should not be able to forge shared audit evidence."
        }
      }
    );
    expect(viewerAuditWrite.status).toBe(403);

    const invalidAgentRunAudit = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/audit-events`,
      {
        method: "POST",
        body: {
          eventType: "agent.run.completed",
          message: "Invalid agent run reference.",
          agentRunId: "missing-agent-run"
        }
      }
    );
    expect(invalidAgentRunAudit.status).toBe(404);

    const sourceRevision = (
      await api(owner.accessToken, `/projects/${projectId}/files/main.tex`)
    ).file as { readonly id: string };
    const artifact = (
      await api(owner.accessToken, `/projects/${projectId}/build-artifacts`, {
        method: "POST",
        body: {
          sourceRevisionId: sourceRevision.id,
          desktopClientId: "owner-desktop",
          compiler: "pdflatex",
          status: "succeeded",
          platform: process.platform,
          rawLog: "Compile succeeded"
        }
      })
    ).buildArtifact as { readonly id: string };
    const agentRun = (
      await api(owner.accessToken, `/projects/${projectId}/agent-runs`, {
        method: "POST",
        body: {
          providerId: "openai-codex",
          mode: "apply-with-review",
          prompt: "Fix the introduction."
        }
      })
    ).agentRun as { readonly id: string };
    const changeset = (
      await api(owner.accessToken, `/projects/${projectId}/changesets`, {
        method: "POST",
        body: {
          agentRunId: agentRun.id,
          filePath: "main.tex",
          beforeRevisionId: sourceRevision.id,
          beforeContents: "Before",
          afterContents: "After",
          summary: "Replace placeholder."
        }
      })
    ).changeset as { readonly id: string };

    const validAudit = await api(
      owner.accessToken,
      `/projects/${projectId}/audit-events`,
      {
        method: "POST",
        body: {
          eventType: "agent.verification.passed",
          message: "Verified shared agent patch with local compile artifact.",
          agentRunId: agentRun.id,
          changesetId: changeset.id,
          buildArtifactIds: [artifact.id]
        }
      }
    );
    expect(validAudit.auditEvent).toMatchObject({
      eventType: "agent.verification.passed",
      actorUserId: owner.user.id,
      agentRunId: agentRun.id,
      changesetId: changeset.id,
      buildArtifactIds: [artifact.id]
    });
  });

  it("stores project comments with member-only access and resolve permissions", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const viewer = await signIn("viewer@example.com", "Viewer");
    const outsider = await signIn("outsider@example.com", "Outsider");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Comment Paper",
          files: [{ path: "main.tex", contents: "Draft" }]
        }
      })
    ).project.id as string;
    const invitation = await api(
      owner.accessToken,
      `/projects/${projectId}/invitations`,
      {
        method: "POST",
        body: { email: "viewer@example.com", role: "viewer" }
      }
    );
    await api(viewer.accessToken, `/invitations/${invitation.invitation.id}/accept`, {
      method: "POST"
    });

    const comment = await api(owner.accessToken, `/projects/${projectId}/comments`, {
      method: "POST",
      body: {
        body: "Please check the intro claim.",
        filePath: "main.tex",
        line: 1
      }
    });
    expect(comment.comment).toMatchObject({
      projectId,
      authorUserId: owner.user.id,
      body: "Please check the intro claim.",
      filePath: "main.tex",
      line: 1,
      resolved: false
    });

    const comments = await api(viewer.accessToken, `/projects/${projectId}/comments`);
    expect(comments.comments).toEqual([
      expect.objectContaining({
        id: comment.comment.id,
        body: "Please check the intro claim."
      })
    ]);

    const deniedResolve = await rawApi(
      viewer.accessToken,
      `/projects/${projectId}/comments/${comment.comment.id}/resolve`,
      { method: "POST" }
    );
    expect(deniedResolve.status).toBe(403);

    const resolved = await api(
      owner.accessToken,
      `/projects/${projectId}/comments/${comment.comment.id}/resolve`,
      { method: "POST" }
    );
    expect(resolved.comment).toMatchObject({
      id: comment.comment.id,
      resolved: true,
      resolvedByUserId: owner.user.id
    });

    const deniedList = await rawApi(
      outsider.accessToken,
      `/projects/${projectId}/comments`
    );
    expect(deniedList.status).toBe(403);
  });

  it("validates agent changeset review payloads before storing them", async () => {
    const owner = await signIn("owner@example.com", "Owner");
    const projectId = (
      await api(owner.accessToken, "/projects", {
        method: "POST",
        body: {
          name: "Changeset Validation Paper",
          files: [{ path: "main.tex", contents: "Before" }]
        }
      })
    ).project.id as string;
    const agentRun = (
      await api(owner.accessToken, `/projects/${projectId}/agent-runs`, {
        method: "POST",
        body: {
          providerId: "openai-codex",
          mode: "apply-with-review",
          prompt: "Validate changeset payloads."
        }
      })
    ).agentRun as { readonly id: string };

    const invalidContents = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/changesets`,
      {
        method: "POST",
        body: {
          agentRunId: agentRun.id,
          filePath: "main.tex",
          beforeContents: { text: "Before" },
          afterContents: "After",
          summary: "Invalid before contents."
        }
      }
    );
    expect(invalidContents.status).toBe(400);
    expect(await invalidContents.json()).toMatchObject({ error: "invalid-request" });

    const invalidAgentRun = await rawApi(
      owner.accessToken,
      `/projects/${projectId}/changesets`,
      {
        method: "POST",
        body: {
          agentRunId: { id: agentRun.id },
          filePath: "main.tex",
          beforeContents: "Before",
          afterContents: "After",
          summary: "Invalid agent run id."
        }
      }
    );
    expect(invalidAgentRun.status).toBe(400);
    expect(await invalidAgentRun.json()).toMatchObject({ error: "invalid-request" });

    const activity = await api(owner.accessToken, `/projects/${projectId}/activity`);
    expect(activity.activity).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "agent.changeset.proposed" })
      ])
    );
  });
});

function realtimeUrl(projectId: string, accessToken: string): string {
  const wsBaseUrl = baseUrl.replace(/^http:/, "ws:");
  return `${wsBaseUrl}/projects/${projectId}/realtime?accessToken=${encodeURIComponent(
    accessToken
  )}`;
}

async function openRealtime(
  projectId: string,
  accessToken: string
): Promise<WebSocket> {
  const socket = new WebSocket(realtimeUrl(projectId, accessToken));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for realtime socket to open.")),
      2000
    );

    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected realtime response ${response.statusCode}.`));
    });
  });

  return socket;
}

async function nextRealtimeEvent(
  socket: WebSocket
): Promise<SharedProjectRealtimeEvent> {
  return new Promise<SharedProjectRealtimeEvent>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for realtime event.")),
      2000
    );

    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as SharedProjectRealtimeEvent);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function collectRealtimeEvents(
  socket: WebSocket,
  expectedCount: number,
  action: () => Promise<void>
): Promise<readonly SharedProjectRealtimeEvent[]> {
  return new Promise<readonly SharedProjectRealtimeEvent[]>((resolve, reject) => {
    const events: SharedProjectRealtimeEvent[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for realtime events.")),
      2000
    );

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (data: Buffer): void => {
      events.push(JSON.parse(data.toString()) as SharedProjectRealtimeEvent);
      if (events.length === expectedCount) {
        cleanup();
        resolve(events);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    void action().catch((error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

async function nextRealtimeClose(
  socket: WebSocket
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise<{ readonly code: number; readonly reason: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for realtime socket to close.")),
        2000
      );

      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }
  );
}

async function closeRealtime(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

function createDocFromState(stateUpdateBase64: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(stateUpdateBase64, "base64")));
  return doc;
}

async function signIn(email: string, name: string): Promise<SignInResult> {
  const response = await fetch(`${baseUrl}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name })
  });

  expect(response.status).toBe(200);
  return (await response.json()) as SignInResult;
}

async function invite(
  accessToken: string,
  projectId: string,
  email: string,
  role: Exclude<SharedProjectRole, "owner">
): Promise<{ readonly id: string }> {
  const response = await api(accessToken, `/projects/${projectId}/invitations`, {
    method: "POST",
    body: { email, role }
  });

  return response.invitation as { readonly id: string };
}

async function api(
  accessToken: string,
  path: string,
  options: ApiOptions = {}
): Promise<Record<string, any>> {
  const response = await rawApi(accessToken, path, options);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as Record<string, any>;
}

async function rawApi(
  accessToken: string,
  path: string,
  options: ApiOptions = {}
): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    }
  };

  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  return fetch(`${baseUrl}${path}`, init);
}

type ApiOptions = {
  readonly method?: string;
  readonly body?: unknown;
};

function createReplaceDocumentUpdateBase64(
  stateUpdateBase64: string,
  contents: string
): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(stateUpdateBase64, "base64")));
  const stateVector = Y.encodeStateVector(doc);
  const text = doc.getText("content");
  text.delete(0, text.length);
  text.insert(0, contents);

  return Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)).toString("base64");
}

function createStandaloneTextUpdateBase64(contents: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, contents);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}
