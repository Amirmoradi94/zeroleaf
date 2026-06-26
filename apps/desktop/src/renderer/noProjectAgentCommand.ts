export type NoProjectAgentCommand = {
  readonly kind: "create-project";
  readonly documentKind: "latex" | "word";
  readonly projectName: string;
  readonly wordPath?: string;
};

export function parseNoProjectAgentCommand(
  prompt: string
): NoProjectAgentCommand | undefined {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length === 0) {
    return undefined;
  }

  const lowerPrompt = normalizedPrompt.toLowerCase();
  const isCreateProjectIntent =
    /\b(create|start|make|set up|setup)\b/u.test(lowerPrompt) &&
    /\b(project|paper|manuscript)\b/u.test(lowerPrompt);

  if (!isCreateProjectIntent) {
    return undefined;
  }

  const projectName = inferNoProjectAgentProjectName(normalizedPrompt);

  if (projectName.length === 0) {
    return undefined;
  }

  const documentKind = inferNoProjectAgentDocumentKind(normalizedPrompt);

  return {
    kind: "create-project",
    documentKind,
    projectName,
    ...(documentKind === "word"
      ? { wordPath: inferNoProjectAgentWordPath(normalizedPrompt, projectName) }
      : {})
  };
}

export function inferNoProjectAgentDocumentKind(prompt: string): "latex" | "word" {
  return /\b(ms\s*word|microsoft\s*word|word\s+document|docx|\.docx)\b/iu.test(prompt)
    ? "word"
    : "latex";
}

export function inferNoProjectAgentWordPath(
  prompt: string,
  projectName: string
): string {
  const explicitDocxName = [
    /\b(?:document|file)\s+(?:named\s+|called\s+)?["'`]?([^"'`\n\r/\\:]+?\.docx)["'`]?/iu,
    /["'`]([^"'`\n\r/\\:]+?\.docx)["'`]/iu,
    /\b([A-Za-z0-9][A-Za-z0-9._-]*\.docx)\b/iu
  ]
    .map((pattern) => prompt.match(pattern)?.[1])
    .find((candidate): candidate is string => candidate !== undefined);
  const rawName =
    explicitDocxName ??
    `${
      projectName
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "") || "document"
    }.docx`;

  return rawName
    .replace(/[/\\:]/gu, "-")
    .replace(/^\.+/u, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/\.docx$/iu, ".docx");
}

export function inferNoProjectAgentProjectName(prompt: string): string {
  const explicitName = [
    /\bname(?:d)?\s+(?:it\s+)?["']?([^"'\n\r]+?)["']?\s+(?:with|and|containing|that)\b/iu,
    /\bcalled\s+["']?([^"'\n\r]+?)["']?\s+(?:with|and|containing|that)\b/iu,
    /\btitled\s+["']?([^"'\n\r]+?)["']?\s+(?:with|and|containing|that)\b/iu,
    /\bname(?:d)?\s+(?:it\s+)?["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\bcalled\s+["']?([^"'\n\r]+?)["']?\s*$/iu,
    /\btitled\s+["']?([^"'\n\r]+?)["']?\s*$/iu
  ]
    .map((pattern) => prompt.match(pattern)?.[1])
    .find((candidate): candidate is string => candidate !== undefined);

  if (explicitName !== undefined) {
    return sanitizeNoProjectAgentProjectName(explicitName);
  }

  const trailingProjectName = prompt.match(
    /\bproject\s+["']?([^"'\n\r]+?)["']?\s*$/iu
  )?.[1];
  if (
    trailingProjectName !== undefined &&
    !/\b(and then|then|inside|containing|with|that)\b/iu.test(trailingProjectName)
  ) {
    return sanitizeNoProjectAgentProjectName(trailingProjectName);
  }

  return "paper";
}

function sanitizeNoProjectAgentProjectName(projectName: string): string {
  return projectName
    .trim()
    .replace(/[.?!,;:]+$/u, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim();
}
