import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

export type BibliographyEntry = {
  readonly type: string;
  readonly key: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
  readonly doi?: string;
  readonly venue?: string;
  readonly filePath: string;
  readonly line: number;
  readonly raw: string;
};

export type CitationOccurrence = {
  readonly key: string;
  readonly command: string;
  readonly filePath: string;
  readonly line: number;
};

export type MissingCitation = CitationOccurrence;

export type UnusedReference = BibliographyEntry;

export type ReferenceAnalysis = {
  readonly entries: readonly BibliographyEntry[];
  readonly citations: readonly CitationOccurrence[];
  readonly missingCitations: readonly MissingCitation[];
  readonly unusedEntries: readonly UnusedReference[];
};

export type ReferenceSearchResult = BibliographyEntry & {
  readonly score: number;
};

export class ReferenceServiceError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-root" | "not-directory" | "outside-root"
  ) {
    super(message);
    this.name = "ReferenceServiceError";
  }
}

const ignoredDirectories = new Set([
  ".git",
  ".latex-agent",
  ".latexmk",
  "dist",
  "node_modules",
  "out"
]);
const maxProjectFiles = 5_000;
const maxFileBytes = 2_000_000;

export function parseBibFile(
  contents: string,
  filePath = "references.bib"
): readonly BibliographyEntry[] {
  const entries: BibliographyEntry[] = [];
  let cursor = 0;

  while (cursor < contents.length) {
    const atIndex = contents.indexOf("@", cursor);

    if (atIndex === -1) {
      break;
    }

    const headerMatch = /^@([A-Za-z]+)\s*[{(]\s*/u.exec(contents.slice(atIndex));

    if (headerMatch === null || headerMatch[1] === undefined) {
      cursor = atIndex + 1;
      continue;
    }

    const bodyStart = atIndex + headerMatch[0].length;
    const openChar = contents[atIndex + headerMatch[0].length - 1];
    const closeChar = openChar === "(" ? ")" : "}";
    const endIndex = findBalancedEntryEnd(contents, bodyStart, closeChar);

    if (endIndex === -1) {
      break;
    }

    const body = contents.slice(bodyStart, endIndex);
    const keyEnd = findTopLevelComma(body);
    const key = keyEnd === -1 ? "" : body.slice(0, keyEnd).trim();

    if (key.length > 0) {
      const fields = parseBibFields(keyEnd === -1 ? "" : body.slice(keyEnd + 1));
      const venue =
        fields.get("journal") ??
        fields.get("booktitle") ??
        fields.get("publisher") ??
        fields.get("school") ??
        fields.get("institution");

      entries.push(
        withOptionalEntryFields({
          type: headerMatch[1].toLowerCase(),
          key,
          filePath,
          line: getLineNumber(contents, atIndex),
          raw: contents.slice(atIndex, endIndex + 1),
          ...optionalString("title", fields.get("title")),
          ...optionalString("author", fields.get("author")),
          ...optionalString("year", fields.get("year")),
          ...optionalString("doi", fields.get("doi")),
          ...optionalString("venue", venue)
        })
      );
    }

    cursor = endIndex + 1;
  }

  return entries;
}

export function parseLatexCitations(
  contents: string,
  filePath = "main.tex"
): readonly CitationOccurrence[] {
  const citations: CitationOccurrence[] = [];
  const commandPattern =
    /\\(cite|citep|citet|parencite|textcite|autocite|footcite|supercite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/gu;
  let match = commandPattern.exec(contents);

  while (match !== null) {
    const command = match[1];
    const keyList = match[2];

    if (command !== undefined && keyList !== undefined) {
      for (const key of keyList.split(",").map((item) => item.trim())) {
        if (key.length > 0) {
          citations.push({
            key,
            command,
            filePath,
            line: getLineNumber(contents, match.index)
          });
        }
      }
    }

    match = commandPattern.exec(contents);
  }

  return citations;
}

export async function analyzeProjectReferences(
  projectRoot: string
): Promise<ReferenceAnalysis> {
  const root = await validateProjectRoot(projectRoot);
  const projectFiles = await listReferenceProjectFiles(root);
  const [bibFiles, texFiles] = [
    projectFiles.filter((filePath) => extname(filePath).toLowerCase() === ".bib"),
    projectFiles.filter((filePath) => extname(filePath).toLowerCase() === ".tex")
  ];
  const entries = (
    await Promise.all(
      bibFiles.map(async (filePath) =>
        parseBibFile(await readCappedFile(join(root, filePath)), filePath)
      )
    )
  ).flat();
  const citations = (
    await Promise.all(
      texFiles.map(async (filePath) =>
        parseLatexCitations(await readCappedFile(join(root, filePath)), filePath)
      )
    )
  ).flat();
  const entryKeys = new Set(entries.map((entry) => entry.key));
  const citedKeys = new Set(citations.map((citation) => citation.key));

  return {
    entries,
    citations,
    missingCitations: citations.filter((citation) => !entryKeys.has(citation.key)),
    unusedEntries: entries.filter((entry) => !citedKeys.has(entry.key))
  };
}

export async function searchProjectReferences(
  projectRoot: string,
  query: string
): Promise<readonly ReferenceSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const analysis = await analyzeProjectReferences(projectRoot);

  if (normalizedQuery.length === 0) {
    return analysis.entries
      .slice()
      .sort(compareEntries)
      .slice(0, 100)
      .map((entry) => ({ ...entry, score: 0 }));
  }

  return analysis.entries
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, normalizedQuery)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareEntries(left, right))
    .slice(0, 100);
}

async function validateProjectRoot(rootPath: string): Promise<string> {
  if (rootPath.trim().length === 0) {
    throw new ReferenceServiceError("Project root is required.", "invalid-root");
  }

  const root = await realpath(rootPath);
  const stats = await stat(root);

  if (!stats.isDirectory()) {
    throw new ReferenceServiceError(
      "Project root must be a directory.",
      "not-directory"
    );
  }

  return root;
}

async function listReferenceProjectFiles(
  projectRoot: string
): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    if (files.length >= maxProjectFiles) {
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (files.length >= maxProjectFiles) {
        return;
      }

      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(join(directoryPath, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = extname(entry.name).toLowerCase();

      if (extension === ".bib" || extension === ".tex") {
        files.push(toProjectPath(projectRoot, join(directoryPath, entry.name)));
      }
    }
  }

  await visit(projectRoot);
  return files;
}

async function readCappedFile(filePath: string): Promise<string> {
  const stats = await stat(filePath);

  if (stats.size > maxFileBytes) {
    return (await readFile(filePath, "utf8")).slice(0, maxFileBytes);
  }

  return readFile(filePath, "utf8");
}

function parseBibFields(input: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  let cursor = 0;

  while (cursor < input.length) {
    cursor = skipWhitespaceAndCommas(input, cursor);

    const nameMatch = /^[A-Za-z][A-Za-z0-9_-]*/u.exec(input.slice(cursor));

    if (nameMatch?.[0] === undefined) {
      cursor += 1;
      continue;
    }

    const fieldName = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    cursor = skipWhitespace(input, cursor);

    if (input[cursor] !== "=") {
      continue;
    }

    cursor += 1;
    cursor = skipWhitespace(input, cursor);

    const parsedValue = parseBibValue(input, cursor);

    if (parsedValue === undefined) {
      continue;
    }

    fields.set(fieldName, normalizeBibValue(parsedValue.value));
    cursor = parsedValue.nextIndex;
  }

  return fields;
}

function parseBibValue(
  input: string,
  startIndex: number
): { readonly value: string; readonly nextIndex: number } | undefined {
  const firstChar = input[startIndex];

  if (firstChar === "{") {
    return parseDelimitedValue(input, startIndex + 1, "{", "}");
  }

  if (firstChar === '"') {
    return parseDelimitedValue(input, startIndex + 1, '"', '"');
  }

  const valueMatch = /^[^,\r\n}]+/u.exec(input.slice(startIndex));

  if (valueMatch?.[0] === undefined) {
    return undefined;
  }

  return {
    value: valueMatch[0],
    nextIndex: startIndex + valueMatch[0].length
  };
}

function parseDelimitedValue(
  input: string,
  startIndex: number,
  openChar: string,
  closeChar: string
): { readonly value: string; readonly nextIndex: number } | undefined {
  if (openChar === closeChar) {
    let quoteCursor = startIndex;

    while (quoteCursor < input.length) {
      if (input[quoteCursor] === closeChar && input[quoteCursor - 1] !== "\\") {
        return {
          value: input.slice(startIndex, quoteCursor),
          nextIndex: quoteCursor + 1
        };
      }

      quoteCursor += 1;
    }

    return undefined;
  }

  let depth = openChar === closeChar ? 0 : 1;
  let cursor = startIndex;

  while (cursor < input.length) {
    const char = input[cursor];
    const previous = input[cursor - 1];

    if (char === openChar && openChar !== closeChar && previous !== "\\") {
      depth += 1;
    } else if (char === closeChar && previous !== "\\") {
      depth -= 1;

      if (depth === 0) {
        return {
          value: input.slice(startIndex, cursor),
          nextIndex: cursor + 1
        };
      }
    }

    cursor += 1;
  }

  return undefined;
}

function findBalancedEntryEnd(
  contents: string,
  startIndex: number,
  closeChar: string
): number {
  let depth = 1;
  let cursor = startIndex;
  const openChar = closeChar === ")" ? "(" : "{";

  while (cursor < contents.length) {
    const char = contents[cursor];
    const previous = contents[cursor - 1];

    if (char === openChar && previous !== "\\") {
      depth += 1;
    } else if (char === closeChar && previous !== "\\") {
      depth -= 1;

      if (depth === 0) {
        return cursor;
      }
    }

    cursor += 1;
  }

  return -1;
}

function findTopLevelComma(value: string): number {
  let braceDepth = 0;
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if (char === '"' && previous !== "\\") {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === "{") {
      braceDepth += 1;
    } else if (!inQuotes && char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (!inQuotes && braceDepth === 0 && char === ",") {
      return index;
    }
  }

  return -1;
}

function normalizeBibValue(value: string): string {
  return value.replace(/[{}]/gu, "").replace(/\\&/gu, "&").replace(/\s+/gu, " ").trim();
}

function scoreEntry(entry: BibliographyEntry, normalizedQuery: string): number {
  const fields = [
    [entry.key, 10],
    [entry.title, 6],
    [entry.author, 5],
    [entry.year, 4],
    [entry.venue, 3],
    [entry.doi, 3]
  ] as const;

  return fields.reduce(
    (score, [value, weight]) =>
      value?.toLowerCase().includes(normalizedQuery) === true ? score + weight : score,
    0
  );
}

function compareEntries(left: BibliographyEntry, right: BibliographyEntry): number {
  return left.key.localeCompare(right.key);
}

function withOptionalEntryFields(entry: {
  readonly type: string;
  readonly key: string;
  readonly title?: string;
  readonly author?: string;
  readonly year?: string;
  readonly doi?: string;
  readonly venue?: string;
  readonly filePath: string;
  readonly line: number;
  readonly raw: string;
}): BibliographyEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined && value !== "")
  ) as BibliographyEntry;
}

function optionalString<TKey extends string>(
  key: TKey,
  value: string | undefined
): Partial<Record<TKey, string>> {
  if (value === undefined || value.length === 0) {
    return {};
  }

  return { [key]: value } as Partial<Record<TKey, string>>;
}

function getLineNumber(contents: string, index: number): number {
  return contents.slice(0, index).split(/\r?\n/u).length;
}

function skipWhitespace(value: string, index: number): number {
  let cursor = index;

  while (/\s/u.test(value[cursor] ?? "")) {
    cursor += 1;
  }

  return cursor;
}

function skipWhitespaceAndCommas(value: string, index: number): number {
  let cursor = index;

  while (/[\s,]/u.test(value[cursor] ?? "")) {
    cursor += 1;
  }

  return cursor;
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  const resolvedPath = resolve(absolutePath);
  const projectPath = relative(projectRoot, resolvedPath);

  if (projectPath.startsWith("..") || projectPath.includes(`${sep}..${sep}`)) {
    throw new ReferenceServiceError("Path escapes project root.", "outside-root");
  }

  return projectPath.split(sep).join("/");
}
