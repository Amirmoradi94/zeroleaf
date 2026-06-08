import type { ProjectFileTreeNode } from "@latex-agent/ipc-contracts";

export type LatexOutlineItem = {
  readonly kind: "section" | "subsection" | "subsubsection" | "label";
  readonly title: string;
  readonly line: number;
};

export type ProjectSearchResult = {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
};

const editableExtensions = new Set([".bib", ".cls", ".md", ".sty", ".tex", ".txt"]);

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

export function isEditableTextPath(path: string): boolean {
  return editableExtensions.has(getExtension(path));
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

export function parseLatexOutline(contents: string): readonly LatexOutlineItem[] {
  const outline: LatexOutlineItem[] = [];
  const outlinePattern =
    /\\(section|subsection|subsubsection|label)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g;
  const lines = contents.split(/\r?\n/);

  lines.forEach((lineText, lineIndex) => {
    outlinePattern.lastIndex = 0;
    let match = outlinePattern.exec(lineText);

    while (match !== null) {
      const kind = match[1];
      const title = match[2]?.trim();

      if (isOutlineKind(kind) && title !== undefined && title.length > 0) {
        outline.push({
          kind,
          title,
          line: lineIndex + 1
        });
      }

      match = outlinePattern.exec(lineText);
    }
  });

  return outline;
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

function getExtension(path: string): string {
  const fileName = path.split("/").at(-1) ?? path;
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart === -1 ? "" : fileName.slice(extensionStart).toLowerCase();
}

function isOutlineKind(value: string | undefined): value is LatexOutlineItem["kind"] {
  return (
    value === "section" ||
    value === "subsection" ||
    value === "subsubsection" ||
    value === "label"
  );
}
