import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
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
import { dirname, resolve } from "node:path";
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
  "document-service",
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
const externalRuntimePackages = [
  "@types/node",
  "core-util-is",
  "docx",
  "hash.js",
  "immediate",
  "inherits",
  "isarray",
  "jszip",
  "lie",
  "minimalistic-assert",
  "nanoid",
  "pako",
  "process-nextick-args",
  "readable-stream",
  "safe-buffer",
  "sax",
  "setimmediate",
  "string_decoder",
  "undici-types",
  "util-deprecate",
  "xml",
  "xml-js"
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
await cp(electronAppRoot, appRoot, {
  recursive: true,
  force: true,
  verbatimSymlinks: true
});
await rename(electronExecutablePath, appExecutablePath);

await rm(resourcesRoot, { recursive: true, force: true });
await mkdir(resourcesRoot, { recursive: true });
await copyTree(resolve(repoRoot, "apps/desktop/dist"), resolve(resourcesRoot, "dist"));
await copyTree(
  resolve(repoRoot, "apps/desktop/assets"),
  resolve(resourcesRoot, "assets")
);
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
  await copyTree(resolve(packageRoot, "dist"), resolve(bundledPackageRoot, "dist"));
}

for (const packageName of externalRuntimePackages) {
  await copyTree(
    resolve(repoRoot, "node_modules", ...packageName.split("/")),
    resolve(resourcesRoot, "node_modules", ...packageName.split("/"))
  );
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
