import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

import { isWordTableOperation } from "@latex-agent/ipc-contracts";
import type {
  WordDocumentBlock,
  WordDocumentModel,
  WordDocumentSaveResult,
  WordBlockOperation,
  WordParagraphBlockOperation,
  WordChangeSet,
  WordChangeSetApplyResult
} from "@latex-agent/ipc-contracts";

const docxExtension = ".docx";

export class DocumentServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-root"
      | "invalid-path"
      | "outside-root"
      | "not-file"
      | "not-readable"
      | "unsupported-document"
  ) {
    super(message);
    this.name = "DocumentServiceError";
  }
}

export async function readWordDocument(
  rootPath: string,
  path: string
): Promise<WordDocumentModel> {
  const root = await validateProjectRoot(rootPath);
  const absolutePath = await resolveExistingDocumentPath(root, path);
  const fileStats = await stat(absolutePath);

  if (!fileStats.isFile()) {
    throw new DocumentServiceError("Word document path must be a file.", "not-file");
  }

  const extraction = await extractDocxParagraphs(absolutePath);
  const paragraphs = splitExtractedParagraphs(extraction.plainText);
  const blocks = (paragraphs.length === 0 ? [""] : paragraphs).map((text, index) =>
    createParagraphBlock(text, index)
  );

  return {
    kind: "word",
    path: toProjectPath(root, absolutePath),
    blocks,
    plainText: blocks.map((block) => block.text).join("\n\n"),
    mtimeMs: fileStats.mtimeMs,
    extractedAt: new Date().toISOString(),
    warnings: extraction.warnings
  };
}

export async function saveWordDocument(
  rootPath: string,
  path: string,
  blocks: readonly WordDocumentBlock[]
): Promise<WordDocumentSaveResult> {
  const root = await validateProjectRoot(rootPath);
  const absolutePath = resolveWritableDocumentPath(root, path);
  const documentBlocks = normalizeBlocks(blocks);
  const document = new Document({
    sections: [
      {
        children:
          documentBlocks.length === 0
            ? [
                new Paragraph({
                  children: [new TextRun(" ")]
                })
              ]
            : documentBlocks.map(
                (block) =>
                  new Paragraph({
                    children: [new TextRun(block.text)]
                  })
              )
      }
    ]
  });
  const buffer = await Packer.toBuffer(document);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  const fileStats = await stat(absolutePath);

  return {
    saved: true,
    path: toProjectPath(root, absolutePath),
    mtimeMs: fileStats.mtimeMs
  };
}

export async function createWordChangeSet({
  projectRoot,
  filePath,
  baseBlocks,
  operations,
  summary
}: {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly baseBlocks: readonly WordDocumentBlock[];
  readonly operations: readonly WordBlockOperation[];
  readonly summary: string;
}): Promise<WordChangeSet> {
  const root = await validateProjectRoot(projectRoot);
  const absolutePath = await resolveExistingDocumentPath(root, filePath);
  const normalizedOperations = normalizeWordOperations(
    assertParagraphBlockOperations(operations)
  );

  if (normalizedOperations.length === 0) {
    throw new DocumentServiceError(
      "Word changeset requires at least one operation.",
      "unsupported-document"
    );
  }

  applyWordBlockOperations(baseBlocks, normalizedOperations);

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectRoot: root,
    filePath: toProjectPath(root, absolutePath),
    summary: summary.trim().length > 0 ? summary.trim() : "Review Word edits",
    baseBlocks: normalizeBlocks(baseBlocks),
    operations: normalizedOperations,
    status: "proposed",
    createdAt: now,
    updatedAt: now
  };
}

export async function applyWordChangeSet(
  changeset: WordChangeSet
): Promise<WordChangeSetApplyResult> {
  if (changeset.status !== "proposed") {
    throw new DocumentServiceError(
      "Only proposed Word changesets can be applied.",
      "unsupported-document"
    );
  }

  const paragraphOperations = assertParagraphBlockOperations(changeset.operations);
  const nextBlocks = applyWordBlockOperations(changeset.baseBlocks, paragraphOperations);
  const appliedAt = new Date().toISOString();
  const appliedChangeSet: WordChangeSet = {
    ...changeset,
    baseBlocks: normalizeBlocks(changeset.baseBlocks),
    operations: normalizeWordOperations(paragraphOperations),
    status: "applied",
    updatedAt: appliedAt,
    appliedAt
  };

  await saveWordDocument(changeset.projectRoot, changeset.filePath, nextBlocks);

  return {
    changeset: appliedChangeSet,
    document: await readWordDocument(changeset.projectRoot, changeset.filePath)
  };
}

export function applyWordBlockOperations(
  blocks: readonly WordDocumentBlock[],
  operations: readonly WordParagraphBlockOperation[]
): readonly WordDocumentBlock[] {
  return operations.reduce(
    (currentBlocks, operation) => applyWordBlockOperation(currentBlocks, operation),
    normalizeBlocks(blocks)
  );
}

function assertParagraphBlockOperations(
  operations: readonly WordBlockOperation[]
): readonly WordParagraphBlockOperation[] {
  if (operations.some(isWordTableOperation)) {
    throw new DocumentServiceError(
      "Word table operations must be applied through the ONLYOFFICE Document Builder path, not the paragraph block rebuild.",
      "unsupported-document"
    );
  }
  return operations as readonly WordParagraphBlockOperation[];
}

function splitExtractedParagraphs(value: string): readonly string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/\n+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

async function extractDocxParagraphs(
  absolutePath: string
): Promise<{ readonly plainText: string; readonly warnings: readonly string[] }> {
  const archive = await JSZip.loadAsync(await readFile(absolutePath));
  const documentXmlFile = archive.file("word/document.xml");

  if (documentXmlFile === null) {
    throw new DocumentServiceError(
      "Word document is missing word/document.xml.",
      "unsupported-document"
    );
  }

  const documentXml = await documentXmlFile.async("string");
  const paragraphs = Array.from(documentXml.matchAll(/<w:p[\s\S]*?<\/w:p>/gu))
    .map((match) => extractParagraphText(match[0]))
    .filter((paragraph) => paragraph.trim().length > 0);

  return {
    plainText: paragraphs.join("\n\n"),
    warnings: []
  };
}

function extractParagraphText(paragraphXml: string): string {
  const textRuns = Array.from(
    paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)
  ).map((match) => decodeXmlText(match[1] ?? ""));
  const text = paragraphXml.includes("<w:tab")
    ? textRuns.join("\t")
    : textRuns.join("");

  return text.replace(/\s+/gu, " ").trim();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function createParagraphBlock(text: string, index: number): WordDocumentBlock {
  const hash = createHash("sha256")
    .update(`${index}:${text}`)
    .digest("hex")
    .slice(0, 12);

  return {
    id: `p-${index + 1}-${hash}`,
    kind: "paragraph",
    text
  };
}

function normalizeBlocks(
  blocks: readonly WordDocumentBlock[]
): readonly WordDocumentBlock[] {
  return blocks.map((block, index) => ({
    id: block.id.trim().length > 0 ? block.id : `p-${index + 1}`,
    kind: "paragraph",
    text: block.text
  }));
}

function normalizeWordOperations(
  operations: readonly WordParagraphBlockOperation[]
): readonly WordParagraphBlockOperation[] {
  return operations.map((operation) => {
    switch (operation.type) {
      case "replace-block":
        return {
          type: operation.type,
          blockId: operation.blockId,
          afterText: operation.afterText
        };
      case "insert-block-after":
        return {
          type: operation.type,
          ...(operation.afterBlockId === undefined
            ? {}
            : { afterBlockId: operation.afterBlockId }),
          block: normalizeBlocks([operation.block])[0]!
        };
      case "delete-block":
        return {
          type: operation.type,
          blockId: operation.blockId
        };
      case "move-block":
        return {
          type: operation.type,
          blockId: operation.blockId,
          ...(operation.afterBlockId === undefined
            ? {}
            : { afterBlockId: operation.afterBlockId })
        };
      case "replace-selection":
        return {
          type: operation.type,
          blockId: operation.blockId,
          startOffset: operation.startOffset,
          endOffset: operation.endOffset,
          replacementText: operation.replacementText
        };
    }
  });
}

function applyWordBlockOperation(
  blocks: readonly WordDocumentBlock[],
  operation: WordParagraphBlockOperation
): readonly WordDocumentBlock[] {
  switch (operation.type) {
    case "replace-block":
      return blocks.map((block) =>
        block.id === operation.blockId ? { ...block, text: operation.afterText } : block
      );
    case "insert-block-after":
      return insertWordBlockAfter(blocks, operation.afterBlockId, operation.block);
    case "delete-block":
      assertBlockExists(blocks, operation.blockId);
      return blocks.filter((block) => block.id !== operation.blockId);
    case "move-block":
      return moveWordBlock(blocks, operation.blockId, operation.afterBlockId);
    case "replace-selection":
      return replaceWordSelection(blocks, operation);
  }
}

function insertWordBlockAfter(
  blocks: readonly WordDocumentBlock[],
  afterBlockId: string | undefined,
  block: WordDocumentBlock
): readonly WordDocumentBlock[] {
  const normalizedBlock = normalizeBlocks([block])[0]!;

  if (afterBlockId === undefined) {
    return [normalizedBlock, ...blocks];
  }

  const afterIndex = blocks.findIndex((candidate) => candidate.id === afterBlockId);

  if (afterIndex === -1) {
    throw new DocumentServiceError(
      `Word block ${afterBlockId} was not found.`,
      "unsupported-document"
    );
  }

  return [
    ...blocks.slice(0, afterIndex + 1),
    normalizedBlock,
    ...blocks.slice(afterIndex + 1)
  ];
}

function moveWordBlock(
  blocks: readonly WordDocumentBlock[],
  blockId: string,
  afterBlockId: string | undefined
): readonly WordDocumentBlock[] {
  const block = blocks.find((candidate) => candidate.id === blockId);

  if (block === undefined) {
    throw new DocumentServiceError(
      `Word block ${blockId} was not found.`,
      "unsupported-document"
    );
  }

  const withoutBlock = blocks.filter((candidate) => candidate.id !== blockId);
  return insertWordBlockAfter(withoutBlock, afterBlockId, block);
}

function replaceWordSelection(
  blocks: readonly WordDocumentBlock[],
  operation: Extract<WordBlockOperation, { readonly type: "replace-selection" }>
): readonly WordDocumentBlock[] {
  assertBlockExists(blocks, operation.blockId);

  return blocks.map((block) => {
    if (block.id !== operation.blockId) {
      return block;
    }

    if (
      operation.startOffset < 0 ||
      operation.endOffset < operation.startOffset ||
      operation.endOffset > block.text.length
    ) {
      throw new DocumentServiceError(
        `Selection for Word block ${operation.blockId} is invalid.`,
        "unsupported-document"
      );
    }

    return {
      ...block,
      text: `${block.text.slice(0, operation.startOffset)}${operation.replacementText}${block.text.slice(operation.endOffset)}`
    };
  });
}

function assertBlockExists(
  blocks: readonly WordDocumentBlock[],
  blockId: string
): void {
  if (!blocks.some((block) => block.id === blockId)) {
    throw new DocumentServiceError(
      `Word block ${blockId} was not found.`,
      "unsupported-document"
    );
  }
}

async function validateProjectRoot(rootPath: string): Promise<string> {
  if (rootPath.trim().length === 0) {
    throw new DocumentServiceError("Project root is required.", "invalid-root");
  }

  let resolvedRoot: string;

  try {
    resolvedRoot = await realpath(rootPath);
  } catch {
    throw new DocumentServiceError(
      "Project folder is missing or inaccessible.",
      "invalid-root"
    );
  }

  const rootStats = await stat(resolvedRoot);

  if (!rootStats.isDirectory()) {
    throw new DocumentServiceError("Project root must be a directory.", "invalid-root");
  }

  try {
    await access(resolvedRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new DocumentServiceError(
      "Project root must be readable and writable.",
      "not-readable"
    );
  }

  return resolvedRoot;
}

async function resolveExistingDocumentPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  const lexicalPath = resolveLexicalDocumentPath(rootPath, projectPath);
  const resolvedPath = await realpath(lexicalPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new DocumentServiceError(
      "Document path resolves outside the project root.",
      "outside-root"
    );
  }

  return resolvedPath;
}

function resolveWritableDocumentPath(rootPath: string, projectPath: string): string {
  const resolvedPath = resolveLexicalDocumentPath(rootPath, projectPath);

  if (!isInsideRoot(rootPath, resolvedPath)) {
    throw new DocumentServiceError(
      "Document path resolves outside the project root.",
      "outside-root"
    );
  }

  return resolvedPath;
}

function resolveLexicalDocumentPath(rootPath: string, projectPath: string): string {
  if (projectPath.trim().length === 0 || isAbsolute(projectPath)) {
    throw new DocumentServiceError(
      "Document path must be project-relative.",
      "invalid-path"
    );
  }

  const resolvedPath = resolve(rootPath, projectPath);

  if (!projectPath.toLowerCase().endsWith(docxExtension)) {
    throw new DocumentServiceError(
      "Only .docx documents are supported.",
      "unsupported-document"
    );
  }

  return resolvedPath;
}

function toProjectPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
