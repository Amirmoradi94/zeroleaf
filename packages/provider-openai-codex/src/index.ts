import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentAuthStatus,
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
  ProjectFileSnapshot
} from "@latex-agent/ipc-contracts";

export const openAiCodexProviderId = "openai-codex" as const;
const defaultCodexExecTimeoutMs = 7_200_000;
const maxCodexPlannerAttempts = 2;
const maxCodexCompileRepairAttempts = 2;

export type CodexCliToolBroker = {
  readonly emitEvent?: (event: AgentEvent) => void;
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
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
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
};

export type CodexAgentResponse = {
  readonly action: "answer" | "patch" | "move-entry" | "set-main-file" | "run-compile";
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
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
  readonly timeoutMs?: number;
  readonly runCodexExec?: CodexExecRunner;
  readonly getCliAuthStatus?: CodexAuthStatusRunner;
};

export class CodexCliProvider {
  readonly id: AgentProviderId = openAiCodexProviderId;
  private readonly codexBinary: string;
  private readonly timeoutMs: number;
  private readonly runCodexExec: CodexExecRunner;
  private readonly getCliAuthStatus: CodexAuthStatusRunner;
  private readonly cancelledSessionIds = new Set<string>();

  constructor(options: CodexCliProviderOptions = {}) {
    this.codexBinary =
      options.codexBinary ?? process.env["LATEX_AGENT_CODEX_BIN"] ?? "codex";
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
        "I will ask the installed Codex CLI to inspect the project and decide whether to answer or propose a reviewable patch."
      )
    ];
    const targetPath = request.activeFilePath ?? request.mainFilePath;

    if (targetPath === undefined) {
      events.push(
        createErrorEvent(sessionId, "Open a project file before starting Codex.")
      );
      return {
        sessionId,
        providerId: this.id,
        status: "failed",
        events
      };
    }

    pushAgentEvents(
      events,
      broker,
      createToolEvent(sessionId, "read-file", "running", `Reading ${targetPath}`, "low")
    );
    const snapshot = await broker.readFile(targetPath);
    pushAgentEvents(
      events,
      broker,
      createToolEvent(
        sessionId,
        "read-file",
        "succeeded",
        `Read ${snapshot.path}`,
        "low"
      )
    );

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
      createCodexPrompt(request, snapshot),
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
        events
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
        createMessageEvent(sessionId, "assistant", formatCompileMessage(buildResult))
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        buildResult
      };
    }

    let patchSnapshot =
      codexResponse.targetFilePath === snapshot.path
        ? snapshot
        : await broker.readFile(codexResponse.targetFilePath);

    if (isLikelyOverbroadPatch(patchSnapshot.contents, codexResponse.afterContents)) {
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
      codexResponse = await this.runPlannerWithRetry(
        request,
        patchSnapshot,
        createCodexOverbroadPatchRetryPrompt(request, patchSnapshot, codexResponse),
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

      if (codexResponse.action !== "patch") {
        events.push(createMessageEvent(sessionId, "assistant", codexResponse.message));
        return {
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }

      patchSnapshot =
        codexResponse.targetFilePath === snapshot.path
          ? snapshot
          : await broker.readFile(codexResponse.targetFilePath);

      if (isLikelyOverbroadPatch(patchSnapshot.contents, codexResponse.afterContents)) {
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
          sessionId,
          providerId: this.id,
          status: "completed",
          events
        };
      }
    }

    if (codexResponse.afterContents === patchSnapshot.contents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          codexResponse.message ||
            "Codex did not propose a file change for this request."
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
        "propose-patch",
        "running",
        `Creating review patch for ${patchSnapshot.path}`,
        "medium"
      )
    );
    const changeset = await broker.proposePatch(
      patchSnapshot.path,
      patchSnapshot.contents,
      codexResponse.afterContents,
      normalizeSummary(codexResponse.summary)
    );
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

    if (request.mode === "autonomous-local" && broker.applyPatch !== undefined) {
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

      if (broker.runCompile === undefined) {
        events.push(
          createMessageEvent(
            sessionId,
            "assistant",
            `${codexResponse.message}\n\nApplied the patch, but this provider bridge cannot run compile verification.`
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
          [codexResponse.message, formatCompileMessage(buildResult)]
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
        buildResult
      };
    }

    pushAgentEvents(
      events,
      broker,
      createPatchEvent(sessionId, changeset),
      createApprovalEvent(sessionId),
      createVerificationEvent(
        sessionId,
        "pending",
        "Apply the Codex patch to start compile verification."
      )
    );

    return {
      sessionId,
      providerId: this.id,
      status: "awaiting-approval",
      events,
      changeset
    };
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
        return await this.runCodexExec({
          projectRoot: request.projectRoot,
          timeoutMs: this.timeoutMs,
          prompt:
            attempt === 1
              ? prompt
              : createCodexInterruptedRetryPrompt(request, snapshot, lastError)
        });
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
      createCodexExecArgs(schemaPath, outputPath, request.projectRoot),
      request.timeoutMs,
      request.prompt
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
  projectRoot: string
): readonly string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--sandbox",
    "read-only",
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
  stdin?: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32"
    });
    let stdout = "";
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
    "You may inspect the project from the current working directory. Do not modify files directly inside Codex CLI; return a ZeroLeaf action so the app can perform project-scoped changes safely.",
    'Do not run LaTeX compile commands inside Codex CLI. For compile, recompile, build, or PDF generation requests, return action "run-compile" so ZeroLeaf can run its local build tool.',
    "Return only JSON matching the provided schema.",
    'Set action to "answer" when the task is best completed by explanation, summary, review, diagnosis, or guidance.',
    'Set action to "patch" when the task requires or asks for a source edit. For patches, produce a minimal full-file replacement for targetFilePath.',
    'Set action to "move-entry" when the task requires moving or renaming a project file without changing file contents. Put the current project path in targetFilePath and the destination project path in afterContents.',
    'Set action to "set-main-file" when the user asks to choose, change, set, or switch the project main/root TeX file without editing source contents. Put the desired .tex project path in targetFilePath.',
    'Set action to "run-compile" when the user asks to compile, recompile, build, verify compilation, or generate/update the PDF.',
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". You may describe suggested edits in message, but do not return a patch action.'
      : 'ZeroLeaf will perform returned actions through project-scoped app tools. In "apply-with-review" mode, patches wait for user approval; in "autonomous-local" mode, patches may be applied and compiled automatically.',
    request.mode === "read-only"
      ? ""
      : 'For edit, change, rewrite, replace, insert, delete, fix, repair, compile, recompile, build, PDF generation, compile-error, failing-build, and diagnostic tasks, return the concrete action whenever safe: "patch" for source edits, "move-entry" for moving or renaming files, "set-main-file" for changing the project main TeX file, and "run-compile" for builds. Do not stop at explaining the edit or app action.',
    "Preserve all unrelated text and formatting when returning a patch.",
    "For patches, afterContents must be the complete target file after the edit, not a snippet, diff, abbreviated file, or only the changed section. Never omit unchanged content.",
    request.selectedText === undefined
      ? ""
      : "The user selected text. Change only that exact selected span; preserve all unrelated paragraphs, LaTeX commands, labels, references, and citations unless the user explicitly asks to change one.",
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
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    request.selectedText === undefined ? "" : `Selected text:\n${request.selectedText}`,
    request.diagnostic === undefined
      ? ""
      : `Diagnostic: ${request.diagnostic.severity} ${request.diagnostic.filePath ?? ""}:${request.diagnostic.line ?? ""} ${request.diagnostic.message}`,
    "",
    `Active file preview (${snapshot.path}):`,
    "```tex",
    createSourcePreview(snapshot.contents),
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
    createCodexPrompt(request, snapshot),
    "",
    "Retry instruction:",
    "Your previous response answered with guidance instead of a concrete app action.",
    'If a concrete safe source edit exists, return action "patch" with afterContents set to the complete target file after the minimal fix.',
    'If the user asked to move or rename a project file, return action "move-entry" with targetFilePath set to the current project path and afterContents set to the destination project path.',
    'If the user asked to set or change the project main TeX file, return action "set-main-file" with targetFilePath set to that .tex project path.',
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
    createCodexPrompt(request, snapshot),
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

function createCodexInterruptedRetryPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot,
  error: unknown
): string {
  return [
    "You are the OpenAI Codex planner inside ZeroLeaf, a local-first LaTeX editor.",
    "The previous Codex planner attempt was interrupted before it returned a valid action.",
    "Use this smaller prompt and avoid broad project scans. Return one JSON action only.",
    "Do not modify files or run LaTeX commands inside Codex CLI. ZeroLeaf will run returned app actions.",
    'Use action "patch" for a minimal source edit, "move-entry" for file moves, "set-main-file" for changing the main TeX file, "run-compile" for compile requests, or "answer" only when no safe action exists.',
    `Interrupted attempt: ${formatPlannerFailure(error)}`,
    `User task: ${request.prompt}`,
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    request.selectedText === undefined ? "" : `Selected text:\n${request.selectedText}`,
    request.diagnostic === undefined
      ? ""
      : `Diagnostic: ${request.diagnostic.severity} ${request.diagnostic.filePath ?? ""}:${request.diagnostic.line ?? ""} ${request.diagnostic.message}`,
    "",
    `Focused active file preview (${snapshot.path}):`,
    "```tex",
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
    message.includes("terminated by sigkill")
  );
}

function formatPlannerFailure(error: unknown): string {
  return getErrorMessage(error).replace(/\s+/gu, " ").trim();
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

  return /\b(edit|change|set|switch|make|update|rewrite|replace|insert|add|remove|delete|move|rename|fix|repair|compile|recompile|build|pdf|compile error|compilation error|failing build|build failure|latex error|diagnostic|main\s+(?:tex|file)|root\s+(?:tex|file))\b/iu.test(
    request.prompt
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
      candidate.action !== "move-entry" &&
      candidate.action !== "set-main-file" &&
      candidate.action !== "run-compile") ||
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
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
    message: candidate.message,
    notes: candidate.notes
  };
}

const codexOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      enum: ["answer", "patch", "move-entry", "set-main-file", "run-compile"]
    },
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
    message: { type: "string" },
    notes: { type: "string" }
  },
  required: ["action", "targetFilePath", "summary", "afterContents", "message", "notes"]
} as const;

function pushAgentEvents(
  events: AgentEvent[],
  broker: Pick<CodexCliToolBroker, "emitEvent"> | undefined,
  ...nextEvents: readonly AgentEvent[]
): void {
  events.push(...nextEvents);
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

function createApprovalEvent(sessionId: string): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "approval",
    approvalId: randomUUID(),
    toolName: "apply-patch",
    risk: "high",
    prompt: "Review the Codex patch before applying it to the project.",
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

function createErrorEvent(sessionId: string, message: string): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "error",
    message,
    recoverable: true
  };
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
