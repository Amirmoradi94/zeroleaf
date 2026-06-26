import { spawnSync } from "node:child_process";

const containerName =
  process.env.ZEROLEAF_ONLYOFFICE_CONTAINER ?? "zeroleaf-onlyoffice-dev";
const image =
  process.env.ZEROLEAF_ONLYOFFICE_IMAGE ?? "onlyoffice/documentserver:latest";
const host = process.env.ZEROLEAF_ONLYOFFICE_HOST ?? "127.0.0.1";
const port = process.env.ZEROLEAF_ONLYOFFICE_PORT ?? "8082";
const documentServerUrl = `http://${host}:${port}`;
const command = process.argv[2] ?? "status";
const expectedContainerEnv = ["JWT_ENABLED=false", "ALLOW_PRIVATE_IP_ADDRESS=true"];

switch (command) {
  case "start":
    await startDocumentServer();
    break;
  case "stop":
    stopDocumentServer();
    break;
  case "restart":
    stopDocumentServer({ allowMissing: true });
    await startDocumentServer();
    break;
  case "status":
    await printStatus();
    break;
  case "logs":
    showLogs();
    break;
  default:
    printUsage();
    process.exitCode = 1;
}

async function startDocumentServer() {
  requireDocker();
  const state = getContainerState();

  if (state.exists && !isExpectedContainerEnv()) {
    if (state.running) {
      runDocker(["stop", containerName]);
    }
    runDocker(["rm", containerName]);
    console.log(`Recreated ${containerName} to apply current dev settings.`);
  } else if (state.exists && state.running) {
    console.log(`${containerName} is already running at ${documentServerUrl}.`);
    await printDocumentServerProbe();
    return;
  } else if (state.exists) {
    runDocker(["start", containerName]);
    console.log(`Started existing ${containerName}.`);
    await printDocumentServerProbe();
    return;
  }

  runDocker([
    "run",
    "-d",
    "--name",
    containerName,
    "--restart",
    "unless-stopped",
    "-p",
    `${host}:${port}:80`,
    "-e",
    "JWT_ENABLED=false",
    "-e",
    "ALLOW_PRIVATE_IP_ADDRESS=true",
    image
  ]);
  console.log(`Started ${containerName} at ${documentServerUrl}.`);
  await printDocumentServerProbe();
}

function stopDocumentServer({ allowMissing = false } = {}) {
  requireDocker();
  const state = getContainerState();

  if (!state.exists) {
    if (!allowMissing) {
      console.log(`${containerName} does not exist.`);
    }
    return;
  }

  if (!state.running) {
    console.log(`${containerName} is already stopped.`);
    return;
  }

  runDocker(["stop", containerName]);
  console.log(`Stopped ${containerName}.`);
}

async function printStatus() {
  requireDocker();
  const state = getContainerState();
  const dockerStatus = !state.exists
    ? "missing"
    : state.running
      ? "running"
      : "stopped";

  console.log(`Container: ${containerName} (${dockerStatus})`);
  console.log(`Document Server URL: ${documentServerUrl}`);
  await printDocumentServerProbe();
}

function showLogs() {
  requireDocker();
  const state = getContainerState();

  if (!state.exists) {
    console.error(`${containerName} does not exist. Run npm run onlyoffice:start.`);
    process.exitCode = 1;
    return;
  }

  runDocker(["logs", "--tail", "120", containerName], { stdio: "inherit" });
}

async function printDocumentServerProbe() {
  const apiUrl = `${documentServerUrl}/web-apps/apps/api/documents/api.js`;

  try {
    const response = await globalThis.fetch(apiUrl);
    if (response.ok) {
      console.log(`API script: reachable (${response.status})`);
      return;
    }

    console.log(`API script: HTTP ${response.status}`);
  } catch (error) {
    console.log(`API script: unreachable (${getErrorMessage(error)})`);
  }
}

function getContainerState() {
  const result = runDocker(
    ["inspect", "--format", "{{.State.Running}}", containerName],
    {
      allowFailure: true,
      stdio: "pipe"
    }
  );

  if (result.status !== 0) {
    return { exists: false, running: false };
  }

  return {
    exists: true,
    running: result.stdout.trim() === "true"
  };
}

function isExpectedContainerEnv() {
  const result = runDocker(
    ["inspect", "--format", "{{json .Config.Env}}", containerName],
    {
      allowFailure: true,
      stdio: "pipe"
    }
  );

  if (result.status !== 0) {
    return false;
  }

  const env = JSON.parse(result.stdout);
  if (!Array.isArray(env)) {
    return false;
  }

  return expectedContainerEnv.every((entry) => env.includes(entry));
}

function requireDocker() {
  const result = spawnSync("docker", ["--version"], {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status !== 0) {
    console.error("Docker is required for the local ONLYOFFICE Document Server.");
    process.exit(1);
  }
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit"
  });

  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = result.stderr.trim();
    throw new Error(
      `docker ${args.join(" ")} failed${detail.length === 0 ? "" : `: ${detail}`}`
    );
  }

  return result;
}

function printUsage() {
  console.error(
    [
      "Usage: node scripts/onlyoffice-dev-server.mjs <start|stop|restart|status|logs>",
      "",
      "Environment overrides:",
      "  ZEROLEAF_ONLYOFFICE_CONTAINER=zeroleaf-onlyoffice-dev",
      "  ZEROLEAF_ONLYOFFICE_IMAGE=onlyoffice/documentserver:latest",
      "  ZEROLEAF_ONLYOFFICE_HOST=127.0.0.1",
      "  ZEROLEAF_ONLYOFFICE_PORT=8082"
    ].join("\n")
  );
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
