import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatAgentImageAttachmentsForPrompt,
  formatAgentSelectionContextForPrompt
} from "@latex-agent/ipc-contracts";
import type {
  AgentAuthStatus,
  AgentDeleteEntryOperation,
  AgentEvent,
  AgentMoveEntryOperation,
  AgentProviderId,
  AgentSessionResult,
  AgentStartRequest,
  AgentToolCallEvent,
  AgentToolName,
  AgentToolRisk,
  BuildResult,
  HistoryChangeSet,
  PdfPreviewCaptureResult,
  ProjectFileSnapshot,
  WordBlockOperation,
  WordChangeSet,
  WordStructureNode,
  WordTableCellRef
} from "@latex-agent/ipc-contracts";

import {
  createEmptyDesignWorkflowOutput,
  designWorkflowOutputSchema,
  isValidDesignWorkflowOutput,
  type DesignWorkflowOutput
} from "./design-workflow.js";

export {
  createOpenRouterChatCompletionRunner,
  getDefaultOpenRouterDesignModels,
  openRouterDesignProviderId,
  OpenRouterDesignProvider,
  OpenRouterDesignWorkflowRunner,
  openRouterDesignWorkflowStepDefinitions,
  type OpenRouterChatMessage,
  type OpenRouterDesignModelMap,
  type OpenRouterDesignStepInput,
  type OpenRouterDesignStepResult,
  type OpenRouterDesignWorkflowInput,
  type OpenRouterDesignWorkflowResult,
  type OpenRouterDesignProviderOptions,
  type OpenRouterHttpRunnerOptions,
  type OpenRouterStructuredCallRequest,
  type OpenRouterStructuredCallRunner
} from "./openrouter-design-workflow.js";

export const openAiCodexProviderId = "openai-codex" as const;
const defaultCodexExecTimeoutMs = 7_200_000;
const defaultCodexProgressHeartbeatMs = 15_000;
const maxCodexPlannerAttempts = 2;
const maxCodexCompileRepairAttempts = 2;
const codexPathEnvName = "LATEX_AGENT_CODEX_BIN";
const commonProviderCliDirs = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/Library/TeX/texbin"
] as const;

export type CodexCliToolBroker = {
  readonly emitEvent?: (event: AgentEvent) => void;
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
  readonly capturePdfPreview?: () => Promise<PdfPreviewCaptureResult>;
  readonly deleteEntry?: (path: string) => Promise<AgentDeleteEntryOperation>;
  readonly moveEntry?: (
    fromPath: string,
    toPath: string
  ) => Promise<AgentMoveEntryOperation>;
  readonly setMainFile?: (path: string) => Promise<{ readonly path: string }>;
  readonly runCompile?: () => Promise<BuildResult>;
  readonly proposePatch: (
    filePath: string,
    beforeContents: string,
    afterContents: string,
    summary: string
  ) => Promise<HistoryChangeSet>;
  readonly applyPatch?: (changesetId: string) => Promise<HistoryChangeSet>;
};

export type CodexExecRequest = {
  readonly onCodexEvent?: (event: unknown) => void;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly sandboxMode?: CodexExecSandboxMode;
  readonly timeoutMs: number;
};

export type CodexExecSandboxMode = "read-only" | "workspace-write";

export type CodexAgentPatch = {
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
};

export type CodexAgentWordChangeSet = {
  readonly filePath: string;
  readonly summary: string;
  readonly operations: readonly WordBlockOperation[];
};

export type CodexAgentResponse = {
  readonly action:
    | "answer"
    | "patch"
    | "word-edit"
    | "delete-entry"
    | "move-entry"
    | "set-main-file"
    | "capture-pdf-preview"
    | "run-compile";
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
  readonly patches?: readonly CodexAgentPatch[];
  readonly wordChangesets?: readonly CodexAgentWordChangeSet[];
  readonly designWorkflow?: DesignWorkflowOutput;
  readonly message: string;
  readonly notes: string;
};

export type CodexCliAuthStatus = {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
};

export type CodexExecRunner = (
  request: CodexExecRequest
) => Promise<CodexAgentResponse>;

export type CodexAuthStatusRunner = () => Promise<CodexCliAuthStatus>;

export type CodexCliProviderOptions = {
  readonly codexBinary?: string;
  readonly progressHeartbeatMs?: number;
  readonly timeoutMs?: number;
  readonly runCodexExec?: CodexExecRunner;
  readonly getCliAuthStatus?: CodexAuthStatusRunner;
};

export class CodexCliProvider {
  readonly id: AgentProviderId = openAiCodexProviderId;
  private readonly codexBinary: string;
  private readonly progressHeartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly runCodexExec: CodexExecRunner;
  private readonly getCliAuthStatus: CodexAuthStatusRunner;
  private readonly cancelledSessionIds = new Set<string>();

  constructor(options: CodexCliProviderOptions = {}) {
    this.codexBinary =
      options.codexBinary ?? getConfiguredCliBinary(codexPathEnvName, "codex");
    this.progressHeartbeatMs =
      options.progressHeartbeatMs ?? defaultCodexProgressHeartbeatMs;
    this.timeoutMs = options.timeoutMs ?? defaultCodexExecTimeoutMs;
    this.runCodexExec =
      options.runCodexExec ?? ((request) => runCodexExec(this.codexBinary, request));
    this.getCliAuthStatus =
      options.getCliAuthStatus ?? (() => getCodexCliAuthStatus(this.codexBinary));
  }

  async getAuthStatus(): Promise<AgentAuthStatus> {
    try {
      const authStatus = await this.getCliAuthStatus();

      if (!authStatus.loggedIn) {
        return {
          providerId: this.id,
          state: "needs-auth",
          message: "Run `codex login` in a terminal to connect Codex CLI."
        };
      }

      return {
        providerId: this.id,
        state: "connected",
        message: `Codex CLI is logged in${formatAuthMethod(authStatus.authMethod)}.`
      };
    } catch (error) {
      return {
        providerId: this.id,
        state: "error",
        message: getErrorMessage(error)
      };
    }
  }

  async startSession(
    request: AgentStartRequest,
    broker: CodexCliToolBroker
  ): Promise<AgentSessionResult> {
    const sessionId = getRequestedSessionId(request) ?? randomUUID();
    const events: AgentEvent[] = [
      createMessageEvent(sessionId, "user", request.prompt),
      createMessageEvent(
        sessionId,
        "assistant",
        request.mode === "autonomous-local"
          ? "I will ask the installed Codex CLI to edit the open project directly and then verify the result through ZeroLeaf."
          : "I will ask the installed Codex CLI to inspect the project and decide whether to answer or propose a reviewable patch."
      )
    ];
    const activeDocumentSnapshot = createActiveDocumentSnapshot(request);
    const targetPath = request.activeFilePath ?? request.mainFilePath;
    const snapshot =
      activeDocumentSnapshot ??
      (targetPath === undefined
        ? createEmptyProjectSnapshot()
        : await readInitialSnapshot({ broker, events, sessionId, targetPath }));

    pushAgentEvents(
      events,
      broker,
      createToolEvent(
        sessionId,
        "codex-exec",
        "running",
        "Running installed Codex CLI in project planning mode",
        "medium"
      )
    );
    let codexResponse = await this.runPlannerWithRetry(
      request,
      snapshot,
      createInitialCodexPrompt(request, snapshot),
      events,
      sessionId,
      broker
    );
    pushAgentEvents(
      events,
      broker,
      createToolEvent(
        sessionId,
        "codex-exec",
        "succeeded",
        codexResponse.notes,
        "medium"
      )
    );

    if (shouldRetryForConcreteAction(request, codexResponse)) {
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          "Codex returned guidance for a concrete change; requesting a tool action",
          "medium"
        )
      );
      codexResponse = await this.runPlannerWithRetry(
        request,
        snapshot,
        createCodexPatchRetryPrompt(request, snapshot, codexResponse),
        events,
        sessionId,
        broker
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "succeeded",
          codexResponse.notes,
          "medium"
        )
      );
    }

    if (this.cancelledSessionIds.has(sessionId)) {
      return {
        sessionId,
        providerId: this.id,
        status: "cancelled",
        events
      };
    }

    if (codexResponse.action === "capture-pdf-preview") {
      if (broker.capturePdfPreview === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              codexResponse.message,
              "Codex requested a rendered PDF preview screenshot, but this provider bridge cannot run that app tool."
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "capture-pdf-preview",
          "running",
          "Capturing the rendered PDF preview pane",
          "low"
        )
      );
      const previewCapture = await broker.capturePdfPreview();
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "capture-pdf-preview",
          "succeeded",
          `Captured PDF preview page ${previewCapture.pageNumber} / ${previewCapture.pageCount}`,
          "low"
        ),
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          "Asking Codex to assess the captured PDF preview evidence",
          "medium"
        )
      );

      codexResponse = await this.runPlannerWithRetry(
        request,
        snapshot,
        createCodexPdfPreviewAssessmentPrompt(request, snapshot, previewCapture),
        events,
        sessionId,
        broker
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "succeeded",
          codexResponse.notes,
          "medium"
        )
      );

      if (codexResponse.action === "capture-pdf-preview") {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              codexResponse.message,
              `PDF preview screenshot captured at ${previewCapture.imagePath}, but Codex did not return a final assessment action.`
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }
    }

    if (
      codexResponse.action === "answer" ||
      (request.mode === "read-only" && codexResponse.action === "patch")
    ) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          codexResponse.action === "patch"
            ? [
                codexResponse.message,
                "Codex identified a possible source edit, but the current agent mode is read-only. Switch to review mode if you want a patch."
              ]
                .filter((line) => line.trim().length > 0)
                .join("\n\n")
            : codexResponse.message
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: getDesignWorkflow(codexResponse)
      };
    }

    if (codexResponse.action === "delete-entry") {
      if (
        request.mode === "read-only" ||
        request.mode === "suggest" ||
        broker.deleteEntry === undefined ||
        codexResponse.targetFilePath.trim().length === 0
      ) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              codexResponse.message,
              request.mode === "read-only" || request.mode === "suggest"
                ? "Codex identified a project file deletion, but the current agent mode cannot delete project entries."
                : broker.deleteEntry === undefined
                  ? "Codex identified a project file deletion, but this provider bridge cannot run that app tool."
                  : "Codex identified a project file deletion, but did not provide a project path."
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      const deletePath = codexResponse.targetFilePath.trim();

      if (request.mode === "autonomous-local") {
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "delete-entry",
            "running",
            `Deleting ${deletePath}`,
            "high"
          )
        );
        const deletedEntry = await broker.deleteEntry(deletePath);
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "delete-entry",
            "succeeded",
            `Deleted ${deletedEntry.path}`,
            "high"
          ),
          createMessageEvent(
            sessionId,
            "assistant",
            codexResponse.message || `Deleted ${deletedEntry.path}.`
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          deleteEntries: [deletedEntry]
        };
      }

      pushAgentEvents(
        events,
        broker,
        createMessageEvent(
          sessionId,
          "assistant",
          codexResponse.message || `I can delete ${deletePath} after your approval.`
        ),
        createApprovalEvent(
          sessionId,
          "delete-entry",
          `Delete ${deletePath} from the project? A local backup will be kept.`
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "awaiting-approval",
        events,
        deleteEntries: [{ path: deletePath }]
      };
    }

    if (codexResponse.action === "set-main-file") {
      if (request.mode === "read-only" || broker.setMainFile === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              codexResponse.message,
              request.mode === "read-only"
                ? "Codex identified an app-level main-file change, but the current agent mode is read-only."
                : "Codex identified an app-level main-file change, but this provider bridge cannot run that app tool."
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "set-main-file",
          "running",
          `Setting main TeX file to ${codexResponse.targetFilePath}`,
          "high"
        )
      );
      const result = await broker.setMainFile(codexResponse.targetFilePath);
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "set-main-file",
          "succeeded",
          `Main TeX file is now ${result.path}`,
          "high"
        ),
        createMessageEvent(
          sessionId,
          "assistant",
          codexResponse.message || `Set the main TeX file to ${result.path}.`
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    if (codexResponse.action === "move-entry") {
      const destinationPath = codexResponse.afterContents.trim();

      if (
        request.mode === "read-only" ||
        broker.moveEntry === undefined ||
        destinationPath.length === 0
      ) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              codexResponse.message,
              request.mode === "read-only"
                ? "Codex identified a project file move, but the current agent mode is read-only."
                : broker.moveEntry === undefined
                  ? "Codex identified a project file move, but this provider bridge cannot run that app tool."
                  : "Codex identified a project file move, but did not provide a destination path."
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "move-entry",
          "running",
          `Moving ${codexResponse.targetFilePath} to ${destinationPath}`,
          "high"
        )
      );
      const moveResult = await broker.moveEntry(
        codexResponse.targetFilePath,
        destinationPath
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "move-entry",
          "succeeded",
          `Moved ${moveResult.fromPath} to ${moveResult.toPath}`,
          "high"
        ),
        createMessageEvent(
          sessionId,
          "assistant",
          codexResponse.message ||
            `Moved ${moveResult.fromPath} to ${moveResult.toPath}.`
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        moveEntries: [moveResult]
      };
    }

    if (codexResponse.action === "run-compile") {
      if (request.mode === "read-only" || broker.runCompile === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            request.mode === "read-only"
              ? "Codex identified a compile request, but the current agent mode is read-only."
              : "Codex identified a compile request, but this provider bridge cannot run the app compile tool."
          )
        );
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "run-compile",
          "running",
          "Running LaTeX compile through ZeroLeaf",
          "medium"
        )
      );
      const buildResult = await broker.runCompile();
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "run-compile",
          buildResult.status === "succeeded" ? "succeeded" : "failed",
          `Compile ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}`,
          "medium"
        ),
        createVerificationEvent(
          sessionId,
          buildResult.status === "succeeded" ? "passed" : "failed",
          `Compile ${buildResult.status}.`,
          buildResult.jobId
        )
      );

      if (
        buildResult.status === "failed" &&
        request.mode === "autonomous-local" &&
        broker.applyPatch !== undefined
      ) {
        return await this.repairFailedCompile({
          broker,
          buildResult,
          events,
          request,
          sessionId,
          snapshot
        });
      }

      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          formatCompileActionMessage(codexResponse, buildResult)
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: getDesignWorkflow(codexResponse),
        buildResult
      };
    }

    const wordChangeSets = createCodexWordChangeSets(request, codexResponse);
    if (wordChangeSets.length > 0) {
      const wordChangeset = wordChangeSets[0];
      if (wordChangeset === undefined) {
        throw new Error("Codex returned an empty Word changeset list.");
      }

      pushAgentEvents(
        events,
        broker,
        ...wordChangeSets.map((changeset) =>
          createWordChangeSetEvent(sessionId, changeset)
        )
      );
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          request.mode === "autonomous-local"
            ? `I prepared ${wordChangeSets.length} Word edit${wordChangeSets.length === 1 ? "" : "s"} for ZeroLeaf to apply directly.`
            : codexResponse.message ||
                `Codex proposed ${wordChangeSets.length} Word edit${wordChangeSets.length === 1 ? "" : "s"}.`
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: getDesignWorkflow(codexResponse),
        wordChangeset,
        wordChangesets: wordChangeSets
      };
    }

    const patchPlan = await this.preparePatchChangeSets({
      broker,
      codexResponse,
      events,
      request,
      sessionId,
      snapshot
    });

    if ("result" in patchPlan) {
      return patchPlan.result;
    }

    const { changeSets, codexResponse: finalCodexResponse } = patchPlan;
    const primaryChangeSet = changeSets[0];
    const isMultiPatch = changeSets.length > 1;

    if (primaryChangeSet === undefined) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          finalCodexResponse.message ||
            "Codex did not propose a file change for this request."
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: getDesignWorkflow(finalCodexResponse)
      };
    }

    if (request.mode === "autonomous-local" && broker.applyPatch !== undefined) {
      const appliedChangeSets: HistoryChangeSet[] = [];

      for (const changeset of changeSets) {
        pushAgentEvents(
          events,
          broker,
          createPatchEvent(sessionId, changeset),
          createToolEvent(
            sessionId,
            "apply-patch",
            "running",
            `Applying ${changeset.summary}`,
            "high"
          )
        );
        const applied = await broker.applyPatch(changeset.id);
        appliedChangeSets.push(applied);
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "apply-patch",
            "succeeded",
            `Applied ${applied.summary}`,
            "high"
          ),
          createPatchEvent(sessionId, applied)
        );
      }

      const primaryAppliedChangeSet =
        appliedChangeSets.find((changeset) => changeset.id === primaryChangeSet.id) ??
        appliedChangeSets[0] ??
        primaryChangeSet;

      if (broker.runCompile === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            `${finalCodexResponse.message}\n\nApplied the patch, but this provider bridge cannot run compile verification.`
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          designWorkflow: getDesignWorkflow(finalCodexResponse),
          changeset: primaryAppliedChangeSet,
          ...(isMultiPatch ? { changesets: appliedChangeSets } : {})
        };
      }

      pushAgentEvents(
        events,
        broker,
        createVerificationEvent(
          sessionId,
          "running",
          "Compile verification started after Codex applied the patch."
        ),
        createToolEvent(
          sessionId,
          "run-compile",
          "running",
          "Running compile verification",
          "medium"
        )
      );
      const buildResult = await broker.runCompile();
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "run-compile",
          buildResult.status === "succeeded" ? "succeeded" : "failed",
          `Compile ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}`,
          "medium"
        ),
        createVerificationEvent(
          sessionId,
          buildResult.status === "succeeded" ? "passed" : "failed",
          `Compile verification ${buildResult.status} with ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}.`,
          buildResult.jobId
        ),
        createMessageEvent(
          sessionId,
          "assistant",
          [
            finalCodexResponse.message,
            finalCodexResponse.message.trim().length === 0
              ? "I applied the edit and ran compile verification."
              : ""
          ]
            .filter((line) => line.trim().length > 0)
            .join("\n\n")
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: getDesignWorkflow(finalCodexResponse),
        changeset: primaryAppliedChangeSet,
        ...(isMultiPatch ? { changesets: appliedChangeSets } : {}),
        buildResult
      };
    }

    pushAgentEvents(
      events,
      broker,
      ...changeSets.map((changeset) => createPatchEvent(sessionId, changeset)),
      createApprovalEvent(
        sessionId,
        "apply-patch",
        isMultiPatch
          ? "Review the Codex patches before applying them to the project."
          : "Review the Codex patch before applying it to the project."
      ),
      createVerificationEvent(
        sessionId,
        "pending",
        isMultiPatch
          ? "Apply the Codex patches to start compile verification."
          : "Apply the Codex patch to start compile verification."
      )
    );

    return {
      sessionId,
      providerId: this.id,
      status: "awaiting-approval",
      events,
      designWorkflow: getDesignWorkflow(finalCodexResponse),
      changeset: primaryChangeSet,
      ...(isMultiPatch ? { changesets: changeSets } : {})
    };
  }

  private async preparePatchChangeSets({
    broker,
    codexResponse,
    events,
    request,
    sessionId,
    snapshot
  }: {
    readonly broker: CodexCliToolBroker;
    readonly codexResponse: CodexAgentResponse;
    readonly events: AgentEvent[];
    readonly request: AgentStartRequest;
    readonly sessionId: string;
    readonly snapshot: ProjectFileSnapshot;
  }): Promise<
    | {
        readonly codexResponse: CodexAgentResponse;
        readonly changeSets: readonly HistoryChangeSet[];
      }
    | { readonly result: AgentSessionResult }
  > {
    let finalResponse = codexResponse;
    let patchSnapshots = await readCodexPatchSnapshots(finalResponse, snapshot, broker);
    const overbroadPatch = patchSnapshots.find((candidate) =>
      isLikelyOverbroadPatch(candidate.snapshot.contents, candidate.patch.afterContents)
    );

    if (overbroadPatch !== undefined) {
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          "Codex returned a patch that removed most of a large file; requesting a complete minimal patch",
          "medium"
        )
      );
      finalResponse = await this.runPlannerWithRetry(
        request,
        overbroadPatch.snapshot,
        createCodexOverbroadPatchRetryPrompt(
          request,
          overbroadPatch.snapshot,
          finalResponse
        ),
        events,
        sessionId,
        broker
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "succeeded",
          finalResponse.notes,
          "medium"
        )
      );

      if (finalResponse.action !== "patch") {
        events.push(createMessageEvent(sessionId, "assistant", finalResponse.message));
        return {
          result: {
            sessionId,
            providerId: this.id,
            status: "completed",
            events
          }
        };
      }

      patchSnapshots = await readCodexPatchSnapshots(finalResponse, snapshot, broker);

      if (
        patchSnapshots.some((candidate) =>
          isLikelyOverbroadPatch(
            candidate.snapshot.contents,
            candidate.patch.afterContents
          )
        )
      ) {
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "propose-patch",
            "blocked",
            "Codex returned a patch that removed most of a large file, so ZeroLeaf did not apply it.",
            "high"
          ),
          createMessageEvent(
            sessionId,
            "assistant",
            "Codex returned a patch that removed too much of the file, so I did not apply it. Please ask for a narrower edit or select the exact lines to change."
          )
        );

        return {
          result: {
            sessionId,
            providerId: this.id,
            status: "completed",
            events
          }
        };
      }
    }

    const changedPatchSnapshots = patchSnapshots.filter(
      (candidate) => candidate.patch.afterContents !== candidate.snapshot.contents
    );
    const changeSets: HistoryChangeSet[] = [];

    for (const candidate of changedPatchSnapshots) {
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "propose-patch",
          "running",
          `Creating review patch for ${candidate.snapshot.path}`,
          "medium"
        )
      );
      const changeset = await broker.proposePatch(
        candidate.snapshot.path,
        candidate.snapshot.contents,
        candidate.patch.afterContents,
        normalizeSummary(candidate.patch.summary || finalResponse.summary)
      );
      changeSets.push(changeset);
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "propose-patch",
          "succeeded",
          `Created changeset ${changeset.id}`,
          "medium"
        )
      );
    }

    return { codexResponse: finalResponse, changeSets };
  }

  cancelSession(sessionId: string): Promise<boolean> {
    this.cancelledSessionIds.add(sessionId);
    return Promise.resolve(true);
  }

  private async runPlannerWithRetry(
    request: AgentStartRequest,
    snapshot: ProjectFileSnapshot,
    prompt: string,
    events: AgentEvent[],
    sessionId: string,
    broker?: CodexCliToolBroker
  ): Promise<CodexAgentResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxCodexPlannerAttempts; attempt += 1) {
      try {
        return await this.runCodexExecWithProgress(
          {
            projectRoot: request.projectRoot,
            sandboxMode:
              request.mode === "autonomous-local" ? "workspace-write" : "read-only",
            ...(broker === undefined
              ? {}
              : {
                  onCodexEvent: (event: unknown) =>
                    emitCodexPublicEvents(event, sessionId, broker)
                }),
            timeoutMs: this.timeoutMs,
            prompt:
              attempt === 1
                ? prompt
                : createCodexInterruptedRetryPrompt(request, snapshot, lastError)
          },
          sessionId,
          broker
        );
      } catch (error) {
        lastError = error;

        if (attempt >= maxCodexPlannerAttempts || !isRetryableCodexExecError(error)) {
          throw error;
        }

        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "codex-exec",
            "failed",
            `${formatPlannerFailure(error)} Retrying with a narrower project-scoped prompt.`,
            "medium"
          ),
          createToolEvent(
            sessionId,
            "codex-exec",
            "running",
            "Retrying Codex planner with focused project context",
            "medium"
          )
        );
      }
    }

    throw lastError;
  }

  private async runCodexExecWithProgress(
    request: CodexExecRequest,
    sessionId: string,
    broker?: CodexCliToolBroker
  ): Promise<CodexAgentResponse> {
    if (this.progressHeartbeatMs <= 0 || broker?.emitEvent === undefined) {
      return await this.runCodexExec(request);
    }

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      pushAgentEvents(
        undefined,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          `Codex CLI is still analyzing the project (${formatElapsedDuration(Date.now() - startedAt)} elapsed).`,
          "medium"
        )
      );
    }, this.progressHeartbeatMs);

    try {
      return await this.runCodexExec(request);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async repairFailedCompile({
    broker,
    buildResult,
    events,
    request,
    sessionId,
    snapshot
  }: {
    readonly broker: CodexCliToolBroker;
    readonly buildResult: BuildResult;
    readonly events: AgentEvent[];
    readonly request: AgentStartRequest;
    readonly sessionId: string;
    readonly snapshot: ProjectFileSnapshot;
  }): Promise<AgentSessionResult> {
    let latestBuild = buildResult;
    let latestChangeSet: HistoryChangeSet | undefined;
    let currentSnapshot = snapshot;

    for (let attempt = 1; attempt <= maxCodexCompileRepairAttempts; attempt += 1) {
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          `Compile failed; asking Codex to repair the LaTeX error (attempt ${attempt} of ${maxCodexCompileRepairAttempts})`,
          "medium"
        )
      );
      let repairResponse = await this.runPlannerWithRetry(
        request,
        currentSnapshot,
        createCodexCompileRepairPrompt(request, currentSnapshot, latestBuild, attempt),
        events,
        sessionId,
        broker
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "codex-exec",
          "succeeded",
          repairResponse.notes,
          "medium"
        )
      );

      if (repairResponse.action !== "patch") {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              "Compile failed, and Codex did not return a safe source patch.",
              repairResponse.message,
              formatCompileMessage(latestBuild)
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
          buildResult: latestBuild
        };
      }

      let patchSnapshot =
        repairResponse.targetFilePath === currentSnapshot.path
          ? currentSnapshot
          : await broker.readFile(repairResponse.targetFilePath);

      if (
        isLikelyOverbroadPatch(patchSnapshot.contents, repairResponse.afterContents)
      ) {
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "codex-exec",
            "running",
            "Codex returned a repair patch that removed most of a large file; requesting a complete minimal patch",
            "medium"
          )
        );
        repairResponse = await this.runPlannerWithRetry(
          request,
          patchSnapshot,
          createCodexOverbroadPatchRetryPrompt(request, patchSnapshot, repairResponse),
          events,
          sessionId,
          broker
        );
        pushAgentEvents(
          events,
          broker,
          createToolEvent(
            sessionId,
            "codex-exec",
            "succeeded",
            repairResponse.notes,
            "medium"
          )
        );

        if (repairResponse.action !== "patch") {
          events.push(
            createMessageEvent(
              sessionId,
              "assistant",
              [
                "Compile failed, and Codex did not return a complete repair patch.",
                repairResponse.message,
                formatCompileMessage(latestBuild)
              ]
                .filter((line) => line.trim().length > 0)
                .join("\n\n")
            )
          );

          return {
            sessionId,
            providerId: this.id,
            status: "completed",
            events,
            ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
            buildResult: latestBuild
          };
        }

        patchSnapshot =
          repairResponse.targetFilePath === currentSnapshot.path
            ? currentSnapshot
            : await broker.readFile(repairResponse.targetFilePath);

        if (
          isLikelyOverbroadPatch(patchSnapshot.contents, repairResponse.afterContents)
        ) {
          pushAgentEvents(
            events,
            broker,
            createToolEvent(
              sessionId,
              "propose-patch",
              "blocked",
              "Codex returned a repair patch that removed most of a large file, so ZeroLeaf did not apply it.",
              "high"
            ),
            createMessageEvent(
              sessionId,
              "assistant",
              [
                "Compile failed, and the proposed repair patch removed too much of the file, so I did not apply it.",
                formatCompileMessage(latestBuild)
              ].join("\n\n")
            )
          );

          return {
            sessionId,
            providerId: this.id,
            status: "completed",
            events,
            ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
            buildResult: latestBuild
          };
        }
      }

      if (repairResponse.afterContents === patchSnapshot.contents) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              repairResponse.message ||
                "Codex did not propose a source change for the compile failure.",
              formatCompileMessage(latestBuild)
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
          buildResult: latestBuild
        };
      }

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "propose-patch",
          "running",
          `Creating compile repair patch for ${patchSnapshot.path}`,
          "medium"
        )
      );
      const proposed = await broker.proposePatch(
        patchSnapshot.path,
        patchSnapshot.contents,
        repairResponse.afterContents,
        normalizeSummary(repairResponse.summary)
      );
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "propose-patch",
          "succeeded",
          `Created changeset ${proposed.id}`,
          "medium"
        ),
        createPatchEvent(sessionId, proposed),
        createToolEvent(
          sessionId,
          "apply-patch",
          "running",
          `Applying ${proposed.summary}`,
          "high"
        )
      );
      const applied = await broker.applyPatch?.(proposed.id);

      if (applied === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            "Codex prepared a compile repair patch, but this provider bridge cannot apply it automatically."
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "awaiting-approval",
          events,
          changeset: proposed,
          buildResult: latestBuild
        };
      }

      latestChangeSet = applied;
      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "apply-patch",
          "succeeded",
          `Applied ${applied.summary}`,
          "high"
        ),
        createPatchEvent(sessionId, applied),
        createVerificationEvent(
          sessionId,
          "running",
          `Recompile started after compile repair attempt ${attempt}.`
        ),
        createToolEvent(
          sessionId,
          "run-compile",
          "running",
          "Recompiling after Codex repair",
          "medium"
        )
      );

      const repairedBuild = await broker.runCompile?.();
      if (repairedBuild === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            "Applied the compile repair patch, but this provider bridge cannot recompile."
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          changeset: applied
        };
      }
      latestBuild = repairedBuild;

      pushAgentEvents(
        events,
        broker,
        createToolEvent(
          sessionId,
          "run-compile",
          latestBuild.status === "succeeded" ? "succeeded" : "failed",
          `Compile ${latestBuild.status} with ${latestBuild.diagnostics.length} diagnostic${latestBuild.diagnostics.length === 1 ? "" : "s"}`,
          "medium"
        ),
        createVerificationEvent(
          sessionId,
          latestBuild.status === "succeeded" ? "passed" : "failed",
          `Compile repair attempt ${attempt} ${latestBuild.status} with ${latestBuild.diagnostics.length} diagnostic${latestBuild.diagnostics.length === 1 ? "" : "s"}.`,
          latestBuild.jobId
        )
      );

      currentSnapshot = await broker.readFile(patchSnapshot.path);

      if (latestBuild.status === "succeeded") {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            [
              repairResponse.message,
              `I fixed the compile issue and recompiled successfully on repair attempt ${attempt}.`,
              formatCompileMessage(latestBuild)
            ]
              .filter((line) => line.trim().length > 0)
              .join("\n\n")
          )
        );

        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events,
          changeset: applied,
          buildResult: latestBuild
        };
      }
    }

    events.push(
      createMessageEvent(
        sessionId,
        "assistant",
        [
          `I attempted ${maxCodexCompileRepairAttempts} compile repair turns, but the build still fails.`,
          formatCompileMessage(latestBuild)
        ].join("\n\n")
      )
    );

    return {
      sessionId,
      providerId: this.id,
      status: "completed",
      events,
      ...(latestChangeSet === undefined ? {} : { changeset: latestChangeSet }),
      buildResult: latestBuild
    };
  }
}

function getConfiguredCliBinary(envName: string, binaryName: string): string {
  const configuredBinary = process.env[envName]?.trim();
  if (configuredBinary !== undefined && configuredBinary.length > 0) {
    return configuredBinary;
  }

  const locatedBinary = commonProviderCliDirs
    .map((directory) => join(directory, binaryName))
    .find((candidate) => existsSync(candidate));

  return locatedBinary ?? binaryName;
}

function createProviderCliEnv(): NodeJS.ProcessEnv {
  const existingPath = process.env.PATH ?? "";
  const pathEntries = existingPath.split(":").filter((entry) => entry.length > 0);
  const nextPath = Array.from(new Set([...commonProviderCliDirs, ...pathEntries])).join(
    ":"
  );

  return {
    ...process.env,
    PATH: nextPath
  };
}

async function getCodexCliAuthStatus(codexBinary: string): Promise<CodexCliAuthStatus> {
  try {
    const { stdout, stderr } = await runCommand(
      codexBinary,
      ["login", "status"],
      15_000
    );
    return parseCodexLoginStatus(`${stdout}\n${stderr}`);
  } catch (error) {
    const message = getErrorMessage(error);

    if (isLoggedOutCodexMessage(message)) {
      return { loggedIn: false };
    }

    throw error;
  }
}

async function runCodexExec(
  codexBinary: string,
  request: CodexExecRequest
): Promise<CodexAgentResponse> {
  const tempRoot = await mkdtemp(join(tmpdir(), "latex-codex-provider-"));
  const schemaPath = join(tempRoot, "codex-output.schema.json");
  const outputPath = join(tempRoot, "codex-output.json");

  try {
    await writeFile(schemaPath, JSON.stringify(codexOutputSchema, null, 2), "utf8");
    await runCommand(
      codexBinary,
      createCodexExecArgs(
        schemaPath,
        outputPath,
        request.projectRoot,
        request.sandboxMode ?? "read-only"
      ),
      request.timeoutMs,
      request.prompt,
      request.onCodexEvent
    );
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    return parseCodexAgentResponse(parsed);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function createCodexExecArgs(
  schemaPath: string,
  outputPath: string,
  projectRoot: string,
  sandboxMode: CodexExecSandboxMode = "read-only"
): readonly string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--json",
    "--sandbox",
    sandboxMode,
    "-c",
    'model_reasoning_effort="low"',
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-C",
    projectRoot,
    "-"
  ];
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
  onCodexEvent?: (event: unknown) => void
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: createProviderCliEnv(),
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stdoutLineBuffer = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      killTimer = setTimeout(() => {
        terminateProcessTree(child.pid, "SIGKILL");
      }, 5_000);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${command} timed out after ${Math.round(timeoutMs / 1000)} seconds. Try a narrower question or a smaller active file.`
          )
        );
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, 80_000);
      if (onCodexEvent !== undefined) {
        stdoutLineBuffer = processCodexJsonLines(
          stdoutLineBuffer + chunk,
          onCodexEvent
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, 160_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (settled || timedOut) {
        return;
      }
      if (onCodexEvent !== undefined && stdoutLineBuffer.trim().length > 0) {
        processCodexJsonLine(stdoutLineBuffer.trim(), onCodexEvent);
        stdoutLineBuffer = "";
      }

      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else if (code === null) {
        reject(
          new Error(
            `${command} was terminated${signal === null ? "" : ` by ${signal}`}: ${formatCodexFailureOutput(stderr || stdout)}`
          )
        );
      } else {
        reject(
          new Error(
            `${command} exited with ${code}: ${formatCodexFailureOutput(stderr || stdout)}`
          )
        );
      }
    });
    child.stdin.end(stdin ?? "");
  });
}

function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM"
) {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }

    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout and cleanup.
    }
  }
}

export function parseCodexLoginStatus(output: string): CodexCliAuthStatus {
  const trimmed = output.trim();
  const normalized = trimmed.toLowerCase();

  if (isLoggedOutCodexMessage(trimmed)) {
    return { loggedIn: false };
  }

  if (
    normalized.includes("logged in") ||
    normalized.includes("authenticated") ||
    normalized.includes("using chatgpt") ||
    normalized.includes("using api key")
  ) {
    const methodMatch = /^logged in using\s+(.+)$/imu.exec(trimmed);
    return {
      loggedIn: true,
      ...(methodMatch?.[1] === undefined ? {} : { authMethod: methodMatch[1].trim() })
    };
  }

  throw new Error("Codex login status did not report a recognizable auth state.");
}

function createCodexPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return [
    "You are the OpenAI Codex provider inside a local-first LaTeX editor.",
    "Use your own judgment to decide how to complete the user's task.",
    request.mode === "autonomous-local"
      ? 'You have full project-scoped access through Codex CLI tools: inspect, create, edit, overwrite, move, and delete files inside the current project root. Do not write outside the project root. For project-scoped edit requests, prefer direct file edits over returning review patches. After direct source edits, return action "run-compile" so ZeroLeaf can verify the result.'
      : "You may inspect the project from the current working directory. Do not modify files directly inside Codex CLI; return a ZeroLeaf action so the app can perform project-scoped changes safely.",
    "If a search command, regex, glob, or shell command fails, retry with a simpler literal search, list files, or read likely source files directly before concluding the task cannot be completed.",
    'Do not run LaTeX compile commands inside Codex CLI. For compile, recompile, build, or PDF generation requests, return action "run-compile" so ZeroLeaf can run its local build tool.',
    "Return only JSON matching the provided schema.",
    "The schema always requires a patches array. Use patches: [] for answers, single-file patches, and non-patch app actions.",
    "The schema always requires a wordChangesets array. Use wordChangesets: [] unless the active document is a Word .docx file and the user requested a Word edit.",
    'The schema always requires designWorkflow. For non-website, non-UI, and non-design tasks, return an empty design workflow with currentStep "none", steps [], qa status "blocked", codeGeneration status "not-started", and implementationQa status "not-run".',
    "For website or UI design tasks, fill designWorkflow as a section-by-section structured output: brand-story, information-architecture, creative-direction, section-design, responsive-layout, interaction-motion, accessibility-review, qa-review, code-generation, implementation-qa, and final-polish.",
    "Every step output.data must include every data key allowed by the schema. For keys that do not apply to the current step, use an empty string, empty array, or passNumber 0.",
    "For the brand-story step, output.data must not be empty. It must include brandName, businessType, positioning, audience, brandPromise, mood, storyPremise, sensoryAnchors, toneOfVoice, differentiators, and antiPatterns. toneOfVoice must include personality and copyRules arrays.",
    "For the information-architecture step, output.data must not hide IA details in prose. It must include websiteStoryArc, sectionsDetailed, sectionOrder, primaryUserPaths, ctaPriority, navigationModel, contentRequirements, and handoffToCreativeDirection. sectionsDetailed entries must include id, title, purpose, storyRole, primaryContent, cta, and requiredEvidence. primaryUserPaths entries must include id, audience, intent, steps, and conversionGoal. ctaPriority entries must include rank, label, targetSection, and intent.",
    "For the creative-direction step, output.data must not hide the visual system in palette or prose. It must include colorSystem, typographySystem, imageDirection, compositionPrinciples, spacingRhythm, textureMaterialRules, iconIllustrationRules, ctaSystem, motionMood, sectionProgression, and handoffToSectionDesign. colorSystem entries must include name, value, role, and usage. sectionProgression entries must include sectionId, visualRole, and treatment.",
    "For the section-design step, output.data must include sectionDesigns. Each sectionDesigns entry must include id, storyRole, layout, elements, visualAssets, assetPlacement, ctas, responsiveNotes, and acceptanceCriteria.",
    "For the responsive-layout step, output.data must include responsiveRules. Each responsiveRules entry must include viewport, layout, typography, navigation, assets, and constraints.",
    "For the interaction-motion step, output.data must include interactionRules. Each interactionRules entry must include trigger, target, feedback, motion, accessibility, and reducedMotion.",
    "For the accessibility-review step, output.data must include accessibilityChecks. Each accessibilityChecks entry must include id, target, requirement, method, status, and fix.",
    "For the qa-review step, report evidence-backed defects in qa.issues across visual-layout, responsive, content-quality, accessibility, interaction, brand-story, and performance. Include viewportResults for mobile, tablet, desktop, and wide-desktop when evidence exists, a concrete fixPlan, remainingIssueIds, stopCondition, and nextAction.",
    "For the code-generation step, fill codeGeneration with status, targetFiles, components, assets, constraints, implementationNotes, and acceptanceCriteria. Generate code only after the approved design QA state is pass or the remaining issues are explicitly accepted.",
    "For the implementation-qa step, fill implementationQa after code exists. Inspect the rendered implementation, build output, responsive behavior, accessibility, interaction behavior, performance risk, and content integrity. Use implementationQa.checks for runtime evidence and implementationQa.issues for defects.",
    "For the final-polish step, output.data must include polishChecks. Each polishChecks entry must include target, criterion, status, and recommendation.",
    "A design QA pass must not claim success without evidence. If visual inspection cannot run, mark unverified viewports as not-checked and explain the evidence gap in qa.stopCondition and message.",
    "An implementation QA pass must not claim success without rendered or build evidence. If runtime inspection cannot run, mark implementationQa status blocked and explain the evidence gap.",
    'When a design QA or implementation QA finding requires source changes and the mode allows edits, return action "patch" with a reviewable fix and set the relevant nextAction to "apply-fixes". When no edit is safe, use action "answer" and keep the fixPlan reviewable in designWorkflow.',
    'Set action to "answer" when the task is best completed by explanation, summary, review, diagnosis, or guidance.',
    'Use action "answer" for planning and scholarly-advice tasks such as literature review plans, paper outlines, manuscript critiques, reading plans, methodology suggestions, and submission checklists unless the user explicitly asks you to insert, rewrite, patch, compile, or change project files.',
    "A user mentioning a PDF, paper, thesis, manuscript, or active document as source context does not by itself require a file edit, PDF preview capture, or compile action.",
    'Set action to "patch" when the task requires or asks for one or more source edits. For a single-file patch, produce a minimal full-file replacement for targetFilePath.',
    "Requests to merge, combine, consolidate, split, reorganize, or restructure sections/subsections are source-edit requests. Do not answer with only a compile action unless you already made the source edit directly in autonomous-local mode.",
    'For multi-file edits, set action to "patch" and populate patches with one entry per changed file. Each patches entry must include targetFilePath, summary, and the complete afterContents for that file. Also copy the primary patch into the top-level targetFilePath, summary, and afterContents fields for compatibility.',
    'Set action to "delete-entry" when the user asks to remove or delete a project file or folder without editing source contents. Put the project path to delete in targetFilePath.',
    'Set action to "move-entry" when the task requires moving or renaming a project file without changing file contents. Put the current project path in targetFilePath and the destination project path in afterContents.',
    'Set action to "set-main-file" when the user asks to choose, change, set, or switch the project main/root TeX file without editing source contents. Put the desired .tex project path in targetFilePath.',
    'Set action to "capture-pdf-preview" when the user asks for visual assessment, rendered PDF layout review, screenshot inspection, figure/table ordering in the preview, clipping, overlap, or other PDF preview-only evidence. ZeroLeaf will capture the current PDF preview pane and ask you again with the screenshot path.',
    'Set action to "run-compile" when the user asks to compile, recompile, build, verify compilation, or generate/update the PDF.',
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". You may describe suggested edits in message, but do not return a patch action.'
      : request.mode === "autonomous-local"
        ? 'The current ZeroLeaf mode is autonomous-local. Use direct project-root edits for project-scoped file changes whenever possible, including multi-file edits and new project files. If no edit is needed, return action "answer". If direct editing is impossible, return a concrete ZeroLeaf action rather than stopping at a tool failure.'
        : 'ZeroLeaf will perform returned actions through project-scoped app tools. In "apply-with-review" mode, patches wait for user approval.',
    request.mode === "read-only"
      ? ""
      : 'For edit, change, rewrite, replace, insert, delete, merge, combine, consolidate, reorganize, restructure, fix, repair, compile, recompile, build, PDF generation, compile-error, failing-build, visual PDF review, and diagnostic tasks, return the concrete action whenever safe: "patch" for source edits, "delete-entry" for deleting project files or folders, "move-entry" for moving or renaming files, "set-main-file" for changing the project main TeX file, "capture-pdf-preview" for rendered preview evidence, and "run-compile" for builds. Do not stop at explaining the edit or app action.',
    "Write message like a person reporting back after doing the task: first person, concrete, concise, and warm. Say what you changed or checked, mention verification when relevant, and avoid generic boilerplate such as build-log directions.",
    "In message, always explain the result in user-facing terms: list the files or sections changed and the purpose of the change. If no source file changed, say why no change was made and do not imply that an edit happened.",
    "Preserve all unrelated text and formatting when returning a patch.",
    formatWordEditInstructions(request),
    "For patches, afterContents must be the complete target file after the edit, not a snippet, diff, abbreviated file, or only the changed section. Never omit unchanged content.",
    "When splitting embedded bibliography entries into a separate .bib file, return one patch for the .bib file and one patch for the TeX file that removes the embedded bibliography block and references the .bib file.",
    snapshot.path === newFileSnapshotPath
      ? 'No active TeX file is open. If the user asks to create a .tex file, return action "patch", choose a clear project-relative targetFilePath ending in .tex, set afterContents to the complete new file contents, and use an empty original file.'
      : "",
    snapshot.path === newFileSnapshotPath
      ? 'If the project root is empty and the user asks to create, start, make, or set up a project, treat the prompt as a project bootstrap request. Return action "patch" with complete file contents for every required project file in patches. Default to a compilable LaTeX project when the requested format is ambiguous. Include a main .tex file, and add supporting .bib, section, style, or README files only when they help satisfy the prompt.'
      : "",
    snapshot.path === newFileSnapshotPath
      ? "For a fresh project bootstrap, do not answer with instructions or ask the user to open a template picker. Decide the project structure from the prompt and return concrete project-relative file patches. Nested file paths are allowed when useful, but never use absolute paths or paths outside the project root."
      : "",
    request.selectedText === undefined
      ? ""
      : "The user selected text inside a containing paragraph. Use the paragraph as context. Change only that exact selected span unless the user explicitly asks for a broader paragraph rewrite; preserve all unrelated paragraphs, LaTeX commands, labels, references, and citations unless the user explicitly asks to change one.",
    request.selectedText === undefined
      ? ""
      : "For writing edits, do not add new claims or citations. If expanding rough notes into prose, preserve TODO lines that require user input instead of resolving them. If shortening an abstract, keep the abstract environment valid and preserve required contribution statements.",
    "For unbalanced-brace repairs, make the smallest syntax-only edit. If the error is inside a caption, balance the caption braces without rewriting the caption text.",
    "For table generation from pasted data, produce valid LaTeX using the project's existing table conventions when visible. Include a caption and label. If the table is wide, mention width/layout advice in notes.",
    "For terminology normalization, preserve citation keys, labels, file paths, BibTeX keys, and LaTeX command arguments. List domain-specific terms that need user confirmation in notes.",
    "For title and keyword requests, return afterContents exactly equal to the original file unless the user explicitly asks to apply a title patch. Put suggestions and their manuscript basis in notes.",
    'If no edit is needed, use action "answer" and put the user-facing answer in message.',
    "",
    `User task: ${request.prompt}`,
    formatApprovedNetworkContext(request),
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    formatAgentSelectionContextForPrompt(request) ?? "",
    formatAgentImageAttachmentsForPrompt(request),
    request.diagnostic === undefined
      ? ""
      : `Diagnostic: ${request.diagnostic.severity} ${request.diagnostic.filePath ?? ""}:${request.diagnostic.line ?? ""} ${request.diagnostic.message}`,
    formatActiveWordBlockContext(request),
    formatActiveWordStructureContext(request),
    "",
    `Active file preview (${snapshot.path}):`,
    request.activeDocument?.kind === "word" ? "```text" : "```tex",
    createSourcePreview(snapshot.contents),
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

const newFileSnapshotPath = "__new_file__.tex";

function createEmptyProjectSnapshot(): ProjectFileSnapshot {
  return {
    path: newFileSnapshotPath,
    contents: "",
    mtimeMs: Date.now()
  };
}

function createActiveDocumentSnapshot(
  request: AgentStartRequest
): ProjectFileSnapshot | undefined {
  if (request.activeDocument === undefined) {
    return undefined;
  }

  return {
    path: request.activeDocument.path,
    contents:
      request.activeDocument.kind === "word"
        ? request.activeDocument.plainText
        : request.activeDocument.contents,
    mtimeMs: Date.now()
  };
}

function formatWordEditInstructions(request: AgentStartRequest): string {
  if (request.activeDocument?.kind !== "word") {
    return "";
  }

  return [
    "The active document is a Microsoft Word .docx file represented as paragraph blocks.",
    'For Word edits, set action "word-edit", targetFilePath to the .docx path, afterContents to "", patches to [], and populate wordChangesets.',
    request.mode === "autonomous-local"
      ? "In autonomous-local mode, ZeroLeaf applies returned wordChangesets directly to the .docx and refreshes ONLYOFFICE. In your message, say you prepared the Word edit for ZeroLeaf to apply; do not claim the .docx changed inside Codex CLI."
      : "",
    "Do not return a raw .docx patch and do not create or edit .tex files for Word-document requests.",
    "Each paragraph operation must target one of the block IDs listed below. Each table operation must target one of the table IDs from the document structure section, using its 0-based row/column indices.",
    "A single wordChangeset's operations must be either ALL paragraph operations (replace-block, insert-block-after, delete-block, move-block, replace-selection) or ALL table operations (replace-table-cell, insert-table-row, delete-table-row, insert-table-column, delete-table-column, merge-table-cells) — never mixed in one changeset. Use separate changesets if you need both.",
    'For operation "replace-block", include type, blockId, afterText, and set afterBlockId, block, startOffset, endOffset, replacementText, tableId, rowIndex, columnIndex, anchorRowIndex, anchorColumnIndex, position, cells to null.',
    'For operation "insert-block-after", include type, afterBlockId, block { id, kind: "paragraph", text }, and set all other fields to null. Use afterBlockId null to insert at the beginning.',
    'For operation "delete-block", include type, blockId, and set all other fields to null.',
    'For operation "replace-selection", include type, blockId, startOffset, endOffset, replacementText, and set all other fields to null.',
    "Prefer replacing the existing blank or placeholder paragraph for the first substantial Word edit.",
    'For operation "replace-table-cell", include type, tableId, rowIndex, columnIndex, afterText, and set all other fields to null.',
    'For operation "insert-table-row", include type, tableId, anchorRowIndex, position ("before" or "after"), and set all other fields to null.',
    'For operation "delete-table-row", include type, tableId, rowIndex, and set all other fields to null.',
    'For operation "insert-table-column", include type, tableId, anchorColumnIndex, position ("before" or "after"), and set all other fields to null.',
    'For operation "delete-table-column", include type, tableId, columnIndex, and set all other fields to null.',
    'For operation "merge-table-cells", include type, tableId, cells (array of { rowIndex, columnIndex }, at least 2), and set all other fields to null.',
    "When a table changeset has multiple operations on the same table, later operations see the row/column indices AFTER earlier operations in the same changeset have already shifted them (e.g. deleting row 1 then row 1 again deletes what was originally row 2)."
  ].join("\n");
}

function formatActiveWordBlockContext(request: AgentStartRequest): string {
  if (request.activeDocument?.kind !== "word") {
    return "";
  }

  const blockLines = request.activeDocument.blocks.map((block, index) => {
    const preview = block.text.length === 0 ? "<blank paragraph>" : block.text;
    return `${index + 1}. id=${block.id} kind=${block.kind} text=${JSON.stringify(preview)}`;
  });

  return [
    "Active Word paragraph blocks:",
    ...blockLines,
    request.activeDocument.warnings.length === 0
      ? ""
      : `Word extraction warnings: ${request.activeDocument.warnings.join("; ")}`
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatActiveWordStructureContext(request: AgentStartRequest): string {
  if (request.activeDocument?.kind !== "word") {
    return "";
  }

  const structure = request.activeDocument.structure ?? [];
  if (structure.length === 0) {
    return "";
  }

  const structureLines = structure.map((node) => formatWordStructureNode(node));
  const structureWarnings = request.activeDocument.structureWarnings ?? [];

  return [
    "Document structure (headings and tables, for understanding layout and position).",
    "Headings are read-only context. Tables can be edited with table operations (see instructions above) targeting the table's id and 0-based row/column indices shown below.",
    ...structureLines,
    structureWarnings.length === 0
      ? ""
      : `Structure extraction warnings: ${structureWarnings.join("; ")}`
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatWordStructureNode(node: WordStructureNode): string {
  if (node.type === "paragraph") {
    if (node.headingLevel === undefined) {
      return "";
    }
    return `Heading (level ${node.headingLevel}): ${JSON.stringify(node.text)}`;
  }

  const grid: string[] = [];
  for (let row = 0; row < node.rowCount; row++) {
    const cells = node.cells
      .filter((cell) => cell.rowIndex === row)
      .sort((a, b) => a.columnIndex - b.columnIndex)
      .map((cell) => `R${cell.rowIndex}C${cell.columnIndex}=${JSON.stringify(cell.text)}`);
    grid.push(`  ${cells.join("  ")}`);
  }

  return [`Table ${node.id} (${node.rowCount} rows x ${node.columnCount} columns):`, ...grid].join(
    "\n"
  );
}

async function readInitialSnapshot({
  broker,
  events,
  sessionId,
  targetPath
}: {
  readonly broker: CodexCliToolBroker;
  readonly events: AgentEvent[];
  readonly sessionId: string;
  readonly targetPath: string;
}): Promise<ProjectFileSnapshot> {
  pushAgentEvents(
    events,
    broker,
    createToolEvent(sessionId, "read-file", "running", `Reading ${targetPath}`, "low")
  );
  const snapshot = await broker.readFile(targetPath);
  pushAgentEvents(
    events,
    broker,
    createToolEvent(sessionId, "read-file", "succeeded", `Read ${snapshot.path}`, "low")
  );

  return snapshot;
}

async function readPatchSnapshot(
  targetFilePath: string,
  fallbackSnapshot: ProjectFileSnapshot,
  broker: Pick<CodexCliToolBroker, "readFile">
): Promise<ProjectFileSnapshot> {
  const normalizedTarget = targetFilePath.trim();

  if (normalizedTarget.length === 0 || normalizedTarget === fallbackSnapshot.path) {
    return fallbackSnapshot;
  }

  try {
    return await broker.readFile(normalizedTarget);
  } catch {
    return {
      path: normalizedTarget,
      contents: "",
      mtimeMs: Date.now()
    };
  }
}

type CodexPatchSnapshot = {
  readonly patch: CodexAgentPatch;
  readonly snapshot: ProjectFileSnapshot;
};

async function readCodexPatchSnapshots(
  response: CodexAgentResponse,
  fallbackSnapshot: ProjectFileSnapshot,
  broker: Pick<CodexCliToolBroker, "readFile">
): Promise<readonly CodexPatchSnapshot[]> {
  const patches = getCodexPatchRequests(response);
  const snapshots: CodexPatchSnapshot[] = [];

  for (const patch of patches) {
    snapshots.push({
      patch,
      snapshot: await readPatchSnapshot(patch.targetFilePath, fallbackSnapshot, broker)
    });
  }

  return snapshots;
}

function getCodexPatchRequests(
  response: CodexAgentResponse
): readonly CodexAgentPatch[] {
  if (response.action !== "patch") {
    return [];
  }

  if ((response.patches?.length ?? 0) > 0) {
    return response.patches ?? [];
  }

  return [
    {
      targetFilePath: response.targetFilePath,
      summary: response.summary,
      afterContents: response.afterContents
    }
  ];
}

function createInitialCodexPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return isSelectedTextEditRequest(request)
    ? createCodexSelectedTextPrompt(request, snapshot)
    : createCodexPrompt(request, snapshot);
}

function formatApprovedNetworkContext(request: AgentStartRequest): string {
  const context = request.networkContext;

  if (context?.fetched !== true) {
    return "";
  }

  return [
    "User-approved external source context fetched by ZeroLeaf:",
    `Resource: ${context.resource}`,
    context.sourceUrl === undefined ? "" : `Source URL: ${context.sourceUrl}`,
    context.contentType === undefined ? "" : `Content type: ${context.contentType}`,
    "Use this context only for the user's requested task. If it is insufficient or contradictory, say what is missing instead of inventing details.",
    "```text",
    context.content.slice(0, 60_000),
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function createCodexSelectedTextPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return [
    "You are the OpenAI Codex provider inside ZeroLeaf, a local-first LaTeX editor.",
    "The user selected text in a TeX source file and asked for a focused writing edit.",
    "Do not modify files directly inside Codex CLI. Return only JSON matching the provided schema so ZeroLeaf can perform the project-scoped action.",
    'The schema always requires designWorkflow. For focused LaTeX writing edits, return an empty design workflow with currentStep "none", steps [], qa status "blocked", codeGeneration status "not-started", and implementationQa status "not-run".',
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". Describe the suggested replacement in message, but do not return a patch action.'
      : 'Return action "patch" with afterContents set to the complete target file after the edit. ZeroLeaf will apply the patch according to the current mode.',
    "Change only the exact selected span unless the user explicitly asks for a broader paragraph rewrite.",
    "Preserve all unrelated paragraphs, LaTeX commands, labels, references, citation keys, file paths, and command arguments.",
    "Do not add new claims or citations. If expanding rough notes into prose, preserve TODO lines that require user input instead of resolving them.",
    "For afterContents, return the complete target file after the edit, not a snippet, diff, abbreviated file, or only the changed paragraph.",
    'If no edit is needed, use action "answer" and put the user-facing answer in message.',
    "",
    `User task: ${request.prompt}`,
    formatApprovedNetworkContext(request),
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    formatAgentSelectionContextForPrompt(request) ?? "",
    formatAgentImageAttachmentsForPrompt(request),
    "",
    `Focused file context (${snapshot.path}):`,
    "```tex",
    createSelectedTextSourcePreview(request, snapshot.contents),
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function createCodexPatchRetryPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  previousResponse: CodexAgentResponse
): string {
  return [
    createInitialCodexPrompt(request, snapshot),
    "",
    "Retry instruction:",
    "Your previous response answered with guidance instead of a concrete app action.",
    'If a concrete safe source edit exists, return action "patch" with afterContents set to the complete target file after the minimal fix.',
    'If the concrete edit spans multiple files, return action "patch" with patches containing one complete full-file replacement per changed file.',
    'If the user asked to delete or remove a project file or folder, return action "delete-entry" with targetFilePath set to that project path.',
    'If the user asked to move or rename a project file, return action "move-entry" with targetFilePath set to the current project path and afterContents set to the destination project path.',
    'If the user asked to set or change the project main TeX file, return action "set-main-file" with targetFilePath set to that .tex project path.',
    'If the user asked for visual PDF preview assessment, rendered layout review, clipping/overlap checks, or screenshot-backed review, return action "capture-pdf-preview".',
    'If the user asked to compile, recompile, build, verify compilation, or generate/update the PDF, return action "run-compile".',
    'Use action "answer" only if no source edit or app action is safe, or no change is actually needed.',
    "",
    "Previous message:",
    previousResponse.message
  ].join("\n");
}

function createCodexOverbroadPatchRetryPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  previousResponse: CodexAgentResponse
): string {
  return [
    createInitialCodexPrompt(request, snapshot),
    "",
    "Safety retry instruction:",
    "Your previous patch removed most of a large file, so ZeroLeaf rejected it before applying.",
    "Return a safe minimal patch action only if you can preserve the entire target file.",
    "afterContents must contain the complete target file after the edit, including all unchanged sections before and after the change.",
    "Do not return only the preamble, only the changed lines, a partial file, or an abbreviated file.",
    'Use action "answer" if you cannot safely return the complete target file.',
    "",
    "Previous summary:",
    previousResponse.summary,
    "",
    "Previous message:",
    previousResponse.message
  ].join("\n");
}

function createCodexCompileRepairPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  buildResult: BuildResult,
  attempt: number
): string {
  const diagnostics = buildResult.diagnostics.slice(0, 8);

  return [
    createCodexPrompt(
      {
        ...request,
        ...(diagnostics[0] === undefined ? {} : { diagnostic: diagnostics[0] })
      },
      snapshot
    ),
    "",
    "Compile repair instruction:",
    `ZeroLeaf already ran the local LaTeX build tool and the build failed. This is repair attempt ${attempt} of ${maxCodexCompileRepairAttempts}.`,
    "Inspect the diagnostic and log excerpt below. Return a minimal source patch that fixes the compile failure, then ZeroLeaf will apply it and recompile.",
    "Do not return action run-compile here; compile has already failed and the next required action is a source repair patch.",
    'Use action "answer" only if the failure cannot be fixed safely by editing project files.',
    "",
    `Build status: ${buildResult.status}`,
    `Build command: ${buildResult.command.join(" ")}`,
    `Diagnostics (${buildResult.diagnostics.length} total):`,
    diagnostics.length === 0
      ? "- No structured diagnostics were parsed. Use the log excerpt."
      : diagnostics
          .map(
            (diagnostic) =>
              `- ${diagnostic.severity}: ${diagnostic.message} (${diagnostic.filePath ?? "unknown file"}:${diagnostic.line ?? "unknown line"})`
          )
          .join("\n"),
    "",
    "Build log excerpt:",
    "```log",
    createBuildLogExcerpt(buildResult),
    "```"
  ].join("\n");
}

function createCodexPdfPreviewAssessmentPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  capture: PdfPreviewCaptureResult
): string {
  return [
    createCodexPrompt(request, snapshot),
    "",
    "Rendered PDF preview evidence:",
    `Screenshot path: ${capture.imagePath}`,
    `Image: ${capture.width}x${capture.height} ${capture.mimeType}, ${capture.byteLength} bytes`,
    `Preview page: ${capture.pageNumber} / ${capture.pageCount}`,
    capture.pdfPath === undefined ? "" : `PDF artifact: ${capture.pdfPath}`,
    `Preview stale: ${capture.stale ? "yes" : "no"}`,
    `Captured at: ${capture.capturedAt}`,
    "",
    "Assessment instruction:",
    "Use the screenshot path above as the rendered PDF preview evidence if your environment can inspect local images.",
    "Answer with visual findings grounded in that rendered evidence. If you cannot inspect the PNG, say that plainly and limit claims to the source, compile log, and screenshot metadata.",
    'Return a source patch only when the visual evidence identifies a concrete LaTeX source fix. Otherwise return action "answer" with the assessment.',
    "Do not request another PDF preview capture in this follow-up response."
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function createCodexInterruptedRetryPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  error: unknown
): string {
  return [
    "You are the OpenAI Codex planner inside ZeroLeaf, a local-first LaTeX editor.",
    "The previous Codex planner attempt failed before it returned a valid action.",
    "Use this smaller prompt and avoid broad project scans. Return one JSON action only.",
    "Do not modify files or run LaTeX commands inside Codex CLI. ZeroLeaf will run returned app actions.",
    "The schema requires designWorkflow. Return an empty design workflow unless this is a website, UI, code-generation, or design/runtime QA task.",
    'Use action "patch" for a minimal source edit, "word-edit" for Microsoft Word .docx edits, "delete-entry" for deleting project files or folders, "move-entry" for file moves, "set-main-file" for changing the main TeX file, "capture-pdf-preview" for rendered preview evidence, "run-compile" for compile requests, or "answer" only when no safe action exists.',
    formatWordEditInstructions(request),
    `Failed attempt: ${formatPlannerFailure(error)}`,
    `User task: ${request.prompt}`,
    formatApprovedNetworkContext(request),
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    formatAgentSelectionContextForPrompt(request) ?? "",
    formatAgentImageAttachmentsForPrompt(request),
    request.diagnostic === undefined
      ? ""
      : `Diagnostic: ${request.diagnostic.severity} ${request.diagnostic.filePath ?? ""}:${request.diagnostic.line ?? ""} ${request.diagnostic.message}`,
    formatActiveWordBlockContext(request),
    formatActiveWordStructureContext(request),
    "",
    `Focused active file preview (${snapshot.path}):`,
    request.activeDocument?.kind === "word" ? "```text" : "```tex",
    createFocusedSourcePreview(snapshot.contents),
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function isRetryableCodexExecError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("terminated by sigterm") ||
    message.includes("terminated by sigkill") ||
    message.includes("expected agent response schema") ||
    message.includes("not a json object")
  );
}

function formatPlannerFailure(error: unknown): string {
  return getErrorMessage(error).replace(/\s+/gu, " ").trim();
}

function formatElapsedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function shouldRetryForConcreteAction(
  request: AgentStartRequest,
  response: CodexAgentResponse
): boolean {
  if (request.mode === "read-only" || response.action !== "answer") {
    return false;
  }

  if (!isConcreteActionPreferredRequest(request)) {
    return false;
  }

  const message = response.message.toLowerCase();
  return !/\b(no source edit|no edit|cannot safely edit|not enough context)\b/u.test(
    message
  );
}

function isConcreteActionPreferredRequest(request: AgentStartRequest): boolean {
  if (request.diagnostic !== undefined) {
    return true;
  }

  if (isAnswerPreferredRequest(request.prompt)) {
    return false;
  }

  return (
    /\b(edit|change|set|switch|make|update|rewrite|replace|insert|add|remove|delete|move|rename|merge|combine|consolidate|split|reorganize|restructure|fix|repair|compile|recompile|build|compile error|compilation error|failing build|build failure|latex error|diagnostic|main\s+(?:tex|file)|root\s+(?:tex|file))\b/iu.test(
      request.prompt
    ) || isPdfAppActionRequest(request.prompt)
  );
}

function isAnswerPreferredRequest(prompt: string): boolean {
  const hasAnswerIntent =
    /\b(answer|explain|summari[sz]e|summary|describe|what|why|how|plan|outline|strategy|review|critique|assess|analy[sz]e|diagnose|guidance|advice|recommend|recommendation|literature review|reading list|submission checklist)\b/iu.test(
      prompt
    );

  if (!hasAnswerIntent) {
    return false;
  }

  return !/\b(edit|change|set|switch|make|update|rewrite|replace|insert|add|remove|delete|move|rename|merge|combine|consolidate|split|reorganize|restructure|fix|repair|compile|recompile|build|apply|patch)\b/iu.test(
    prompt
  );
}

function isPdfAppActionRequest(prompt: string): boolean {
  return (
    /\b(?:generate|update|create|build)\s+(?:the\s+)?pdf\b/iu.test(prompt) ||
    (/\bpdf\b/iu.test(prompt) &&
      /\b(preview|screenshot|visual|rendered|layout|formatting|clipping|overlap|page break|figure placement|table placement)\b/iu.test(
        prompt
      ))
  );
}

function isSelectedTextEditRequest(request: AgentStartRequest): boolean {
  const selectedText = request.selectionContext?.selectedText ?? request.selectedText;

  if (selectedText === undefined || selectedText.trim().length === 0) {
    return false;
  }

  const prompt = request.prompt.toLowerCase();

  if (
    request.diagnostic !== undefined ||
    /\b(compile|recompile|build|pdf|latex error|compile error|compilation error|failing build|build failure|diagnostic)\b/iu.test(
      prompt
    )
  ) {
    return false;
  }

  return /\b(edit|change|make|update|rewrite|replace|improve|shorten|expand|tone|polish|revise|rephrase)\b/iu.test(
    prompt
  );
}

function isLikelyOverbroadPatch(
  beforeContents: string,
  afterContents: string
): boolean {
  const before = beforeContents.trim();
  const after = afterContents.trim();

  if (before.length < 2_000 || after.length === 0) {
    return false;
  }

  const beforeLines = before.split(/\r?\n/u).length;
  const afterLines = after.split(/\r?\n/u).length;

  return after.length < before.length * 0.65 || afterLines < beforeLines * 0.65;
}

function createSourcePreview(contents: string): string {
  const maxPreviewLength = 14_000;

  if (contents.length <= maxPreviewLength) {
    return contents;
  }

  const abstractMatch = /\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/u.exec(contents);
  const titleMatch = /\\title(?:\[[^\]]*\])?\{[^}]+\}/u.exec(contents);
  const keywordMatch = /\\begin\{IEEEkeywords\}[\s\S]*?\\end\{IEEEkeywords\}/u.exec(
    contents
  );
  const frontMatter = [titleMatch?.[0], abstractMatch?.[0], keywordMatch?.[0]]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const head = contents.slice(0, 8_000);
  const tail = contents.slice(-3_000);

  return [
    frontMatter.length === 0 ? "" : frontMatter,
    "% ... active file preview truncated; inspect the project files from the working directory if more context is needed ...",
    head,
    "% ...",
    tail
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function createFocusedSourcePreview(contents: string): string {
  const maxPreviewLength = 6_000;

  if (contents.length <= maxPreviewLength) {
    return contents;
  }

  const head = contents.slice(0, 4_000);
  const tail = contents.slice(-1_500);

  return [head, "% ... focused retry preview truncated ...", tail].join("\n\n");
}

function createSelectedTextSourcePreview(
  request: AgentStartRequest,
  contents: string
): string {
  const context = request.selectionContext;

  if (context === undefined) {
    return createFocusedSourcePreview(contents);
  }

  const lines = contents.split(/\r?\n/u);
  const startLine = Math.max(1, context.startLine - 20);
  const endLine = Math.min(lines.length, context.endLine + 20);
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  const beforeMarker =
    startLine > 1 ? "% ... selection-focused preview truncated before ...\n" : "";
  const afterMarker =
    endLine < lines.length
      ? "\n% ... selection-focused preview truncated after ..."
      : "";

  return `${beforeMarker}${excerpt}${afterMarker}`;
}

function createBuildLogExcerpt(buildResult: BuildResult): string {
  const combinedLog = [buildResult.stderr, buildResult.stdout, buildResult.rawLog]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const normalizedLog =
    combinedLog.trim().length === 0
      ? "No LaTeX log output was captured."
      : combinedLog.trim();

  if (normalizedLog.length <= 8_000) {
    return normalizedLog;
  }

  return [
    normalizedLog.slice(0, 4_000),
    "% ... build log excerpt truncated ...",
    normalizedLog.slice(-3_000)
  ].join("\n\n");
}

function parseCodexAgentResponse(value: unknown): CodexAgentResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Codex output was not a JSON object.");
  }

  const candidate = value as Partial<CodexAgentResponse>;

  if (
    (candidate.action !== "answer" &&
      candidate.action !== "patch" &&
      candidate.action !== "word-edit" &&
      candidate.action !== "delete-entry" &&
      candidate.action !== "move-entry" &&
      candidate.action !== "set-main-file" &&
      candidate.action !== "capture-pdf-preview" &&
      candidate.action !== "run-compile") ||
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
    !isValidCodexAgentPatches(candidate.patches) ||
    !isValidCodexAgentWordChangeSets(candidate.wordChangesets) ||
    (candidate.designWorkflow !== undefined &&
      !isValidDesignWorkflowOutput(candidate.designWorkflow)) ||
    typeof candidate.message !== "string" ||
    typeof candidate.notes !== "string"
  ) {
    throw new Error("Codex output did not match the expected agent response schema.");
  }

  return {
    action: candidate.action,
    targetFilePath: candidate.targetFilePath,
    summary: candidate.summary,
    afterContents: candidate.afterContents,
    ...(candidate.patches === undefined ? {} : { patches: candidate.patches }),
    ...(candidate.wordChangesets === undefined
      ? {}
      : {
          wordChangesets: normalizeCodexAgentWordChangeSets(candidate.wordChangesets)
        }),
    designWorkflow: candidate.designWorkflow ?? createEmptyDesignWorkflowOutput(),
    message: candidate.message,
    notes: candidate.notes
  };
}

function getDesignWorkflow(response: CodexAgentResponse): DesignWorkflowOutput {
  return response.designWorkflow ?? createEmptyDesignWorkflowOutput();
}

function createCodexWordChangeSets(
  request: AgentStartRequest,
  response: CodexAgentResponse
): readonly WordChangeSet[] {
  const activeDocument = request.activeDocument;

  if (activeDocument?.kind !== "word") {
    return [];
  }

  const requestedChangeSets = response.wordChangesets ?? [];

  if (requestedChangeSets.length === 0) {
    return [];
  }

  return requestedChangeSets.map((changeset) => {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      projectRoot: request.projectRoot,
      filePath: changeset.filePath || activeDocument.path,
      summary: normalizeSummary(changeset.summary || response.summary),
      baseBlocks: activeDocument.blocks,
      operations: changeset.operations,
      status: "proposed",
      createdAt: now,
      updatedAt: now
    };
  });
}

function isValidCodexAgentPatches(
  value: Partial<CodexAgentResponse>["patches"]
): value is readonly CodexAgentPatch[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (patch) =>
          patch !== null &&
          typeof patch === "object" &&
          typeof (patch as Partial<CodexAgentPatch>).targetFilePath === "string" &&
          typeof (patch as Partial<CodexAgentPatch>).summary === "string" &&
          typeof (patch as Partial<CodexAgentPatch>).afterContents === "string"
      ))
  );
}

function isValidCodexAgentWordChangeSets(
  value: Partial<CodexAgentResponse>["wordChangesets"]
): value is readonly CodexAgentWordChangeSet[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (changeset) =>
          changeset !== null &&
          typeof changeset === "object" &&
          typeof (changeset as Partial<CodexAgentWordChangeSet>).filePath ===
            "string" &&
          typeof (changeset as Partial<CodexAgentWordChangeSet>).summary === "string" &&
          isValidWordBlockOperations(
            (changeset as Partial<CodexAgentWordChangeSet>).operations
          )
      ))
  );
}

function isValidWordBlockOperations(
  value: unknown
): value is readonly WordBlockOperation[] {
  return Array.isArray(value) && value.every(isValidWordBlockOperation);
}

function isValidWordBlockOperation(value: unknown): value is WordBlockOperation {
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
          operation.afterBlockId === null ||
          typeof operation.afterBlockId === "string") &&
        typeof operation.block === "object" &&
        operation.block !== null &&
        typeof operation.block.id === "string" &&
        operation.block.kind === "paragraph" &&
        typeof operation.block.text === "string"
      );
    case "delete-block":
      return typeof operation.blockId === "string";
    case "move-block":
      return (
        typeof operation.blockId === "string" &&
        (operation.afterBlockId === undefined ||
          operation.afterBlockId === null ||
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
        operation.cells.length >= 2 &&
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

function normalizeCodexAgentWordChangeSets(
  changesets: readonly CodexAgentWordChangeSet[]
): readonly CodexAgentWordChangeSet[] {
  return changesets.map((changeset) => ({
    ...changeset,
    operations: changeset.operations.map(normalizeCodexWordBlockOperation)
  }));
}

function normalizeCodexWordBlockOperation(
  operation: WordBlockOperation
): WordBlockOperation {
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
        ...(typeof operation.afterBlockId === "string"
          ? { afterBlockId: operation.afterBlockId }
          : {}),
        block: operation.block
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
        ...(typeof operation.afterBlockId === "string"
          ? { afterBlockId: operation.afterBlockId }
          : {})
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
}

export const codexOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      enum: [
        "answer",
        "patch",
        "word-edit",
        "delete-entry",
        "move-entry",
        "set-main-file",
        "capture-pdf-preview",
        "run-compile"
      ]
    },
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetFilePath: { type: "string" },
          summary: { type: "string" },
          afterContents: { type: "string" }
        },
        required: ["targetFilePath", "summary", "afterContents"]
      }
    },
    wordChangesets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: { type: "string" },
          summary: { type: "string" },
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: {
                  enum: [
                    "replace-block",
                    "insert-block-after",
                    "delete-block",
                    "move-block",
                    "replace-selection",
                    "replace-table-cell",
                    "insert-table-row",
                    "delete-table-row",
                    "insert-table-column",
                    "delete-table-column",
                    "merge-table-cells"
                  ]
                },
                blockId: { type: ["string", "null"] },
                afterText: { type: ["string", "null"] },
                afterBlockId: { type: ["string", "null"] },
                block: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    kind: { enum: ["paragraph"] },
                    text: { type: "string" }
                  },
                  required: ["id", "kind", "text"]
                },
                startOffset: { type: ["number", "null"] },
                endOffset: { type: ["number", "null"] },
                replacementText: { type: ["string", "null"] },
                tableId: { type: ["string", "null"] },
                rowIndex: { type: ["number", "null"] },
                columnIndex: { type: ["number", "null"] },
                anchorRowIndex: { type: ["number", "null"] },
                anchorColumnIndex: { type: ["number", "null"] },
                position: { type: ["string", "null"], enum: ["before", "after", null] },
                cells: {
                  type: ["array", "null"],
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      rowIndex: { type: "number" },
                      columnIndex: { type: "number" }
                    },
                    required: ["rowIndex", "columnIndex"]
                  }
                }
              },
              required: [
                "type",
                "blockId",
                "afterText",
                "afterBlockId",
                "block",
                "startOffset",
                "endOffset",
                "replacementText",
                "tableId",
                "rowIndex",
                "columnIndex",
                "anchorRowIndex",
                "anchorColumnIndex",
                "position",
                "cells"
              ]
            }
          }
        },
        required: ["filePath", "summary", "operations"]
      }
    },
    designWorkflow: designWorkflowOutputSchema,
    message: { type: "string" },
    notes: { type: "string" }
  },
  required: [
    "action",
    "targetFilePath",
    "summary",
    "afterContents",
    "patches",
    "wordChangesets",
    "designWorkflow",
    "message",
    "notes"
  ]
} as const;

function processCodexJsonLines(
  buffer: string,
  onCodexEvent: (event: unknown) => void
): string {
  const lines = buffer.split(/\r?\n/u);
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    processCodexJsonLine(line, onCodexEvent);
  }

  return rest;
}

function processCodexJsonLine(
  line: string,
  onCodexEvent: (event: unknown) => void
): void {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0) {
    return;
  }

  try {
    onCodexEvent(JSON.parse(trimmedLine) as unknown);
  } catch {
    // Codex can still write non-JSON diagnostics on stdout in failure paths.
  }
}

function emitCodexPublicEvents(
  event: unknown,
  sessionId: string,
  broker: Pick<CodexCliToolBroker, "emitEvent">
): void {
  pushAgentEvents(
    undefined,
    broker,
    ...createCodexAgentEventsFromJson(event, sessionId)
  );
}

export function createCodexAgentEventsFromJson(
  event: unknown,
  sessionId: string
): readonly AgentEvent[] {
  const eventType = getCodexJsonEventType(event);

  if (eventType.length === 0 || eventType.includes("reasoning")) {
    return [];
  }

  const events: AgentEvent[] = [];
  const publicText = extractCodexJsonPublicText(event, eventType);
  if (publicText !== undefined) {
    events.push(createMessageEvent(sessionId, "assistant", publicText));
  }

  return events;
}

function getCodexJsonEventType(event: unknown): string {
  return (
    readStringAtPath(event, ["type"]) ??
    readStringAtPath(event, ["event"]) ??
    readStringAtPath(event, ["kind"]) ??
    readStringAtPath(event, ["msg", "type"]) ??
    readStringAtPath(event, ["item", "type"]) ??
    ""
  )
    .trim()
    .toLowerCase()
    .replaceAll(".", "_")
    .replaceAll("-", "_");
}

function extractCodexJsonPublicText(
  event: unknown,
  eventType: string
): string | undefined {
  if (
    eventType.includes("reasoning") ||
    (!eventType.includes("message") &&
      !eventType.includes("text") &&
      !eventType.includes("answer"))
  ) {
    return undefined;
  }

  const text = readFirstStringAtPaths(event, [
    ["text"],
    ["content"],
    ["message"],
    ["delta"],
    ["msg", "text"],
    ["msg", "content"],
    ["msg", "message"],
    ["item", "text"],
    ["item", "content"],
    ["item", "message"]
  ])?.trim();

  if (
    text === undefined ||
    text.length === 0 ||
    text.length > 1_500 ||
    isLikelyStructuredCodexFinalResponse(text)
  ) {
    return undefined;
  }

  return text;
}

function isLikelyStructuredCodexFinalResponse(text: string): boolean {
  const trimmedText = text.trim();
  return (
    trimmedText.startsWith("{") &&
    trimmedText.includes('"action"') &&
    trimmedText.includes('"targetFilePath"')
  );
}

function readFirstStringAtPaths(
  value: unknown,
  paths: readonly (readonly string[])[]
): string | undefined {
  for (const path of paths) {
    const result = readStringAtPath(value, path);

    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

function readStringAtPath(value: unknown, path: readonly string[]): string | undefined {
  const result = readValueAtPath(value, path);

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result)) {
    const text = result
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { readonly text?: unknown }).text ?? "")
            : ""
      )
      .filter((part) => part.length > 0)
      .join("");

    return text.length === 0 ? undefined : text;
  }

  return undefined;
}

function readValueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;

  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function pushAgentEvents(
  events: AgentEvent[] | undefined,
  broker: Pick<CodexCliToolBroker, "emitEvent"> | undefined,
  ...nextEvents: readonly AgentEvent[]
): void {
  events?.push(...nextEvents);
  for (const event of nextEvents) {
    broker?.emitEvent?.(event);
  }
}

function createMessageEvent(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "message",
    role,
    content
  };
}

function createToolEvent(
  sessionId: string,
  toolName: AgentToolName,
  status: AgentToolCallEvent["status"],
  summary: string,
  risk: AgentToolRisk
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "tool-call",
    toolName,
    status,
    summary,
    risk
  };
}

function createPatchEvent(sessionId: string, changeset: HistoryChangeSet): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "patch",
    changesetId: changeset.id,
    filePath: changeset.filePath,
    summary: changeset.summary,
    status: changeset.status
  };
}

function createWordChangeSetEvent(
  sessionId: string,
  changeset: WordChangeSet
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "patch",
    changesetId: changeset.id,
    filePath: changeset.filePath,
    summary: changeset.summary,
    status: changeset.status
  };
}

function createApprovalEvent(
  sessionId: string,
  toolName: AgentToolName = "apply-patch",
  prompt = "Review the Codex patch before applying it to the project."
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "approval",
    approvalId: randomUUID(),
    toolName,
    risk: "high",
    prompt,
    status: "requested"
  };
}

function createVerificationEvent(
  sessionId: string,
  status: "pending" | "running" | "passed" | "failed",
  summary: string,
  buildJobId?: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "verification",
    status,
    summary,
    ...(buildJobId === undefined ? {} : { buildJobId })
  };
}

function formatCompileMessage(buildResult: BuildResult): string {
  const diagnostics = buildResult.diagnostics.slice(0, 4);
  const diagnosticSummary =
    diagnostics.length === 0
      ? "No diagnostics were reported."
      : diagnostics
          .map(
            (diagnostic) =>
              `- ${diagnostic.severity}: ${diagnostic.message}${
                diagnostic.filePath === undefined
                  ? ""
                  : ` (${diagnostic.filePath}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`})`
              }`
          )
          .join("\n");

  return [
    `Compile ${buildResult.status}.`,
    `Diagnostics: ${buildResult.diagnostics.length}.`,
    diagnosticSummary
  ].join("\n\n");
}

function formatCompileActionMessage(
  response: CodexAgentResponse,
  buildResult: BuildResult
): string {
  const actionSummary =
    response.message.trim().length > 0
      ? response.message.trim()
      : "Codex requested a project compile.";

  return [
    actionSummary,
    buildResult.status === "succeeded"
      ? "I ran the compile, and it passed."
      : `I ran the compile, but it still has ${buildResult.diagnostics.length} diagnostic${buildResult.diagnostics.length === 1 ? "" : "s"}.`
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

function getRequestedSessionId(request: AgentStartRequest): string | undefined {
  if (!("sessionId" in request)) {
    return undefined;
  }

  const candidate = (request as { readonly sessionId?: unknown }).sessionId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length === 0 ? "Codex proposed update" : trimmed.slice(0, 160);
}

function formatAuthMethod(authMethod: string | undefined): string {
  return authMethod === undefined ? "" : ` using ${authMethod}`;
}

function isLoggedOutCodexMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("not authenticated") ||
    normalized.includes("login required") ||
    normalized.includes("log in to continue") ||
    normalized.includes("run `codex login`") ||
    normalized.includes("run codex login")
  );
}

function appendCapped(current: string, chunk: string, maxLength: number): string {
  const next = current + chunk;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

function formatCodexFailureOutput(output: string): string {
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return "no error output";
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .filter(
      (line) => !line.startsWith("Original ") && !line.startsWith("Active file preview")
    )
    .slice(0, 24)
    .join("\n")
    .trim();
  const capped = lines.length === 0 ? trimmed : lines;

  return capped.length <= 1_500 ? capped : `${capped.slice(0, 1_500).trimEnd()}...`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex CLI is unavailable.";
}
