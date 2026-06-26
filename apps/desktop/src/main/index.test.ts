import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectChangeDebouncer } from "./projectWatcher.js";

describe("desktop main process project watcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid external file changes into one project.changed event", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify("figures/results.pdf");
    vi.advanceTimersByTime(120);
    debouncer.notify("figures/results.pdf");
    vi.advanceTimersByTime(120);
    debouncer.notify(Buffer.from("sections\\results.tex"));

    expect(dispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      projectRoot: "/project/paper",
      paths: ["figures/results.pdf", "sections/results.tex"]
    });
  });

  it("emits an empty path list when the watcher cannot identify the file", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify(null);
    vi.advanceTimersByTime(250);

    expect(dispatch).toHaveBeenCalledWith({
      projectRoot: "/project/paper",
      paths: []
    });
  });

  it("cancels pending watcher notifications when disposed", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify("figures/results.pdf");
    debouncer.dispose();
    vi.advanceTimersByTime(250);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records agent start and approval results into local audit history", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain(
      'await recordAgentAudit(\n      request.projectRoot,\n      "agent.session.started"'
    );
    expect(source).toContain(
      "await recordAgentEvents(request.projectRoot, result.events, result.changeset?.id);"
    );
    expect(source).toContain(
      'await recordAgentEvents(\n        result.changeset?.projectRoot ?? activeProjectRoot ?? "",'
    );
    expect(source).toContain(
      "return `${event.toolName} ${event.status}: ${event.prompt}`;"
    );
  });

  it("opens exported PDFs in the default external viewer after saving", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("const viewerOpenError = await shell.openPath");
    expect(source).toContain("openedInViewer: true");
    expect(source).toContain("viewerOpenError");
  });

  it("loads the packaged renderer through a stable app protocol", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("protocol.registerSchemesAsPrivileged");
    expect(source).toContain("registerPackagedRendererProtocol");
    expect(source).toContain("packagedRendererUrl");
    expect(source).toContain("await mainWindow.loadURL(packagedRendererUrl)");
    expect(source).not.toContain("await mainWindow.loadFile(rendererIndexPath)");
  });

  it("creates external template projects through the main process", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("lifecycleCreateFromExternalTemplate");
    expect(source).toContain("fetchExternalTemplateMainTex");
    expect(source).toContain(
      "https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/bare_jrnl.tex"
    );
    expect(source).toContain("writeProjectFile(");
    expect(source).toContain(
      "Fetched template did not look like a valid IEEEtran source."
    );
  });

  it("installs macOS DMG updates after downloading them", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("installAppUpdateFromDmg");
    expect(source).toContain("downloadUpdateAsset(downloadUrl, dmgPath)");
    expect(source).toContain("hdiutil attach");
    expect(source).toContain('ditto "$SOURCE_APP" "$TARGET_APP"');
    expect(source).toContain("app.quit()");
    expect(source).toContain("ipcChannels.appInstallUpdate");
  });

  it("refreshes the project to detect a main file before agent compile fallback", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("detectAgentCompileMainFile");
    expect(source).toContain("message.context.mainFilePath ??");
    expect(source).toContain("(await detectAgentCompileMainFile(projectRoot));");
    expect(source).toContain(
      "const refreshed = await refreshProjectThroughActiveBackend(projectRoot);"
    );
    expect(source).toContain("return refreshed.project.mainFilePath;");
    expect(source).toContain("setProjectMainFileThroughActiveBackend");
    expect(source).toContain(
      "return setProjectMainFileThroughActiveBackend(request.projectRoot, request.path);"
    );
    expect(source).toContain(
      "const result = await setProjectMainFileThroughActiveBackend(\n          projectRoot,\n          payload.path\n        );"
    );
    expect(source).toContain("assertAgentProjectContextMatchesActiveProject");
    expect(source).toContain(
      "Shared agent requests must include shared project context."
    );
    expect(source).toContain(
      "Shared agent context does not match the active shared project."
    );
  });

  it("routes shared project IPC through main-process client and managed cache", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("SharedProjectHttpClient");
    expect(source).toContain("isSharedProjectCollaborativeDocumentPath");
    expect(source).toContain("SharedProjectCache");
    expect(source).toContain("SharedProjectDocumentSession");
    expect(source).toContain("shared-session.json");
    expect(source).toContain("safeStorage");
    expect(source).toContain("encryptedRefreshToken");
    expect(source).toContain("readPersistedSharedProjectRefreshToken");
    expect(source).toContain("encryptSharedProjectRefreshToken");
    expect(source).toContain("client.refreshSession(persisted.refreshToken)");
    expect(source).toContain("createSharedProjectClient");
    expect(source).toContain("onSessionRefreshed");
    expect(source).toContain("persistRefreshedSharedProjectSession");
    expect(source).toContain("refreshToken: session.refreshToken");
    expect(source).toContain("refreshToken === undefined");
    expect(source).toContain("await clearPersistedSharedProjectSession();");
    expect(source).toContain("? {}");
    expect(source).toContain("encryptedAccessToken");
    expect(source).toContain("readPersistedSharedProjectAccessToken");
    expect(source).toContain("encryptSharedProjectAccessToken");
    expect(source).toContain("restoreSharedProjectConnection");
    expect(source).toContain("writePersistedSharedProjectSession");
    expect(source).toContain("handleIpc(ipcChannels.sharedSignIn");
    expect(source).toContain("handleIpc(ipcChannels.sharedSignOut");
    expect(source).toContain("handleIpc(ipcChannels.sharedListSessions");
    expect(source).toContain("handleIpc(ipcChannels.sharedRevokeSession");
    expect(source).toContain("toSharedProjectSessionSummary");
    expect(source).toContain("listSessions()");
    expect(source).toContain("revokeSession(request.sessionId)");
    expect(source).toContain("clearPersistedSharedProjectSession");
    expect(source).toContain("await client?.signOut();");
    expect(source).toContain("handleIpc(ipcChannels.sharedListProjects");
    expect(source).toContain("handleIpc(ipcChannels.sharedCreateProject");
    expect(source).toContain("handleIpc(ipcChannels.sharedCreateFromLocalProject");
    expect(source).toContain("updateProjectSettings(");
    expect(source).toContain("setProjectMainFileThroughActiveBackend");
    expect(source).toContain("handleIpc(ipcChannels.sharedUpdateProjectSettings");
    expect(source).toContain(
      "requireSharedProjectClient().updateProjectSettings(projectId, settings)"
    );
    expect(source).toContain("client.getProject(request.projectId)");
    expect(source).toContain("sharedProject.mainFilePath");
    expect(source).toContain("compiler: sharedProject.compiler");
    expect(source).toContain("localProject.project.mainFilePath");
    expect(source).toContain("collectSharedProjectSourceFiles");
    expect(source).toContain("directories: sourceFiles.directories");
    expect(source).toContain("importedFileCount");
    expect(source).toContain("importedDirectoryCount");
    expect(source).toContain("handleIpc(ipcChannels.sharedCreateFromSourceZip");
    expect(source).toContain("Import ZIP as Shared Project");
    expect(source).toContain("importProjectZip({");
    expect(source).toContain("detectShareableMainFilePath(");
    expect(source).toContain("detectMainTexFile(projectRoot, tree, texPaths)");
    expect(source).toContain("const mainFilePath = await detectShareableMainFilePath(");
    expect(source).toContain("...(mainFilePath === undefined ? {} : { mainFilePath })");
    expect(source).toContain(
      "No shareable source files were found in this ZIP archive."
    );
    expect(source).toContain("handleIpc(ipcChannels.sharedDeleteProject");
    expect(source).toContain("deleteProject(");
    expect(source).toContain("handleIpc(ipcChannels.sharedExportSourceZip");
    expect(source).toContain("exportProjectSource(");
    expect(source).toContain("writeSharedProjectSourceExportFiles");
    expect(source).toContain("sourceExport.directories");
    expect(source).toContain("Export Shared Source ZIP");
    expect(source).toContain("handleIpc(ipcChannels.sharedOpenProject");
    expect(source).toContain("handleIpc(ipcChannels.sharedInvite");
    expect(source).toContain("handleIpc(ipcChannels.sharedAcceptInvitation");
    expect(source).toContain("handleIpc(ipcChannels.sharedListMembers");
    expect(source).toContain("toSharedProjectMemberSummary");
    expect(source).toContain("handleIpc(ipcChannels.sharedTransferOwnership");
    expect(source).toContain("transferOwnership(");
    expect(source).toContain("handleIpc(ipcChannels.sharedListPresence");
    expect(source).toContain("handleIpc(ipcChannels.sharedUpdatePresence");
    expect(source).toContain("handleIpc(ipcChannels.sharedListActivity");
    expect(source).toContain("toSharedProjectActivitySummary");
    expect(source).toContain("handleIpc(ipcChannels.sharedListComments");
    expect(source).toContain("handleIpc(ipcChannels.sharedCreateComment");
    expect(source).toContain("handleIpc(ipcChannels.sharedResolveComment");
    expect(source).toContain("toSharedProjectCommentSummary");
    expect(source).toContain("handleIpc(ipcChannels.sharedListAuditEvents");
    expect(source).toContain("toSharedProjectAuditEventSummary");
    expect(source).toContain("handleIpc(ipcChannels.sharedPublishAgentRun");
    expect(source).toContain("request.agentRunId === undefined");
    expect(source).toContain("updateAgentRunStatus(request.projectId");
    expect(source).toContain("handleIpc(ipcChannels.sharedUpdateAgentRunStatus");
    expect(source).toContain("handleIpc(ipcChannels.sharedListAgentRuns");
    expect(source).toContain(
      "requireSharedProjectClient().listAgentRuns(request.projectId)"
    );
    expect(source).toContain("handleIpc(ipcChannels.sharedAttachAgentRunBuildArtifact");
    expect(source).toContain("attachBuildArtifactToAgentRun(");
    expect(source).toContain("handleIpc(ipcChannels.sharedListAgentChangeSets");
    expect(source).toContain("handleIpc(ipcChannels.sharedApplyAgentChangeSet");
    expect(source).toContain(
      "const revision = await client.readFile(request.projectId"
    );
    expect(source).toContain("fileRevision");
    expect(source).toContain("writeSharedDocumentRevisionToActiveCache({");
    expect(source).toContain("handleIpc(ipcChannels.sharedRejectAgentChangeSet");
    expect(source).toContain("toSharedProjectAgentRunSummary");
    expect(source).toContain("toSharedProjectAgentChangeSetSummary");
    expect(source).toContain("createSharedChangeSetPatchPreview");
    expect(source).toContain("beforeRevisionId");
    expect(source).toContain("patchPreview:");
    expect(source).toContain("beforeContents: string");
    expect(source).toContain("afterContents: string");
    expect(source).toContain("getChangeSetWithContents");
    expect(source).toContain("syncHistoryChangeSetToActiveSharedBackend");
    expect(source).toContain("isSharedRevisionConflict(error)");
    expect(source).toContain("await history.rollbackChangeSet(changeset.id);");
    expect(source).toContain(
      "await refreshProjectThroughActiveBackend(changeset.projectRoot);"
    );
    expect(source).toContain("error instanceof SharedProjectClientError");
    expect(source).toContain('error.code === "revision-conflict"');
    expect(source).toContain("handleIpc(ipcChannels.sharedListBuildArtifacts");
    expect(source).toContain("handleIpc(ipcChannels.sharedGetBuildArtifact");
    expect(source).toContain("handleIpc(ipcChannels.sharedPublishBuildArtifact");
    expect(source).toContain("toSharedProjectBuildArtifactSummary");
    expect(source).toContain("toSharedProjectBuildArtifactDetails");
    expect(source).toContain("readOptionalBuildPdfBase64");
    expect(source).toContain("client.uploadBuildArtifact(request.projectId");
    expect(source).toContain("handleIpc(ipcChannels.sharedListFileRevisions");
    expect(source).toContain(
      "requireSharedProjectClient().listFileRevisions(request.projectId, request.path)"
    );
    expect(source).toContain("handleIpc(ipcChannels.sharedGetFileRevisionDetails");
    expect(source).toContain("toSharedProjectFileRevisionDetails");
    expect(source).toContain("handleIpc(ipcChannels.sharedRestoreFileRevision");
    expect(source).toContain("requireSharedProjectClient().restoreFileRevision(");
    expect(source).toContain("getSharedDesktopClientId");
    expect(source).toContain("desktopClientId: await getSharedDesktopClientId()");
    expect(source).toContain("const toolchain = await detectLatexToolchain();");
    expect(source).toContain("engineVersion:");
    expect(source).toContain("latexmkVersion:");
    expect(source).toContain("handleIpc(ipcChannels.sharedSyncDocumentContents");
    expect(source).toContain("ipcChannels.sharedApplyDocumentTextOperations");
    expect(source).toContain("handleIpc(ipcChannels.sharedPullDocumentContents");
    expect(source).toContain("SharedProjectRealtimeSession");
    expect(source).toContain("handleIpc(ipcChannels.sharedStartRealtime");
    expect(source).toContain("handleIpc(ipcChannels.sharedStopRealtime");
    expect(source).toContain("openRealtimeSession(projectId");
    expect(source).toContain("ipcChannels.sharedRealtimeEvent");
    expect(source).toContain(
      'if (event.type === "tree.updated") {\n        clearSharedDocumentSessions();\n      }'
    );
    expect(source).toContain("toDesktopSharedRealtimeEvent");
    expect(source).toContain("scheduleSharedRealtimeReconnect");
    expect(source).toContain("clearSharedRealtimeReconnectTimer");
    expect(source).toContain("closeCode === 4003");
    expect(source).toContain("Math.min(30_000");
    expect(source).toContain("getSharedDocumentSession(");
    expect(source).toContain("session.applyTextOperations(");
    expect(source).toContain("request.operations");
    expect(source).toContain("request.clientOperationId");
    expect(source).toContain("session.pullRemoteUpdates(request.afterUpdateId)");
    expect(source).toContain("createRemoteTextOperations(");
    expect(source).toContain("remoteTextOperations");
    expect(source).toContain("clearSharedDocumentSessions");
    expect(source).toContain("sharedDocumentSessions.delete(");
    expect(source).toContain("remoteUpdateCount: feed.updates.length");
    expect(source).toContain("toSharedProjectInvitationSummary");
    expect(source).toContain("toSharedProjectMemberSummary");
    expect(source).toContain("toSharedProjectPresenceSummary");
    expect(source).toContain('role: project.role ?? "owner"');
    expect(source).toContain('role: "owner"');
    expect(source).toContain("project.id === request.projectId)?.role");
    expect(source).toContain("toSharedProjectDocumentSyncResult");
    expect(source).toContain("writeSharedDocumentRevisionToActiveCache");
    expect(source).toContain("replaceDocumentContents(");
    expect(source).toContain("isSharedProjectCollaborativeDocumentPath(path)");
    expect(source).toContain(
      "requireSharedProjectClient().recordAuditEvent(sharedProject.projectId"
    );
    expect(source).toContain(
      "Local audit remains authoritative if the collaboration audit endpoint is unavailable."
    );
    expect(source).toContain("sharedProject.localCachePath");
    expect(source).toContain("result.revision.contents");
    expect(source).toContain(
      "getCachedRevisionId(\n      sharedProject.projectId,\n      path"
    );
    expect(source).toContain("getCachedRevisionId(request.projectId, request.path)");
    expect(source).toContain("expectedRevisionId");
    expect(source).toContain("recordFileRevision(sharedProject.projectId");
    expect(source).toContain("recordFileRevision(");
    expect(source).toContain("backupPath: `shared-project:${sharedProject.projectId}:");
    expect(source).toContain("await refreshProjectThroughActiveBackend(projectRoot);");
    expect(source).toContain("refreshProjectThroughActiveBackend");
    expect(source).toContain("materializeProject(");
    expect(source).toContain("startProjectWatcher(project.project.rootPath)");
    expect(source).toContain("activeSharedProject");
    expect(source).toContain("readProjectFileThroughActiveBackend");
    expect(source).toContain("writeProjectFileThroughActiveBackend");
    expect(source).toContain("deleteProjectEntryThroughActiveBackend");
    expect(source).toContain("moveProjectEntryThroughActiveBackend");
    expect(source).toContain("requireSharedProjectClient().getTree(");
    expect(source).toContain(
      'await requireSharedProjectClient().createFile(\n          sharedProject.projectId,\n          path,\n          ""\n        );'
    );
    expect(source).toContain("requireSharedProjectClient().writeFile(");
    expect(source).toContain("requireSharedProjectClient().createDirectory(");
    expect(source).toContain("requireSharedProjectClient().renameEntry(");
    expect(source).toContain("requireSharedProjectClient().moveEntry(");
    expect(source).toContain("requireSharedProjectClient().deleteEntry(");
  });

  it("refreshes active shared projects from the server before rereading the cache", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain(
      "async function refreshProjectThroughActiveBackend(projectRoot: string)"
    );
    expect(source).toContain(
      "const sharedProject = getActiveSharedProject(projectRoot);"
    );
    expect(source).toContain("const client = requireSharedProjectClient();");
    expect(source).toContain(
      "getSharedProjectCache().materializeProject(client, sharedProject.projectId)"
    );
    expect(source).toContain("client.getProject(sharedProject.projectId)");
    expect(source).toContain("serverProject.mainFilePath");
    expect(source).toContain(
      "activeSharedProject = {\n    projectId: sharedProject.projectId,\n    localCachePath: materialized.workingPath\n  };"
    );
    expect(source).toContain("clearSharedDocumentSessions();");
    expect(source).toContain(
      "const project = await refreshProject(\n    materialized.workingPath,\n    getProjectMetadataStore()\n  );"
    );
    expect(source).toContain("handleIpc(ipcChannels.projectRefresh");
    expect(source).toContain(
      "return refreshProjectThroughActiveBackend(request.projectRoot);"
    );
  });
});
