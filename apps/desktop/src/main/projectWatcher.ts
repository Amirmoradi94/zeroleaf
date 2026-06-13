import type { ProjectChangeEvent } from "@latex-agent/ipc-contracts";

export type ProjectChangeDispatcher = (event: ProjectChangeEvent) => void;

export class ProjectChangeDebouncer {
  private readonly pendingPaths = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly projectRoot: string,
    private readonly dispatch: ProjectChangeDispatcher,
    private readonly delayMs = 250
  ) {}

  notify(filename: string | Buffer | null | undefined): void {
    const projectPath = normalizeWatcherPath(filename);

    if (projectPath !== undefined) {
      this.pendingPaths.add(projectPath);
    }

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const paths = Array.from(this.pendingPaths);
    this.pendingPaths.clear();
    this.dispatch({
      projectRoot: this.projectRoot,
      paths
    });
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.pendingPaths.clear();
  }
}

function normalizeWatcherPath(filename: string | Buffer | null | undefined) {
  const rawPath =
    typeof filename === "string"
      ? filename
      : Buffer.isBuffer(filename)
        ? filename.toString("utf8")
        : undefined;
  const normalizedPath = rawPath?.split("\\").join("/").replace(/^\.\//u, "");

  return normalizedPath === undefined || normalizedPath.length === 0
    ? undefined
    : normalizedPath;
}
