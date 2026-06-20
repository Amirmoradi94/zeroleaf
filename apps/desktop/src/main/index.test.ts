import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectChangeDebouncer } from "./projectWatcher.js";

describe("desktop main process project watcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid external file changes into one project.changed event", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify("figures/results.pdf");
    vi.advanceTimersByTime(120);
    debouncer.notify("figures/results.pdf");
    vi.advanceTimersByTime(120);
    debouncer.notify(Buffer.from("sections\\results.tex"));

    expect(dispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      projectRoot: "/project/paper",
      paths: ["figures/results.pdf", "sections/results.tex"]
    });
  });

  it("emits an empty path list when the watcher cannot identify the file", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify(null);
    vi.advanceTimersByTime(250);

    expect(dispatch).toHaveBeenCalledWith({
      projectRoot: "/project/paper",
      paths: []
    });
  });

  it("cancels pending watcher notifications when disposed", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const debouncer = new ProjectChangeDebouncer("/project/paper", dispatch);

    debouncer.notify("figures/results.pdf");
    debouncer.dispose();
    vi.advanceTimersByTime(250);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records agent start and approval results into local audit history", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain(
      'await recordAgentAudit(\n      request.projectRoot,\n      "agent.session.started"'
    );
    expect(source).toContain(
      "await recordAgentEvents(request.projectRoot, result.events, result.changeset?.id);"
    );
    expect(source).toContain(
      'await recordAgentEvents(\n        result.changeset?.projectRoot ?? activeProjectRoot ?? "",'
    );
    expect(source).toContain(
      "return `${event.toolName} ${event.status}: ${event.prompt}`;"
    );
  });

  it("opens exported PDFs in the default external viewer after saving", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("const viewerOpenError = await shell.openPath");
    expect(source).toContain("openedInViewer: true");
    expect(source).toContain("viewerOpenError");
  });

  it("creates external template projects through the main process", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("lifecycleCreateFromExternalTemplate");
    expect(source).toContain("fetchExternalTemplateMainTex");
    expect(source).toContain(
      "https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/bare_jrnl.tex"
    );
    expect(source).toContain("writeProjectFile(");
    expect(source).toContain(
      "Fetched template did not look like a valid IEEEtran source."
    );
  });

  it("installs macOS DMG updates after downloading them", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("installAppUpdateFromDmg");
    expect(source).toContain("downloadUpdateAsset(downloadUrl, dmgPath)");
    expect(source).toContain("hdiutil attach");
    expect(source).toContain('ditto "$SOURCE_APP" "$TARGET_APP"');
    expect(source).toContain("app.quit()");
    expect(source).toContain("ipcChannels.appInstallUpdate");
  });

  it("refreshes the project to detect a main file before agent compile fallback", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );

    expect(source).toContain("detectAgentCompileMainFile");
    expect(source).toContain("message.context.mainFilePath ??");
    expect(source).toContain("(await detectAgentCompileMainFile(projectRoot));");
    expect(source).toContain("return refreshed.project.mainFilePath;");
  });
});
