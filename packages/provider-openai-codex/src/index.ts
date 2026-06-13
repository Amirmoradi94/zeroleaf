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
  readonly setMainFile?: (path: string) => Promise<{ readonly path: string }>;
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

export type CodexAgentResponse = {
  readonly action: "answer" | "patch" | "set-main-file";
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
    this.timeoutMs = options.timeoutMs ?? 180_000;
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
        "codex-exec",
        "running",
        "Running installed Codex CLI in a read-only project sandbox",
        "medium"
      )
    );
    let codexResponse = await this.runCodexExec({
      projectRoot: request.projectRoot,
      timeoutMs: this.timeoutMs,
      prompt: createCodexPrompt(request, snapshot)
    });
    events.push(
      createToolEvent(
        sessionId,
        "codex-exec",
        "succeeded",
        codexResponse.notes,
        "medium"
      )
    );

    if (shouldRetryForConcreteAction(request, codexResponse)) {
      events.push(
        createToolEvent(
          sessionId,
          "codex-exec",
          "running",
          "Codex returned guidance for a concrete change; requesting a tool action",
          "medium"
        )
      );
      codexResponse = await this.runCodexExec({
        projectRoot: request.projectRoot,
        timeoutMs: this.timeoutMs,
        prompt: createCodexPatchRetryPrompt(request, snapshot, codexResponse)
      });
      events.push(
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

      events.push(
        createToolEvent(
          sessionId,
          "set-main-file",
          "running",
          `Setting main TeX file to ${codexResponse.targetFilePath}`,
          "high"
        )
      );
      const result = await broker.setMainFile(codexResponse.targetFilePath);
      events.push(
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

    const patchSnapshot =
      codexResponse.targetFilePath === snapshot.path
        ? snapshot
        : await broker.readFile(codexResponse.targetFilePath);

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
      codexResponse.afterContents,
      normalizeSummary(codexResponse.summary)
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
      [
        "exec",
        "--skip-git-repo-check",
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
        request.projectRoot,
        "-"
      ],
      request.timeoutMs,
      request.prompt
    );
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    return parseCodexAgentResponse(parsed);
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
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
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
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled || timedOut) {
        return;
      }

      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else if (code === null) {
        reject(
          new Error(
            `${command} was terminated${signal === null ? "" : ` by ${signal}`}.`
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
    "You may inspect the project from the current working directory, but do not modify files.",
    "Return only JSON matching the provided schema.",
    'Set action to "answer" when the task is best completed by explanation, summary, review, diagnosis, or guidance.',
    'Set action to "patch" when the task requires or asks for a source edit. For patches, produce a minimal full-file replacement for targetFilePath.',
    'Set action to "set-main-file" when the user asks to choose, change, set, or switch the project main/root TeX file without editing source contents. Put the desired .tex project path in targetFilePath.',
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". You may describe suggested edits in message, but do not return a patch action.'
      : "ZeroLeaf will convert patch actions into a reviewable local changeset before any file is changed.",
    request.mode === "read-only"
      ? ""
      : 'For edit, change, rewrite, replace, set, insert, delete, fix, repair, compile-error, failing-build, and diagnostic tasks, return the concrete action whenever safe: "patch" for source edits and "set-main-file" for changing the project main TeX file. Do not stop at explaining the edit or app action.',
    "Preserve all unrelated text and formatting when returning a patch.",
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
    'If the user asked to set or change the project main TeX file, return action "set-main-file" with targetFilePath set to that .tex project path.',
    'Use action "answer" only if no source edit or app action is safe, or no change is actually needed.',
    "",
    "Previous message:",
    previousResponse.message
  ].join("\n");
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

  return /\b(edit|change|set|switch|make|update|rewrite|replace|insert|add|remove|delete|fix|repair|compile error|compilation error|failing build|build failure|latex error|diagnostic|main\s+(?:tex|file)|root\s+(?:tex|file))\b/iu.test(
    request.prompt
  );
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

function parseCodexAgentResponse(value: unknown): CodexAgentResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Codex output was not a JSON object.");
  }

  const candidate = value as Partial<CodexAgentResponse>;

  if (
    (candidate.action !== "answer" &&
      candidate.action !== "patch" &&
      candidate.action !== "set-main-file") ||
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
    action: { enum: ["answer", "patch", "set-main-file"] },
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
    message: { type: "string" },
    notes: { type: "string" }
  },
  required: ["action", "targetFilePath", "summary", "afterContents", "message", "notes"]
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
