import type {
  AgentSelectionContext,
  BibliographyEntry,
  BuildResult,
  CitationOccurrence,
  EditorProjectState,
  PdfArtifactData,
  ProjectFileTreeNode,
  ReferenceAnalysis,
  SubmissionCheckResult
} from "@latex-agent/ipc-contracts";

export type LatexOutlineItem = {
  readonly kind:
    | "part"
    | "chapter"
    | "section"
    | "subsection"
    | "subsubsection"
    | "paragraph"
    | "subparagraph"
    | "label";
  readonly title: string;
  readonly path: string;
  readonly line: number;
};

export type LatexOutlineSource = {
  readonly path: string;
  readonly contents: string;
};

export type LatexLabelReference = {
  readonly key: string;
  readonly path: string;
  readonly line: number;
};

export type LatexSnippet = {
  readonly label: string;
  readonly insertText: string;
  readonly documentation: string;
};

export type LatexCompletionState = {
  readonly projectRoot: string | null;
  readonly citations: readonly BibliographyEntry[];
  readonly labels: readonly LatexLabelReference[];
};

export type PdfPreviewState = {
  readonly artifactData: PdfArtifactData | null;
  readonly stale: boolean;
};

export type ProjectSearchResult = {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
};

export type CitationCommand = "cite" | "citep" | "parencite";

export type MissingCitationGroup = {
  readonly key: string;
  readonly occurrences: readonly CitationOccurrence[];
};

export type EditorRestorePlan = {
  readonly filePaths: readonly string[];
  readonly activeFilePath: string | undefined;
};

export type TextSelectionRange = {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
};

const internalProjectPathPrefixes = [".latex-agent/"] as const;
const editableExtensions = new Set([
  ".bib",
  ".cls",
  ".docx",
  ".md",
  ".sty",
  ".tex",
  ".txt"
]);

export const latexSnippets = [
  {
    label: "section",
    insertText: "\\section{${1:Title}}\n$0",
    documentation: "Insert a section heading"
  },
  {
    label: "subsection",
    insertText: "\\subsection{${1:Title}}\n$0",
    documentation: "Insert a subsection heading"
  },
  {
    label: "figure",
    insertText:
      "\\begin{figure}[ht]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${1:path}}\n\\caption{${2:Caption}}\n\\label{fig:${3:label}}\n\\end{figure}\n$0",
    documentation: "Insert a figure environment"
  },
  {
    label: "equation",
    insertText:
      "\\begin{equation}\n${1:E = mc^2}\n\\label{eq:${2:label}}\n\\end{equation}\n$0",
    documentation: "Insert an equation environment"
  },
  {
    label: "cite",
    insertText: "\\cite{${1:key}}",
    documentation: "Insert a citation command"
  },
  {
    label: "label",
    insertText: "\\label{${1:prefix}:${2:name}}",
    documentation: "Insert a label command"
  },
  {
    label: "ref",
    insertText: "\\ref{${1:label}}",
    documentation: "Insert a reference command"
  },
  {
    label: "eqref",
    insertText: "\\eqref{${1:eq:label}}",
    documentation: "Insert an equation reference command"
  },
  {
    label: "autoref",
    insertText: "\\autoref{${1:label}}",
    documentation: "Insert an automatic reference command"
  }
] as const satisfies readonly LatexSnippet[];

export function flattenFileTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children === undefined ? [] : flattenFileTree(node.children))
  ]);
}

export function getProjectFiles(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return flattenFileTree(nodes).filter((node) => node.kind === "file");
}

export function getEditableProjectFiles(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return getProjectFiles(nodes).filter((node) => isEditableTextPath(node.path));
}

export function planEditorRestore({
  availablePaths,
  mainFilePath,
  preferredFilePath,
  savedState
}: {
  readonly availablePaths: ReadonlySet<string>;
  readonly mainFilePath: string | undefined;
  readonly preferredFilePath?: string | undefined;
  readonly savedState: EditorProjectState;
}): EditorRestorePlan {
  const filePaths = uniqueStrings([
    ...(preferredFilePath === undefined ? [] : [preferredFilePath]),
    ...(savedState.activeFilePath === undefined ? [] : [savedState.activeFilePath]),
    ...savedState.openFilePaths,
    ...(mainFilePath === undefined ? [] : [mainFilePath])
  ]).filter((path) => availablePaths.has(path));
  const activeFilePath = [
    preferredFilePath,
    savedState.activeFilePath,
    ...filePaths
  ].find((path): path is string => path !== undefined && availablePaths.has(path));

  return {
    filePaths,
    activeFilePath
  };
}

export function isEditableTextPath(path: string): boolean {
  return editableExtensions.has(getExtension(path));
}

export function shouldMarkPdfStaleForProjectChange(
  changedPaths: readonly string[]
): boolean {
  if (changedPaths.length === 0) {
    return true;
  }

  return changedPaths.some((path) => {
    const normalizedPath = path.split("\\").join("/");
    return !internalProjectPathPrefixes.some((prefix) =>
      normalizedPath.startsWith(prefix)
    );
  });
}

export function getLanguageForPath(path: string): string {
  const extension = getExtension(path);

  if (extension === ".tex" || extension === ".sty" || extension === ".cls") {
    return "latex";
  }

  if (extension === ".bib") {
    return "bibtex";
  }

  if (extension === ".md") {
    return "markdown";
  }

  return "plaintext";
}

export function parseLatexOutline(
  contents: string,
  path = ""
): readonly LatexOutlineItem[] {
  const lines = contents.split(/\r?\n/);

  return lines.flatMap((lineText, lineIndex) =>
    parseLatexOutlineLine(lineText, path, lineIndex + 1)
  );
}

export function buildProjectLatexOutline({
  files,
  mainFilePath
}: {
  readonly files: readonly LatexOutlineSource[];
  readonly mainFilePath: string | undefined;
}): readonly LatexOutlineItem[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const outline: LatexOutlineItem[] = [];
  const visited = new Set<string>();

  const visitFile = (path: string) => {
    const file = filesByPath.get(path);

    if (file === undefined || visited.has(file.path)) {
      return;
    }

    visited.add(file.path);

    for (const { lineText, lineNumber } of getSourceLines(file.contents)) {
      outline.push(...parseLatexOutlineLine(lineText, file.path, lineNumber));

      for (const includedPath of parseLatexIncludePaths(
        lineText,
        file.path,
        filesByPath
      )) {
        visitFile(includedPath);
      }
    }
  };

  if (mainFilePath !== undefined) {
    visitFile(mainFilePath);
  }

  for (const file of files) {
    visitFile(file.path);
  }

  return outline;
}

export function getLatexLabelReferences(
  outline: readonly LatexOutlineItem[]
): readonly LatexLabelReference[] {
  const labels = new Map<string, LatexLabelReference>();

  for (const item of outline) {
    if (item.kind !== "label" || labels.has(item.title)) {
      continue;
    }

    labels.set(item.title, {
      key: item.title,
      path: item.path,
      line: item.line
    });
  }

  return Array.from(labels.values());
}

export function createLatexCompletionState(): LatexCompletionState {
  return {
    projectRoot: null,
    citations: [],
    labels: []
  };
}

export function startLatexCompletionProject(
  _state: LatexCompletionState,
  projectRoot: string
): LatexCompletionState {
  return {
    projectRoot,
    citations: [],
    labels: []
  };
}

export function clearLatexCompletionProject(
  _state: LatexCompletionState
): LatexCompletionState {
  return createLatexCompletionState();
}

export function updateLatexCompletionCitations(
  state: LatexCompletionState,
  projectRoot: string,
  citations: readonly BibliographyEntry[]
): LatexCompletionState {
  if (state.projectRoot !== projectRoot) {
    return state;
  }

  return {
    ...state,
    citations
  };
}

export function updateLatexCompletionLabels(
  state: LatexCompletionState,
  projectRoot: string,
  labels: readonly LatexLabelReference[]
): LatexCompletionState {
  if (state.projectRoot !== projectRoot) {
    return state;
  }

  return {
    ...state,
    labels
  };
}

export function startPdfPreviewBuild(state: PdfPreviewState): PdfPreviewState {
  return state;
}

export function finishPdfPreviewBuild({
  artifactData,
  result,
  state
}: {
  readonly artifactData?: PdfArtifactData | undefined;
  readonly result: BuildResult;
  readonly state: PdfPreviewState;
}): PdfPreviewState {
  if (result.status === "succeeded" && artifactData !== undefined) {
    return {
      artifactData,
      stale: false
    };
  }

  return {
    artifactData: state.artifactData,
    stale: state.artifactData === null ? state.stale : true
  };
}

export function searchFileContents(
  path: string,
  contents: string,
  query: string,
  maxResults = 20
): readonly ProjectSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const results: ProjectSearchResult[] = [];
  const lines = contents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.toLowerCase().includes(normalizedQuery)) {
      results.push({
        path,
        line: index + 1,
        preview: line.trim()
      });
    }

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

export function createCitationCommand({
  key,
  sources
}: {
  readonly key: string;
  readonly sources: readonly LatexOutlineSource[];
}): string {
  return `\\${detectPreferredCitationCommand(sources)}{${key}}`;
}

export function insertTextAtLineColumn({
  column,
  contents,
  lineNumber,
  text
}: {
  readonly column: number;
  readonly contents: string;
  readonly lineNumber: number;
  readonly text: string;
}): string {
  const lines = contents.split(/\r?\n/u);
  const targetLineIndex = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  const targetLine = lines[targetLineIndex] ?? "";
  const targetColumnIndex = Math.max(0, Math.min(targetLine.length, column - 1));

  lines[targetLineIndex] =
    `${targetLine.slice(0, targetColumnIndex)}${text}${targetLine.slice(targetColumnIndex)}`;

  return lines.join("\n");
}

export function createDiagnosticAgentPrompt(
  diagnostic: BuildResult["diagnostics"][number],
  buildResult: BuildResult | null
): string {
  return [
    "Fix this LaTeX diagnostic.",
    "Start from the failing diagnostic, active file, and attached capped build log context.",
    "Focus on the root cause and return a minimal reviewable patch when a concrete source edit can fix it.",
    "Do not only explain the fix if the failing file can be edited safely.",
    "",
    `Diagnostic: ${diagnostic.severity}${formatDiagnosticSource(diagnostic)} ${diagnostic.message}`,
    "",
    createDiagnosticLogContext(diagnostic, buildResult)
  ].join("\n");
}

export function createReferenceEntryAgentPrompt(entry: BibliographyEntry): string {
  return [
    "Use only the attached bibliography entry below.",
    "Suggest where this source fits in the active LaTeX file, preferably in related work if that context is present.",
    `Use the citation command \\cite{${entry.key}} unless the project style clearly requires a local variant.`,
    `Do not invent or mention unavailable bibliography keys; the only attached key is ${entry.key}.`,
    "",
    "Attached bibliography entry:",
    formatBibliographyEntryContext(entry)
  ].join("\n");
}

export function createNumberingMismatchAgentPrompt(): string {
  return [
    "Figure numbering mismatch: the rendered PDF order does not match source order.",
    "Compare source figure order, label placement, and rendered output sequence.",
    "Propose fixes that preserve semantic source order, unless I explicitly approve reordering figures.",
    "Inspect \\label before \\caption and duplicate label issues first."
  ].join("\n");
}

export function createFinalFormattingReviewPrompt(
  buildResult: BuildResult | null,
  referenceAnalysis: ReferenceAnalysis,
  submissionCheckResult: SubmissionCheckResult | null
): string {
  const submissionItems = submissionCheckResult?.items ?? [];
  const submissionChecklist = submissionItems
    .map(
      (item) =>
        `- ${item.severity}: ${item.message}${item.filePath === undefined ? "" : ` (${item.filePath})`}`
    )
    .join("\n");
  const diagnostics = (buildResult?.diagnostics ?? [])
    .slice(0, 8)
    .map(
      (diagnostic) =>
        `- ${diagnostic.severity}: ${diagnostic.message}${diagnostic.filePath === undefined ? "" : ` (${diagnostic.filePath}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`})`}`
    )
    .join("\n");
  const missingCitationLines = referenceAnalysis.missingCitations
    .slice(0, 6)
    .map(
      (citation) =>
        `- warning: Missing citation key ${citation.key} referenced by ${citation.command}. (${citation.filePath}:${citation.line})`
    )
    .join("\n");
  const unusedReferenceLines = referenceAnalysis.unusedEntries
    .slice(0, 6)
    .map(
      (entry) =>
        `- warning: Unused bibliography entry ${entry.key}. (${entry.filePath}:${entry.line})`
    )
    .join("\n");
  const referenceSummaryLines = [
    `- info: ${referenceAnalysis.entries.length} bibliography entr${referenceAnalysis.entries.length === 1 ? "y" : "ies"} and ${referenceAnalysis.citations.length} citation occurrence${referenceAnalysis.citations.length === 1 ? "" : "s"} loaded locally.`,
    `- info: ${referenceAnalysis.missingCitations.length} missing citation${referenceAnalysis.missingCitations.length === 1 ? "" : "s"} and ${referenceAnalysis.unusedEntries.length} unused bibliography entr${referenceAnalysis.unusedEntries.length === 1 ? "y" : "ies"}.`
  ].join("\n");

  return [
    "Final PDF formatting review before submission.",
    "Use local project files only.",
    "Inspect warnings, figures, tables, references, and the submission check.",
    "Produce a prioritized checklist only. Do not apply risky formatting changes automatically.",
    "If no rendered PDF snapshot is attached, keep visual claims limited to source, diagnostics, and submission-check evidence.",
    "",
    "Build diagnostics:",
    diagnostics.length === 0
      ? "- info: No build diagnostics are attached."
      : diagnostics,
    "",
    "Reference health:",
    [referenceSummaryLines, missingCitationLines, unusedReferenceLines]
      .filter((section) => section.length > 0)
      .join("\n"),
    "",
    "Submission check:",
    submissionChecklist.length === 0
      ? "- info: No automated bundle check has run yet."
      : submissionChecklist
  ].join("\n");
}

export function groupMissingCitations(
  citations: readonly CitationOccurrence[]
): readonly MissingCitationGroup[] {
  const groups = new Map<string, CitationOccurrence[]>();

  for (const citation of citations) {
    const occurrences = groups.get(citation.key);

    if (occurrences === undefined) {
      groups.set(citation.key, [citation]);
      continue;
    }

    occurrences.push(citation);
  }

  return Array.from(groups.entries()).map(([key, occurrences]) => ({
    key,
    occurrences
  }));
}

export function detectPreferredCitationCommand(
  sources: readonly LatexOutlineSource[]
): CitationCommand {
  const combinedSource = sources
    .map((source) => source.contents.split(/\r?\n/u).map(stripLatexComment).join("\n"))
    .join("\n");

  if (usesLatexPackage(combinedSource, "biblatex")) {
    return "parencite";
  }

  if (usesLatexPackage(combinedSource, "natbib")) {
    return "citep";
  }

  const citedCommands = Array.from(
    combinedSource.matchAll(/\\(citep|parencite|cite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{/gu)
  )
    .map((match) => match[1])
    .filter(
      (command): command is CitationCommand =>
        command === "citep" || command === "parencite" || command === "cite"
    );

  return citedCommands[0] ?? "cite";
}

function getExtension(path: string): string {
  const fileName = path.split("/").at(-1) ?? path;
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart === -1 ? "" : fileName.slice(extensionStart).toLowerCase();
}

function isOutlineKind(value: string | undefined): value is LatexOutlineItem["kind"] {
  return (
    value === "part" ||
    value === "chapter" ||
    value === "section" ||
    value === "subsection" ||
    value === "subsubsection" ||
    value === "paragraph" ||
    value === "subparagraph" ||
    value === "label"
  );
}

function parseLatexOutlineLine(
  lineText: string,
  path: string,
  lineNumber: number
): readonly LatexOutlineItem[] {
  const outlinePattern =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|label)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  const outline: LatexOutlineItem[] = [];
  const sourceLine = stripLatexComment(lineText);
  let match = outlinePattern.exec(sourceLine);

  while (match !== null) {
    const kind = match[1];
    const title = match[2]?.trim();

    if (isOutlineKind(kind) && title !== undefined && title.length > 0) {
      outline.push({
        kind,
        title,
        path,
        line: lineNumber
      });
    }

    match = outlinePattern.exec(sourceLine);
  }

  return outline;
}

function getSourceLines(contents: string) {
  return contents.split(/\r?\n/).map((lineText, index) => ({
    lineText,
    lineNumber: index + 1
  }));
}

function parseLatexIncludePaths(
  lineText: string,
  fromPath: string,
  filesByPath: ReadonlyMap<string, LatexOutlineSource>
): readonly string[] {
  const includePattern = /\\(?:input|include)\s*\{([^}]*)\}/g;
  const paths: string[] = [];
  const sourceLine = stripLatexComment(lineText);
  let match = includePattern.exec(sourceLine);

  while (match !== null) {
    const reference = match[1]?.trim();

    if (reference !== undefined && reference.length > 0) {
      const includedPath = resolveIncludedTexPath(reference, fromPath, filesByPath);

      if (includedPath !== undefined) {
        paths.push(includedPath);
      }
    }

    match = includePattern.exec(sourceLine);
  }

  return paths;
}

function resolveIncludedTexPath(
  reference: string,
  fromPath: string,
  filesByPath: ReadonlyMap<string, LatexOutlineSource>
) {
  const withoutExtension = reference.endsWith(".tex")
    ? reference.slice(0, -4)
    : reference;
  const fromDirectory = getDirectoryPath(fromPath);
  const candidates = [
    normalizeProjectPath(`${withoutExtension}.tex`),
    normalizeProjectPath(`${fromDirectory}/${withoutExtension}.tex`)
  ];

  return candidates.find((candidate) => filesByPath.has(candidate));
}

export function createSelectionContextFromText({
  contents,
  selection
}: {
  readonly contents: string;
  readonly selection: TextSelectionRange;
}): AgentSelectionContext | null {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/u, ""));
  const lineStartOffsets = createLineStartOffsets(contents);
  const startOffset = getTextOffsetAt(
    selection.startLineNumber,
    selection.startColumn,
    lineStartOffsets
  );
  const endOffset = getTextOffsetAt(
    selection.endLineNumber,
    selection.endColumn,
    lineStartOffsets
  );

  if (startOffset === endOffset) {
    return null;
  }

  const selectedText = contents.slice(startOffset, endOffset);

  if (selectedText.trim().length === 0) {
    return null;
  }

  const lastSelectedLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  let paragraphStartLine = selection.startLineNumber;
  let paragraphEndLine = Math.max(selection.startLineNumber, lastSelectedLine);

  while (
    paragraphStartLine > 1 &&
    (lines[paragraphStartLine - 2] ?? "").trim().length > 0
  ) {
    paragraphStartLine -= 1;
  }

  while (
    paragraphEndLine < lines.length &&
    (lines[paragraphEndLine] ?? "").trim().length > 0
  ) {
    paragraphEndLine += 1;
  }

  const paragraphStartOffset = getTextOffsetAt(paragraphStartLine, 1, lineStartOffsets);
  const paragraphEndOffset = getTextOffsetAt(
    paragraphEndLine,
    (lines[paragraphEndLine - 1] ?? "").length + 1,
    lineStartOffsets
  );

  return {
    containingParagraph: contents.slice(paragraphStartOffset, paragraphEndOffset),
    endLine: paragraphEndLine,
    selectedText,
    selectionEndOffset: Math.max(0, endOffset - paragraphStartOffset),
    selectionStartOffset: Math.max(0, startOffset - paragraphStartOffset),
    startLine: paragraphStartLine
  };
}

function createLineStartOffsets(contents: string): readonly number[] {
  const offsets = [0];

  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function getTextOffsetAt(
  lineNumber: number,
  column: number,
  lineStartOffsets: readonly number[]
): number {
  const lineIndex = Math.max(0, Math.min(lineNumber - 1, lineStartOffsets.length - 1));
  return (lineStartOffsets[lineIndex] ?? 0) + Math.max(0, column - 1);
}

function getDirectoryPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function normalizeProjectPath(path: string) {
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function stripLatexComment(lineText: string) {
  for (let index = 0; index < lineText.length; index += 1) {
    if (lineText[index] !== "%") {
      continue;
    }

    let backslashCount = 0;
    for (
      let cursor = index - 1;
      cursor >= 0 && lineText[cursor] === "\\";
      cursor -= 1
    ) {
      backslashCount += 1;
    }

    if (backslashCount % 2 === 0) {
      return lineText.slice(0, index);
    }
  }

  return lineText;
}

function usesLatexPackage(source: string, packageName: string): boolean {
  const packagePattern = new RegExp(
    String.raw`\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}`,
    "gu"
  );
  let match = packagePattern.exec(source);

  while (match !== null) {
    const packageList = match[1] ?? "";

    if (
      packageList
        .split(",")
        .map((item) => item.trim())
        .includes(packageName)
    ) {
      return true;
    }

    match = packagePattern.exec(source);
  }

  return false;
}

function createDiagnosticLogContext(
  diagnostic: BuildResult["diagnostics"][number],
  buildResult: BuildResult | null
): string {
  const rawLog = buildResult?.rawLog ?? "";

  if (rawLog.trim().length === 0) {
    return "Build log context: No build log is available.";
  }

  const diagnosticQuery = diagnostic.message.trim();
  const matches =
    diagnosticQuery.length === 0 ? [] : findBuildLogMatches(rawLog, diagnosticQuery);
  const excerpt = createBuildLogExcerpt(rawLog, diagnosticQuery, matches[0]?.index);
  const cappedNotice =
    rawLog.length > excerpt.length || buildResult?.rawLogTruncated === true
      ? " This context is capped; do not infer from omitted log lines."
      : "";
  const serviceTruncationNotice =
    buildResult?.rawLogTruncated === true
      ? ` The stored log was already truncated to ${
          buildResult.rawLogBytes ?? rawLog.length
        } of ${buildResult.rawLogOriginalBytes ?? "unknown"} bytes.`
      : "";

  return [
    `Build log context (capped to ${excerpt.length} characters).${cappedNotice}${serviceTruncationNotice}`,
    excerpt
  ].join("\n");
}

function createBuildLogExcerpt(
  rawLog: string,
  query: string,
  matchIndex: number | undefined
): string {
  if (rawLog.trim().length === 0) {
    return "";
  }

  if (query.trim().length === 0 || matchIndex === undefined) {
    return rawLog.length <= 4_000 ? rawLog : `${rawLog.slice(0, 4_000)}\n...`;
  }

  const start = findLineBoundaryBefore(rawLog, Math.max(0, matchIndex - 1_500));
  const end = findLineBoundaryAfter(
    rawLog,
    Math.min(rawLog.length, matchIndex + query.trim().length + 1_500)
  );
  const prefix = start > 0 ? "...\n" : "";
  const suffix = end < rawLog.length ? "\n..." : "";

  return `${prefix}${rawLog.slice(start, end)}${suffix}`;
}

function findLineBoundaryBefore(value: string, index: number): number {
  const boundary = value.lastIndexOf("\n", index);
  return boundary === -1 ? 0 : boundary + 1;
}

function findLineBoundaryAfter(value: string, index: number): number {
  const boundary = value.indexOf("\n", index);
  return boundary === -1 ? value.length : boundary;
}

function findBuildLogMatches(
  rawLog: string,
  query: string
): readonly { readonly index: number }[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const normalizedLog = rawLog.toLowerCase();
  const matches: { readonly index: number }[] = [];
  let searchIndex = 0;

  while (matches.length < 500) {
    const index = normalizedLog.indexOf(normalizedQuery, searchIndex);

    if (index === -1) {
      return matches;
    }

    matches.push({ index });
    searchIndex = index + normalizedQuery.length;
  }

  return matches;
}

function formatBibliographyEntryContext(entry: BibliographyEntry): string {
  return [
    `key=${entry.key}`,
    `file=${entry.filePath}:${entry.line}`,
    `type=${entry.type}`,
    entry.title === undefined ? "" : `title=${entry.title}`,
    entry.author === undefined ? "" : `author=${entry.author}`,
    entry.year === undefined ? "" : `year=${entry.year}`,
    entry.venue === undefined ? "" : `venue=${entry.venue}`,
    entry.doi === undefined ? "" : `doi=${entry.doi}`,
    "raw:",
    entry.raw.length <= 2_000 ? entry.raw : `${entry.raw.slice(0, 2_000)}\n...`
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function formatDiagnosticSource(
  diagnostic: BuildResult["diagnostics"][number]
): string {
  const source = [
    diagnostic.filePath,
    diagnostic.line === undefined ? "" : String(diagnostic.line)
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(":");

  return source.length === 0 ? "" : ` at ${source}:`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}
