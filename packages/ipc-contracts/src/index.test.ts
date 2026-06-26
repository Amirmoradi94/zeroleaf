import { describe, expect, it } from "vitest";

import {
  createReadOnlyAgentExplanation,
  createReadOnlyAgentResponse,
  defaultAppSettings,
  defaultWorkbenchLayout,
  formatAgentSelectionContextForPrompt,
  ipcChannels
} from "./index.js";

describe("ipc contracts", () => {
  it("exposes a stable app info channel", () => {
    expect(ipcChannels.appGetInfo).toBe("app.getInfo");
    expect(ipcChannels.referencesRemoveUnused).toBe("references.removeUnused");
    expect(ipcChannels.historyCreateAppliedChangeSet).toBe(
      "history.createAppliedChangeSet"
    );
    expect(ipcChannels.historyApplyChangeSetHunks).toBe("history.applyChangeSetHunks");
    expect(ipcChannels.lifecycleCreateFromExternalTemplate).toBe(
      "lifecycle.createFromExternalTemplate"
    );
    expect(ipcChannels.onlyOfficeExportPdf).toBe("onlyoffice.exportPdf");
    expect(ipcChannels.sharedSignIn).toBe("shared.signIn");
    expect(ipcChannels.sharedSignOut).toBe("shared.signOut");
    expect(ipcChannels.sharedListSessions).toBe("shared.listSessions");
    expect(ipcChannels.sharedRevokeSession).toBe("shared.revokeSession");
    expect(ipcChannels.sharedOpenProject).toBe("shared.openProject");
    expect(ipcChannels.sharedUpdateProjectSettings).toBe(
      "shared.updateProjectSettings"
    );
    expect(ipcChannels.sharedCreateFromLocalProject).toBe(
      "shared.createFromLocalProject"
    );
    expect(ipcChannels.sharedCreateFromSourceZip).toBe("shared.createFromSourceZip");
    expect(ipcChannels.sharedDeleteProject).toBe("shared.deleteProject");
    expect(ipcChannels.sharedExportSourceZip).toBe("shared.exportSourceZip");
    expect(ipcChannels.sharedInvite).toBe("shared.invite");
    expect(ipcChannels.sharedAcceptInvitation).toBe("shared.acceptInvitation");
    expect(ipcChannels.sharedListMembers).toBe("shared.listMembers");
    expect(ipcChannels.sharedTransferOwnership).toBe("shared.transferOwnership");
    expect(ipcChannels.sharedListPresence).toBe("shared.listPresence");
    expect(ipcChannels.sharedUpdatePresence).toBe("shared.updatePresence");
    expect(ipcChannels.sharedListActivity).toBe("shared.listActivity");
    expect(ipcChannels.sharedListComments).toBe("shared.listComments");
    expect(ipcChannels.sharedCreateComment).toBe("shared.createComment");
    expect(ipcChannels.sharedResolveComment).toBe("shared.resolveComment");
    expect(ipcChannels.sharedListAuditEvents).toBe("shared.listAuditEvents");
    expect(ipcChannels.sharedPublishAgentRun).toBe("shared.publishAgentRun");
    expect(ipcChannels.sharedUpdateAgentRunStatus).toBe("shared.updateAgentRunStatus");
    expect(ipcChannels.sharedListAgentRuns).toBe("shared.listAgentRuns");
    expect(ipcChannels.sharedListAgentChangeSets).toBe("shared.listAgentChangeSets");
    expect(ipcChannels.sharedApplyAgentChangeSet).toBe("shared.applyAgentChangeSet");
    expect(ipcChannels.sharedRejectAgentChangeSet).toBe("shared.rejectAgentChangeSet");
    expect(ipcChannels.sharedListBuildArtifacts).toBe("shared.listBuildArtifacts");
    expect(ipcChannels.sharedGetBuildArtifact).toBe("shared.getBuildArtifact");
    expect(ipcChannels.sharedPublishBuildArtifact).toBe("shared.publishBuildArtifact");
    expect(ipcChannels.sharedAttachAgentRunBuildArtifact).toBe(
      "shared.attachAgentRunBuildArtifact"
    );
    expect(ipcChannels.sharedListFileRevisions).toBe("shared.listFileRevisions");
    expect(ipcChannels.sharedGetFileRevisionDetails).toBe(
      "shared.getFileRevisionDetails"
    );
    expect(ipcChannels.sharedRestoreFileRevision).toBe("shared.restoreFileRevision");
    expect(ipcChannels.sharedSyncDocumentContents).toBe("shared.syncDocumentContents");
    expect(ipcChannels.sharedApplyDocumentTextOperations).toBe(
      "shared.applyDocumentTextOperations"
    );
    expect(ipcChannels.sharedPullDocumentContents).toBe("shared.pullDocumentContents");
    expect(ipcChannels.sharedStartRealtime).toBe("shared.startRealtime");
    expect(ipcChannels.sharedStopRealtime).toBe("shared.stopRealtime");
    expect(ipcChannels.sharedRealtimeEvent).toBe("shared.realtimeEvent");
    expect(
      "presence" satisfies keyof Extract<
        import("./index.js").SharedProjectRealtimeEvent,
        { readonly type: "presence.updated" }
      >
    ).toBe("presence");
    expect(
      "operations" satisfies keyof import("./index.js").SharedProjectDocumentTextOperationRequest
    ).toBe("operations");
    expect(
      "projectContext" satisfies keyof import("./index.js").AgentStartRequest
    ).toBe("projectContext");
    expect(
      "clientOperationId" satisfies keyof import("./index.js").SharedProjectDocumentTextOperationRequest
    ).toBe("clientOperationId");
    expect(
      "fileRevision" satisfies keyof import("./index.js").SharedProjectAppliedAgentChangeSetResult
    ).toBe("fileRevision");
    expect(
      "contents" satisfies keyof import("./index.js").SharedProjectAppliedAgentChangeSetResult["fileRevision"]
    ).toBe("contents");
    expect(
      "patchPreview" satisfies keyof import("./index.js").SharedProjectAgentChangeSetSummary
    ).toBe("patchPreview");
    expect(
      "buildArtifactIds" satisfies keyof import("./index.js").SharedProjectAgentRunSummary
    ).toBe("buildArtifactIds");
    expect("role" satisfies keyof import("./index.js").SharedProjectSummary).toBe(
      "role"
    );
    expect("role" satisfies keyof import("./index.js").SharedProjectOpenResult).toBe(
      "role"
    );
    expect(
      "compiler" satisfies keyof import("./index.js").SharedProjectOpenResult
    ).toBe("compiler");
    expect(
      "compiler" satisfies keyof import("./index.js").SharedProjectSettingsUpdateRequest
    ).toBe("compiler");
    expect(
      "mainFilePath" satisfies keyof import("./index.js").SharedProjectSettingsUpdateRequest
    ).toBe("mainFilePath");
    expect(
      "projectRoot" satisfies keyof import("./index.js").SharedProjectCreateFromLocalProjectRequest
    ).toBe("projectRoot");
    expect(
      "name" satisfies keyof import("./index.js").SharedProjectCreateFromSourceZipRequest
    ).toBe("name");
    expect(
      "refreshTokenExpiresAt" satisfies keyof import("./index.js").SharedProjectSessionSummary
    ).toBe("refreshTokenExpiresAt");
    expect(
      "current" satisfies keyof import("./index.js").SharedProjectSessionSummary
    ).toBe("current");
    expect(
      "sessionId" satisfies keyof import("./index.js").SharedProjectSessionRevokeRequest
    ).toBe("sessionId");
    expect(
      "revoked" satisfies keyof import("./index.js").SharedProjectSessionRevokeResult
    ).toBe("revoked");
    expect(
      "projectId" satisfies keyof import("./index.js").SharedProjectDeleteRequest
    ).toBe("projectId");
    expect(
      "projectId" satisfies keyof import("./index.js").SharedProjectExportSourceZipRequest
    ).toBe("projectId");
    expect(
      "importedFileCount" satisfies keyof import("./index.js").SharedProjectCreateFromLocalProjectResult
    ).toBe("importedFileCount");
    expect(
      "email" satisfies keyof import("./index.js").SharedProjectMemberSummary
    ).toBe("email");
    expect(
      "userId" satisfies keyof import("./index.js").SharedProjectOwnershipTransferRequest
    ).toBe("userId");
    expect(
      "diagnosticCount" satisfies keyof import("./index.js").SharedProjectBuildArtifactSummary
    ).toBe("diagnosticCount");
    expect(
      "rawLog" satisfies keyof import("./index.js").SharedProjectBuildArtifactDetails
    ).toBe("rawLog");
    expect(
      "artifactId" satisfies keyof import("./index.js").IpcRequestMap[typeof ipcChannels.sharedGetBuildArtifact]
    ).toBe("artifactId");
    expect(
      "byteLength" satisfies keyof import("./index.js").SharedProjectFileRevisionSummary
    ).toBe("byteLength");
    expect(
      "contents" satisfies keyof import("./index.js").SharedProjectFileRevisionDetails
    ).toBe("contents");
    expect(
      "revisionId" satisfies keyof import("./index.js").SharedProjectFileRevisionRequest
    ).toBe("revisionId");
    expect(
      "agentRunId" satisfies keyof import("./index.js").SharedProjectAgentRunBuildArtifactAttachRequest
    ).toBe("agentRunId");
    expect(
      "eventType" satisfies keyof import("./index.js").SharedProjectActivitySummary
    ).toBe("eventType");
    expect(
      "body" satisfies keyof import("./index.js").SharedProjectCommentSummary
    ).toBe("body");
    expect(
      "commentId" satisfies keyof import("./index.js").SharedProjectCommentResolveRequest
    ).toBe("commentId");
    expect(
      "changesetIds" satisfies keyof import("./index.js").SharedProjectAgentRunPublishRequest
    ).toBe("changesetIds");
    expect(
      "agentRunId" satisfies keyof import("./index.js").SharedProjectAgentRunPublishRequest
    ).toBe("agentRunId");
    expect(
      "status" satisfies keyof import("./index.js").SharedProjectAgentRunStatusUpdateRequest
    ).toBe("status");
    expect(
      "localChangeSetId" satisfies keyof import("./index.js").SharedProjectAgentRunPublishResult["changesets"][number]
    ).toBe("localChangeSetId");
    expect(
      "summary" satisfies keyof import("./index.js").SharedProjectAgentChangeSetSummary
    ).toBe("summary");
    expect(
      "changesetId" satisfies keyof import("./index.js").SharedProjectAgentChangeSetStatusRequest
    ).toBe("changesetId");
    expect(
      "buildResult" satisfies keyof import("./index.js").SharedProjectBuildArtifactPublishRequest
    ).toBe("buildResult");
    expect(
      "afterUpdateId" satisfies keyof import("./index.js").SharedProjectDocumentPullRequest
    ).toBe("afterUpdateId");
    expect(
      "lastUpdateId" satisfies keyof import("./index.js").SharedProjectDocumentSyncResult
    ).toBe("lastUpdateId");
    expect(
      "remoteUpdateCount" satisfies keyof import("./index.js").SharedProjectDocumentSyncResult
    ).toBe("remoteUpdateCount");
    expect(
      "remoteTextOperations" satisfies keyof import("./index.js").SharedProjectDocumentSyncResult
    ).toBe("remoteTextOperations");
  });

  it("defines default workbench pane sizes", () => {
    expect(defaultWorkbenchLayout.sidebarWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.pdfWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.agentWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.bottomPanelHeight).toBeGreaterThan(0);
  });

  it("keeps shell escape disabled in default compiler settings", () => {
    expect(defaultAppSettings.compiler.shellEscape).toBe(false);
  });

  it("defaults new agent sessions to suggest mode", () => {
    expect(defaultAppSettings.agentPermissions.defaultMode).toBe("suggest");
  });

  it("defaults ONLYOFFICE to a local Document Server setup", () => {
    expect(defaultAppSettings.onlyOffice.enabled).toBe(true);
    expect(defaultAppSettings.onlyOffice.documentServerUrl).toBe(
      "http://127.0.0.1:8082"
    );
    expect(defaultAppSettings.onlyOffice.bridgePublicBaseUrl).toContain(
      "host.docker.internal"
    );
  });

  it("formats selected text with containing paragraph context", () => {
    const context = formatAgentSelectionContextForPrompt({
      selectedText: "otherwise",
      selectionContext: {
        containingParagraph:
          "If no exception is raised, the algorithm is otherwise stated.",
        endLine: 12,
        selectedText: "otherwise",
        selectionEndOffset: 45,
        selectionStartOffset: 36,
        startLine: 12
      }
    });

    expect(context).toContain("Selected text:");
    expect(context).toContain("otherwise");
    expect(context).toContain("Containing paragraph:");
    expect(context).toContain("algorithm is otherwise stated");
    expect(context).toContain("Selection offsets in paragraph: 36-45");
  });

  it("allows agent starts to continue an existing project session explicitly", () => {
    const request = {
      providerId: "mock",
      mode: "read-only",
      projectRoot: "/tmp/project",
      sessionId: "session-1",
      prompt: "Follow up on the previous answer"
    } satisfies Parameters<typeof createReadOnlyAgentExplanation>[0];

    expect(request.sessionId).toBe("session-1");
  });

  it("describes diagnostics in read-only mode without requesting actions", () => {
    const explanation = createReadOnlyAgentExplanation(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Explain this warning",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 42,
          message: "Overfull \\hbox (12.0pt too wide) in paragraph at lines 42--43"
        }
      },
      {
        path: "main.tex",
        contents: "\\documentclass{article}\n\\begin{document}\nHello\n",
        mtimeMs: 1
      }
    );

    expect(explanation).not.toContain("Read-only mode is active");
    expect(explanation).toContain("Overfull \\hbox");
    expect(explanation).not.toContain(
      "No patch, file write, approval, or compile action"
    );
  });

  it("handles paper-about prompts through the generic mock summary fallback", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Tell me what is this paper about?",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{article}",
          "\\title{Reliable Local-First LaTeX Agents}",
          "\\begin{abstract}",
          "This paper studies reviewable AI assistance for local scholarly writing workflows.",
          "\\end{abstract}",
          "\\begin{document}",
          "\\section{Introduction}",
          "We show that patch-first agent workflows improve LaTeX repair review.",
          "\\section{Evaluation}",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents: "",
            mtimeMs: 1
          }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Structure:");
    expect(response).toContain("Main claims:");
    expect(response).toContain("reviewable AI assistance");
    expect(response).toContain("Introduction, Evaluation");
    expect(response).not.toContain("Read-only mode is active");
  });

  it("summarizes a scoped thesis project incrementally in read-only mode", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Summarize this thesis project structure, main claims, missing sections, and build health.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{report}",
          "\\begin{document}",
          "\\chapter{Introduction}",
          "This thesis studies local-first scholarly editing.",
          "We demonstrate that scoped agent workflows improve repair review.",
          "\\input{chapters/method}",
          "\\input{chapters/conclusion}",
          "\\bibliography{references}",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: (path) =>
          Promise.resolve({
            path,
            contents:
              path === "chapters/method.tex"
                ? "\\chapter{Method}\nOur contributions are a review-first patch model."
                : "\\chapter{Conclusion}\nWe show the workflow remains local-first.",
            mtimeMs: 1
          }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Structure:");
    expect(response).toContain("Introduction, Method, Conclusion");
    expect(response).toContain("Main claims:");
    expect(response).toContain("Missing sections:");
    expect(response).toContain("abstract");
    expect(response).toContain("Build health:");
    expect(response).toContain("Coverage:");
  });

  it("finds TODO and placeholder markers with file and line references", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Find TODOs, citation needed notes, and placeholders in this draft.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: "\\section{Intro}\nBackground text.\n",
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents: "\\section{Intro}\nBackground text.\n",
            mtimeMs: 1
          }),
        searchProject: (query) =>
          Promise.resolve(
            query === "TODO"
              ? [
                  {
                    path: "chapters/introduction.tex",
                    contents: "Intro line\n% TODO: add motivation cite\n",
                    mtimeMs: 1
                  }
                ]
              : query === "citation needed"
                ? [
                    {
                      path: "chapters/related.tex",
                      contents: "Prior work discussion. citation needed\n",
                      mtimeMs: 1
                    }
                  ]
                : query === "placeholder"
                  ? [
                      {
                        path: "chapters/results.tex",
                        contents: "Placeholder table caption\n",
                        mtimeMs: 1
                      }
                    ]
                  : []
          )
      }
    );

    expect(response).toContain("Checklist: found 3 unresolved");
    expect(response).toContain("chapters/introduction.tex:2 [TODO]");
    expect(response).toContain("chapters/related.tex:1 [citation needed]");
    expect(response).toContain("chapters/results.tex:1 [placeholder]");
    expect(response).toContain(
      "Build outputs and internal .latex-agent state are excluded"
    );
  });

  it("formats an attached submission checklist into a prioritized read-only response", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Inspect this LaTeX project for submission readiness.",
          "",
          "- error: Selected main .tex file is missing. (main.tex)",
          "- warning: Generated build artifact is present in the source tree. (.latex-agent/build/main.log)",
          "- info: No submission issues found in the local bundle check."
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: "",
        mtimeMs: 1
      },
      {
        readFile: () => Promise.resolve({ path: "main.tex", contents: "", mtimeMs: 1 }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Submission checklist:");
    expect(response).toContain("Blockers:");
    expect(response).toContain("Warnings:");
    expect(response).toContain("Export the source ZIP");
  });

  it("diagnoses a missing figure path from local project evidence only", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Why is figures/model.png missing in the PDF output?",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{article}",
          "\\usepackage{graphicx}",
          "\\begin{document}",
          "\\includegraphics[width=0.6\\linewidth]{figures/model.png}",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents: [
              "\\documentclass{article}",
              "\\usepackage{graphicx}",
              "\\begin{document}",
              "\\includegraphics[width=0.6\\linewidth]{figures/model.png}",
              "\\end{document}",
              ""
            ].join("\n"),
            mtimeMs: 1
          }),
        searchProject: (query) =>
          Promise.resolve(
            query === "model"
              ? [{ path: "assets/model.png", contents: "", mtimeMs: 1 }]
              : []
          )
      }
    );

    expect(response).toContain("Figure diagnosis:");
    expect(response).toContain("figures/model.png");
    expect(response).toContain("assets/model.png");
    expect(response).toContain("I will not fetch images from the network");
  });

  it("explains a proposed booktabs package hunk without applying edits", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Explain this proposed change hunk using the current source and any attached diagnostic context. Do not apply new edits.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText: [
          "@@ -1,3 +1,4 @@",
          " \\documentclass{article}",
          "+\\usepackage{booktabs}"
        ].join("\n")
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{article}",
          "\\usepackage{booktabs}",
          "\\begin{document}",
          "\\begin{tabular}{lr}",
          "\\toprule",
          "A & B \\\\",
          "\\bottomrule",
          "\\end{tabular}",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: () => Promise.resolve({ path: "main.tex", contents: "", mtimeMs: 1 }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain(
      "Change explanation: the proposed hunk adds `\\usepackage{booktabs}`"
    );
    expect(response).toContain("\\toprule");
    expect(response).toContain("read-only");
    expect(response).toContain("does not approve, reject, or apply any new edit");
  });

  it("explains numbering mismatch from label placement before caption", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Explain why Figure 3 is referenced before Figure 2.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{article}",
          "\\begin{document}",
          "\\begin{figure}[ht]",
          "\\label{fig:overview}",
          "\\caption{Overview}",
          "\\includegraphics{figures/overview.png}",
          "\\end{figure}",
          "\\begin{figure}[ht]",
          "\\caption{Results}",
          "\\label{fig:results}",
          "\\includegraphics{figures/results.png}",
          "\\end{figure}",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents: "",
            mtimeMs: 1
          }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Source order:");
    expect(response).toContain("Label placement issue:");
    expect(response).toContain("\\label before \\caption");
    expect(response).toContain("previous figure number");
  });

  it("produces a prioritized final formatting review checklist from attached and source evidence", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Final PDF formatting review before submission.",
          "- warning: Generated build artifact is present in the source tree. (.latex-agent/build/main.log)",
          "- warning: Missing citation key missing2026 referenced by \\cite{missing2026}. (main.tex:14)",
          "- warning: Unused bibliography entry smith2024. (references.bib:22)",
          "- info: No submission issues found in the local bundle check."
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: [
          "\\documentclass{article}",
          "\\usepackage{graphicx}",
          "\\begin{document}",
          "\\begin{figure}[ht]",
          "\\includegraphics{figures/missing.png}",
          "\\caption{System overview}",
          "\\end{figure}",
          "\\begin{table}[ht]",
          "\\centering",
          "\\begin{tabular}{lrrrrrr}",
          "A & 1 & 2 & 3 & 4 & 5 & 6 \\\\",
          "\\end{tabular}",
          "\\end{table}",
          "% TODO: verify final appendix order",
          "\\end{document}",
          ""
        ].join("\n"),
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents: [
              "\\documentclass{article}",
              "\\usepackage{graphicx}",
              "\\begin{document}",
              "\\begin{figure}[ht]",
              "\\includegraphics{figures/missing.png}",
              "\\caption{System overview}",
              "\\end{figure}",
              "\\begin{table}[ht]",
              "\\centering",
              "\\begin{tabular}{lrrrrrr}",
              "A & 1 & 2 & 3 & 4 & 5 & 6 \\\\",
              "\\end{tabular}",
              "\\end{table}",
              "% TODO: verify final appendix order",
              "\\end{document}",
              ""
            ].join("\n"),
            mtimeMs: 1
          }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Evidence basis:");
    expect(response).toContain("Priority 1 blockers:");
    expect(response).toContain("Missing local figure asset referenced by source");
    expect(response).toContain("Priority 2 warnings:");
    expect(response).toContain("Wide table may need width review");
    expect(response).toContain("Missing citation key missing2026");
    expect(response).toContain("Unused bibliography entry smith2024");
    expect(response).toContain("Priority 3 polish:");
    expect(response).toContain("review checklist only");
  });

  it("suggests only local bibliography candidates for uncited-claim prompts", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Suggest where citations should be added in the active LaTeX file.",
          "Use only the local bibliography entries below.",
          "",
          "Local bibliography entries:",
          "smith2024 | title=Robust Local Editing | author=Smith, Ada | year=2024",
          "lamport1994 | title=LaTeX: A Document Preparation System | author=Lamport, Leslie | year=1994"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents: "",
        mtimeMs: 1
      },
      {
        readFile: () => Promise.resolve({ path: "main.tex", contents: "", mtimeMs: 1 }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Citation suggestions:");
    expect(response).toContain("Candidate local sources:");
    expect(response).toContain("smith2024");
    expect(response).toContain("lamport1994");
    expect(response).toContain("instead of inventing a citation");
  });

  it("explains whether an attached unused reference still fits the active manuscript", async () => {
    const response = await createReadOnlyAgentResponse(
      {
        providerId: "mock",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Use only the attached bibliography entry below.",
          "Suggest where this source fits in the active LaTeX file, preferably in related work if that context is present.",
          "Use the citation command \\cite{unused2026} unless the project style clearly requires a local variant.",
          "Do not invent or mention unavailable bibliography keys; the only attached key is unused2026.",
          "",
          "Attached bibliography entry:",
          "title=Robust Local Editing",
          "author=Smith, Ada",
          "year=2026"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      {
        path: "main.tex",
        contents:
          "This section discusses robust local editing workflows in related work.",
        mtimeMs: 1
      },
      {
        readFile: () =>
          Promise.resolve({
            path: "main.tex",
            contents:
              "This section discusses robust local editing workflows in related work.",
            mtimeMs: 1
          }),
        searchProject: () => Promise.resolve([])
      }
    );

    expect(response).toContain("Unused-reference review for unused2026");
    expect(response).toContain("overlapping terms include");
    expect(response).toContain("related work");
  });
});
