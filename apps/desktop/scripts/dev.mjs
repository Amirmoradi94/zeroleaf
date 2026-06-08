import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createServer } from "vite";

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.resolve(appRoot, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronBinary =
  process.platform === "win32"
    ? path.join(root, "node_modules/.bin/electron.cmd")
    : path.join(root, "node_modules/.bin/electron");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      stdio: "inherit",
      ...options
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

await runCommand(npmCommand, ["run", "build:main"]);

const server = await createServer({
  configFile: path.join(appRoot, "vite.renderer.config.ts")
});

await server.listen();

const devServerUrl =
  server.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1")) ??
  server.resolvedUrls?.local[0] ??
  "http://127.0.0.1:5173/";

console.log(`Renderer dev server: ${devServerUrl}`);

const electron = spawn(electronBinary, ["dist/main/index.js"], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl
  }
});

const close = async () => {
  electron.kill();
  await server.close();
};

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

electron.on("exit", (code) => {
  void server.close().finally(() => process.exit(code ?? 0));
});
