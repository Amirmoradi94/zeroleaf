import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  formatAgentImageAttachmentsForPrompt,
  formatAgentSelectionContextForPrompt
} from "@latex-agent/ipc-contracts";
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
  ProjectFileSnapshot,
  WordBlockOperation,
  WordChangeSet
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
  readonly emitEvent?: (event: AgentEvent) => void;
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
  readonly mode: AgentStartRequest["mode"];
  readonly projectRoot: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly onProgress?: (summary: string) => void;
};

export type ClaudeAgentWordChangeSet = {
  readonly filePath: string;
  readonly summary: string;
  readonly operations: readonly WordBlockOperation[];
};

export type ClaudeAgentResponse = {
  readonly action: "answer" | "patch" | "word-edit";
  readonly targetFilePath: string;
  readonly summary: string;
  readonly afterContents: string;
  readonly wordChangesets?: readonly ClaudeAgentWordChangeSet[];
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
        request.mode === "autonomous-local"
          ? "I will ask the installed Claude Code CLI to edit the open project directly and report what changed."
          : "I will ask the installed Claude Code CLI to inspect the project and decide whether to answer or propose a reviewable patch."
      )
    ];
    const activeDocumentSnapshot = createActiveDocumentSnapshot(request);
    const targetPath = request.activeFilePath ?? request.mainFilePath;
    const snapshot =
      activeDocumentSnapshot ??
      (targetPath === undefined
        ? createEmptyProjectSnapshot()
        : await readInitialSnapshot({ broker, events, sessionId, targetPath }));

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
      mode: request.mode,
      projectRoot: request.projectRoot,
      timeoutMs: this.timeoutMs,
      prompt: createClaudePrompt(request, snapshot),
      onProgress: (summary) => {
        broker.emitEvent?.(createToolEvent(sessionId, "claude-code", "running", summary, "low"));
      }
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

    const wordChangeSets = createClaudeWordChangeSets(request, claudeResponse);
    if (wordChangeSets.length > 0) {
      const wordChangeset = wordChangeSets[0];
      if (wordChangeset === undefined) {
        throw new Error("Claude returned an empty Word changeset list.");
      }

      events.push(
        ...wordChangeSets.map((changeset) =>
          createWordChangeSetEvent(sessionId, changeset)
        ),
        createMessageEvent(
          sessionId,
          "assistant",
          claudeResponse.message ||
            `Claude proposed ${wordChangeSets.length} Word edit${wordChangeSets.length === 1 ? "" : "s"}.`
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        wordChangeset,
        wordChangesets: wordChangeSets
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

    const patchSnapshot = await readPatchSnapshot(
      claudeResponse.targetFilePath,
      snapshot,
      broker
    );

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
  const finalResult = await runClaudeCodeStream(
    claudeBinary,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--json-schema",
      JSON.stringify(claudeOutputSchema),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "local",
      "--disable-slash-commands",
      "--tools",
      getClaudeToolsForMode(request.mode),
      "--add-dir",
      request.projectRoot,
      "--no-session-persistence",
      "--model",
      model,
      "-"
    ],
    request
  );

  return parseClaudeAgentResponseFromParsedResult(finalResult);
}

function runClaudeCodeStream(
  command: string,
  args: readonly string[],
  request: ClaudeCodeRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: createProviderCliEnv()
    });
    let pendingLine = "";
    let stderr = "";
    let finalResult: unknown;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${request.timeoutMs}ms.`));
    }, request.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";

      for (const line of lines) {
        const parsedLine = parseClaudeStreamLine(line);
        if (parsedLine === undefined) {
          continue;
        }

        if (parsedLine["type"] === "result") {
          finalResult = parsedLine;
          continue;
        }

        const progress = describeClaudeStreamEvent(parsedLine);
        if (progress !== undefined) {
          request.onProgress?.(progress);
        }
      }
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

      if (code !== 0) {
        reject(
          new Error(`${command} exited with ${code}: ${formatCommandFailure(stderr)}`)
        );
        return;
      }

      if (finalResult === undefined) {
        reject(new Error("Claude Code returned no output."));
        return;
      }

      resolve(finalResult);
    });
    child.stdin.end(request.prompt);
  });
}

function parseClaudeStreamLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function describeClaudeStreamEvent(record: Record<string, unknown>): string | undefined {
  if (record["type"] === "system" && record["subtype"] === "post_turn_summary") {
    const detail = record["status_detail"];
    return typeof detail === "string" && detail.trim().length > 0
      ? `Claude progress: ${truncateForLiveStatus(detail)}`
      : undefined;
  }

  if (record["type"] !== "assistant") {
    return undefined;
  }

  const message = record["message"];
  const content =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)["content"]
      : undefined;

  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  const block = content[content.length - 1] as Record<string, unknown>;

  if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
    const thinking = block["thinking"].trim();
    return thinking.length === 0
      ? undefined
      : `Claude is thinking: ${truncateForLiveStatus(thinking)}`;
  }

  if (block["type"] === "text" && typeof block["text"] === "string") {
    const text = block["text"].trim();
    return text.length === 0
      ? undefined
      : `Claude is drafting a response: ${truncateForLiveStatus(text)}`;
  }

  if (block["type"] === "tool_use" && typeof block["name"] === "string") {
    return `Claude is using a tool: ${describeClaudeToolUse(block["name"], block["input"])}`;
  }

  return undefined;
}

function describeClaudeToolUse(toolName: string, input: unknown): string {
  const fields = typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};

  switch (toolName) {
    case "Read":
      return `Reading ${describeToolInputField(fields["file_path"])}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${describeToolInputField(fields["file_path"])}`;
    case "Write":
      return `Writing ${describeToolInputField(fields["file_path"])}`;
    case "Glob":
      return `Searching for ${describeToolInputField(fields["pattern"])}`;
    case "Grep":
      return `Searching project for "${describeToolInputField(fields["pattern"])}"`;
    case "LS":
      return `Listing ${describeToolInputField(fields["path"])}`;
    default:
      return toolName;
  }
}

function describeToolInputField(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "the project";
}

function truncateForLiveStatus(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > 140 ? `${singleLine.slice(0, 140)}…` : singleLine;
}

export function getClaudeToolsForMode(mode: AgentStartRequest["mode"]): string {
  if (mode === "autonomous-local") {
    return "Read,Grep,Glob,LS,Edit,MultiEdit,Write";
  }

  return "Read,Grep,Glob,LS";
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

  return parseClaudeAgentResponseFromParsedResult(JSON.parse(stdout) as unknown);
}

function parseClaudeAgentResponseFromParsedResult(parsed: unknown): ClaudeAgentResponse {
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
    (candidate.action !== "answer" &&
      candidate.action !== "patch" &&
      candidate.action !== "word-edit") ||
    typeof candidate.targetFilePath !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.afterContents !== "string" ||
    !isValidClaudeAgentWordChangeSets(candidate.wordChangesets) ||
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
    ...(candidate.wordChangesets === undefined
      ? {}
      : { wordChangesets: candidate.wordChangesets }),
    message: candidate.message,
    notes: candidate.notes
  };
}

function isValidClaudeAgentWordChangeSets(
  value: Partial<ClaudeAgentResponse>["wordChangesets"]
): value is readonly ClaudeAgentWordChangeSet[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (changeset) =>
          changeset !== null &&
          typeof changeset === "object" &&
          typeof (changeset as Partial<ClaudeAgentWordChangeSet>).filePath ===
            "string" &&
          typeof (changeset as Partial<ClaudeAgentWordChangeSet>).summary ===
            "string" &&
          isValidWordBlockOperations(
            (changeset as Partial<ClaudeAgentWordChangeSet>).operations
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
          typeof operation.afterBlockId === "string")
      );
    case "replace-selection":
      return (
        typeof operation.blockId === "string" &&
        typeof operation.startOffset === "number" &&
        typeof operation.endOffset === "number" &&
        typeof operation.replacementText === "string"
      );
    default:
      return false;
  }
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
    request.mode === "autonomous-local"
      ? "You have direct project-scoped access to inspect, create, edit, overwrite, move, and delete files under the current project root. Do not write outside the project root."
      : "You may inspect the project from the current working directory, but do not modify files.",
    request.mode === "autonomous-local"
      ? 'For project-scoped edit requests, use the available file tools directly instead of merely describing the edit. After direct source edits, return action "answer" with the files changed and what you did.'
      : "",
    "If a search command or pattern fails, retry with a simpler literal search, list files, or read likely source files directly before concluding the task cannot be completed.",
    "Return only JSON matching the provided schema.",
    'Set action to "answer" when the task is best completed by explanation, summary, review, diagnosis, or guidance.',
    'Use action "answer" for planning and scholarly-advice tasks such as literature review plans, paper outlines, manuscript critiques, reading plans, methodology suggestions, and submission checklists unless the user explicitly asks you to insert, rewrite, patch, compile, or change project files.',
    "A user mentioning a PDF, paper, thesis, manuscript, or active document as source context does not by itself require a file edit or patch.",
    'Set action to "patch" only when the task requires a source edit. For patches, produce a minimal full-file replacement for targetFilePath.',
    "Requests to merge, combine, consolidate, split, reorganize, or restructure sections/subsections are source-edit requests.",
    request.mode === "read-only"
      ? 'The current ZeroLeaf mode is read-only, so action must be "answer". You may describe suggested edits in message, but do not return a patch action.'
      : request.mode === "autonomous-local"
        ? 'The current ZeroLeaf mode is autonomous-local. Prefer direct project-root file edits for any safe project-scoped edit. Use action "answer" after direct edits, or action "patch" only if direct editing is not possible.'
        : "ZeroLeaf will convert patch actions into a reviewable local changeset before any file is changed.",
    "Write message like a person reporting back after doing the task: first person, concrete, concise, and warm. Say what you changed or checked, mention verification when relevant, and avoid generic boilerplate such as build-log directions.",
    "In message, always explain the result in user-facing terms: list the files or sections changed and the purpose of the change. If no source file changed, say why no change was made and do not imply that an edit happened.",
    "Preserve all unrelated text and formatting when returning a patch.",
    request.activeDocument?.kind === "word"
      ? 'The active document is a Microsoft Word .docx file represented as extracted paragraphs. Do not return a raw .docx patch. For Word edits, set action "word-edit", afterContents "", and populate wordChangesets with filePath, summary, and operations using operation types "replace-block", "insert-block-after", "delete-block", "move-block", or "replace-selection".'
      : "",
    snapshot.path === newFileSnapshotPath
      ? 'No active TeX file is open. If the user asks to create a .tex file, return action "patch", choose a clear project-relative targetFilePath ending in .tex, set afterContents to the complete new file contents, and use an empty original file.'
      : "",
    snapshot.path === newFileSnapshotPath
      ? 'If the project root is empty and the user asks to create, start, make, or set up a project, treat the prompt as a project bootstrap request. Return action "patch" with a complete compilable main .tex file. Default to a LaTeX project when the requested format is ambiguous. Do not answer with instructions or ask the user to open a template picker.'
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
    "",
    `Original ${snapshot.path}:`,
    request.activeDocument?.kind === "word" ? "```text" : "```tex",
    snapshot.contents,
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

function createClaudeWordChangeSets(
  request: AgentStartRequest,
  response: ClaudeAgentResponse
): readonly WordChangeSet[] {
  const activeDocument = request.activeDocument;

  if (activeDocument?.kind !== "word") {
    return [];
  }

  const requestedChangeSets = response.wordChangesets ?? [];

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

async function readInitialSnapshot({
  broker,
  events,
  sessionId,
  targetPath
}: {
  readonly broker: ClaudeCodeToolBroker;
  readonly events: AgentEvent[];
  readonly sessionId: string;
  readonly targetPath: string;
}): Promise<ProjectFileSnapshot> {
  events.push(
    createToolEvent(sessionId, "read-file", "running", `Reading ${targetPath}`, "low")
  );
  const snapshot = await broker.readFile(targetPath);
  events.push(
    createToolEvent(sessionId, "read-file", "succeeded", `Read ${snapshot.path}`, "low")
  );

  return snapshot;
}

async function readPatchSnapshot(
  targetFilePath: string,
  fallbackSnapshot: ProjectFileSnapshot,
  broker: Pick<ClaudeCodeToolBroker, "readFile">
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

const claudeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ["answer", "patch", "word-edit"] },
    targetFilePath: { type: "string" },
    summary: { type: "string" },
    afterContents: { type: "string" },
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
                    "replace-selection"
                  ]
                },
                blockId: { type: "string" },
                afterText: { type: "string" },
                afterBlockId: { type: "string" },
                block: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    kind: { enum: ["paragraph"] },
                    text: { type: "string" }
                  },
                  required: ["id", "kind", "text"]
                },
                startOffset: { type: "number" },
                endOffset: { type: "number" },
                replacementText: { type: "string" }
              },
              required: ["type"]
            }
          }
        },
        required: ["filePath", "summary", "operations"]
      }
    },
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
