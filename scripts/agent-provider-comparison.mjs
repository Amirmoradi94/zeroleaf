#!/usr/bin/env node
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AgentHostClient } from "../packages/agent-host/dist/index.js";
import { HistoryStore } from "../packages/history-service/dist/index.js";
import { runLatexBuild } from "../packages/latex-service/dist/index.js";
import { readProjectFile } from "../packages/project-service/dist/index.js";

const providers = parseListArg("--providers", [
  "mock",
  "openai-codex",
  "anthropic-claude"
]);
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
    const auth = await client.getAuthStatus(providerId);
    const projectRoot = join(root, providerId);
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "main.tex"), input, "utf8");

    if (auth.state !== "connected") {
      const skipped = {
        providerId,
        status: "skipped",
        authState: auth.state,
        message: auth.message
      };
      results.push(skipped);
      console.log(`SKIP ${providerId}: ${auth.state} ${auth.message ?? ""}`.trim());

      if (requireProviders.includes(providerId)) {
        throw new Error(`${providerId} was required but is ${auth.state}`);
      }
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
      results.push({
        providerId,
        status: start.status,
        authState: auth.state,
        changesetId: start.changeset?.id,
        message: "Provider did not propose an approval-ready changeset."
      });
      console.log(`FAIL ${providerId}: ${start.status}`);
      continue;
    }

    const final = await client.respondApproval({
      sessionId: start.sessionId,
      approvalId: approval.approvalId,
      decision: "allowed"
    });
    const finalText = await readFile(join(projectRoot, "main.tex"), "utf8");
    const pdfPath = final.buildResult?.artifact?.pdfPath;
    const pdfBytes = pdfPath === undefined ? 0 : (await stat(pdfPath)).size;
    const status =
      final.status === "completed" &&
      final.changeset?.status === "applied" &&
      final.buildResult?.status === "succeeded" &&
      pdfBytes > 0
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
      finalHasDocumentEnd: finalText.includes("\\end{document}")
    });
    console.log(`${status.toUpperCase()} ${providerId}: ${final.buildResult?.status}`);
  }
} finally {
  client.stop();
  for (const store of historyStores.values()) {
    store.close();
  }
}

const failed = results.filter((result) => result.status === "failed");
console.log(JSON.stringify({ root, prompt, results }, null, 2));

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
