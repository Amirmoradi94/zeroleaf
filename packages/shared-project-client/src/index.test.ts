import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import * as Y from "yjs";

import { runLatexBuild } from "@latex-agent/latex-service";
import {
  collectSharedProjectSourceFiles,
  exportSourceZip,
  importProjectZip
} from "@latex-agent/project-lifecycle-service";
import {
  SharedProjectService,
  SharedProjectStore,
  createSharedProjectHttpServer,
  type SharedProjectRealtimeEvent,
  type SignInResult
} from "@latex-agent/shared-project-server";
import { ProjectMetadataStore, listProjectTree } from "@latex-agent/project-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectGateway } from "../../project-service/src/project-gateway.js";
import {
  SharedProjectCache,
  SharedProjectClientError,
  SharedProjectDocumentSession,
  SharedProjectGatewayAdapter,
  SharedProjectHttpClient,
  readCacheFile
} from "./index.js";

let sandboxPath: string;
let server: ReturnType<typeof createSharedProjectHttpServer>;
let baseUrl: string;

beforeEach(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "zeroleaf-shared-client-"));
  const store = new SharedProjectStore(join(sandboxPath, "server", "db.json"));
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

describe("shared project client and cache", () => {
  it("materializes a server-backed project into a managed desktop cache", async () => {
    const refreshedSessions: SignInResult[] = [];
    const client = new SharedProjectHttpClient({
      baseUrl,
      onSessionRefreshed: (session) => {
        refreshedSessions.push(session);
      }
    });
    const signIn = await client.signIn("owner@example.com", "Owner");
    const initialAccessToken = signIn.accessToken;
    const initialRefreshToken = signIn.refreshToken;
    expect(signIn.refreshToken).toEqual(expect.any(String));
    expect(new Date(signIn.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(client.getSession()).resolves.toEqual(signIn.user);
    const staleClient = new SharedProjectHttpClient({
      baseUrl,
      accessToken: initialAccessToken
    });

    await expireServerAccessToken(initialAccessToken);
    await expect(client.getSession()).resolves.toEqual(signIn.user);
    expect(refreshedSessions).toHaveLength(1);
    const autoRefreshedSession = refreshedSessions[0]!;
    expect(autoRefreshedSession.accessToken).not.toBe(initialAccessToken);
    expect(autoRefreshedSession.refreshToken).not.toBe(initialRefreshToken);
    expect(refreshedSessions[0]).toMatchObject({ user: signIn.user });

    await expect(client.getSession()).resolves.toEqual(signIn.user);
    await expect(client.refreshSession(initialRefreshToken)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    });
    const refreshedSession = await client.refreshSession();
    expect(refreshedSession.accessToken).not.toBe(autoRefreshedSession.accessToken);
    expect(refreshedSession.refreshToken).not.toBe(autoRefreshedSession.refreshToken);
    expect(refreshedSessions).toHaveLength(2);
    expect(refreshedSessions[1]?.accessToken).toBe(refreshedSession.accessToken);
    expect(refreshedSessions[1]?.refreshToken).toBe(refreshedSession.refreshToken);
    expect(refreshedSession).toMatchObject({
      user: signIn.user
    });
    await expect(staleClient.getSession()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    });

    const signOutClient = new SharedProjectHttpClient({ baseUrl });
    const signOutSession = await signOutClient.signIn(
      "signout@example.com",
      "Sign Out"
    );
    await expect(signOutClient.signOut()).resolves.toEqual({ signedOut: true });
    await expect(
      signOutClient.refreshSession(signOutSession.refreshToken)
    ).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const project = await client.createProject({
      name: "Shared Paper",
      directories: [{ path: "notes" }],
      mainFilePath: "main.tex",
      compiler: "xelatex",
      files: [
        {
          path: "main.tex",
          contents: "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n"
        },
        {
          path: "sections/intro.tex",
          contents: "Intro"
        },
        {
          path: "figures/plot.png",
          contents: pngBytes.toString("base64"),
          contentEncoding: "base64"
        }
      ]
    });
    const cache = new SharedProjectCache(join(sandboxPath, "cache-root"));
    await expect(client.listProjects()).resolves.toContainEqual(
      expect.objectContaining({
        id: project.id,
        mainFilePath: "main.tex",
        compiler: "xelatex",
        role: "owner"
      })
    );
    await expect(client.getProject(project.id)).resolves.toMatchObject({
      mainFilePath: "main.tex",
      compiler: "xelatex"
    });
    await expect(
      client.updateProjectSettings(project.id, {
        mainFilePath: "sections/intro.tex",
        compiler: "lualatex"
      })
    ).resolves.toMatchObject({
      mainFilePath: "sections/intro.tex",
      compiler: "lualatex"
    });

    const result = await cache.materializeProject(client, project.id);

    expect(result.files.map((file) => file.path).sort()).toEqual([
      "figures/plot.png",
      "main.tex",
      "sections/intro.tex"
    ]);
    expect(result.directories).toEqual(["figures", "notes", "sections"]);
    await expect(readCacheFile(result.workingPath, "main.tex")).resolves.toContain(
      "Hi"
    );
    await expect(readCacheFile(result.workingPath, "sections/intro.tex")).resolves.toBe(
      "Intro"
    );
    await expect(
      readFile(join(result.workingPath, "figures", "plot.png"))
    ).resolves.toEqual(pngBytes);
    const notesStats = await stat(join(result.workingPath, "notes"));
    expect(notesStats.isDirectory()).toBe(true);

    const metadata = JSON.parse(
      await readFile(join(result.cachePath, "metadata.json"), "utf8")
    ) as {
      readonly projectId?: unknown;
      readonly directories?: readonly unknown[];
      readonly files?: readonly unknown[];
    };
    expect(metadata.projectId).toBe(project.id);
    expect(metadata.directories).toEqual(["figures", "notes", "sections"]);
    expect(metadata.files).toHaveLength(3);
    const mainRevisionId = result.files.find(
      (file) => file.path === "main.tex"
    )?.revisionId;
    expect(await cache.getCachedRevisionId(project.id, "main.tex")).toBe(
      mainRevisionId
    );
    await cache.recordFileRevision(project.id, "main.tex", "manual-revision");
    expect(await cache.getCachedRevisionId(project.id, "main.tex")).toBe(
      "manual-revision"
    );
    const updatedMain = await client.writeFile(
      project.id,
      "main.tex",
      "\\documentclass{article}\n\\begin{document}\nRevision two\n\\end{document}\n",
      mainRevisionId
    );
    await expect(client.listFileRevisions(project.id, "main.tex")).resolves.toEqual([
      expect.objectContaining({
        id: updatedMain.id,
        path: "main.tex",
        byteLength: Buffer.byteLength(updatedMain.contents, "utf8")
      }),
      expect.objectContaining({
        id: mainRevisionId,
        path: "main.tex"
      })
    ]);
    await expect(
      client.getFileRevision(project.id, mainRevisionId ?? "")
    ).resolves.toMatchObject({
      id: mainRevisionId,
      contents: expect.stringContaining("Hi")
    });
    const restoredMain = await client.restoreFileRevision(
      project.id,
      mainRevisionId ?? ""
    );
    expect(restoredMain.id).not.toBe(mainRevisionId);
    expect(restoredMain.contents).toContain("Hi");
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      id: restoredMain.id,
      contents: expect.stringContaining("Hi")
    });
    const introRevisionId = result.files.find(
      (file) => file.path === "sections/intro.tex"
    )?.revisionId;
    await cache.recordDirectory(project.id, "drafts");
    await cache.recordEntryMove(project.id, "sections", "chapters");
    expect(await cache.getCachedRevisionId(project.id, "chapters/intro.tex")).toBe(
      introRevisionId
    );
    await cache.recordEntryDelete(project.id, "chapters");
    expect(await cache.getCachedRevisionId(project.id, "chapters/intro.tex")).toBe(
      undefined
    );
    const updatedMetadata = JSON.parse(
      await readFile(join(result.cachePath, "metadata.json"), "utf8")
    ) as {
      readonly directories?: readonly unknown[];
    };
    expect(updatedMetadata.directories).toContain("drafts");
    expect(updatedMetadata.directories).not.toContain("chapters");
  });

  it("lists and revokes authenticated desktop sessions through the typed client", async () => {
    const firstDevice = new SharedProjectHttpClient({ baseUrl });
    const secondDevice = new SharedProjectHttpClient({ baseUrl });
    await firstDevice.signIn("owner@example.com", "Owner");
    await secondDevice.signIn("owner@example.com", "Owner");

    const sessions = await firstDevice.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current: true }),
        expect.objectContaining({ current: false })
      ])
    );

    const secondDeviceSession = sessions.find((session) => !session.current);
    expect(secondDeviceSession).toBeDefined();

    await expect(firstDevice.revokeSession(secondDeviceSession!.id)).resolves.toEqual({
      sessionId: secondDeviceSession!.id,
      revoked: true
    });
    await expect(secondDevice.getSession()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    });
    await expect(firstDevice.listSessions()).resolves.toEqual([
      expect.objectContaining({ current: true })
    ]);
  });

  it("refreshes the managed cache from later server revisions", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Shared Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });
    const cache = new SharedProjectCache(join(sandboxPath, "cache-root"));
    const first = await cache.materializeProject(client, project.id);

    await expect(readCacheFile(first.workingPath, "main.tex")).resolves.toBe("First");

    await client.writeFile(project.id, "main.tex", "Second");
    const second = await cache.materializeProject(client, project.id);

    await expect(readCacheFile(second.workingPath, "main.tex")).resolves.toBe("Second");
  });

  it("reopens the latest shared source from a separate desktop cache", async () => {
    const firstDesktop = new SharedProjectHttpClient({ baseUrl });
    const secondDesktop = new SharedProjectHttpClient({ baseUrl });
    await firstDesktop.signIn("owner@example.com", "Owner");
    await secondDesktop.signIn("owner@example.com", "Owner");
    const project = await firstDesktop.createProject({
      name: "Cross Device Paper",
      files: [{ path: "main.tex", contents: "Initial source" }]
    });
    const firstCache = new SharedProjectCache(join(sandboxPath, "first-cache-root"));
    const firstOpen = await firstCache.materializeProject(firstDesktop, project.id);

    await expect(readCacheFile(firstOpen.workingPath, "main.tex")).resolves.toBe(
      "Initial source"
    );

    await firstDesktop.writeFile(project.id, "main.tex", "Latest source");
    const secondCache = new SharedProjectCache(join(sandboxPath, "second-cache-root"));
    const secondOpen = await secondCache.materializeProject(secondDesktop, project.id);

    expect(secondOpen.workingPath).not.toBe(firstOpen.workingPath);
    await expect(readCacheFile(secondOpen.workingPath, "main.tex")).resolves.toBe(
      "Latest source"
    );
    await expect(
      secondCache.getCachedRevisionId(project.id, "main.tex")
    ).resolves.toBeDefined();
  });

  it("surfaces server permission failures through typed client errors", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    const project = await owner.createProject({
      name: "Shared Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });

    const outsider = new SharedProjectHttpClient({ baseUrl });
    await outsider.signIn("outsider@example.com", "Outsider");

    await expect(outsider.getTree(project.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
  });

  it("allows viewers to read collaborative documents but blocks text operations", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const viewer = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await viewer.signIn("viewer@example.com", "Viewer");
    const project = await owner.createProject({
      name: "Viewer Collaborative Paper",
      files: [{ path: "main.tex", contents: "Viewer can read" }]
    });
    const invitation = await owner.invite(project.id, "viewer@example.com", "viewer");
    await viewer.acceptInvitation(invitation.id);

    await expect(
      viewer.listDocumentUpdates(project.id, "main.tex")
    ).resolves.toMatchObject({
      state: {
        contents: "Viewer can read"
      }
    });
    await expect(
      viewer.applyDocumentTextOperations(project.id, "main.tex", [
        { rangeOffset: 0, rangeLength: 0, text: "Viewer should not edit " }
      ])
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Viewer can read"
    });
  });

  it("surfaces binary asset collaboration attempts as typed unsupported-path errors", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 6, 7, 8]).toString("base64");
    const project = await owner.createProject({
      name: "Binary Boundary Paper",
      files: [
        {
          path: "figures/plot.png",
          contents: pngBase64,
          contentEncoding: "base64"
        }
      ]
    });

    await expect(
      owner.getDocumentState(project.id, "figures/plot.png")
    ).rejects.toMatchObject({
      status: 415,
      code: "unsupported-collaboration-path"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      owner.applyDocumentTextOperations(project.id, "figures/plot.png", [
        { rangeOffset: 0, rangeLength: 0, text: "not image data" }
      ])
    ).rejects.toMatchObject({
      status: 415,
      code: "unsupported-collaboration-path"
    } satisfies Partial<SharedProjectClientError>);
    await expect(owner.readFile(project.id, "figures/plot.png")).resolves.toMatchObject(
      {
        contents: pngBase64,
        contentEncoding: "base64"
      }
    );
  });

  it("opens authenticated realtime sessions through the typed client", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const collaborator = new SharedProjectHttpClient({ baseUrl });
    const outsider = new SharedProjectHttpClient({ baseUrl });
    const ownerSession = await owner.signIn("owner@example.com", "Owner");
    await collaborator.signIn("collaborator@example.com", "Collaborator");
    await outsider.signIn("outsider@example.com", "Outsider");
    const project = await owner.createProject({
      name: "Realtime Client Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });
    const invitation = await owner.invite(
      project.id,
      "collaborator@example.com",
      "editor"
    );
    await collaborator.acceptInvitation(invitation.id);

    await expect(
      new SharedProjectHttpClient({ baseUrl }).openRealtimeSession(project.id)
    ).rejects.toMatchObject({
      status: 401,
      code: "unauthorized"
    } satisfies Partial<SharedProjectClientError>);
    await expect(outsider.openRealtimeSession(project.id)).rejects.toMatchObject({
      status: 403,
      code: "realtime-upgrade-failed"
    } satisfies Partial<SharedProjectClientError>);

    await expireServerAccessToken(ownerSession.accessToken);
    const realtimeEvent = createRealtimeEventPromise();
    const session = await owner.openRealtimeSession(project.id, {
      onEvent: realtimeEvent.resolve
    });
    const refreshedOwnerSession = await readServerSessionForUser(ownerSession.user.id);
    expect(refreshedOwnerSession.accessToken).not.toBe(ownerSession.accessToken);

    try {
      const restoredRefreshes: SignInResult[] = [];
      const restoredOwner = new SharedProjectHttpClient({
        baseUrl,
        refreshToken: refreshedOwnerSession.refreshToken,
        onSessionRefreshed: (session) => {
          restoredRefreshes.push(session);
        }
      });
      const restoredRealtimeSession = await restoredOwner.openRealtimeSession(
        project.id
      );
      await restoredRealtimeSession.close();
      expect(restoredRefreshes).toHaveLength(1);
      expect(restoredRefreshes[0]).toMatchObject({ user: ownerSession.user });
      expect(restoredRefreshes[0]?.accessToken).not.toBe(ownerSession.accessToken);
      expect(restoredRefreshes[0]?.refreshToken).not.toBe(
        refreshedOwnerSession.refreshToken
      );

      await collaborator.updatePresence(project.id, {
        filePath: "main.tex",
        cursorLine: 4,
        cursorColumn: 2
      });

      await expect(realtimeEvent.promise).resolves.toMatchObject({
        type: "presence.updated",
        projectId: project.id,
        presence: {
          displayName: "Collaborator",
          filePath: "main.tex",
          cursorLine: 4,
          cursorColumn: 2
        }
      });

      const signOutCloseEvent = createRealtimeClosePromise();
      const signedOutOwner = new SharedProjectHttpClient({ baseUrl });
      const signedOutOwnerSession = await signedOutOwner.signIn(
        "signedout@example.com",
        "Signed Out"
      );
      const signedOutProject = await signedOutOwner.createProject({
        name: "Signed Out Realtime Client Paper",
        files: [{ path: "main.tex", contents: "Base" }]
      });
      await signedOutOwner.openRealtimeSession(signedOutProject.id, {
        onClose: signOutCloseEvent.resolve
      });
      await signedOutOwner.signOut(signedOutOwnerSession.refreshToken);

      await expect(signOutCloseEvent.promise).resolves.toEqual({
        code: 4003,
        reason: "Session was revoked."
      });

      const closeEvent = createRealtimeClosePromise();
      const collaboratorRealtimeSession = await collaborator.openRealtimeSession(
        project.id,
        {
          onClose: closeEvent.resolve
        }
      );

      await collaboratorRealtimeSession.close();

      await expect(closeEvent.promise).resolves.toEqual(
        expect.objectContaining({
          code: expect.any(Number),
          reason: expect.any(String)
        })
      );
    } finally {
      await session.close();
    }
  });

  it("updates and removes project members through typed client calls", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const collaborator = new SharedProjectHttpClient({ baseUrl });
    const ownerSession = await owner.signIn("owner@example.com", "Owner");
    const collaboratorSession = await collaborator.signIn(
      "collaborator@example.com",
      "Collaborator"
    );
    const project = await owner.createProject({
      name: "Managed Members Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });
    const invitation = await owner.invite(
      project.id,
      "collaborator@example.com",
      "viewer"
    );
    await collaborator.acceptInvitation(invitation.id);

    await expect(
      collaborator.writeFile(project.id, "main.tex", "Blocked")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      collaborator.createFile(project.id, "viewer-created.tex", "Blocked")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      collaborator.renameFile(project.id, "main.tex", "viewer-renamed.tex")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      collaborator.moveFile(project.id, "main.tex", "viewer-moved.tex")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(collaborator.deleteFile(project.id, "main.tex")).rejects.toMatchObject(
      {
        status: 403,
        code: "forbidden"
      } satisfies Partial<SharedProjectClientError>
    );

    await expect(
      collaborator.updateMemberRole(project.id, collaboratorSession.user.id, "editor")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);

    await expect(
      owner.updateMemberRole(project.id, collaboratorSession.user.id, "editor")
    ).resolves.toMatchObject({
      userId: collaboratorSession.user.id,
      role: "editor"
    });
    const createdFile = await collaborator.createFile(
      project.id,
      "sections/created-by-editor.tex",
      "Created through the typed client"
    );
    expect(createdFile).toMatchObject({
      path: "sections/created-by-editor.tex",
      contents: "Created through the typed client"
    });
    await expect(
      collaborator.createFile(
        project.id,
        "sections/created-by-editor.tex",
        "Must not overwrite"
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict"
    } satisfies Partial<SharedProjectClientError>);
    await collaborator.writeFile(project.id, "main.tex", "Allowed");
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Allowed"
    });
    await expect(
      owner.readFile(project.id, "sections/created-by-editor.tex")
    ).resolves.toMatchObject({
      contents: "Created through the typed client"
    });
    await collaborator.createFile(
      project.id,
      "sections/file-route.tex",
      "File route contents"
    );
    await expect(
      collaborator.renameFile(
        project.id,
        "sections/file-route.tex",
        "file-route-renamed.tex"
      )
    ).resolves.toEqual([
      expect.objectContaining({ path: "sections/file-route-renamed.tex" })
    ]);
    await expect(
      collaborator.moveFile(
        project.id,
        "sections/file-route-renamed.tex",
        "file-route-moved.tex"
      )
    ).resolves.toEqual([expect.objectContaining({ path: "file-route-moved.tex" })]);
    await expect(
      owner.readFile(project.id, "file-route-moved.tex")
    ).resolves.toMatchObject({
      contents: "File route contents"
    });
    await expect(
      collaborator.deleteFile(project.id, "file-route-moved.tex")
    ).resolves.toEqual(["file-route-moved.tex"]);
    await expect(
      owner.readFile(project.id, "file-route-moved.tex")
    ).rejects.toMatchObject({
      status: 404,
      code: "not-found"
    } satisfies Partial<SharedProjectClientError>);

    await expect(
      owner.removeMember(project.id, collaboratorSession.user.id)
    ).resolves.toMatchObject({
      userId: collaboratorSession.user.id,
      role: "editor"
    });
    await expect(collaborator.getTree(project.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      owner.removeMember(project.id, ownerSession.user.id)
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid-member-removal"
    } satisfies Partial<SharedProjectClientError>);
  });

  it("transfers shared project ownership through the typed client", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const collaborator = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    const collaboratorSession = await collaborator.signIn(
      "collaborator@example.com",
      "Collaborator"
    );
    const project = await owner.createProject({
      name: "Transfer Client Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });
    const invitation = await owner.invite(
      project.id,
      "collaborator@example.com",
      "editor"
    );
    await collaborator.acceptInvitation(invitation.id);

    await expect(
      collaborator.transferOwnership(project.id, collaboratorSession.user.id)
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      owner.transferOwnership(project.id, collaboratorSession.user.id)
    ).resolves.toEqual([
      expect.objectContaining({
        userId: collaboratorSession.user.id,
        role: "owner"
      }),
      expect.objectContaining({
        email: "owner@example.com",
        role: "editor"
      })
    ]);
    await expect(
      owner.invite(project.id, "new@example.com", "viewer")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(collaborator.listProjects()).resolves.toEqual([
      expect.objectContaining({
        id: project.id,
        ownerUserId: collaboratorSession.user.id,
        role: "owner"
      })
    ]);
  });

  it("deletes shared projects through the typed HTTP client", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const collaborator = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await collaborator.signIn("collaborator@example.com", "Collaborator");
    const project = await owner.createProject({
      name: "Deleted Client Paper",
      files: [{ path: "main.tex", contents: "First" }]
    });
    const invitation = await owner.invite(
      project.id,
      "collaborator@example.com",
      "editor"
    );
    await collaborator.acceptInvitation(invitation.id);

    await expect(collaborator.deleteProject(project.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(owner.deleteProject(project.id)).resolves.toMatchObject({
      id: project.id,
      name: "Deleted Client Paper"
    });
    await expect(owner.listProjects()).resolves.toEqual([]);
    await expect(collaborator.getTree(project.id)).rejects.toMatchObject({
      status: 404,
      code: "not-found"
    } satisfies Partial<SharedProjectClientError>);
  });

  it("exports owner-only shared source snapshots through the typed HTTP client", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const collaborator = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await collaborator.signIn("collaborator@example.com", "Collaborator");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]).toString("base64");
    const project = await owner.createProject({
      name: "Export Client Paper",
      directories: [{ path: "notes" }, { path: "figures" }],
      files: [
        { path: "main.tex", contents: "First" },
        {
          path: "figures/plot.png",
          contents: pngBase64,
          contentEncoding: "base64"
        }
      ]
    });
    const invitation = await owner.invite(
      project.id,
      "collaborator@example.com",
      "editor"
    );
    await collaborator.acceptInvitation(invitation.id);
    await collaborator.writeFile(project.id, "main.tex", "Latest");

    await expect(collaborator.exportProjectSource(project.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(owner.exportProjectSource(project.id)).resolves.toMatchObject({
      project: { id: project.id, name: "Export Client Paper" },
      directories: [
        {
          path: "figures"
        },
        {
          path: "notes"
        }
      ],
      files: [
        {
          path: "figures/plot.png",
          contents: pngBase64,
          contentEncoding: "base64"
        },
        {
          path: "main.tex",
          contents: "Latest"
        }
      ]
    });
  });

  it("syncs whole-file edits through the shared project adapter into server and cache", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Gateway Paper",
      files: [
        { path: "main.tex", contents: "Before" },
        { path: "sections/intro.tex", contents: "Intro" },
        { path: "appendix/raw.tex", contents: "Raw" }
      ]
    });
    const cache = new SharedProjectCache(join(sandboxPath, "cache-root"));
    const adapter = new SharedProjectGatewayAdapter({
      client,
      cache,
      metadataStore: new ProjectMetadataStore(
        join(sandboxPath, "client", "project-metadata.json")
      )
    });
    const [handle] = await adapter.listRecentProjects();

    expect(handle).toMatchObject({
      backend: "shared",
      displayName: "Gateway Paper",
      sharedProjectId: project.id
    });

    if (handle === undefined) {
      throw new Error("Expected shared project handle.");
    }

    const opened = await adapter.openProject(handle);
    const openedHandle =
      opened.project.mainFilePath === undefined
        ? { ...handle, localCachePath: opened.project.rootPath }
        : {
            ...handle,
            localCachePath: opened.project.rootPath,
            mainFilePath: opened.project.mainFilePath
          };

    await expect(adapter.readFile(openedHandle, "main.tex")).resolves.toMatchObject({
      contents: "Before"
    });

    const initialDocumentFeed = await client.listDocumentUpdates(
      project.id,
      "main.tex"
    );
    await adapter.writeFile(openedHandle, "main.tex", "After");

    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "After"
    });
    await expect(
      client.listDocumentUpdates(
        project.id,
        "main.tex",
        initialDocumentFeed.latestUpdateId
      )
    ).resolves.toMatchObject({
      updates: [
        expect.objectContaining({
          path: "main.tex"
        })
      ],
      state: expect.objectContaining({
        contents: "After"
      })
    });

    await client.writeFile(project.id, "main.tex", "Remote newer revision");
    await expect(
      adapter.writeFile(openedHandle, "main.tex", "Stale local overwrite")
    ).rejects.toMatchObject({
      status: 409,
      code: "revision-conflict"
    } satisfies Partial<SharedProjectClientError>);
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Remote newer revision"
    });
    await cache.materializeProject(client, project.id);
    await adapter.writeFile(openedHandle, "main.tex", "After conflict refresh");
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "After conflict refresh"
    });

    await adapter.createEntry(openedHandle, ".", "figures", "directory");
    await expect(client.getTree(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: "figures" })
      ])
    );
    await adapter.createEntry(openedHandle, "figures", "notes.tex", "file");
    await expect(
      client.readFile(project.id, "figures/notes.tex")
    ).resolves.toMatchObject({
      contents: ""
    });
    await expect(
      adapter.createEntry(openedHandle, "figures", "notes.tex", "file")
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict"
    } satisfies Partial<SharedProjectClientError>);

    await adapter.renameEntry(openedHandle, "main.tex", "paper.tex");
    await expect(client.readFile(project.id, "paper.tex")).resolves.toMatchObject({
      contents: "After conflict refresh"
    });

    await adapter.moveEntry(openedHandle, "sections", "chapters");
    await expect(
      client.readFile(project.id, "chapters/intro.tex")
    ).resolves.toMatchObject({
      contents: "Intro"
    });

    await adapter.deleteEntry(openedHandle, "appendix");
    await expect(client.readFile(project.id, "appendix/raw.tex")).rejects.toMatchObject(
      {
        status: 404,
        code: "not-found"
      } satisfies Partial<SharedProjectClientError>
    );

    const refreshed = await cache.materializeProject(client, project.id);
    await expect(readCacheFile(refreshed.workingPath, "paper.tex")).resolves.toBe(
      "After conflict refresh"
    );
    await expect(listProjectTree(refreshed.workingPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: "figures" })
      ])
    );
    await expect(
      readCacheFile(refreshed.workingPath, "chapters/intro.tex")
    ).resolves.toBe("Intro");
  });

  it("routes shared project sessions through the project gateway adapter", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Gateway Routed Paper",
      mainFilePath: "sections/intro.tex",
      files: [
        { path: "main.tex", contents: "Gateway before" },
        { path: "sections/intro.tex", contents: "Intro through gateway" }
      ]
    });
    const gateway = new ProjectGateway([
      new SharedProjectGatewayAdapter({
        client,
        cache: new SharedProjectCache(join(sandboxPath, "gateway-cache-root")),
        metadataStore: new ProjectMetadataStore(
          join(sandboxPath, "gateway-client", "project-metadata.json")
        )
      })
    ]);
    const handles = await gateway.listRecentProjects();
    const handle = handles.find(
      (candidate) =>
        candidate.backend === "shared" && candidate.sharedProjectId === project.id
    );

    expect(handle).toMatchObject({
      backend: "shared",
      displayName: "Gateway Routed Paper",
      sharedProjectId: project.id,
      mainFilePath: "sections/intro.tex",
      syncState: "synced"
    });

    if (handle === undefined) {
      throw new Error("Expected shared project handle.");
    }

    const opened = await gateway.openProject(handle);

    expect(opened.project.mainFilePath).toBe("sections/intro.tex");
    expect(opened.session.handle).toMatchObject({
      backend: "shared",
      sharedProjectId: project.id,
      localCachePath: opened.project.rootPath
    });
    await expect(
      gateway.readFile(opened.session.id, "main.tex")
    ).resolves.toMatchObject({
      contents: "Gateway before"
    });

    const mainFileUpdate = await gateway.setMainFile(opened.session.id, "main.tex");

    expect(mainFileUpdate.project.mainFilePath).toBe("main.tex");
    await expect(client.getProject(project.id)).resolves.toMatchObject({
      mainFilePath: "main.tex"
    });

    const secondGateway = new ProjectGateway([
      new SharedProjectGatewayAdapter({
        client,
        cache: new SharedProjectCache(join(sandboxPath, "gateway-second-cache-root")),
        metadataStore: new ProjectMetadataStore(
          join(sandboxPath, "gateway-second-client", "project-metadata.json")
        )
      })
    ]);
    const secondHandle = (await secondGateway.listRecentProjects()).find(
      (candidate) =>
        candidate.backend === "shared" && candidate.sharedProjectId === project.id
    );

    expect(secondHandle).toMatchObject({
      backend: "shared",
      sharedProjectId: project.id,
      mainFilePath: "main.tex"
    });

    if (secondHandle === undefined) {
      throw new Error("Expected shared project handle on second desktop.");
    }

    const secondOpened = await secondGateway.openProject(secondHandle);

    expect(secondOpened.project.mainFilePath).toBe("main.tex");

    await gateway.renameEntry(opened.session.id, "main.tex", "paper.tex");
    await expect(client.getProject(project.id)).resolves.toMatchObject({
      mainFilePath: "paper.tex"
    });

    const renamedMainGateway = new ProjectGateway([
      new SharedProjectGatewayAdapter({
        client,
        cache: new SharedProjectCache(
          join(sandboxPath, "gateway-renamed-main-cache-root")
        ),
        metadataStore: new ProjectMetadataStore(
          join(sandboxPath, "gateway-renamed-main-client", "project-metadata.json")
        )
      })
    ]);
    const renamedMainHandle = (await renamedMainGateway.listRecentProjects()).find(
      (candidate) =>
        candidate.backend === "shared" && candidate.sharedProjectId === project.id
    );

    expect(renamedMainHandle).toMatchObject({
      backend: "shared",
      sharedProjectId: project.id,
      mainFilePath: "paper.tex"
    });

    if (renamedMainHandle === undefined) {
      throw new Error("Expected renamed main file handle on next desktop.");
    }

    const renamedMainOpened = await renamedMainGateway.openProject(renamedMainHandle);

    expect(renamedMainOpened.project.mainFilePath).toBe("paper.tex");

    await gateway.writeFile(opened.session.id, "paper.tex", "Gateway after");

    await expect(client.readFile(project.id, "paper.tex")).resolves.toMatchObject({
      contents: "Gateway after"
    });
    await expect(gateway.listFiles(opened.session.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: "paper.tex" }),
        expect.objectContaining({ kind: "directory", path: "sections" })
      ])
    );

    await gateway.deleteEntry(opened.session.id, "paper.tex");
    const projectAfterMainDelete = await client.getProject(project.id);

    expect(projectAfterMainDelete).not.toHaveProperty("mainFilePath");
  });

  it("imports a source ZIP into a shared project that another client can reopen", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const secondDevice = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await secondDevice.signIn("owner@example.com", "Owner");
    const localProjectPath = join(sandboxPath, "zip-source-paper");
    await mkdir(join(localProjectPath, "sections"), { recursive: true });
    await writeFile(
      join(localProjectPath, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nImported source\n\\input{sections/intro}\n\\end{document}\n",
      "utf8"
    );
    await writeFile(
      join(localProjectPath, "sections", "intro.tex"),
      "Intro from ZIP",
      "utf8"
    );
    await writeFile(join(localProjectPath, "main.aux"), "generated", "utf8");
    const archivePath = join(sandboxPath, "zip-source-paper.zip");
    await exportSourceZip({
      projectRoot: localProjectPath,
      destinationPath: archivePath
    });
    const importParentPath = join(sandboxPath, "zip-imports");
    await mkdir(importParentPath, { recursive: true });
    const imported = await importProjectZip({
      zipPath: archivePath,
      destinationParentPath: importParentPath,
      projectName: "shared-zip-paper"
    });
    const sourceFiles = await collectSharedProjectSourceFiles({
      projectRoot: imported.projectRoot
    });

    const sharedProject = await owner.createProject({
      name: "Shared ZIP Paper",
      directories: sourceFiles.directories,
      files: sourceFiles.files
    });

    expect(sourceFiles.files.map((file) => file.path).sort()).toEqual([
      "main.tex",
      "sections/intro.tex"
    ]);
    expect(sourceFiles.skippedFilePaths).toEqual([]);
    await expect(
      secondDevice.readFile(sharedProject.id, "main.tex")
    ).resolves.toMatchObject({
      contents: expect.stringContaining("Imported source")
    });
    await expect(
      secondDevice.readFile(sharedProject.id, "sections/intro.tex")
    ).resolves.toMatchObject({
      contents: "Intro from ZIP"
    });
    await expect(
      secondDevice.readFile(sharedProject.id, "main.aux")
    ).rejects.toMatchObject({
      status: 404,
      code: "not-found"
    } satisfies Partial<SharedProjectClientError>);
  });

  it("uploads a local latexmk build artifact for a materialized shared project", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Compiled Paper",
      files: [
        {
          path: "main.tex",
          contents: [
            "\\documentclass{article}",
            "\\begin{document}",
            "Compiled from the local desktop cache.",
            "\\end{document}",
            ""
          ].join("\n")
        }
      ]
    });
    const cache = new SharedProjectCache(join(sandboxPath, "cache-root"));
    const materialized = await cache.materializeProject(client, project.id);
    const sourceRevision = await client.readFile(project.id, "main.tex");

    const build = await runLatexBuild({
      projectRoot: materialized.workingPath,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });

    expect(build.status).toBe("succeeded");
    expect(build.artifact?.pdfPath).toBeDefined();
    const buildStatus = build.status;

    if (buildStatus === "running") {
      throw new Error("Completed build unexpectedly remained running.");
    }

    const pdfBytes = await readFile(build.artifact?.pdfPath ?? "");
    const uploaded = await client.uploadBuildArtifact(project.id, {
      sourceRevisionId: sourceRevision.id,
      desktopClientId: "desktop-client-test-1",
      compiler: build.compiler,
      engineVersion: "pdfTeX fake 1.0",
      latexmkVersion: "Latexmk fake 1.0",
      status: buildStatus,
      platform: process.platform,
      rawLog: build.rawLog,
      diagnostics: build.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
      })),
      pdfBase64: pdfBytes.toString("base64"),
      pdfByteLength: pdfBytes.byteLength
    });

    expect(uploaded.sourceRevisionId).toBe(sourceRevision.id);
    expect(uploaded.desktopClientId).toBe("desktop-client-test-1");
    expect(uploaded.status).toBe("succeeded");
    expect(uploaded.engineVersion).toBe("pdfTeX fake 1.0");
    expect(uploaded.latexmkVersion).toBe("Latexmk fake 1.0");
    expect(uploaded.pdfByteLength).toBeGreaterThan(0);

    const listed = await client.listBuildArtifacts(project.id);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: uploaded.id,
          desktopClientId: "desktop-client-test-1",
          engineVersion: "pdfTeX fake 1.0",
          latexmkVersion: "Latexmk fake 1.0"
        })
      ])
    );

    const fetched = await client.getBuildArtifact(project.id, uploaded.id);
    expect(fetched.pdfBase64).toBe(pdfBytes.toString("base64"));
    expect(fetched.desktopClientId).toBe("desktop-client-test-1");
    expect(fetched.engineVersion).toBe("pdfTeX fake 1.0");
    expect(fetched.latexmkVersion).toBe("Latexmk fake 1.0");

    const agentRun = await client.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Verify the local compile result.",
      status: "completed",
      buildArtifactIds: [uploaded.id]
    });
    expect(agentRun.buildArtifactIds).toEqual([uploaded.id]);

    const lateCompileRun = await client.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Attach compile result after approval.",
      status: "completed"
    });
    expect(lateCompileRun.buildArtifactIds).toEqual([]);
    const attachedRun = await client.attachBuildArtifactToAgentRun(
      project.id,
      lateCompileRun.id,
      { artifactId: uploaded.id }
    );
    expect(attachedRun.buildArtifactIds).toEqual([uploaded.id]);
    const duplicateAttachedRun = await client.attachBuildArtifactToAgentRun(
      project.id,
      lateCompileRun.id,
      { artifactId: uploaded.id }
    );
    expect(duplicateAttachedRun.buildArtifactIds).toEqual([uploaded.id]);
    expect(duplicateAttachedRun.updatedAt).toBe(attachedRun.updatedAt);
    await expect(client.listAgentRuns(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lateCompileRun.id,
          buildArtifactIds: [uploaded.id]
        })
      ])
    );

    const activity = await client.listActivity(project.id);
    expect(
      activity.filter(
        (event) => event.eventType === "agent.run.build-artifact.attached"
      )
    ).toHaveLength(1);
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "build-artifact.created",
          message: "Uploaded succeeded local pdflatex build artifact."
        }),
        expect.objectContaining({
          eventType: "agent.run.completed",
          message: "Completed openai-codex agent run with 1 compile artifact."
        }),
        expect.objectContaining({
          eventType: "agent.run.build-artifact.attached",
          message:
            "Attached succeeded pdflatex compile artifact to openai-codex agent run."
        })
      ])
    );

    const comment = await client.createComment(project.id, {
      body: "Please recheck this paragraph.",
      filePath: "main.tex",
      line: 1
    });
    expect(comment).toMatchObject({
      body: "Please recheck this paragraph.",
      filePath: "main.tex",
      line: 1,
      resolved: false
    });
    await expect(client.listComments(project.id)).resolves.toEqual([
      expect.objectContaining({
        id: comment.id,
        body: "Please recheck this paragraph."
      })
    ]);
    await expect(client.resolveComment(project.id, comment.id)).resolves.toMatchObject({
      id: comment.id,
      resolved: true
    });

    const auditEvents = await client.listAuditEvents(project.id);
    expect(
      auditEvents.filter(
        (event) => event.eventType === "agent.run.build-artifact.attached"
      )
    ).toHaveLength(1);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent.run.build-artifact.attached",
          agentRunId: lateCompileRun.id,
          buildArtifactIds: [uploaded.id]
        })
      ])
    );
  });

  it("surfaces invalid build artifact uploads as typed client errors", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Invalid Artifact Paper",
      files: [{ path: "main.tex", contents: "Base" }]
    });
    const sourceRevision = await client.readFile(project.id, "main.tex");

    await expect(
      client.uploadBuildArtifact(project.id, {
        sourceRevisionId: sourceRevision.id,
        desktopClientId: "desktop-client-test-1",
        compiler: "pdflatex",
        status: "not-a-build-status",
        platform: process.platform,
        rawLog: "",
        diagnostics: [{ severity: "notice", message: "not allowed" }]
      } as never)
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid-request"
    } satisfies Partial<SharedProjectClientError>);
    await expect(client.listBuildArtifacts(project.id)).resolves.toEqual([]);
  });

  it("lets viewers inspect shared build artifacts without uploading them", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const viewer = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await viewer.signIn("viewer@example.com", "Viewer");
    const project = await owner.createProject({
      name: "Viewer Artifact Paper",
      files: [{ path: "main.tex", contents: "Viewer artifact source" }]
    });
    const invitation = await owner.invite(project.id, "viewer@example.com", "viewer");
    await viewer.acceptInvitation(invitation.id);
    const sourceRevision = await owner.readFile(project.id, "main.tex");
    const uploaded = await owner.uploadBuildArtifact(project.id, {
      sourceRevisionId: sourceRevision.id,
      desktopClientId: "owner-desktop-1",
      compiler: "pdflatex",
      status: "failed",
      platform: process.platform,
      rawLog: "Viewer can inspect this failed compile.",
      diagnostics: [
        {
          severity: "error",
          message: "Undefined control sequence",
          filePath: "main.tex",
          line: 3
        }
      ]
    });

    await expect(viewer.listBuildArtifacts(project.id)).resolves.toEqual([
      expect.objectContaining({
        id: uploaded.id,
        sourceRevisionId: sourceRevision.id,
        desktopClientId: "owner-desktop-1",
        diagnostics: [
          expect.objectContaining({
            severity: "error",
            message: "Undefined control sequence"
          })
        ]
      })
    ]);
    await expect(
      viewer.getBuildArtifact(project.id, uploaded.id)
    ).resolves.toMatchObject({
      id: uploaded.id,
      rawLog: "Viewer can inspect this failed compile.",
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          message: "Undefined control sequence",
          filePath: "main.tex",
          line: 3
        })
      ]
    });
    await expect(
      viewer.uploadBuildArtifact(project.id, {
        sourceRevisionId: sourceRevision.id,
        desktopClientId: "viewer-desktop-1",
        compiler: "pdflatex",
        status: "failed",
        platform: process.platform,
        rawLog: "Viewer should not upload compile evidence.",
        diagnostics: []
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
  });

  it("lets an editor fix a shared compile error and publish collaborator-visible evidence", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const editor = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await editor.signIn("editor@example.com", "Editor");
    const brokenContents = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\undefinedzeroleafcommand",
      "\\end{document}",
      ""
    ].join("\n");
    const fixedContents = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Fixed by the editor's local agent run.",
      "\\end{document}",
      ""
    ].join("\n");
    const project = await owner.createProject({
      name: "Broken Shared Agent Paper",
      files: [{ path: "main.tex", contents: brokenContents }]
    });
    const invitation = await owner.invite(project.id, "editor@example.com", "editor");
    await editor.acceptInvitation(invitation.id);
    const cache = new SharedProjectCache(join(sandboxPath, "agent-fix-cache"));
    const brokenMaterialized = await cache.materializeProject(editor, project.id);
    const brokenBuild = await runLatexBuild({
      projectRoot: brokenMaterialized.workingPath,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });

    expect(brokenBuild.status).toBe("failed");

    const agentRun = await editor.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Fix the undefined command compile error in main.tex."
    });
    const brokenRevision = await editor.readFile(project.id, "main.tex");
    const changeset = await editor.createChangeSet(project.id, {
      agentRunId: agentRun.id,
      filePath: "main.tex",
      beforeRevisionId: brokenRevision.id,
      beforeContents: brokenContents,
      afterContents: fixedContents,
      summary: "Replace undefined command with valid document text."
    });
    const applied = await editor.applyChangeSet(project.id, changeset.id);

    expect(applied.status).toBe("applied");
    const fixedMaterialized = await cache.materializeProject(editor, project.id);
    const fixedBuild = await runLatexBuild({
      projectRoot: fixedMaterialized.workingPath,
      mainFilePath: "main.tex",
      compiler: "pdflatex",
      timeoutMs: 60_000
    });

    expect(fixedBuild.status).toBe("succeeded");
    expect(fixedBuild.artifact?.pdfPath).toBeDefined();
    const fixedBuildStatus = fixedBuild.status;

    if (fixedBuildStatus === "running") {
      throw new Error("Completed build unexpectedly remained running.");
    }

    const pdfBytes = await readFile(fixedBuild.artifact?.pdfPath ?? "");
    const fixedRevision = await editor.readFile(project.id, "main.tex");
    const uploaded = await editor.uploadBuildArtifact(project.id, {
      sourceRevisionId: fixedRevision.id,
      desktopClientId: "editor-desktop-agent-fix",
      compiler: fixedBuild.compiler,
      status: fixedBuildStatus,
      platform: process.platform,
      rawLog: fixedBuild.rawLog,
      diagnostics: fixedBuild.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
      })),
      pdfBase64: pdfBytes.toString("base64"),
      pdfByteLength: pdfBytes.byteLength
    });
    const runWithCompileEvidence = await editor.attachBuildArtifactToAgentRun(
      project.id,
      agentRun.id,
      { artifactId: uploaded.id }
    );

    expect(runWithCompileEvidence.buildArtifactIds).toEqual([uploaded.id]);
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: fixedContents
    });
    await expect(owner.listChangeSets(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: changeset.id,
          status: "applied",
          appliedRevisionId: fixedRevision.id
        })
      ])
    );
    await expect(owner.listAgentRuns(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentRun.id,
          status: "completed",
          changesetIds: [changeset.id],
          buildArtifactIds: [uploaded.id]
        })
      ])
    );
    await expect(owner.listAuditEvents(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent.run.created",
          agentRunId: agentRun.id
        }),
        expect.objectContaining({
          eventType: "agent.changeset.applied",
          agentRunId: agentRun.id,
          changesetId: changeset.id
        }),
        expect.objectContaining({
          eventType: "agent.run.build-artifact.attached",
          agentRunId: agentRun.id,
          buildArtifactIds: [uploaded.id]
        })
      ])
    );
    await expect(
      owner.getBuildArtifact(project.id, uploaded.id)
    ).resolves.toMatchObject({
      id: uploaded.id,
      sourceRevisionId: fixedRevision.id,
      status: "succeeded",
      pdfByteLength: pdfBytes.byteLength
    });
  });

  it("converges collaborative Yjs edits and presence through separate clients", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const editor = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await editor.signIn("editor@example.com", "Editor");
    const project = await owner.createProject({
      name: "Collaborative Paper",
      files: [{ path: "main.tex", contents: "Base" }]
    });
    const invitation = await owner.invite(project.id, "editor@example.com", "editor");
    await editor.acceptInvitation(invitation.id);
    const initialState = await owner.getDocumentState(project.id, "main.tex");
    const initialFeed = await owner.listDocumentUpdates(project.id, "main.tex");
    const ownerDoc = createDocFromState(initialState.stateUpdateBase64);
    const editorDoc = createDocFromState(initialState.stateUpdateBase64);
    const ownerBefore = Y.encodeStateVector(ownerDoc);
    const editorBefore = Y.encodeStateVector(editorDoc);

    expect(initialFeed.updates).toHaveLength(1);
    expect(initialFeed.latestUpdateId).toBe(initialFeed.updates[0]?.id);

    ownerDoc.getText("content").insert(4, " owner");
    editorDoc.getText("content").insert(0, "editor ");

    const ownerUpdate = await owner.applyDocumentUpdate(
      project.id,
      "main.tex",
      Buffer.from(Y.encodeStateAsUpdate(ownerDoc, ownerBefore)).toString("base64")
    );
    const ownerFeed = await editor.listDocumentUpdates(
      project.id,
      "main.tex",
      initialFeed.latestUpdateId
    );
    await editor.applyDocumentUpdate(
      project.id,
      "main.tex",
      Buffer.from(Y.encodeStateAsUpdate(editorDoc, editorBefore)).toString("base64")
    );
    const editorFeed = await owner.listDocumentUpdates(
      project.id,
      "main.tex",
      ownerUpdate.update.id
    );

    expect(ownerFeed.updates.map((update) => update.id)).toEqual([
      ownerUpdate.update.id
    ]);
    expect(editorFeed.updates).toHaveLength(1);
    const finalState = await owner.getDocumentState(project.id, "main.tex");
    const finalDoc = createDocFromState(finalState.stateUpdateBase64);
    const finalContents = finalDoc.getText("content").toString();

    expect(finalContents).toContain("Base");
    expect(finalContents).toContain("owner");
    expect(finalContents).toContain("editor");

    await owner.updatePresence(project.id, {
      filePath: "main.tex",
      cursorLine: 1,
      cursorColumn: 3
    });
    await editor.updatePresence(project.id, {
      filePath: "main.tex",
      cursorLine: 1,
      cursorColumn: 9
    });

    await expect(owner.listMembers(project.id)).resolves.toEqual([
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
    await expect(owner.listPresence(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "Owner", cursorColumn: 3 }),
        expect.objectContaining({ displayName: "Editor", cursorColumn: 9 })
      ])
    );
  });

  it("replaces document contents through a Yjs collaboration update", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Collaborative Replace",
      files: [{ path: "main.tex", contents: "Before" }]
    });
    const initialRevision = await client.readFile(project.id, "main.tex");

    const result = await client.replaceDocumentContents(
      project.id,
      "main.tex",
      "After",
      initialRevision.id
    );

    expect(result.state.contents).toBe("After");
    expect(result.revision.contents).toBe("After");
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "After"
    });
  });

  it("rejects stale whole-document replacements", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Stale Collaborative Replace",
      files: [{ path: "main.tex", contents: "Before" }]
    });
    const initialRevision = await client.readFile(project.id, "main.tex");
    await client.writeFile(project.id, "main.tex", "Remote newer revision");

    await expect(
      client.replaceDocumentContents(
        project.id,
        "main.tex",
        "Stale replacement",
        initialRevision.id
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "revision-conflict"
    } satisfies Partial<SharedProjectClientError>);
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Remote newer revision"
    });
  });

  it("applies Monaco-style text operations as Yjs collaboration updates", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Collaborative Text Operation",
      files: [{ path: "main.tex", contents: "Hello world" }]
    });

    const result = await client.applyDocumentTextOperations(project.id, "main.tex", [
      { rangeOffset: 6, rangeLength: 5, text: "ZeroLeaf" }
    ]);

    expect(result.state.contents).toBe("Hello ZeroLeaf");
    expect(result.revision.contents).toBe("Hello ZeroLeaf");
    expect(result.update.updateBase64.length).toBeGreaterThan(0);
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Hello ZeroLeaf"
    });
  });

  it("deduplicates retried text operations by client operation id", async () => {
    const client = new SharedProjectHttpClient({ baseUrl });
    await client.signIn("owner@example.com", "Owner");
    const project = await client.createProject({
      name: "Retried Text Operation",
      files: [{ path: "main.tex", contents: "Hello" }]
    });
    const operation = { rangeOffset: 5, rangeLength: 0, text: " ZeroLeaf" };

    await client.applyDocumentTextOperations(
      project.id,
      "main.tex",
      [operation],
      "retry-operation-1"
    );
    const retried = await client.applyDocumentTextOperations(
      project.id,
      "main.tex",
      [operation],
      "retry-operation-1"
    );

    expect(retried.state.contents).toBe("Hello ZeroLeaf");
    await expect(client.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Hello ZeroLeaf"
    });
  });

  it("keeps a shared document session cursor across local edits and remote pulls", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const editor = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await editor.signIn("editor@example.com", "Editor");
    const project = await owner.createProject({
      name: "Session Paper",
      files: [{ path: "main.tex", contents: "Base" }]
    });
    const invitation = await owner.invite(project.id, "editor@example.com", "editor");
    await editor.acceptInvitation(invitation.id);
    const ownerSession = await SharedProjectDocumentSession.open(
      owner,
      project.id,
      "main.tex"
    );
    const editorSession = await SharedProjectDocumentSession.open(
      editor,
      project.id,
      "main.tex"
    );
    const initialOwnerCursor = ownerSession.updateCursor;

    await ownerSession.applyTextOperations([
      { rangeOffset: 4, rangeLength: 0, text: " owner" }
    ]);
    const editorPull = await editorSession.pullRemoteUpdates();
    await editorSession.applyTextOperations([
      { rangeOffset: 0, rangeLength: 0, text: "editor " }
    ]);
    await ownerSession.pullRemoteUpdates();
    const reconnectSession = await SharedProjectDocumentSession.open(
      owner,
      project.id,
      "main.tex"
    );
    const reconnectPull = await reconnectSession.pullRemoteUpdates(initialOwnerCursor);

    expect(ownerSession.updateCursor).not.toBe(initialOwnerCursor);
    expect(editorPull.updates).toHaveLength(1);
    expect(reconnectPull.updates.map((update) => update.id)).not.toContain(
      initialOwnerCursor
    );
    expect(reconnectPull.updates).toHaveLength(2);
    expect(editorSession.contents).toContain("owner");
    expect(ownerSession.contents).toBe(editorSession.contents);
    expect(reconnectSession.contents).toBe(ownerSession.contents);
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: ownerSession.contents
    });
  });

  it("converges shared document sessions that edit from the same base", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const editor = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await editor.signIn("editor@example.com", "Editor");
    const project = await owner.createProject({
      name: "Concurrent Session Paper",
      files: [{ path: "main.tex", contents: "Base" }]
    });
    const invitation = await owner.invite(project.id, "editor@example.com", "editor");
    await editor.acceptInvitation(invitation.id);
    const ownerSession = await SharedProjectDocumentSession.open(
      owner,
      project.id,
      "main.tex"
    );
    const editorSession = await SharedProjectDocumentSession.open(
      editor,
      project.id,
      "main.tex"
    );
    const initialCursor = ownerSession.updateCursor;

    const ownerResult = await ownerSession.applyTextOperations(
      [{ rangeOffset: 4, rangeLength: 0, text: " owner" }],
      "owner-concurrent-edit"
    );
    const editorResult = await editorSession.applyTextOperations(
      [{ rangeOffset: 0, rangeLength: 0, text: "editor " }],
      "editor-concurrent-edit"
    );
    const ownerCatchUp = await ownerSession.pullRemoteUpdates(ownerResult.update.id);
    const reconnectSession = await SharedProjectDocumentSession.open(
      owner,
      project.id,
      "main.tex"
    );
    const reconnectCatchUp = await reconnectSession.pullRemoteUpdates(initialCursor);

    expect(editorResult.state.contents).toContain("owner");
    expect(editorResult.state.contents).toContain("editor");
    expect(ownerCatchUp.updates.map((update) => update.id)).toEqual([
      editorResult.update.id
    ]);
    expect(reconnectCatchUp.updates).toHaveLength(2);
    expect(ownerSession.contents).toBe(editorSession.contents);
    expect(reconnectSession.contents).toBe(ownerSession.contents);
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: ownerSession.contents
    });
  });

  it("records shared agent runs and applies reviewable changesets", async () => {
    const owner = new SharedProjectHttpClient({ baseUrl });
    const viewer = new SharedProjectHttpClient({ baseUrl });
    const outsider = new SharedProjectHttpClient({ baseUrl });
    await owner.signIn("owner@example.com", "Owner");
    await viewer.signIn("viewer@example.com", "Viewer");
    await outsider.signIn("outsider@example.com", "Outsider");
    const project = await owner.createProject({
      name: "Agent Paper",
      files: [{ path: "main.tex", contents: "Before" }]
    });
    const viewerInvitation = await owner.invite(
      project.id,
      "viewer@example.com",
      "viewer"
    );
    await viewer.acceptInvitation(viewerInvitation.id);

    const agentRun = await owner.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Change Before to After."
    });
    const liveRun = await owner.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Show collaborators that an agent is running.",
      status: "running"
    });
    expect(liveRun.status).toBe("running");
    const completedLiveRun = await owner.updateAgentRunStatus(project.id, liveRun.id, {
      status: "completed"
    });
    expect(completedLiveRun.status).toBe("completed");
    const duplicateCompletedLiveRun = await owner.updateAgentRunStatus(
      project.id,
      liveRun.id,
      { status: "completed" }
    );
    expect(duplicateCompletedLiveRun.updatedAt).toBe(completedLiveRun.updatedAt);
    const initialRevision = await owner.readFile(project.id, "main.tex");
    await expect(
      owner.createChangeSet(project.id, {
        agentRunId: agentRun.id,
        filePath: "main.tex",
        beforeRevisionId: initialRevision.id,
        beforeContents: { text: "Before" },
        afterContents: "After",
        summary: "Invalid before contents."
      } as never)
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid-request"
    } satisfies Partial<SharedProjectClientError>);
    await expect(owner.listChangeSets(project.id)).resolves.toEqual([]);

    const changeset = await owner.createChangeSet(project.id, {
      agentRunId: agentRun.id,
      filePath: "main.tex",
      beforeRevisionId: initialRevision.id,
      beforeContents: "Before",
      afterContents: "After",
      summary: "Replace placeholder text."
    });

    expect(changeset.status).toBe("proposed");
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "Before"
    });
    const preApplyFeed = await owner.listDocumentUpdates(project.id, "main.tex");

    const applied = await owner.applyChangeSet(project.id, changeset.id);

    expect(applied.status).toBe("applied");
    expect(applied.appliedRevisionId).toBeDefined();
    const appliedFeed = await owner.listDocumentUpdates(
      project.id,
      "main.tex",
      preApplyFeed.latestUpdateId
    );
    expect(appliedFeed.state.contents).toBe("After");
    expect(appliedFeed.updates).toHaveLength(1);
    const collaboratorDoc = createDocFromState(preApplyFeed.state.stateUpdateBase64);
    for (const update of appliedFeed.updates) {
      Y.applyUpdate(
        collaboratorDoc,
        Uint8Array.from(Buffer.from(update.updateBase64, "base64"))
      );
    }
    expect(collaboratorDoc.getText("content").toString()).toBe("After");
    await expect(owner.readFile(project.id, "main.tex")).resolves.toMatchObject({
      contents: "After"
    });

    await expect(owner.listAgentRuns(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentRun.id,
          status: "completed",
          changesetIds: [changeset.id]
        }),
        expect.objectContaining({
          id: liveRun.id,
          status: "completed"
        })
      ])
    );
    await expect(owner.listChangeSets(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: changeset.id,
          status: "applied"
        })
      ])
    );
    await expect(owner.listAuditEvents(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "agent.run.created",
          agentRunId: agentRun.id
        }),
        expect.objectContaining({
          eventType: "agent.run.completed",
          agentRunId: liveRun.id
        }),
        expect.objectContaining({
          eventType: "agent.changeset.proposed",
          agentRunId: agentRun.id,
          changesetId: changeset.id
        }),
        expect.objectContaining({
          eventType: "agent.changeset.applied",
          agentRunId: agentRun.id,
          changesetId: changeset.id
        })
      ])
    );
    const toolAudit = await owner.recordAuditEvent(project.id, {
      eventType: "agent.tool.started",
      message: "read-file (low risk)",
      agentRunId: agentRun.id
    });
    expect(toolAudit).toMatchObject({
      projectId: project.id,
      eventType: "agent.tool.started",
      message: "read-file (low risk)",
      agentRunId: agentRun.id
    });
    await expect(owner.listAuditEvents(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: toolAudit.id,
          eventType: "agent.tool.started"
        })
      ])
    );
    await expect(
      viewer.recordAuditEvent(project.id, {
        eventType: "agent.tool.started",
        message: "Viewer should not forge collaborator-visible audit evidence."
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      owner.recordAuditEvent(project.id, {
        eventType: "agent.tool.started",
        message: "Missing agent run reference should be rejected.",
        agentRunId: "missing-agent-run"
      })
    ).rejects.toMatchObject({
      status: 404,
      code: "not-found"
    } satisfies Partial<SharedProjectClientError>);

    const alreadySyncedRun = await owner.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Record already-synced shared state."
    });
    const alreadySyncedChangeSet = await owner.createChangeSet(project.id, {
      agentRunId: alreadySyncedRun.id,
      filePath: "main.tex",
      beforeContents: "Before",
      afterContents: "After",
      summary: "Record already synced text."
    });
    const idempotentApplied = await owner.applyChangeSet(
      project.id,
      alreadySyncedChangeSet.id
    );
    expect(idempotentApplied.status).toBe("applied");
    expect(idempotentApplied.appliedRevisionId).toBe(applied.appliedRevisionId);

    const staleBaseRun = await owner.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Do not apply over a newer same-content revision."
    });
    const staleBaseRevision = await owner.writeFile(project.id, "main.tex", "Before");
    const staleBaseChangeSet = await owner.createChangeSet(project.id, {
      agentRunId: staleBaseRun.id,
      filePath: "main.tex",
      beforeRevisionId: staleBaseRevision.id,
      beforeContents: "Before",
      afterContents: "Stale after",
      summary: "Stale revision anchored change."
    });
    await owner.writeFile(project.id, "main.tex", "Before");
    await expect(
      owner.applyChangeSet(project.id, staleBaseChangeSet.id)
    ).rejects.toMatchObject({
      status: 409,
      code: "changeset-conflict"
    } satisfies Partial<SharedProjectClientError>);

    const rejectedRun = await owner.createAgentRun(project.id, {
      providerId: "openai-codex",
      mode: "apply-with-review",
      prompt: "Reject a suggested change."
    });
    const rejectedChangeSet = await owner.createChangeSet(project.id, {
      agentRunId: rejectedRun.id,
      filePath: "main.tex",
      beforeContents: "After",
      afterContents: "Nope",
      summary: "Rejected text."
    });
    const rejected = await owner.rejectChangeSet(project.id, rejectedChangeSet.id);
    expect(rejected.status).toBe("rejected");
    await expect(owner.listAgentRuns(project.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rejectedRun.id,
          status: "cancelled"
        })
      ])
    );

    await expect(
      outsider.createAgentRun(project.id, {
        providerId: "openai-codex",
        mode: "apply-with-review",
        prompt: "Try to edit."
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      outsider.updateAgentRunStatus(project.id, agentRun.id, {
        status: "failed"
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(outsider.listAuditEvents(project.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
    await expect(
      outsider.recordAuditEvent(project.id, {
        eventType: "agent.tool.started",
        message: "Try to forge an audit event."
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    } satisfies Partial<SharedProjectClientError>);
  });
});

async function expireServerAccessToken(accessToken: string): Promise<void> {
  const databasePath = join(sandboxPath, "server", "db.json");
  const database = JSON.parse(await readFile(databasePath, "utf8")) as {
    readonly sessions?: readonly Record<string, unknown>[];
  };

  await writeFile(
    databasePath,
    JSON.stringify(
      {
        ...database,
        sessions: (database.sessions ?? []).map((session) =>
          session.accessToken === accessToken
            ? { ...session, accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" }
            : session
        )
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readServerSessionForUser(userId: string): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string;
}> {
  const database = JSON.parse(
    await readFile(join(sandboxPath, "server", "db.json"), "utf8")
  ) as {
    readonly sessions?: readonly {
      readonly userId?: unknown;
      readonly accessToken?: unknown;
      readonly refreshToken?: unknown;
    }[];
  };
  const session = database.sessions?.find((candidate) => candidate.userId === userId);

  if (
    typeof session?.accessToken !== "string" ||
    typeof session.refreshToken !== "string"
  ) {
    throw new Error("Expected refreshed shared project session in server store.");
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken
  };
}

function createDocFromState(stateUpdateBase64: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(stateUpdateBase64, "base64")));
  return doc;
}

function createRealtimeEventPromise(): {
  readonly promise: Promise<SharedProjectRealtimeEvent>;
  readonly resolve: (event: SharedProjectRealtimeEvent) => void;
} {
  let resolveEvent: (event: SharedProjectRealtimeEvent) => void = () => undefined;
  const promise = new Promise<SharedProjectRealtimeEvent>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for realtime event.")),
      2000
    );
    resolveEvent = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
  });

  return { promise, resolve: resolveEvent };
}

function createRealtimeClosePromise(): {
  readonly promise: Promise<{ readonly code: number; readonly reason: string }>;
  readonly resolve: (event: { readonly code: number; readonly reason: string }) => void;
} {
  let resolveClose: (event: {
    readonly code: number;
    readonly reason: string;
  }) => void = () => undefined;
  const promise = new Promise<{ readonly code: number; readonly reason: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for realtime close.")),
        2000
      );
      resolveClose = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    }
  );

  return { promise, resolve: resolveClose };
}
