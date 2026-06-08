import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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

export type ClaudePatchResponse = {
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
  readonly notes: string;
};

export type ClaudeCodeRunner = (
  request: ClaudeCodeRequest
) => Promise<ClaudePatchResponse>;

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
      options.claudeBinary ?? process.env["LATEX_AGENT_CLAUDE_BIN"] ?? "claude";
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
        "I will ask the installed Claude Code CLI for a minimal full-file replacement, then turn it into a reviewable patch."
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

    if (request.mode === "read-only") {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          "Read-only mode is active, so I stopped before asking Claude for edits."
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
        "claude-code",
        "running",
        "Running installed Claude Code CLI with built-in tools disabled",
        "medium"
      )
    );
    const claudePatch = await this.runClaudeCode({
      projectRoot: request.projectRoot,
      timeoutMs: this.timeoutMs,
      prompt: createClaudePrompt(request, snapshot)
    });
    events.push(
      createToolEvent(
        sessionId,
        "claude-code",
        "succeeded",
        claudePatch.notes,
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

    if (claudePatch.afterContents === snapshot.contents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
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
        `Creating review patch for ${snapshot.path}`,
        "medium"
      )
    );
    const changeset = await broker.proposePatch(
      snapshot.path,
      snapshot.contents,
      claudePatch.afterContents,
      normalizeSummary(claudePatch.summary)
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
): Promise<ClaudePatchResponse> {
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

  return parseClaudePatchResponseFromCli(stdout);
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
      env: process.env
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
        reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
      }
    });
    child.stdin.end(stdin ?? "");
  });
}

export function parseClaudePatchResponseFromCli(stdout: string): ClaudePatchResponse {
  const parsed = JSON.parse(stdout) as unknown;

  if (typeof parsed === "object" && parsed !== null && "structured_output" in parsed) {
    return parseClaudePatchResponse(
      (parsed as { readonly structured_output?: unknown }).structured_output
    );
  }

  if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
    return parseClaudePatchResponse((parsed as { readonly result?: unknown }).result);
  }

  return parseClaudePatchResponse(parsed);
}

export function parseClaudePatchResponse(value: unknown): ClaudePatchResponse {
  const parsed = typeof value === "string" ? parseJsonText(value) : value;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Claude output was not a JSON object.");
  }

  const candidate = parsed as Partial<ClaudePatchResponse>;

  if (
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
    typeof candidate.notes !== "string"
  ) {
    throw new Error("Claude output did not match the expected patch schema.");
  }

  return {
    targetFilePath: candidate.targetFilePath,
    summary: candidate.summary,
    afterContents: candidate.afterContents,
    notes: candidate.notes
  };
}

function createClaudePrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return [
    "You are the Claude Code provider inside a local-first LaTeX editor.",
    "Do not modify files. Your built-in tools are disabled for this request.",
    "Return only JSON matching the provided schema.",
    "Produce a minimal full-file replacement for the target file.",
    "Preserve all unrelated text and formatting.",
    "If no edit is needed, return afterContents exactly equal to the original file.",
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
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
    notes: { type: "string" }
  },
  required: ["targetFilePath", "summary", "afterContents", "notes"]
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
