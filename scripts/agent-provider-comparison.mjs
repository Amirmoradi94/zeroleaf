#!/usr/bin/env node
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AgentHostClient } from "../packages/agent-host/dist/index.js";
import { HistoryStore } from "../packages/history-service/dist/index.js";
import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import { readProjectFile } from "../packages/project-service/dist/index.js";

const providers = parseListArg("--providers", ["openai-codex", "anthropic-claude"]);
const requireProviders = parseListArg("--require", []);
const root = join(process.cwd(), "tmp", "agent-provider-comparison");
const hostProcessPath = resolve(
  process.cwd(),
  "packages",
  "agent-host",
  "dist",
  "host-process.js"
);
const prompt =
  getArgValue("--prompt") ??
  "Fix the LaTeX compile error by adding the smallest correct edit.";
const input = String.raw`\documentclass{article}
\begin{document}
Provider comparison sample.
`;
const expectedRealProviderStartSignature = [
  "message:user",
  "message:assistant",
  "tool-call:read-file:running:low",
  "tool-call:read-file:succeeded:low",
  "tool-call:provider-local:running:medium",
  "tool-call:provider-local:succeeded:medium",
  "tool-call:propose-patch:running:medium",
  "tool-call:propose-patch:succeeded:medium",
  "patch:proposed",
  "approval:apply-patch:requested:high",
  "verification:pending"
];
const expectedFinalSignature = [
  "approval:apply-patch:allowed:high",
  "tool-call:apply-patch:running:high",
  "tool-call:apply-patch:succeeded:high",
  "patch:applied",
  "tool-call:run-compile:running:medium",
  "tool-call:run-compile:succeeded:medium",
  "verification:passed"
];

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const results = [];
const historyStores = new Map();
const client = new AgentHostClient({
  hostProcessPath,
  handleToolRequest: async (message) => {
    const store = getHistoryStore(message.context.projectRoot);

    switch (message.toolName) {
      case "read-file":
        return readProjectFile(message.context.projectRoot, message.payload.path);
      case "search-project":
        return [];
      case "propose-patch":
        return store.createChangeSet({
          projectRoot: message.context.projectRoot,
          filePath: message.payload.filePath,
          beforeContents: message.payload.beforeContents,
          afterContents: message.payload.afterContents,
          summary: message.payload.summary
        });
      case "apply-patch":
        if (!message.payload.approved) {
          throw new Error("apply-patch was not approved");
        }
        return store.applyChangeSet(message.payload.changesetId);
      case "run-compile":
        if (!message.payload.approved) {
          throw new Error("run-compile was not approved");
        }
        return runLatexBuild({
          projectRoot: message.context.projectRoot,
          mainFilePath: message.context.mainFilePath ?? "main.tex",
          compiler: "pdflatex",
          timeoutMs: 120_000,
          maxOutputBytes: 2_000_000
        });
      case "codex-exec":
      case "claude-code":
        throw new Error(`${message.toolName} is provider-local`);
      default:
        throw new Error(`Unhandled tool ${message.toolName}`);
    }
  }
});

try {
  for (const providerId of providers) {
    try {
      const auth = await client.getAuthStatus(providerId);
      const projectRoot = join(root, providerId);
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, "main.tex"), input, "utf8");
      const initialBuild = await runLatexBuild({
        projectRoot,
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        timeoutMs: 120_000,
        maxOutputBytes: 2_000_000
      });

      if (initialBuild.status !== "failed") {
        results.push({
          providerId,
          status: "failed",
          authState: auth.state,
          buildStatus: initialBuild.status,
          message: "Scenario project was expected to fail before agent repair."
        });
        console.log(`FAIL ${providerId}: initial build ${initialBuild.status}`);
        continue;
      }

      if (auth.state !== "connected") {
        const required = requireProviders.includes(providerId);
        const skipped = {
          providerId,
          status: required ? "failed" : "skipped",
          authState: auth.state,
          message:
            auth.message ??
            (required ? `${providerId} was required but is ${auth.state}` : undefined)
        };
        results.push(skipped);
        console.log(
          `${required ? "FAIL" : "SKIP"} ${providerId}: ${auth.state} ${auth.message ?? ""}`.trim()
        );
        continue;
      }

      const start = await client.startSession({
        providerId,
        mode: "apply-with-review",
        projectRoot,
        prompt,
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      });
      const approval = start.events.find(
        (event) => event.type === "approval" && event.status === "requested"
      );

      if (start.status !== "awaiting-approval" || approval === undefined) {
        const providerError = start.events.find((event) => event.type === "error");
        results.push({
          providerId,
          status: start.status,
          authState: auth.state,
          changesetId: start.changeset?.id,
          message:
            providerError?.message ??
            "Provider did not propose an approval-ready changeset."
        });
        console.log(`FAIL ${providerId}: ${start.status}`);
        continue;
      }

      const final = await client.respondApproval({
        sessionId: start.sessionId,
        approvalId: approval.approvalId,
        decision: "allowed"
      });
      const startEventSignature = normalizeAgentEvents(start.events);
      const finalEventSignature = normalizeAgentEvents(final.events);
      const eventContractError = validateProviderEventContract(
        providerId,
        startEventSignature,
        finalEventSignature
      );
      const finalText = await readFile(join(projectRoot, "main.tex"), "utf8");
      const pdfPath = final.buildResult?.artifact?.pdfPath;
      const pdfBytes = pdfPath === undefined ? 0 : (await stat(pdfPath)).size;
      const status =
        final.status === "completed" &&
        final.changeset?.status === "applied" &&
        final.buildResult?.status === "succeeded" &&
        pdfBytes > 0 &&
        eventContractError === undefined
          ? "passed"
          : "failed";

      results.push({
        providerId,
        status,
        authState: auth.state,
        changesetId: final.changeset?.id,
        summary: final.changeset?.summary,
        buildStatus: final.buildResult?.status,
        pdfPath,
        pdfBytes,
        finalHasDocumentEnd: finalText.includes("\\end{document}"),
        startEventSignature,
        finalEventSignature,
        ...(eventContractError === undefined ? {} : { message: eventContractError })
      });
      console.log(
        `${status.toUpperCase()} ${providerId}: ${final.buildResult?.status}`
      );
    } catch (error) {
      results.push({
        providerId,
        status: "failed",
        message: getErrorMessage(error)
      });
      console.log(`FAIL ${providerId}: ${getErrorMessage(error)}`);
    }
  }
} finally {
  client.stop();
  for (const store of historyStores.values()) {
    store.close();
  }
}

const passedRealProviderResults = results.filter(
  (result) =>
    result.status === "passed" &&
    (result.providerId === "openai-codex" || result.providerId === "anthropic-claude")
);
const realProviderSignaturesMatch =
  passedRealProviderResults.length < 2 ||
  passedRealProviderResults.every(
    (result) =>
      JSON.stringify(result.startEventSignature) ===
        JSON.stringify(passedRealProviderResults[0].startEventSignature) &&
      JSON.stringify(result.finalEventSignature) ===
        JSON.stringify(passedRealProviderResults[0].finalEventSignature)
  );

if (!realProviderSignaturesMatch) {
  for (const result of passedRealProviderResults) {
    result.status = "failed";
    result.message = "Real provider normalized event signatures did not match.";
  }
}

const failed = results.filter((result) => result.status === "failed");
console.log(
  JSON.stringify(
    {
      root,
      prompt,
      realProviderSignaturesMatch,
      results
    },
    null,
    2
  )
);

if (failed.length > 0) {
  process.exitCode = 1;
}

function getHistoryStore(projectRoot) {
  const existing = historyStores.get(projectRoot);
  if (existing !== undefined) {
    return existing;
  }

  const store = new HistoryStore(join(projectRoot, "history.sqlite"));
  historyStores.set(projectRoot, store);
  return store;
}

function parseListArg(name, fallback) {
  const value = getArgValue(name);
  return value === undefined
    ? fallback
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));

  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function normalizeAgentEvents(events) {
  return events.map((event) => {
    switch (event.type) {
      case "message":
        return `message:${event.role}`;
      case "tool-call":
        return `tool-call:${normalizeToolName(event.toolName)}:${event.status}:${event.risk}`;
      case "patch":
        return `patch:${event.status}`;
      case "approval":
        return `approval:${event.toolName}:${event.status}:${event.risk}`;
      case "verification":
        return `verification:${event.status}`;
      case "error":
        return `error:${event.recoverable}`;
      default:
        return `unknown:${event.type}`;
    }
  });
}

function normalizeToolName(toolName) {
  return toolName === "codex-exec" || toolName === "claude-code"
    ? "provider-local"
    : toolName;
}

function validateProviderEventContract(
  providerId,
  startEventSignature,
  finalEventSignature
) {
  if (providerId === "mock") {
    return undefined;
  }

  if (!sameArray(startEventSignature, expectedRealProviderStartSignature)) {
    return "Provider start events did not match the normalized real-provider contract.";
  }

  if (!sameArray(finalEventSignature, expectedFinalSignature)) {
    return "Provider approval events did not match the normalized apply/verify contract.";
  }

  return undefined;
}

function sameArray(left, right) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Provider comparison failed.";
}
