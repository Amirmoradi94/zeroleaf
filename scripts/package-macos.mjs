import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(repoRoot, "package.json"), "utf8")
);
const appVersion =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-alpha";
const appRoot = resolve(repoRoot, "release/mac/ZeroLeaf.app");
const contentsRoot = resolve(appRoot, "Contents");
const bundleResourcesRoot = resolve(contentsRoot, "Resources");
const resourcesRoot = resolve(bundleResourcesRoot, "app");
const launcherPath = resolve(contentsRoot, "MacOS/ZeroLeaf");
const plistPath = resolve(contentsRoot, "Info.plist");

await rm(appRoot, { recursive: true, force: true });
await mkdir(resolve(contentsRoot, "MacOS"), { recursive: true });
await mkdir(resourcesRoot, { recursive: true });
await cp(resolve(repoRoot, "apps/desktop/dist"), resolve(resourcesRoot, "dist"), {
  recursive: true
});
await cp(resolve(repoRoot, "apps/desktop/assets"), resolve(resourcesRoot, "assets"), {
  recursive: true
});
await cp(
  resolve(repoRoot, "apps/desktop/assets/zeroleaf-icon.icns"),
  resolve(bundleResourcesRoot, "zeroleaf-icon.icns")
);
await cp(resolve(repoRoot, "package.json"), resolve(resourcesRoot, "package.json"));

await writeFile(
  launcherPath,
  `#!/bin/sh\nDIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"\ncd "$DIR"\nexec "${repoRoot}/node_modules/.bin/electron" "$DIR/dist/main/index.js"\n`,
  "utf8"
);
await chmod(launcherPath, 0o755);

await writeFile(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>ZeroLeaf</string>\n  <key>CFBundleIdentifier</key>\n  <string>local.zeroleaf.alpha</string>\n  <key>CFBundleIconFile</key>\n  <string>zeroleaf-icon.icns</string>\n  <key>CFBundleName</key>\n  <string>ZeroLeaf</string>\n  <key>CFBundlePackageType</key>\n  <string>APPL</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${appVersion}</string>\n  <key>LSMinimumSystemVersion</key>\n  <string>13.0</string>\n</dict>\n</plist>\n`,
  "utf8"
);

console.log(`Created ${appRoot}`);
