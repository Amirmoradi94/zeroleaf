import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("App renderer shell", () => {
  it("defines the primary workbench and lifecycle entry points", async () => {
    const appSource = await readFile(
      fileURLToPath(new URL("./App.tsx", import.meta.url)),
      "utf8"
    );
    const pdfPaneSource = await readFile(
      fileURLToPath(new URL("./components/PdfPane.tsx", import.meta.url)),
      "utf8"
    );
    const pdfPreviewModelSource = await readFile(
      fileURLToPath(new URL("./pdfPreviewModel.ts", import.meta.url)),
      "utf8"
    );
    const noProjectAgentCommandSource = await readFile(
      fileURLToPath(new URL("./noProjectAgentCommand.ts", import.meta.url)),
      "utf8"
    );
    const onlyOfficeWordEditorPaneSource = await readFile(
      fileURLToPath(
        new URL("./components/OnlyOfficeWordEditorPane.tsx", import.meta.url)
      ),
      "utf8"
    );
    const stylesSource = await readFile(
      fileURLToPath(new URL("./styles.css", import.meta.url)),
      "utf8"
    );
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../../../package.json", import.meta.url)),
        "utf8"
      )
    ) as { readonly scripts: Record<string, string> };
    const onlyOfficeDevServerSource = await readFile(
      fileURLToPath(
        new URL("../../../../scripts/onlyoffice-dev-server.mjs", import.meta.url)
      ),
      "utf8"
    );
    const rendererSource = [
      appSource,
      pdfPaneSource,
      pdfPreviewModelSource,
      noProjectAgentCommandSource,
      onlyOfficeWordEditorPaneSource,
      stylesSource
    ].join("\n");

    expect(rendererSource).toContain("ZeroLeaf");
    expect(appSource).toContain("Command Palette");
    expect(appSource).toContain("Open Folder");
    expect(appSource).toContain("Import ZIP");
    expect(appSource).toContain("Create Project");
    expect(appSource).toContain("Shared Projects");
    expect(appSource).toContain("desktopApi.shared.signIn");
    expect(appSource).toContain("desktopApi.shared.signOut");
    expect(appSource).toContain("Sign Out");
    expect(appSource).toContain("desktopApi.shared.listSessions");
    expect(appSource).toContain("desktopApi.shared.revokeSession");
    expect(appSource).toContain("sharedSessions");
    expect(appSource).toContain("Shared sessions");
    expect(appSource).toContain("formatSharedSessionLabel");
    expect(appSource).toContain("formatSharedSessionDetails");
    expect(appSource).toContain("This desktop");
    expect(appSource).toContain("Revoke");
    expect(appSource).toContain("desktopApi.shared.createProject");
    expect(appSource).toContain("desktopApi.shared.createFromLocalProject");
    expect(appSource).toContain("desktopApi.shared.createFromSourceZip");
    expect(appSource).toContain("desktopApi.shared.deleteProject");
    expect(appSource).toContain("desktopApi.shared.exportSourceZip");
    expect(appSource).toContain("desktopApi.shared.openProject");
    expect(appSource).toContain("desktopApi.shared.updateProjectSettings");
    expect(appSource).toContain("updateProjectCompiler");
    expect(appSource).toContain("opened.compiler");
    expect(appSource).toContain("result.compiler");
    expect(appSource).toContain("Set shared compiler to");
    expect(appSource).toContain("desktopApi.shared.invite");
    expect(appSource).toContain("desktopApi.shared.acceptInvitation");
    expect(appSource).toContain("desktopApi.shared.listMembers");
    expect(appSource).toContain("desktopApi.shared.updateMemberRole");
    expect(appSource).toContain("desktopApi.shared.transferOwnership");
    expect(appSource).toContain("desktopApi.shared.removeMember");
    expect(appSource).toContain("desktopApi.shared.updatePresence");
    expect(appSource).toContain("desktopApi.shared.listPresence");
    expect(appSource).toContain("desktopApi.shared.listActivity");
    expect(appSource).toContain("desktopApi.shared.publishAgentRun");
    expect(appSource).toContain("desktopApi.shared.listAgentChangeSets");
    expect(appSource).toContain("desktopApi.shared.applyAgentChangeSet");
    expect(appSource).toContain("desktopApi.shared.rejectAgentChangeSet");
    expect(appSource).toContain(".listBuildArtifacts(");
    expect(appSource).toContain("desktopApi.shared.getBuildArtifact");
    expect(appSource).toContain(".publishBuildArtifact(");
    expect(appSource).toContain(".getFileRevision({");
    expect(appSource).toContain(".listFileRevisions({");
    expect(appSource).toContain(".getFileRevisionDetails({");
    expect(appSource).toContain(".restoreFileRevision({");
    expect(appSource).toContain("sharedFileRevisions");
    expect(appSource).toContain("selectedSharedFileRevision");
    expect(appSource).toContain("File revisions");
    expect(appSource).toContain("formatSharedFileRevisionDetails");
    expect(appSource).toContain("formatSharedFileRevisionPreview");
    expect(appSource).toContain("Restore");
    expect(appSource).toContain("sourceRevisionId");
    expect(appSource).toContain("formatSharedRevisionLabel");
    expect(appSource).toContain("formatSharedToolchainVersion");
    expect(appSource).toContain("formatSharedDesktopClientLabel");
    expect(appSource).toContain("artifact.desktopClientId");
    expect(appSource).toContain("toolchain unknown");
    expect(appSource).toContain("artifact.engineVersion");
    expect(appSource).toContain("artifact.latexmkVersion");
    expect(appSource).toContain("sharedBuildSourceRevisionId");
    expect(appSource).toContain(
      "Could not capture shared source revision before compile"
    );
    expect(appSource).toContain("desktopApi.shared.syncDocumentContents");
    expect(appSource).toContain("desktopApi.shared.applyDocumentTextOperations");
    expect(appSource).toContain("desktopApi.shared.onRealtimeEvent");
    expect(appSource).toContain(".startRealtime(projectId)");
    expect(appSource).toContain(".stopRealtime(projectId)");
    expect(appSource).toContain("sharedRealtimeDocumentVersions");
    expect(appSource).toContain("createSharedTextOperations(");
    expect(appSource).toContain(
      "Wait for queued shared operations to finish before saving."
    );
    expect(appSource).toContain("Resolve the shared document conflict before saving.");
    expect(appSource).toContain("desktopApi.shared.pullDocumentContents");
    expect(appSource).toContain("activeSharedSaveProject");
    expect(appSource).toContain(
      "activeSharedProject?.localCachePath === currentProject.rootPath"
    );
    expect(appSource).toContain("sharedDocumentSyncStatus");
    expect(appSource).toContain("sharedDocumentConflictPaths");
    expect(appSource).toContain("sharedDocumentOperationFailedPaths");
    expect(appSource).toContain("sharedDocumentPendingOperations");
    expect(appSource).toContain("sharedDocumentUpdateCursors");
    expect(appSource).toContain("sharedRemotePullInterval");
    expect(appSource).toContain("pullInFlight");
    expect(appSource).toContain("window.clearInterval(sharedRemotePullInterval)");
    expect(appSource).toContain("openSharedTextFiles");
    expect(appSource).toContain("pullBackgroundSharedDocumentUpdates");
    expect(appSource).toContain("sharedBackgroundPullInterval");
    expect(appSource).toContain("window.clearInterval(sharedBackgroundPullInterval)");
    expect(appSource).toContain("Pulled background shared update");
    expect(appSource).toContain("Shared background pull failed");
    expect(appSource).toContain("sharedBuildArtifacts");
    expect(appSource).toContain("publishSharedBuildArtifact");
    expect(appSource).toContain("await publishSharedBuildArtifact(agentBuildResult);");
    expect(appSource).toContain("sharedAgentRunIdsBySessionId");
    expect(appSource).toContain("sharedAgentRunIdsByLocalChangeSetId");
    expect(appSource).toContain(
      'await verifyChangeSet(changeset, "apply", sharedAgentRunId);'
    );
    expect(appSource).toContain("Published running shared agent run.");
    expect(appSource).toContain("sharedAgentRunIdForRequest");
    expect(appSource).toContain("prompt,\n            effectiveAgentMode,");
    expect(appSource).toContain("Attached shared compile verification to agent run.");
    expect(appSource).toContain("desktopApi.shared.publishBuildArtifact({");
    expect(appSource).toContain("applySharedAgentChangeSetFromPanel");
    expect(appSource).toContain("rejectSharedAgentChangeSetFromPanel");
    expect(appSource).toContain("onApplySharedAgentChangeSet(changeset)");
    expect(appSource).toContain("onRejectSharedAgentChangeSet(changeset)");
    expect(appSource).toContain("Applied and compiled shared agent changeset for");
    expect(appSource).toContain('status: "running"');
    expect(appSource).toContain("desktopApi.shared.updateAgentRunStatus");
    expect(appSource).toContain("Could not mark shared agent run failed");
    expect(appSource).toContain("const sharedApprovalBuildArtifact =");
    expect(appSource).toContain("desktopApi.shared.attachAgentRunBuildArtifact");
    expect(appSource).toContain("Attached approval compile to shared agent run.");
    expect(appSource).toContain("Recent local compiles");
    expect(appSource).toContain("formatSharedBuildArtifactDetails");
    expect(appSource).toContain("inspectSharedBuildArtifact");
    expect(appSource).toContain("createBuildResultFromSharedArtifact");
    expect(appSource).toContain("inline-text-button");
    expect(stylesSource).toContain(".inline-text-button");
    expect(appSource).toContain("sharedActivity");
    expect(appSource).toContain("Shared activity");
    expect(appSource).toContain("formatSharedActivityDetails");
    expect(appSource).toContain("formatSharedActivityTitle");
    expect(appSource).toContain("sharedComments");
    expect(appSource).toContain("Shared comments");
    expect(appSource).toContain("desktopApi.shared.createComment");
    expect(appSource).toContain("desktopApi.shared.resolveComment");
    expect(appSource).toContain("formatSharedCommentTitle");
    expect(appSource).toContain("formatSharedCommentDetails");
    expect(appSource).toContain("sharedAuditEvents");
    expect(appSource).toContain("desktopApi.shared.listAuditEvents");
    expect(appSource).toContain("Agent audit");
    expect(appSource).toContain("formatSharedAgentAuditTitle");
    expect(appSource).toContain("formatSharedAgentAuditDetails");
    expect(appSource).toContain("selectedSharedAgentChangeSetId");
    expect(appSource).toContain("formatSharedAgentChangeSetLinkLabel");
    expect(appSource).toContain("Show changeset");
    expect(appSource).toContain("shared-presence__row--selected");
    expect(stylesSource).toContain(".shared-presence__row--selected");
    expect(appSource).toContain("Agent run completed");
    expect(appSource).toContain("Agent run failed");
    expect(appSource).toContain("Agent run waiting for review");
    expect(appSource).toContain("sharedAgentRuns");
    expect(appSource).toContain("desktopApi.shared.listAgentRuns");
    expect(appSource).toContain("Agent runs");
    expect(appSource).toContain("formatSharedAgentRunTitle");
    expect(appSource).toContain("formatSharedAgentRunDetails");
    expect(appSource).toContain("formatSharedAgentRunBuildArtifactLabel");
    expect(appSource).toContain("agentRun.buildArtifactIds.map");
    expect(appSource).toContain("Inspect compile");
    expect(appSource).toContain("compile results");
    expect(appSource).toContain("sharedAgentChangeSets");
    expect(appSource).toContain("Agent changesets");
    expect(appSource).toContain("formatSharedAgentChangeSetDetails");
    expect(appSource).toContain("formatSharedAgentChangeSetTitle");
    expect(appSource).toContain("publishSharedAgentRun");
    expect(appSource).toContain("projectContext: {");
    expect(appSource).toContain('backend: "shared" as const');
    expect(appSource).toContain("sharedProjectId: activeSharedProject.id");
    expect(appSource).toContain("updateSharedAgentChangeSetStatus");
    expect(appSource).toContain("applied.fileRevision.contents");
    expect(appSource).toContain(
      "clearSharedDocumentConflictState(applied.fileRevision.path)"
    );
    expect(appSource).toContain("sharedAgentChangeSetIdsByLocalId");
    expect(appSource).toContain("toSharedProjectAgentRunStatus");
    expect(appSource).toContain("changeset.patchPreview");
    expect(rendererSource).toContain("shared-agent-changeset-preview");
    expect(appSource).toContain("createSharedPresenceCursorDecorations");
    expect(appSource).toContain("createDecorationsCollection");
    expect(appSource).toContain("cursorLine: position.lineNumber");
    expect(appSource).toContain("cursorColumn: position.column");
    expect(rendererSource).toContain("shared-remote-cursor");
    expect(appSource).toContain("getActiveSharedCollaborators");
    expect(appSource).toContain("Active collaborators in this file");
    expect(appSource).toContain("formatSharedPresenceLocation");
    expect(rendererSource).toContain(".editor-collaborator");
    expect(appSource).toContain("sharedProjectCanEdit");
    expect(appSource).toContain("formatSharedProjectRole");
    expect(appSource).toContain("Shared ZIP import cancelled.");
    expect(appSource).toContain("Import ZIP");
    expect(appSource).toContain("Delete shared project");
    expect(appSource).toContain("Only owners can delete shared projects");
    expect(appSource).toContain("Export shared source ZIP");
    expect(appSource).toContain("Only owners can export shared projects");
    expect(stylesSource).toContain(".shared-project-row");
    expect(appSource).toContain("onSharedMemberRoleChange");
    expect(appSource).toContain("onSharedMemberRemove");
    expect(appSource).toContain("Transfer ownership");
    expect(appSource).toContain("Only shared project owners can transfer ownership.");
    expect(appSource).toContain("Only shared project owners can manage collaborators.");
    expect(appSource).toContain("shared-member-role-select");
    expect(stylesSource).toContain(".shared-member-role-select");
    expect(appSource).toContain(
      "Read-only shared project. Local compile remains available."
    );
    expect(appSource).toContain("Shared read-only");
    expect(appSource).toContain("readOnly: !canEditProject");
    expect(appSource).toContain("getEffectiveSharedAgentMode");
    expect(appSource).toContain(
      'activeSharedProject?.role === "viewer" ? "read-only" : mode'
    );
    expect(appSource).toContain("sharedViewerAgentModeRestricted");
    expect(appSource).toContain("shared viewers cannot propose or apply project edits");
    expect(appSource).toContain("mode: effectiveAgentMode");
    expect(appSource).toContain("Only shared project owners can invite collaborators.");
    expect(appSource).toContain("result.role");
    expect(appSource).toContain("Shared text operation failed");
    expect(appSource).toContain("Waiting for shared operation ack");
    expect(appSource).toContain("Shared operation fallback syncing");
    expect(appSource).toContain("Shared operation fallback queued");
    expect(appSource).toContain("Queued shared operation for");
    expect(appSource).toContain("Replaying ${operations.length} queued shared");
    expect(appSource).toContain("Queued shared operation retry failed");
    expect(appSource).toContain("clientOperationId: pendingOperation.id");
    expect(appSource).toContain("change.rangeOffset");
    expect(appSource).toContain("sharedRemoteEditPathsRef");
    expect(appSource).toContain("applySharedRemoteTextOperationsToEditor");
    expect(appSource).toContain('"shared-remote"');
    expect(appSource).toContain("result.remoteTextOperations");
    expect(appSource).toContain("afterUpdateId");
    expect(appSource).toContain("result.remoteUpdateCount === 0");
    expect(appSource).toContain("result.lastUpdateId");
    expect(appSource).toContain(
      "Shared sync failed for ${file.path}; resolve remote changes before saving."
    );
    expect(appSource).toContain("Remote changes available");
    expect(appSource).toContain("Resolve remote changes");
    expect(appSource).toContain("activeSharedDocumentConflict");
    expect(appSource).toContain("acceptSharedRemoteDocumentChanges");
    expect(appSource).toContain("keepLocalSharedDocumentChanges");
    expect(appSource).toContain("clearSharedDocumentConflictState");
    expect(appSource).toContain("Accept remote changes");
    expect(appSource).toContain("Keep local changes");
    expect(appSource).toContain("Shared conflict");
    expect(appSource).toContain("Published local changes for");
    expect(appSource).toContain("Collaborator email");
    expect(appSource).toContain("Invitation id");
    expect(appSource).toContain("sharedMembers");
    expect(appSource).toContain("Members");
    expect(appSource).toContain("Active now");
    expect(stylesSource).toContain(".shared-presence");
    expect(appSource).toContain("formatSharedProjectDetails");
    expect(appSource).toContain("activeSharedProject");
    expect(appSource).toContain("Shared project");
    expect(appSource).toContain("Share project");
    expect(appSource).toContain("onSharedCreateFromLocalProject");
    expect(stylesSource).toContain(".project-origin-badge");
    expect(stylesSource).toContain(".shared-projects");
    expect(appSource).toContain("Template project name");
    expect(appSource).toContain("getDefaultProjectNameForTemplate");
    expect(appSource).toContain(
      "Enter a project name before creating a template project."
    );
    expect(appSource).not.toContain('window.prompt("Project name"');
    expect(appSource).toContain("latexmk is missing.");
    expect(appSource).toContain("is not available. Set one of:");
    expect(appSource).toContain("Delete selected entry");
    expect(appSource).toContain(
      "window.confirm(`Delete ${selectedProjectEntryPath}?`)"
    );
    expect(appSource).toContain("backup saved to");
    expect(appSource).toContain("found ${referenceCount} references");
    expect(appSource).toContain("createCitationCommand");
    expect(appSource).toContain("groupMissingCitations");
    expect(appSource).toContain("group.occurrences.length");
    expect(appSource).toContain("onRemoveUnusedReference");
    expect(appSource).toContain("Remove unused bibliography entry");
    expect(appSource).toContain("Removed unused reference");
    expect(appSource).toContain("file-row__main-action");
    expect(appSource).toContain("file-row__badge");
    expect(appSource).toContain("buildProjectLatexOutline");
    expect(appSource).toContain(
      "onJumpToOutlineItem={(item) => jumpToFileLine(item.path, item.line)}"
    );
    expect(appSource).toContain("No outline for the current project.");
    expect(appSource).toContain("Could not save ${file.path}");
    expect(appSource).toContain(
      "shouldMarkPdfStaleForProjectChange(staleCandidatePaths)"
    );
    expect(appSource).toContain("appWrittenProjectPathsRef");
    expect(rendererSource).toContain("PDF Preview");
    expect(appSource).toContain("startPdfPreviewBuild");
    expect(appSource).toContain("finishPdfPreviewBuild");
    expect(appSource).toContain("Stop Build");
    expect(appSource).toContain("Stopping build...");
    expect(appSource).toContain("Search raw log");
    expect(appSource).toContain("Copy excerpt");
    expect(appSource).toContain("Build log search excerpt");
    expect(appSource).toContain("Log truncated: showing");
    expect(appSource).toContain("Recompile before SyncTeX; PDF is stale.");
    expect(rendererSource).toContain("Stale: unsaved source changes");
    expect(rendererSource).toContain("Stale: saved source newer than PDF");
    expect(rendererSource).toContain("Stale: project changed outside editor");
    expect(appSource).toContain("No SyncTeX source target found.");
    expect(appSource).toContain("getEditorPosition");
    expect(appSource).toContain("setEditorValue");
    expect(appSource).toContain("getEditorValue");
    expect(appSource).toContain("installE2EEditorHooks");
    expect(rendererSource).toContain("Fit PDF width");
    expect(rendererSource).toContain("Zoom in");
    expect(rendererSource).toContain("Zoom out");
    expect(appSource).toContain("collectPdfSearchMatches");
    expect(appSource).toContain("PDF match ${nextIndex + 1} of");
    expect(rendererSource).toContain("Previous PDF match");
    expect(rendererSource).toContain("Next PDF match");
    expect(appSource).toContain('No PDF search match for "${query}"');
    expect(rendererSource).toContain("Save PDF");
    expect(appSource).toContain("Include generated build artifacts and cache files");
    expect(appSource).toContain("The current PDF preview is stale");
    expect(appSource).toContain("Agent");
    expect(appSource).toContain("Connect an AI provider once on this computer");
    expect(appSource).toContain("openProviderSetupTerminal");
    expect(appSource).toContain("Log in with your subscription");
    expect(appSource).toMatch(/does\s+not request or store provider API keys/u);
    expect(appSource).toContain("scoped edit, compile, or project inspection");
    expect(appSource).toContain("Explain selection");
    expect(appSource).toContain("Expand notes");
    expect(appSource).toContain("Improve academic tone");
    expect(appSource).toContain("Shorten abstract");
    expect(appSource).toContain("openInlineSelectionPrompt");
    expect(appSource).toContain("runInlineSelectionPrompt");
    expect(appSource).toContain("AI for selected text");
    expect(appSource).toContain("INLINE_SELECTION_PROMPT_AUTO_OPEN_DELAY_MS");
    expect(appSource).toContain("editorSelectionPointerDownRef");
    expect(appSource).toContain("editorSelectionPendingAfterPointerUpRef");
    expect(appSource).toContain("contentRowResizeObserver.observe(contentRow)");
    expect(appSource).toContain('.closest(".editor-pane")');
    expect(appSource).toContain('"pointerup"');
    expect(appSource).toContain('"pointercancel"');
    expect(appSource).toContain("createAgentSelectionContext");
    expect(appSource).toContain("activeAgentSelectionContext");
    expect(appSource).toContain("selectionContext");
    expect(appSource).toContain("getSelectionAgentDefaultPrompt");
    expect(appSource).toContain(
      'const effectiveAgentMode = action === "explain" ? "suggest" : agentMode;'
    );
    expect(appSource).toContain(
      'formatAgentModeLabel(action === "explain" ? "suggest" : mode)'
    );
    expect(appSource).toContain("selectedText");
    expect(appSource).toContain("createDiagnosticAgentPrompt");
    expect(appSource).toContain("createNumberingMismatchAgentPrompt");
    expect(appSource).toContain("startDiagnosticAgentFix(topDiagnostic)");
    expect(appSource).toContain("{ activeFilePath: diagnostic.filePath }");
    expect(appSource).toContain("createReferenceEntryAgentPrompt");
    expect(appSource).toContain("createFinalFormattingReviewPrompt");
    expect(appSource).toContain("Agent final PDF formatting review");
    expect(appSource).toContain("Command search");
    expect(appSource).toContain('event.key === "ArrowDown"');
    expect(appSource).toContain('event.key === "Enter"');
    expect(appSource).toContain("aria-activedescendant");
    expect(appSource).toContain("agentSessionProjectRoot");
    expect(appSource).toContain("agentSessionProviderId");
    expect(appSource).toContain("Agent figure numbering mismatch");
    expect(appSource).toContain("onAskAgentNumberingMismatch");
    expect(appSource).toContain("{ sessionId: continuationSessionId }");
    expect(appSource).toContain("setAgentSessionId(result.sessionId)");
    expect(appSource).toContain('setAgentPrompt("");');
    expect(appSource).toContain("AgentLiveStatus");
    expect(appSource).toContain("zeroleaf-agent-history");
    expect(appSource).toContain("zeroleaf-agent-provider");
    expect(appSource).toContain("Clear agent history");
    expect(appSource).toContain("Stop agent run");
    expect(appSource).toContain("Attach image");
    expect(appSource).toContain("agentImageAttachments");
    expect(appSource).toContain("hasImageDragItems");
    expect(appSource).toContain("readAgentImageAttachment");
    expect(appSource).toContain("imageAttachments: composerImageAttachments");
    expect(appSource).toContain("parseNoProjectAgentCommand");
    expect(appSource).toContain("runNoProjectAgentCommand");
    expect(appSource).toContain("desktopApi.lifecycle.createFromTemplate");
    expect(appSource).toContain("desktopApi.lifecycle.createForAgent");
    expect(appSource).toContain('mode: "apply-with-review"');
    expect(noProjectAgentCommandSource).toContain("inferNoProjectAgentDocumentKind");
    expect(noProjectAgentCommandSource).toContain("inferNoProjectAgentWordPath");
    expect(appSource).toContain("desktopApi.word.save");
    expect(appSource).toContain("activeDocument: {");
    expect(appSource).toContain("getAgentResultWordChangeSets(agentResult)");
    expect(appSource).toContain("<OnlyOfficeWordEditorPane");
    expect(appSource).toContain("editor-pane--word");
    expect(rendererSource).toContain(".editor-pane--word");
    expect(rendererSource).toContain("grid-template-rows: 37px minmax(0, 1fr)");
    expect(rendererSource).toContain(".word-editor--onlyoffice");
    expect(appSource).toContain("isWordEditorActive");
    expect(appSource).toContain("showEditorToolbar");
    expect(appSource).toContain('activeFile?.documentKind === "word"');
    expect(appSource).toContain("desktopApi.onlyOffice.forceSave({ sessionId })");
    expect(appSource).toContain("desktopApi.onlyOffice.exportPdf({ sessionId })");
    expect(appSource).toContain(
      "getProjectRelativePath(currentProject.rootPath, result.pdfPath)"
    );
    expect(appSource).toContain("SyncTeX unavailable for Word PDF");
    expect(rendererSource).toContain("Compile Word document to PDF");
    expect(rendererSource).toContain(".onlyoffice-word-command-bar");
    expect(rendererSource).toContain(".onlyoffice-compile-button");
    expect(appSource).toContain("dirtyOnlyOfficeWordPath");
    expect(appSource).toContain("before asking the agent to inspect or edit it");
    expect(appSource).toContain("Word document has unsaved changes");
    expect(appSource).toContain(
      "Save or sync the open ONLYOFFICE document before applying this Word edit."
    );
    expect(appSource).not.toContain("function WordEditor({");
    expect(appSource).not.toContain("function BasicWordEditor({");
    expect(onlyOfficeWordEditorPaneSource).toContain("new window.DocsAPI!.DocEditor");
    expect(onlyOfficeWordEditorPaneSource).toContain("focusOnlyOfficeFrame");
    expect(onlyOfficeWordEditorPaneSource).toContain(
      "const onCloseRef = useLatestRef(onClose);"
    );
    expect(onlyOfficeWordEditorPaneSource).toContain("onCloseRef.current();");
    expect(onlyOfficeWordEditorPaneSource).toContain("onDocumentReady");
    expect(onlyOfficeWordEditorPaneSource).toContain("onDocumentStateChange");
    expect(onlyOfficeWordEditorPaneSource).toContain("onRequestRefreshFile");
    expect(onlyOfficeWordEditorPaneSource).toContain("onOutdatedVersion");
    expect(onlyOfficeWordEditorPaneSource).toContain("onError");
    expect(onlyOfficeWordEditorPaneSource).toContain("formatOnlyOfficeErrorData");
    expect(onlyOfficeWordEditorPaneSource).toContain("onRequestClose");
    expect(onlyOfficeWordEditorPaneSource).toContain("withOnlyOfficeReadOnly");
    expect(onlyOfficeWordEditorPaneSource).toContain('mode: "view"');
    expect(onlyOfficeWordEditorPaneSource).toContain("edit: false");
    expect(onlyOfficeWordEditorPaneSource).toContain("Open Word Settings");
    expect(onlyOfficeWordEditorPaneSource).toContain("onExportPdfRef");
    expect(appSource).toContain("npm run onlyoffice:start");
    expect(packageJson.scripts["onlyoffice:start"]).toBe(
      "node scripts/onlyoffice-dev-server.mjs start"
    );
    expect(packageJson.scripts["onlyoffice:status"]).toBe(
      "node scripts/onlyoffice-dev-server.mjs status"
    );
    expect(onlyOfficeDevServerSource).toContain("zeroleaf-onlyoffice-dev");
    expect(onlyOfficeDevServerSource).toContain("onlyoffice/documentserver:latest");
    expect(onlyOfficeDevServerSource).toContain("JWT_ENABLED=false");
    expect(onlyOfficeDevServerSource).toContain("ALLOW_PRIVATE_IP_ADDRESS=true");
    expect(onlyOfficeDevServerSource).toContain("/web-apps/apps/api/documents/api.js");
    expect(onlyOfficeWordEditorPaneSource).not.toContain("desktopApi.word.save");
    expect(appSource).toContain(
      "setAgentSessionProjectRoot(projectResult.project.rootPath)"
    );
    expect(appSource).not.toContain("parseExternalTemplateAgentCommand");
    expect(appSource).not.toContain("runExternalTemplateAgentCommand");
    expect(appSource).not.toContain("desktopApi.lifecycle.createFromExternalTemplate");
    expect(appSource).not.toContain("ieee-systems-journal-template");
    expect(appSource).toContain("Preparing agent project");
    expect(appSource).toContain(
      "Open or create a project before project-scoped agent work."
    );
    expect(appSource).toContain("create a new project and name it front-postdoc");
    expect(appSource).toContain("formatElapsedTime");
    expect(appSource).toContain("RevealedAgentRichText");
    expect(appSource).toContain("parseMarkdownCodeFence");
    expect(appSource).toContain('type: "code-block"');
    expect(appSource).toContain("agent-rich-code-block");
    expect(appSource).toContain("setVisibleTokenCount");
    expect(appSource).toContain("content.match(/\\S+\\s*|\\s+/gu)");
    expect(appSource).not.toContain("scheduleBackgroundUpdate");
    expect(appSource).not.toContain("Context loaded");
    expect(appSource).not.toContain("Local inspection");
    expect(appSource).not.toContain("Action planning");
    expect(appSource).toContain("Waiting for patch review");
    expect(appSource).toContain("`${requestSessionId}-failed-error`");
    expect(appSource).toContain("`${requestSessionId}-failed-message`");
    expect(appSource).toContain(
      "`${providerLabel} could not complete the task: ${errorMessage}`"
    );
    expect(appSource).toContain("prepareAgentDisplayEvents(result.events)");
    expect(appSource).toContain("mergeAgentThreadEvents");
    expect(appSource).toContain("buildAgentCompletionSummaryEvent(result, {");
    expect(appSource).toContain("handleAgentWordChangeSets");
    expect(appSource).toContain("applyWordChangeSetsDirectly");
    expect(appSource).toContain("reloadOnlyOfficeWordDocument");
    expect(appSource).toContain(
      "Word document changes were applied and ONLYOFFICE was refreshed."
    );
    expect(appSource).toContain("wordChangesAutoApply");
    const directWordApplySource =
      appSource.match(
        /const applyWordChangeSetsDirectly = useCallback\([\s\S]+?const handleAgentWordChangeSets = useCallback/u
      )?.[0] ?? "";
    expect(directWordApplySource).not.toContain("setBottomPanelOpen(true)");
    expect(directWordApplySource).not.toContain('setActiveBottomTab("History")');
    expect(appSource).not.toContain("I compiled the project.");
    expect(appSource).not.toContain("ran compile verification");
    expect(appSource).not.toContain(
      "I inspected the scoped project context and answered without changing files."
    );
    expect(appSource).not.toContain(
      "I completed the request without changing project files."
    );
    expect(appSource).toContain("AgentRunLiveStatus");
    expect(appSource).toContain("createAgentToolLiveStatus");
    expect(appSource).toContain("createAgentRunLiveStatus");
    expect(appSource).toContain("getAgentRunActivityEvents");
    expect(appSource).toContain("findLatestOperationalLiveStatus");
    expect(appSource).toContain("createStartingAgentLiveStatus");
    expect(appSource).toContain("createAwaitingApprovalLiveStatus");
    expect(appSource).toContain("Understanding request");
    expect(appSource).toContain("Planning with Codex");
    expect(appSource).toContain("Codex is still working");
    expect(appSource).toContain("Network approval required");
    expect(appSource).toContain("Searching official sources");
    expect(appSource).toContain("Verifying source");
    expect(appSource).toContain("Inspecting template");
    expect(appSource).toContain("Comparing with project");
    expect(appSource).toContain("Preparing recommendation");
    expect(appSource).toContain("Final response");
    expect(appSource).toContain("isExternalResearchPrompt");
    expect(appSource).toContain("getRequestedApprovalToolName");
    expect(appSource).toContain("Web access is required");
    expect(appSource).toContain("Analyzing project");
    expect(appSource).toContain("Reading project file");
    expect(appSource).not.toContain(
      "`${formatAgentToolName(event.toolName)} ${event.status}`"
    );
    expect(appSource).toContain("compactAgentWorkflowEvents");
    expect(appSource).toContain("getLatestAssistantRunItemKey");
    expect(appSource).toContain('items[index + 1]?.type === "assistant-run"');
    expect(appSource).toContain("findPreviousUserThreadItem");
    expect(appSource).toContain("findNextUserThreadItem");
    expect(appSource).toContain("isAgentEventInRunWindow");
    expect(appSource).not.toContain(
      "getAgentRunWorkflowEvents(events, item.sessionId)"
    );
    expect(appSource).toContain('return event.type === "tool-call";');
    expect(appSource).not.toContain("createTransientAgentMessage");
    expect(appSource).not.toContain("agent-progress-message");
    expect(appSource).not.toContain("agent-activity-feed");
    expect(appSource).toContain("isOperationalAgentStatusMessage");
    expect(appSource).not.toContain("Atlas is preparing your request context");
    expect(appSource).toContain("setAgentSessionProjectRoot(null)");
    expect(appSource).toContain("setAgentSessionProviderId(null)");
    expect(appSource).toContain("changeSetVerifications");
    expect(appSource).toContain("createAppliedChangeSet");
    expect(appSource).toContain("Manual save: ${file.path}");
    expect(appSource).toContain("local history captured");
    expect(appSource).toContain("Saved edit captured locally.");
    expect(appSource).toContain("Action Timeline");
    expect(appSource).toContain("Tool call failed");
    expect(appSource).toContain("Changed file");
    expect(appSource).toContain("Build result");
    expect(appSource).toContain("formatAuditTimelineEvent");
    expect(appSource).toContain("parseUnifiedDiffHunks");
    expect(appSource).toContain("Accept hunk");
    expect(appSource).toContain("Reject hunk");
    expect(appSource).toContain("Explain hunk");
    expect(appSource).toContain("applyChangeSetHunks");
    expect(appSource).toContain("Apply & Verify");
    expect(appSource).toContain("Compile verification");
    expect(appSource).toContain("Rejected before apply; no files were changed.");
    expect(appSource).toContain("Rolling back changeset before compile verification.");
    expect(appSource).toContain("Rollback failed:");
    expect(appSource).toContain('"apply" ? "Agent patch" : "Rollback"');
    expect(appSource).toContain("compileAfterPatch");
    expect(appSource).toContain("Ask only");
    expect(appSource).toContain("Review changes first");
    expect(appSource).toContain("Auto-apply local changes");
    expect(appSource).toContain("Auto-apply local changes is advanced");
    expect(appSource).toContain("prompt.trim().length > 0");
    expect(appSource).toContain("!event.shiftKey");
  }, 20_000);

  it("refreshes shared project metadata after realtime tree updates", async () => {
    const appSource = await readFile(
      fileURLToPath(new URL("./App.tsx", import.meta.url)),
      "utf8"
    );

    expect(appSource).toContain("desktopApi.shared.listProjects()");
    expect(appSource).toContain("setSelectedCompiler(refreshedProject.compiler)");
    expect(appSource).toMatch(
      /sharedConnection\.connected,\n\s+sharedRealtimeMemberVersion,\n\s+sharedRealtimeTreeVersion/
    );
  });
});
