#!/usr/bin/env node
import { mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const appPath = resolve(
  process.env.ZEROLEAF_PACKAGE_APP_ROOT ??
    resolve(tmpdir(), "zeroleaf-release/ZeroLeaf.app")
);
const dmgRoot = resolve(tmpdir(), "zeroleaf-dmg-root");
const dmgPath = resolve(releaseRoot, `ZeroLeaf-${version}-mac.dmg`);

await mkdir(releaseRoot, { recursive: true });
await stat(appPath);
await rm(dmgRoot, { recursive: true, force: true });
await mkdir(dmgRoot, { recursive: true });

run("ditto", ["--norsrc", appPath, resolve(dmgRoot, "ZeroLeaf.app")]);
await symlink("/Applications", resolve(dmgRoot, "Applications"));

await rm(dmgPath, { force: true });
run("hdiutil", [
  "create",
  "-volname",
  "ZeroLeaf",
  "-srcfolder",
  dmgRoot,
  "-ov",
  "-format",
  "UDZO",
  dmgPath
]);

const dmgStats = await stat(dmgPath);
console.log(`Created ${dmgPath} (${dmgStats.size} bytes)`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
    );
  }
}
