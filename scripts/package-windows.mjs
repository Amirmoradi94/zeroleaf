#!/usr/bin/env node
import { downloadArtifact } from "@electron/get";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(repoRoot, "package.json"), "utf8")
);
const appVersion =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-alpha";
const electronVersion = resolveElectronVersion(packageJson);
const updateManifestUrl = process.env.ZEROLEAF_UPDATE_MANIFEST_URL?.trim();
const appRoot = resolve(
  process.env.ZEROLEAF_PACKAGE_WIN_ROOT ??
    resolve(tmpdir(), "zeroleaf-release/ZeroLeaf-win32-x64")
);
const releaseRoot = resolve(repoRoot, "release/win");
const resourcesRoot = resolve(appRoot, "resources/app");
const zipPath = resolve(releaseRoot, `ZeroLeaf-${appVersion}-win-x64.zip`);
const localWorkspacePackages = [
  "agent-host",
  "core-domain",
  "history-service",
  "ipc-contracts",
  "latex-service",
  "pdf-service",
  "project-lifecycle-service",
  "project-service",
  "provider-anthropic-claude",
  "provider-openai-codex",
  "reference-service",
  "security",
  "ui"
];

async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await copyTreeContents(source, destination);
}

async function copyTreeContents(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);

    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyTreeContents(sourcePath, destinationPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
      continue;
    }

    if (entry.isFile()) {
      const sourceStats = await stat(sourcePath);
      await writeFile(destinationPath, await readFile(sourcePath));
      await chmod(destinationPath, sourceStats.mode);
    }
  }
}

function resolveElectronVersion(rootPackageJson) {
  const dependencyValue =
    rootPackageJson.devDependencies?.electron ?? rootPackageJson.dependencies?.electron;

  if (typeof dependencyValue !== "string") {
    throw new Error("Could not find an electron dependency in package.json.");
  }

  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(dependencyValue);
  if (match === null) {
    throw new Error(`Could not parse electron version from ${dependencyValue}.`);
  }

  return match[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8",
    ...options
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
    );
  }
}

async function extractZip(zipFile, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (process.platform === "darwin") {
    run("ditto", ["-x", "-k", zipFile, destination]);
    return;
  }

  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      zipFile,
      destination
    ]);
    return;
  }

  run("unzip", ["-q", zipFile, "-d", destination]);
}

async function createReleaseZip(sourceDirectory, destinationZip) {
  await mkdir(dirname(destinationZip), { recursive: true });
  await rm(destinationZip, { force: true });

  if (process.platform === "darwin") {
    run("ditto", [
      "-c",
      "-k",
      "--norsrc",
      "--keepParent",
      sourceDirectory,
      destinationZip
    ]);
    return;
  }

  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      sourceDirectory,
      destinationZip
    ]);
    return;
  }

  run("zip", ["-qr", destinationZip, basename(sourceDirectory)], {
    cwd: dirname(sourceDirectory)
  });
}

const electronZipPath = await downloadArtifact({
  artifactName: "electron",
  version: electronVersion,
  platform: "win32",
  arch: "x64"
});

await extractZip(electronZipPath, appRoot);
await rename(resolve(appRoot, "electron.exe"), resolve(appRoot, "ZeroLeaf.exe"));
await rm(resolve(appRoot, "resources/default_app.asar"), {
  recursive: true,
  force: true
});

await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
await copyTree(resolve(repoRoot, "apps/desktop/dist"), resolve(resourcesRoot, "dist"));
await copyTree(
  resolve(repoRoot, "apps/desktop/assets"),
  resolve(resourcesRoot, "assets")
);

await writeFile(
  resolve(resourcesRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "zeroleaf",
      version: appVersion,
      private: true,
      type: "module",
      main: "dist/main/index.js",
      ...(updateManifestUrl === undefined || updateManifestUrl.length === 0
        ? {}
        : { zeroLeaf: { updateManifestUrl } })
    },
    null,
    2
  )}\n`,
  "utf8"
);

await mkdir(resolve(resourcesRoot, "node_modules/@latex-agent"), {
  recursive: true
});

for (const packageName of localWorkspacePackages) {
  const packageRoot = resolve(repoRoot, `packages/${packageName}`);
  const bundledPackageRoot = resolve(
    resourcesRoot,
    `node_modules/@latex-agent/${packageName}`
  );
  await mkdir(bundledPackageRoot, { recursive: true });
  await copyFile(
    resolve(packageRoot, "package.json"),
    resolve(bundledPackageRoot, "package.json")
  );
  await copyTree(resolve(packageRoot, "dist"), resolve(bundledPackageRoot, "dist"));
}

await createReleaseZip(appRoot, zipPath);

const zipStats = await stat(zipPath);
console.log(`Created ${zipPath} (${zipStats.size} bytes)`);
