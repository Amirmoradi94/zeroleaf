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
    const rendererSource = [appSource, pdfPaneSource, pdfPreviewModelSource].join("\n");

    expect(rendererSource).toContain("ZeroLeaf");
    expect(appSource).toContain("Command Palette");
    expect(appSource).toContain("Open Folder");
    expect(appSource).toContain("Import ZIP");
    expect(appSource).toContain("Create Project");
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
    expect(appSource).toContain("parseNoProjectAgentCommand");
    expect(appSource).toContain("runNoProjectAgentCommand");
    expect(appSource).toContain("desktopApi.lifecycle.createFromTemplate");
    expect(appSource).toContain("parseExternalTemplateAgentCommand");
    expect(appSource).toContain("runExternalTemplateAgentCommand");
    expect(appSource).toContain("desktopApi.lifecycle.createFromExternalTemplate");
    expect(appSource).toContain("ieee-systems-journal-template");
    expect(appSource).toContain("Created **${result.project.displayName}**");
    expect(appSource).toContain("Creating project");
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
    expect(appSource).toContain("buildAgentCompletionSummaryEvent(result)");
    expect(appSource).toContain("I compiled the project.");
    expect(appSource).not.toContain(
      "I inspected the scoped project context and answered without changing files."
    );
    expect(appSource).not.toContain(
      "I completed the request without changing project files."
    );
    expect(appSource).toContain("AgentRunLiveStatus");
    expect(appSource).toContain("createAgentToolLiveStatus");
    expect(appSource).toContain("createAgentRunLiveStatus");
    expect(appSource).toContain("createStartingAgentLiveStatus");
    expect(appSource).toContain("createAwaitingApprovalLiveStatus");
    expect(appSource).toContain("Understanding request");
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
});
