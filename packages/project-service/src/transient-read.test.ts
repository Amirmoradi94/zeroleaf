import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
  tempRoots.length = 0;
});

describe("project-service transient file reads", () => {
  it("retries an EAGAIN read and returns the project file snapshot", async () => {
    const projectRoot = await createTempProject();
    const createReadStream = vi
      .fn()
      .mockImplementationOnce(() => erroringStream("EAGAIN", -11))
      .mockImplementationOnce(() => contentStream("Recovered source"));

    vi.doMock("node:fs", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("node:fs")),
      createReadStream
    }));

    const { readProjectFile } = await import("./index.js");
    const snapshot = await readProjectFile(projectRoot, "main.tex");

    expect(snapshot).toMatchObject({
      path: "main.tex",
      contents: "Recovered source"
    });
    expect(createReadStream).toHaveBeenCalledTimes(2);
  });

  it("returns a typed not-readable error after repeated transient read failures", async () => {
    const projectRoot = await createTempProject();
    const createReadStream = vi.fn(() => erroringStream("EAGAIN", -11));

    vi.doMock("node:fs", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("node:fs")),
      createReadStream
    }));

    const { readProjectFile } = await import("./index.js");

    await expect(readProjectFile(projectRoot, "main.tex")).rejects.toMatchObject({
      code: "not-readable",
      message:
        "Project file is temporarily unavailable. Wait for the file to finish downloading locally, then try again."
    });
    expect(createReadStream).toHaveBeenCalledTimes(6);
  });
});

async function createTempProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "latex-project-service-read-"));
  tempRoots.push(projectRoot);
  await mkdir(join(projectRoot, "sections"), { recursive: true });
  await writeFile(
    join(projectRoot, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    "utf8"
  );
  return projectRoot;
}

function erroringStream(code: string, errno: number) {
  const stream = new PassThrough();
  queueMicrotask(() => {
    const error = new Error(code) as Error & { code: string; errno: number };
    error.code = code;
    error.errno = errno;
    stream.destroy(error);
  });
  return stream;
}

function contentStream(contents: string) {
  const stream = new PassThrough();
  queueMicrotask(() => {
    stream.end(contents);
  });
  return stream;
}
