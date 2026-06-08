import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export const openAiCodexProviderId = "openai-codex" as const;

export type CodexCliToolBroker = {
  readonly readFile: (path: string) => Promise<ProjectFileSnapshot>;
  readonly searchProject: (query: string) => Promise<readonly ProjectFileSnapshot[]>;
  readonly proposePatch: (
    filePath: string,
    beforeContents: string,
    afterContents: string,
    summary: string
  ) => Promise<HistoryChangeSet>;
};

export type CodexExecRequest = {
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
};

export type CodexPatchResponse = {
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
  readonly notes: string;
};

export type CodexExecRunner = (
  request: CodexExecRequest
) => Promise<CodexPatchResponse>;

export type CodexCliProviderOptions = {
  readonly codexBinary?: string;
  readonly timeoutMs?: number;
  readonly runCodexExec?: CodexExecRunner;
};

export class CodexCliProvider {
  readonly id: AgentProviderId = openAiCodexProviderId;
  private readonly codexBinary: string;
  private readonly timeoutMs: number;
  private readonly runCodexExec: CodexExecRunner;
  private readonly cancelledSessionIds = new Set<string>();

  constructor(options: CodexCliProviderOptions = {}) {
    this.codexBinary =
      options.codexBinary ?? process.env["LATEX_AGENT_CODEX_BIN"] ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.runCodexExec =
      options.runCodexExec ?? ((request) => runCodexExec(this.codexBinary, request));
  }

  async getAuthStatus(): Promise<AgentAuthStatus> {
    try {
      await runCommand(this.codexBinary, ["--version"], 10_000);
      return {
        providerId: this.id,
        state: "connected",
        message: "Installed Codex CLI is available."
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
        "I will ask the installed Codex CLI for a minimal full-file replacement, then turn it into a reviewable patch."
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
          "Read-only mode is active, so I stopped before asking Codex for edits."
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
        "codex-exec",
        "running",
        "Running installed Codex CLI in a read-only sandbox",
        "medium"
      )
    );
    const codexPatch = await this.runCodexExec({
      projectRoot: request.projectRoot,
      timeoutMs: this.timeoutMs,
      prompt: createCodexPrompt(request, snapshot)
    });
    events.push(
      createToolEvent(sessionId, "codex-exec", "succeeded", codexPatch.notes, "medium")
    );

    if (this.cancelledSessionIds.has(sessionId)) {
      return {
        sessionId,
        providerId: this.id,
        status: "cancelled",
        events
      };
    }

    if (codexPatch.afterContents === snapshot.contents) {
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
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
      codexPatch.afterContents,
      normalizeSummary(codexPatch.summary)
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
}

async function runCodexExec(
  codexBinary: string,
  request: CodexExecRequest
): Promise<CodexPatchResponse> {
  const tempRoot = await mkdtemp(join(tmpdir(), "latex-codex-provider-"));
  const schemaPath = join(tempRoot, "codex-output.schema.json");
  const outputPath = join(tempRoot, "codex-output.json");

  try {
    await writeFile(schemaPath, JSON.stringify(codexOutputSchema, null, 2), "utf8");
    await runCommand(
      codexBinary,
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-C",
        request.projectRoot,
        "-"
      ],
      request.timeoutMs,
      request.prompt
    );
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    return parseCodexPatchResponse(parsed);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      stdout = appendCapped(stdout, chunk, 80_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk, 160_000);
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

function createCodexPrompt(
  request: AgentStartRequest,
  snapshot: ProjectFileSnapshot
): string {
  return [
    "You are the OpenAI Codex provider inside a local-first LaTeX editor.",
    "Do not modify files. Return only JSON matching the provided schema.",
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

function parseCodexPatchResponse(value: unknown): CodexPatchResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Codex output was not a JSON object.");
  }

  const candidate = value as Partial<CodexPatchResponse>;

  if (
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
    typeof candidate.notes !== "string"
  ) {
    throw new Error("Codex output did not match the expected patch schema.");
  }

  return {
    targetFilePath: candidate.targetFilePath,
    summary: candidate.summary,
    afterContents: candidate.afterContents,
    notes: candidate.notes
  };
}

const codexOutputSchema = {
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
  return trimmed.length === 0 ? "Codex proposed update" : trimmed.slice(0, 160);
}

function appendCapped(current: string, chunk: string, maxLength: number): string {
  const next = current + chunk;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex CLI is unavailable.";
}
