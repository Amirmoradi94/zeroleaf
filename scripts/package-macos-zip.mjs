#!/usr/bin/env node
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(repoRoot, "package.json"), "utf8")
);
const version =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-alpha";
const releaseRoot = resolve(repoRoot, "release/mac");
const appPath = resolve(releaseRoot, "ZeroLeaf.app");
const zipPath = resolve(releaseRoot, `ZeroLeaf-${version}-mac.zip`);

await mkdir(releaseRoot, { recursive: true });
await stat(appPath);
await rm(zipPath, { force: true });

const result = spawnSync(
  "ditto",
  ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
  {
    cwd: releaseRoot,
    encoding: "utf8"
  }
);

if (result.status !== 0) {
  throw new Error(
    `ditto failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
  );
}

const zipStats = await stat(zipPath);
console.log(`Created ${zipPath} (${zipStats.size} bytes)`);
