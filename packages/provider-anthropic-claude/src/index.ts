import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatAgentSelectionContextForPrompt } from "@latex-agent/ipc-contracts";
import type {
  AgentAuthStatus,
  AgentEvent,
  AgentProviderId,
  AgentSessionResult,
  AgentStartRequest,
  AgentToolCallEvent,
  AgentToolName,
  AgentToolRisk,
  HistoryChangeSet,
  ProjectFileSnapshot
} from "@latex-agent/ipc-contracts";

export const anthropicClaudeProviderId = "anthropic-claude" as const;
const claudePathEnvName = "LATEX_AGENT_CLAUDE_BIN";
const commonProviderCliDirs = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/Library/TeX/texbin"
] as const;

export type ClaudeCodeToolBroker = {
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
  readonly proposePatch: (
    filePath: string,
    beforeContents: string,
    afterContents: string,
    summary: string
  ) => Promise<HistoryChangeSet>;
};

export type ClaudeCodeRequest = {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
};

export type ClaudeAgentResponse = {
  readonly action: "answer" | "patch";
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
  readonly message: string;
  readonly notes: string;
};

export type ClaudeCodeRunner = (
  request: ClaudeCodeRequest
) => Promise<ClaudeAgentResponse>;

export type ClaudeAuthStatusRunner = () => Promise<ClaudeCodeAuthStatus>;

export type ClaudeCodeAuthStatus = {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
  readonly apiProvider?: string;
  readonly subscriptionType?: string;
};

export type ClaudeProviderOptions = {
  readonly claudeBinary?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly runClaudeCode?: ClaudeCodeRunner;
  readonly getCliAuthStatus?: ClaudeAuthStatusRunner;
};

const defaultClaudeModel = "sonnet";

export class ClaudeProvider {
  readonly id: AgentProviderId = anthropicClaudeProviderId;
  private readonly claudeBinary: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly runClaudeCode: ClaudeCodeRunner;
  private readonly getCliAuthStatus: ClaudeAuthStatusRunner;
  private readonly cancelledSessionIds = new Set<string>();

  constructor(options: ClaudeProviderOptions = {}) {
    this.claudeBinary =
      options.claudeBinary ?? getConfiguredCliBinary(claudePathEnvName, "claude");
    this.model =
      options.model ?? process.env["LATEX_AGENT_CLAUDE_MODEL"] ?? defaultClaudeModel;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.runClaudeCode =
      options.runClaudeCode ??
      ((request) => runClaudeCode(this.claudeBinary, this.model, request));
    this.getCliAuthStatus =
      options.getCliAuthStatus ?? (() => getClaudeCliAuthStatus(this.claudeBinary));
  }

  async getAuthStatus(): Promise<AgentAuthStatus> {
    try {
      const authStatus = await this.getCliAuthStatus();

      if (!authStatus.loggedIn) {
        return {
          providerId: this.id,
          state: "needs-auth",
          message: "Run `claude auth login` in a terminal to connect Claude Code."
        };
      }

      return {
        providerId: this.id,
        state: "connected",
        message: `Claude Code CLI is logged in${formatSubscription(authStatus.subscriptionType)}.`
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
    broker: ClaudeCodeToolBroker
  ): Promise<AgentSessionResult> {
    const sessionId = getRequestedSessionId(request) ?? randomUUID();
    const events: AgentEvent[] = [
      createMessageEvent(sessionId, "user", request.prompt),
      createMessageEvent(
        sessionId,
        "assistant",
        "I will ask the installed Claude Code CLI to inspect the project and decide whether to answer or propose a reviewable patch."
      )
    ];
    const targetPath = request.activeFilePath ?? request.mainFilePath;

    if (targetPath === undefined) {
      events.push(
        createErrorEvent(sessionId, "Open a project file before starting Claude.")
      );
      return {
        sessionId,
        providerId: this.id,
        status: "failed",
        events
      };
    }

    events.push(
      createToolEvent(sessionId, "read-file", "running", `Reading ${targetPath}`, "low")
    );
    const snapshot = await broker.readFile(targetPath);
    events.push(
      createToolEvent(
        sessionId,
        "read-file",
        "succeeded",
        `Read ${snapshot.path}`,
        "low"
      )
    );

    events.push(
      createToolEvent(
        sessionId,
        "claude-code",
        "running",
        "Running installed Claude Code CLI",
        "medium"
      )
    );
    const claudeResponse = await this.runClaudeCode({
      projectRoot: request.projectRoot,
      timeoutMs: this.timeoutMs,
      prompt: createClaudePrompt(request, snapshot)
    });
    events.push(
      createToolEvent(
        sessionId,
        "claude-code",
        "succeeded",
        claudeResponse.notes,
        "medium"
      )
    );

    if (this.cancelledSessionIds.has(sessionId)) {
      return {
        sessionId,
        providerId: this.id,
        status: "cancelled",
        events
      };
    }

    if (
      claudeResponse.action === "answer" ||
      (request.mode === "read-only" && claudeResponse.action === "patch")
    ) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          claudeResponse.action === "patch"
            ? [
                claudeResponse.message,
                "Claude identified a possible source edit, but the current agent mode is read-only. Switch to review mode if you want a patch."
              ]
                .filter((line) => line.trim().length > 0)
                .join("\n\n")
            : claudeResponse.message
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    const patchSnapshot =
      claudeResponse.targetFilePath === snapshot.path
        ? snapshot
        : await broker.readFile(claudeResponse.targetFilePath);

    if (claudeResponse.afterContents === patchSnapshot.contents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          claudeResponse.message ||
            "Claude did not propose a file change for this request."
        )
      );
      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events
      };
    }

    events.push(
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
      claudeResponse.afterContents,
      normalizeSummary(claudeResponse.summary)
    );
    events.push(
      createToolEvent(
        sessionId,
        "propose-patch",
        "succeeded",
        `Created changeset ${changeset.id}`,
        "medium"
      ),
      createPatchEvent(sessionId, changeset),
      createApprovalEvent(sessionId),
      createVerificationEvent(
        sessionId,
        "pending",
        "Apply the Claude patch to start compile verification."
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

async function getClaudeCliAuthStatus(
  claudeBinary: string
): Promise<ClaudeCodeAuthStatus> {
  const { stdout } = await runCommand(claudeBinary, ["auth", "status"], 15_000);
  const parsed = JSON.parse(stdout) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Claude auth status was not a JSON object.");
  }

  const candidate = parsed as Partial<ClaudeCodeAuthStatus>;

  return {
    loggedIn: candidate.loggedIn === true,
    ...(typeof candidate.authMethod === "string"
      ? { authMethod: candidate.authMethod }
      : {}),
    ...(typeof candidate.apiProvider === "string"
      ? { apiProvider: candidate.apiProvider }
      : {}),
    ...(typeof candidate.subscriptionType === "string"
      ? { subscriptionType: candidate.subscriptionType }
      : {})
  };
}

async function runClaudeCode(
  claudeBinary: string,
  model: string,
  request: ClaudeCodeRequest
): Promise<ClaudeAgentResponse> {
  const { stdout } = await runCommand(
    claudeBinary,
    [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(claudeOutputSchema),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "local",
      "--disable-slash-commands",
      "--tools",
      "",
      "--no-session-persistence",
      "--model",
      model,
      "-"
    ],
    request.timeoutMs,
    request.prompt,
    request.projectRoot
  );

  return parseClaudeAgentResponseFromCli(stdout);
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
  cwd?: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: createProviderCliEnv()
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk, 240_000);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, 240_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with ${code}: ${formatCommandFailure(stderr || stdout)}`
          )
        );
      }
    });
    child.stdin.end(stdin ?? "");
  });
}

function formatCommandFailure(output: string): string {
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return "no error output";
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isClaudeErrorResult(parsed)) {
      return getClaudeResultText(parsed);
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function parseClaudeAgentResponseFromCli(stdout: string): ClaudeAgentResponse {
  if (stdout.trim().length === 0) {
    throw new Error("Claude Code returned no output.");
  }

  const parsed = JSON.parse(stdout) as unknown;

  if (isClaudeErrorResult(parsed)) {
    throw new Error(
      `Claude Code returned an error result: ${getClaudeResultText(parsed)}`
    );
  }

  if (typeof parsed === "object" && parsed !== null && "structured_output" in parsed) {
    return parseClaudeAgentResponse(
      (parsed as { readonly structured_output?: unknown }).structured_output
    );
  }

  if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
    return parseClaudeAgentResponse((parsed as { readonly result?: unknown }).result);
  }

  return parseClaudeAgentResponse(parsed);
}

export function parseClaudeAgentResponse(value: unknown): ClaudeAgentResponse {
  if (typeof value === "string" && value.trim().length === 0) {
    throw new Error(
      "Claude Code returned an empty result. Run `claude -p 'Say hello.'` to verify print mode."
    );
  }

  const parsed = typeof value === "string" ? parseJsonText(value) : value;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Claude output was not a JSON object.");
  }

  const candidate = parsed as Partial<ClaudeAgentResponse>;

  if (
    (candidate.action !== "answer" && candidate.action !== "patch") ||
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.notes !== "string"
  ) {
    throw new Error("Claude output did not match the expected agent response schema.");
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

function isClaudeErrorResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly is_error?: unknown;
    readonly subtype?: unknown;
  };
  return candidate.is_error === true || candidate.subtype === "error";
}

function getClaudeResultText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("result" in value)) {
    return "unknown error";
  }

  const result = (value as { readonly result?: unknown }).result;
  return typeof result === "string" && result.trim().length > 0
    ? result.trim()
    : "unknown error";
}

function createClaudePrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return [
    "You are the Claude Code provider inside a local-first LaTeX editor.",
    "Use your own judgment to decide how to complete the user's task.",
    "You may inspect the project from the current working directory, but do not modify files.",
    "Return only JSON matching the provided schema.",
    'Set action to "answer" when the task is best completed by explanation, summary, review, diagnosis, or guidance.',
    'Set action to "patch" only when the task requires a source edit. For patches, produce a minimal full-file replacement for targetFilePath.',
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". You may describe suggested edits in message, but do not return a patch action.'
      : "ZeroLeaf will convert patch actions into a reviewable local changeset before any file is changed.",
    "Preserve all unrelated text and formatting when returning a patch.",
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
    `Project root: ${request.projectRoot}`,
    `Target file: ${snapshot.path}`,
    request.mainFilePath === undefined ? "" : `Main file: ${request.mainFilePath}`,
    formatAgentSelectionContextForPrompt(request) ?? "",
    request.diagnostic === undefined
      ? ""
      : `Diagnostic: ${request.diagnostic.severity} ${request.diagnostic.filePath ?? ""}:${request.diagnostic.line ?? ""} ${request.diagnostic.message}`,
    "",
    `Original ${snapshot.path}:`,
    "```tex",
    snapshot.contents,
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

const claudeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ["answer", "patch"] },
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
    message: { type: "string" },
    notes: { type: "string" }
  },
  required: ["action", "targetFilePath", "summary", "afterContents", "message", "notes"]
} as const;

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
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
    prompt: "Review the Claude patch before applying it to the project.",
    status: "requested"
  };
}

function createVerificationEvent(
  sessionId: string,
  status: "pending" | "running" | "passed" | "failed",
  summary: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    type: "verification",
    status,
    summary
  };
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
  return trimmed.length === 0 ? "Claude proposed update" : trimmed.slice(0, 160);
}

function formatSubscription(subscriptionType: string | undefined): string {
  return subscriptionType === undefined ? "" : ` (${subscriptionType})`;
}

function appendCapped(current: string, chunk: string, maxLength: number): string {
  const next = current + chunk;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Claude Code CLI is unavailable.";
}
