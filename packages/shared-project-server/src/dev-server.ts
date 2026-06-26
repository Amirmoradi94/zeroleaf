import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";

import {
  createSharedProjectHttpServer,
  SharedProjectService,
  SharedProjectStore
} from "./index.js";

const defaultHost = "127.0.0.1";
const defaultPort = 3768;
const defaultDataPath = join(
  homedir(),
  ".zeroleaf",
  "shared-project-server",
  "shared-projects.json"
);

function readPort(): number {
  const rawPort = process.env.ZEROLEAF_SHARED_PROJECT_PORT;

  if (rawPort === undefined || rawPort.trim().length === 0) {
    return defaultPort;
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      "ZEROLEAF_SHARED_PROJECT_PORT must be an integer between 0 and 65535."
    );
  }

  return port;
}

async function main() {
  const host = process.env.ZEROLEAF_SHARED_PROJECT_HOST ?? defaultHost;
  const port = readPort();
  const dataPath = process.env.ZEROLEAF_SHARED_PROJECT_DATA_PATH ?? defaultDataPath;

  await mkdir(dirname(dataPath), { recursive: true });

  const store = new SharedProjectStore(dataPath);
  const service = new SharedProjectService(store);
  const server = createSharedProjectHttpServer(service);

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${address.address}:${address.port}`;

  console.log(`ZeroLeaf shared project server listening at ${baseUrl}`);
  console.log(`Project store: ${dataPath}`);

  const shutdown = () => {
    server.close((error) => {
      if (error !== undefined) {
        console.error(error);
        process.exitCode = 1;
      }

      process.exit();
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
