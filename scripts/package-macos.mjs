import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(repoRoot, "package.json"), "utf8")
);
const appVersion =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-alpha";
const updateManifestUrl = process.env.ZEROLEAF_UPDATE_MANIFEST_URL?.trim();
const appRoot = resolve(
  process.env.ZEROLEAF_PACKAGE_APP_ROOT ??
    resolve(tmpdir(), "zeroleaf-release/ZeroLeaf.app")
);
const contentsRoot = resolve(appRoot, "Contents");
const bundleResourcesRoot = resolve(contentsRoot, "Resources");
const resourcesRoot = resolve(bundleResourcesRoot, "app");
const plistPath = resolve(contentsRoot, "Info.plist");
const electronAppRoot = resolve(repoRoot, "node_modules/electron/dist/Electron.app");
const electronExecutablePath = resolve(contentsRoot, "MacOS/Electron");
const appExecutablePath = resolve(contentsRoot, "MacOS/ZeroLeaf");
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

function ditto(source, destination) {
  const result = spawnSync("ditto", ["--norsrc", source, destination], {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      `ditto failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
    );
  }
}

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

function plistSet(key, value) {
  run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

await rm(appRoot, { recursive: true, force: true });
ditto(electronAppRoot, appRoot);
await rename(electronExecutablePath, appExecutablePath);

await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
ditto(resolve(repoRoot, "apps/desktop/dist"), resolve(resourcesRoot, "dist"));
ditto(resolve(repoRoot, "apps/desktop/assets"), resolve(resourcesRoot, "assets"));
await copyFile(
  resolve(repoRoot, "apps/desktop/assets/zeroleaf-icon.icns"),
  resolve(bundleResourcesRoot, "zeroleaf-icon.icns")
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
  ditto(resolve(packageRoot, "dist"), resolve(bundledPackageRoot, "dist"));
}

plistSet("CFBundleDisplayName", "ZeroLeaf");
plistSet("CFBundleExecutable", "ZeroLeaf");
plistSet("CFBundleIdentifier", "local.zeroleaf.alpha");
plistSet("CFBundleIconFile", "zeroleaf-icon.icns");
plistSet("CFBundleName", "ZeroLeaf");
plistSet("CFBundleShortVersionString", appVersion);
plistSet("CFBundleVersion", appVersion);
plistSet("LSMinimumSystemVersion", "13.0");

run("xattr", ["-cr", appRoot]);
run("codesign", ["--force", "--deep", "--sign", "-", appRoot]);

console.log(`Created ${appRoot}`);
