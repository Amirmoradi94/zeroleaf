import { watch, type FSWatcher } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from "electron";
import {
  detectLatexToolchain,
  runLatexBuild,
  runSyncTexForward,
  runSyncTexReverse,
  stopLatexBuild
} from "@latex-agent/latex-service";
import {
  applyWordChangeSet,
  createWordChangeSet,
  readWordDocument,
  saveWordDocument
} from "@latex-agent/document-service";
import {
  AgentHostClient,
  getAgentToolRisk,
  isAgentToolAllowed,
  type AgentHostToolRequestMessage,
  type AgentToolRequestPayloadMap
} from "@latex-agent/agent-host";
import { HistoryStore } from "@latex-agent/history-service";
import { readPdfArtifact } from "@latex-agent/pdf-service";
import {
  ProjectMetadataStore,
  createProjectEntry,
  deleteProjectEntry,
  detectMainTexFile,
  listProjectTree,
  moveProjectEntry,
  openProject,
  readProjectFile,
  refreshProject,
  renameProjectEntry,
  setProjectMainFile,
  writeProjectFile
} from "@latex-agent/project-service";
import {
  SharedProjectCache,
  SharedProjectClientError,
  SharedProjectDocumentSession,
  SharedProjectHttpClient,
  isSharedProjectCollaborativeDocumentPath,
  type SharedProjectRealtimeSession
} from "@latex-agent/shared-project-client";
import {
  analyzeProjectReferences,
  removeUnusedReferenceEntry,
  searchProjectReferences
} from "@latex-agent/reference-service";
import {
  checkSubmissionBundle,
  collectSharedProjectSourceFiles,
  createEmptyProject,
  createProjectFromTemplate,
  exportPdf as exportLifecyclePdf,
  exportSourceZip,
  importProjectZip,
  projectTemplates
} from "@latex-agent/project-lifecycle-service";
import { OnlyOfficeBridgeService } from "@latex-agent/onlyoffice-service";

import {
  defaultAppSettings,
  defaultWorkbenchLayout,
  ipcChannels,
  type AgentProviderId,
  type AgentProviderSetupAction,
  type AgentEvent,
  type AgentNetworkFetchResult,
  type AgentStartRequest,
  type AppSettings,
  type AppUpdateCheckResult,
  type EditorProjectState,
  type ExternalProjectTemplateId,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
  type PrivacySummary,
  type ProjectFileSnapshot,
  type ProjectFileTreeNode,
  type SharedProjectActivitySummary,
  type SharedProjectAuditEventSummary,
  type SharedProjectAgentChangeSetSummary,
  type SharedProjectAgentRunSummary,
  type SharedProjectBuildArtifactDetails,
  type SharedProjectBuildArtifactSummary,
  type SharedProjectConnection,
  type SharedProjectDocumentSyncResult,
  type SharedProjectDocumentTextOperation,
  type SharedProjectInvitationSummary,
  type SharedProjectMemberSummary,
  type SharedProjectPresenceSummary,
  type SharedProjectRealtimeEvent,
  type SharedProjectRole,
  type SharedProjectSessionSummary,
  type SharedProjectSummary,
  type WorkbenchLayout
} from "@latex-agent/ipc-contracts";
import { ProjectChangeDebouncer } from "./projectWatcher.js";
import { PdfPreviewCaptureStore } from "./pdfPreviewCapture.js";

const rendererDevServerUrl = process.env["VITE_DEV_SERVER_URL"];
const mainDir = fileURLToPath(new URL(".", import.meta.url));
const preloadPath = join(mainDir, "../preload/index.cjs");
const rendererRootPath = join(mainDir, "../renderer");
const rendererProtocol = "zeroleaf";
const rendererHost = "renderer";
const packagedRendererUrl = `${rendererProtocol}://${rendererHost}/index.html`;
const appIconPath = fileURLToPath(
  new URL("../../assets/zeroleaf-icon.png", import.meta.url)
);
const agentHostProcessPath = fileURLToPath(
  import.meta.resolve("@latex-agent/agent-host/host-process")
);
const appName = "ZeroLeaf";

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const agentHostClient = new AgentHostClient({
  hostProcessPath: agentHostProcessPath,
  handleToolRequest: handleAgentHostToolRequest,
  onEvent: (event) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send(ipcChannels.agentEvent, event);
    });
  },
  onCrash: (message) => {
    if (activeProjectRoot !== undefined) {
      void recordAgentAudit(activeProjectRoot, "agent.host.crashed", message);
    }
  }
});
let activeProjectWatcher: FSWatcher | undefined;
let activeProjectRoot: string | undefined;
let projectChangeDebouncer: ProjectChangeDebouncer | undefined;
const pdfPreviewCaptureStore = new PdfPreviewCaptureStore();
let sharedProjectClient: SharedProjectHttpClient | undefined;
let sharedProjectConnection: SharedProjectConnection = { connected: false };
let activeSharedProject:
  | {
      readonly projectId: string;
      readonly localCachePath: string;
    }
  | undefined;
const sharedDocumentSessions = new Map<string, SharedProjectDocumentSession>();
let activeSharedRealtimeSession: SharedProjectRealtimeSession | undefined;
let activeSharedRealtimeProjectId: string | undefined;
let activeSharedRealtimeReconnectTimer: ReturnType<typeof setTimeout> | undefined;

type PersistedSharedProjectSession = {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly user: NonNullable<SharedProjectConnection["user"]>;
};

type PersistedSharedProjectSessionFile = {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly encryptedAccessToken?: string;
  readonly refreshToken?: string;
  readonly encryptedRefreshToken?: string;
  readonly user: NonNullable<SharedProjectConnection["user"]>;
};

type ServerSharedProjectRealtimeEvent = Parameters<
  NonNullable<
    NonNullable<
      Parameters<SharedProjectHttpClient["openRealtimeSession"]>[1]
    >["onEvent"]
  >
>[0];

type SharedProjectSourceExportFile = {
  readonly path: string;
  readonly contents: string;
  readonly contentEncoding?: "utf8" | "base64";
};

type SharedProjectSourceExportDirectory = {
  readonly path: string;
};

const onlyOfficeBridge = new OnlyOfficeBridgeService({
  onBeforeDocumentSave: async ({ projectRoot, filePath }) => {
    const history = getHistoryStore();
    try {
      await history.createWordDocumentSnapshot(projectRoot, filePath);
    } finally {
      history.close();
    }
  },
  onAfterDocumentSave: async ({ projectRoot, filePath, sessionId }) => {
    await recordAgentAudit(
      projectRoot,
      "onlyoffice.document.saved",
      `ONLYOFFICE saved ${filePath} from session ${sessionId}.`
    );
    dispatchProjectChange(projectRoot, [filePath]);
  }
});

function optionalStringProperty<TKey extends string>(
  key: TKey,
  value: string | undefined
): { readonly [K in TKey]?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? {}
    : ({ [key]: trimmed } as { readonly [K in TKey]: string });
}

function optionalNumberProperty<TKey extends string>(
  key: TKey,
  value: number | undefined
): { readonly [K in TKey]?: number } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { readonly [K in TKey]: number });
}

function inferOnlyOfficeBridgeHost(
  publicBaseUrl: string | undefined
): string | undefined {
  const explicitHost = process.env["ZEROLEAF_ONLYOFFICE_BRIDGE_HOST"]?.trim();
  if (explicitHost !== undefined && explicitHost.length > 0) {
    return explicitHost;
  }

  try {
    return publicBaseUrl !== undefined &&
      new URL(publicBaseUrl).hostname === "host.docker.internal"
      ? "0.0.0.0"
      : undefined;
  } catch {
    return undefined;
  }
}

function inferOnlyOfficeBridgePort(
  publicBaseUrl: string | undefined
): number | undefined {
  const explicitPort = process.env["ZEROLEAF_ONLYOFFICE_BRIDGE_PORT"]?.trim();
  if (explicitPort !== undefined && explicitPort.length > 0) {
    return parsePort(explicitPort);
  }

  try {
    const parsedPort = publicBaseUrl === undefined ? "" : new URL(publicBaseUrl).port;
    return parsedPort.length === 0 ? undefined : parsePort(parsedPort);
  } catch {
    return undefined;
  }
}

function parsePort(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : undefined;
}

async function configureOnlyOfficeBridge(): Promise<void> {
  const settings = await readAppSettings();
  const bridgePublicBaseUrl = firstNonEmptyString(
    process.env["ZEROLEAF_ONLYOFFICE_BRIDGE_PUBLIC_URL"],
    settings.onlyOffice.bridgePublicBaseUrl
  );
  await onlyOfficeBridge.configure({
    enabled: settings.onlyOffice.enabled,
    documentServerUrl: firstNonEmptyString(
      process.env["ZEROLEAF_ONLYOFFICE_DOCUMENT_SERVER_URL"],
      settings.onlyOffice.documentServerUrl
    ),
    jwtSecret: firstNonEmptyString(
      process.env["ZEROLEAF_ONLYOFFICE_JWT_SECRET"],
      settings.onlyOffice.jwtSecret
    ),
    ...optionalStringProperty("bridgePublicBaseUrl", bridgePublicBaseUrl),
    ...optionalStringProperty(
      "bridgeHost",
      inferOnlyOfficeBridgeHost(bridgePublicBaseUrl)
    ),
    ...optionalNumberProperty(
      "preferredPort",
      inferOnlyOfficeBridgePort(bridgePublicBaseUrl)
    )
  });
}

function firstNonEmptyString(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }

  return "";
}

function toSafeExportFileBaseName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 80)
    .trim();

  return sanitized.length === 0 ? "shared-project" : sanitized;
}

function resolveSharedExportFilePath(rootPath: string, projectPath: string): string {
  const targetPath = join(rootPath, projectPath);
  const relativePath = relative(rootPath, targetPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Shared export contained an unsafe project path.");
  }

  return targetPath;
}

async function writeSharedProjectSourceExportFiles(
  rootPath: string,
  files: readonly SharedProjectSourceExportFile[],
  directories: readonly SharedProjectSourceExportDirectory[] = []
): Promise<void> {
  for (const directory of directories) {
    await mkdir(resolveSharedExportFilePath(rootPath, directory.path), {
      recursive: true
    });
  }

  for (const file of files) {
    const targetPath = resolveSharedExportFilePath(rootPath, file.path);
    const data =
      file.contentEncoding === "base64"
        ? Buffer.from(file.contents, "base64")
        : file.contents;
    await mkdir(dirname(targetPath), { recursive: true });
    if (file.contentEncoding === "base64") {
      await writeFile(targetPath, data);
    } else {
      await writeFile(targetPath, data, "utf8");
    }
  }
}

async function detectShareableMainFilePath(
  projectRoot: string,
  files: readonly { readonly path: string }[]
): Promise<string | undefined> {
  const tree = await listProjectTree(projectRoot);
  const texPaths = flattenProjectTree(tree)
    .filter((node) => node.kind === "file" && node.path.endsWith(".tex"))
    .map((node) => node.path);
  const mainFilePath = await detectMainTexFile(projectRoot, tree, texPaths);

  return mainFilePath !== undefined && files.some((file) => file.path === mainFilePath)
    ? mainFilePath
    : undefined;
}

function registerPackagedRendererProtocol(): void {
  protocol.handle(rendererProtocol, (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== rendererHost) {
      return new Response("Not found", { status: 404 });
    }

    const requestedPath =
      requestUrl.pathname === "/"
        ? "index.html"
        : decodeURIComponent(requestUrl.pathname.replace(/^\/+/u, ""));
    const rendererFilePath = join(rendererRootPath, requestedPath);
    const relativePath = relative(rendererRootPath, rendererFilePath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(rendererFilePath).toString());
  });
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalizeWorkbenchLayout(value: unknown): WorkbenchLayout {
  const layout =
    typeof value === "object" && value !== null
      ? (value as Partial<WorkbenchLayout>)
      : {};

  return {
    sidebarWidth: clampNumber(
      layout.sidebarWidth,
      220,
      420,
      defaultWorkbenchLayout.sidebarWidth
    ),
    pdfWidth: clampNumber(layout.pdfWidth, 320, 720, defaultWorkbenchLayout.pdfWidth),
    agentWidth: clampNumber(
      layout.agentWidth,
      340,
      560,
      defaultWorkbenchLayout.agentWidth
    ),
    bottomPanelHeight: clampNumber(
      layout.bottomPanelHeight,
      140,
      360,
      defaultWorkbenchLayout.bottomPanelHeight
    )
  };
}

const compilerIds = ["pdflatex", "xelatex", "lualatex"] as const;
const agentProviderIds = [
  "mock",
  "openai-codex",
  "anthropic-claude",
  "openrouter-design"
] as const;
const agentModes = ["suggest", "apply-with-review", "autonomous-local"] as const;
const externalProjectTemplates = {
  "ieee-systems-journal": {
    baseTemplateId: "article",
    mainFilePath: "main.tex",
    sourceUrl: "https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/bare_jrnl.tex"
  }
} as const satisfies Record<
  ExternalProjectTemplateId,
  {
    readonly baseTemplateId: IpcRequestMap[typeof ipcChannels.lifecycleCreateFromTemplate]["templateId"];
    readonly mainFilePath: string;
    readonly sourceUrl: string;
  }
>;

function normalizeAppSettings(value: unknown): AppSettings {
  const candidate =
    typeof value === "object" && value !== null ? (value as Partial<AppSettings>) : {};
  const editor =
    typeof candidate.editor === "object" && candidate.editor !== null
      ? (candidate.editor as Partial<AppSettings["editor"]>)
      : {};
  const compiler =
    typeof candidate.compiler === "object" && candidate.compiler !== null
      ? (candidate.compiler as Partial<AppSettings["compiler"]>)
      : {};
  const agentPermissions =
    typeof candidate.agentPermissions === "object" &&
    candidate.agentPermissions !== null
      ? (candidate.agentPermissions as Partial<AppSettings["agentPermissions"]>)
      : {};
  const appearance =
    typeof candidate.appearance === "object" && candidate.appearance !== null
      ? (candidate.appearance as Partial<AppSettings["appearance"]>)
      : {};
  const privacy =
    typeof candidate.privacy === "object" && candidate.privacy !== null
      ? (candidate.privacy as Partial<AppSettings["privacy"]>)
      : {};
  const updates =
    typeof candidate.updates === "object" && candidate.updates !== null
      ? (candidate.updates as Partial<AppSettings["updates"]>)
      : {};
  const onlyOffice =
    typeof candidate.onlyOffice === "object" && candidate.onlyOffice !== null
      ? (candidate.onlyOffice as Partial<AppSettings["onlyOffice"]>)
      : {};

  return {
    editor: {
      fontFamily:
        typeof editor.fontFamily === "string" && editor.fontFamily.trim().length > 0
          ? editor.fontFamily.trim()
          : defaultAppSettings.editor.fontFamily,
      fontSize: clampNumber(
        editor.fontSize,
        11,
        24,
        defaultAppSettings.editor.fontSize
      ),
      lineHeight: clampNumber(
        editor.lineHeight,
        16,
        36,
        defaultAppSettings.editor.lineHeight
      ),
      autocomplete:
        typeof editor.autocomplete === "boolean"
          ? editor.autocomplete
          : defaultAppSettings.editor.autocomplete,
      minimap:
        typeof editor.minimap === "boolean"
          ? editor.minimap
          : defaultAppSettings.editor.minimap
    },
    compiler: {
      compiler: isOneOf(compiler.compiler, compilerIds)
        ? compiler.compiler
        : defaultAppSettings.compiler.compiler,
      buildProfile: isOneOf(compiler.buildProfile, ["draft", "normal", "synctex"])
        ? compiler.buildProfile
        : defaultAppSettings.compiler.buildProfile,
      texPath: typeof compiler.texPath === "string" ? compiler.texPath.trim() : "",
      shellEscape: false
    },
    agentPermissions: {
      defaultProviderId: isOneOf(agentPermissions.defaultProviderId, agentProviderIds)
        ? agentPermissions.defaultProviderId
        : defaultAppSettings.agentPermissions.defaultProviderId,
      defaultMode: isOneOf(agentPermissions.defaultMode, agentModes)
        ? agentPermissions.defaultMode
        : defaultAppSettings.agentPermissions.defaultMode,
      compileAfterPatch:
        typeof agentPermissions.compileAfterPatch === "boolean"
          ? agentPermissions.compileAfterPatch
          : defaultAppSettings.agentPermissions.compileAfterPatch,
      requireApprovalForPatches:
        typeof agentPermissions.requireApprovalForPatches === "boolean"
          ? agentPermissions.requireApprovalForPatches
          : defaultAppSettings.agentPermissions.requireApprovalForPatches,
      networkPolicy: isOneOf(agentPermissions.networkPolicy, ["blocked", "ask"])
        ? agentPermissions.networkPolicy
        : defaultAppSettings.agentPermissions.networkPolicy,
      maxTurns: clampNumber(
        agentPermissions.maxTurns,
        1,
        10,
        defaultAppSettings.agentPermissions.maxTurns
      )
    },
    appearance: {
      density: isOneOf(appearance.density, ["compact", "comfortable"])
        ? appearance.density
        : defaultAppSettings.appearance.density,
      accent: isOneOf(appearance.accent, ["teal", "blue", "green"])
        ? appearance.accent
        : defaultAppSettings.appearance.accent,
      highContrastLight:
        typeof appearance.highContrastLight === "boolean"
          ? appearance.highContrastLight
          : defaultAppSettings.appearance.highContrastLight
    },
    updates: {
      checkOnStartup:
        typeof updates.checkOnStartup === "boolean"
          ? updates.checkOnStartup
          : defaultAppSettings.updates.checkOnStartup
    },
    onlyOffice: {
      enabled:
        typeof onlyOffice.enabled === "boolean"
          ? onlyOffice.enabled
          : defaultAppSettings.onlyOffice.enabled,
      documentServerUrl: normalizeHttpUrlSetting(
        onlyOffice.documentServerUrl,
        defaultAppSettings.onlyOffice.documentServerUrl
      ),
      jwtSecret: typeof onlyOffice.jwtSecret === "string" ? onlyOffice.jwtSecret : "",
      bridgePublicBaseUrl: normalizeHttpUrlSetting(
        onlyOffice.bridgePublicBaseUrl,
        defaultAppSettings.onlyOffice.bridgePublicBaseUrl
      )
    },
    privacy: {
      storeAgentTranscripts:
        typeof privacy.storeAgentTranscripts === "boolean"
          ? privacy.storeAgentTranscripts
          : defaultAppSettings.privacy.storeAgentTranscripts,
      storeBuildLogs:
        typeof privacy.storeBuildLogs === "boolean"
          ? privacy.storeBuildLogs
          : defaultAppSettings.privacy.storeBuildLogs
    },
    credentials: defaultAppSettings.credentials
  };
}

function normalizeHttpUrlSetting(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? trimmed
      : fallback;
  } catch {
    return fallback;
  }
}

function isOneOf<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[]
): value is TValue {
  return typeof value === "string" && allowedValues.includes(value as TValue);
}

async function readAppSettings(): Promise<AppSettings> {
  try {
    const contents = await readFile(getSettingsPath(), "utf8");
    return normalizeAppSettings(JSON.parse(contents));
  } catch {
    return defaultAppSettings;
  }
}

async function writeAppSettings(settings: AppSettings): Promise<AppSettings> {
  const normalizedSettings = normalizeAppSettings(settings);
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(
    getSettingsPath(),
    JSON.stringify(normalizedSettings, null, 2),
    "utf8"
  );
  return normalizedSettings;
}

async function readWorkbenchLayout(): Promise<WorkbenchLayout> {
  try {
    const contents = await readFile(getWorkbenchLayoutPath(), "utf8");
    return normalizeWorkbenchLayout(JSON.parse(contents));
  } catch {
    return defaultWorkbenchLayout;
  }
}

async function writeWorkbenchLayout(layout: WorkbenchLayout): Promise<WorkbenchLayout> {
  const normalizedLayout = normalizeWorkbenchLayout(layout);
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(
    getWorkbenchLayoutPath(),
    JSON.stringify(normalizedLayout, null, 2),
    "utf8"
  );
  return normalizedLayout;
}

function getWorkbenchLayoutPath() {
  return join(app.getPath("userData"), "workbench-layout.json");
}

function getEditorStatePath() {
  return join(app.getPath("userData"), "editor-project-state.json");
}

function getSettingsPath() {
  return join(app.getPath("userData"), "app-settings.json");
}

function getProjectMetadataPath() {
  return join(app.getPath("userData"), "project-metadata.json");
}

function getSharedSessionPath() {
  return join(app.getPath("userData"), "shared-session.json");
}

function getSharedDesktopClientIdPath() {
  return join(app.getPath("userData"), "shared-desktop-client-id");
}

async function getSharedDesktopClientId(): Promise<string> {
  try {
    const existingId = (await readFile(getSharedDesktopClientIdPath(), "utf8")).trim();
    if (existingId.length > 0) {
      return existingId;
    }
  } catch {
    // Create the id below when this desktop has not uploaded shared artifacts yet.
  }

  const nextId = `desktop_${randomUUID()}`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(getSharedDesktopClientIdPath(), `${nextId}\n`, "utf8");
  return nextId;
}

async function readPersistedSharedProjectSession(): Promise<
  PersistedSharedProjectSession | undefined
> {
  try {
    const parsed = JSON.parse(
      await readFile(getSharedSessionPath(), "utf8")
    ) as Partial<PersistedSharedProjectSessionFile>;
    const accessToken = readPersistedSharedProjectAccessToken(parsed);
    const refreshToken = readPersistedSharedProjectRefreshToken(parsed);
    if (
      typeof parsed.baseUrl !== "string" ||
      refreshToken === undefined ||
      typeof parsed.user?.id !== "string" ||
      typeof parsed.user.email !== "string" ||
      typeof parsed.user.name !== "string"
    ) {
      return undefined;
    }

    return {
      baseUrl: parsed.baseUrl,
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      user: {
        id: parsed.user.id,
        email: parsed.user.email,
        name: parsed.user.name
      }
    };
  } catch {
    return undefined;
  }
}

function readPersistedSharedProjectAccessToken(
  parsed: Partial<PersistedSharedProjectSessionFile>
): string | undefined {
  return readPersistedSharedProjectToken(
    parsed.encryptedAccessToken,
    parsed.accessToken
  );
}

function readPersistedSharedProjectRefreshToken(
  parsed: Partial<PersistedSharedProjectSessionFile>
): string | undefined {
  return readPersistedSharedProjectToken(
    parsed.encryptedRefreshToken,
    parsed.refreshToken
  );
}

function readPersistedSharedProjectToken(
  encryptedToken: string | undefined,
  plaintextToken: string | undefined
): string | undefined {
  if (typeof encryptedToken === "string") {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
    } catch {
      return undefined;
    }
  }

  return typeof plaintextToken === "string" ? plaintextToken : undefined;
}

async function writePersistedSharedProjectSession(
  session: PersistedSharedProjectSession
): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  const encryptedAccessToken =
    session.accessToken === undefined
      ? {}
      : encryptSharedProjectAccessToken(session.accessToken);
  const encryptedRefreshToken =
    session.refreshToken === undefined
      ? {}
      : encryptSharedProjectRefreshToken(session.refreshToken);

  if (
    session.refreshToken !== undefined &&
    encryptedRefreshToken.encryptedRefreshToken === undefined
  ) {
    await clearPersistedSharedProjectSession();
    return;
  }

  const persistedSession: PersistedSharedProjectSessionFile = {
    baseUrl: session.baseUrl,
    user: session.user,
    ...encryptedAccessToken,
    ...encryptedRefreshToken
  };
  await writeFile(
    getSharedSessionPath(),
    JSON.stringify(persistedSession, null, 2),
    "utf8"
  );
}

async function clearPersistedSharedProjectSession(): Promise<void> {
  await rm(getSharedSessionPath(), { force: true });
}

function encryptSharedProjectAccessToken(
  accessToken: string
): Pick<PersistedSharedProjectSessionFile, "accessToken" | "encryptedAccessToken"> {
  const token = encryptSharedProjectToken(accessToken);
  return token.encryptedToken === undefined
    ? {}
    : { encryptedAccessToken: token.encryptedToken };
}

function encryptSharedProjectRefreshToken(
  refreshToken: string
): Pick<PersistedSharedProjectSessionFile, "refreshToken" | "encryptedRefreshToken"> {
  const token = encryptSharedProjectToken(refreshToken);
  return token.encryptedToken === undefined
    ? {}
    : { encryptedRefreshToken: token.encryptedToken };
}

function encryptSharedProjectToken(token: string): {
  readonly encryptedToken?: string;
} {
  if (!safeStorage.isEncryptionAvailable()) {
    return {};
  }

  return {
    encryptedToken: safeStorage.encryptString(token).toString("base64")
  };
}

function toSharedProjectConnection(
  baseUrl: string,
  user: NonNullable<SharedProjectConnection["user"]>
): SharedProjectConnection {
  return {
    connected: true,
    baseUrl,
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    }
  };
}

type SharedProjectClientCredentials = {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
};

function createSharedProjectClient(
  credentials: SharedProjectClientCredentials
): SharedProjectHttpClient {
  return new SharedProjectHttpClient({
    ...credentials,
    onSessionRefreshed: (session) =>
      persistRefreshedSharedProjectSession(credentials.baseUrl, session)
  });
}

async function persistRefreshedSharedProjectSession(
  baseUrl: string,
  session: {
    readonly refreshToken: string;
    readonly user: NonNullable<SharedProjectConnection["user"]>;
  }
): Promise<void> {
  await writePersistedSharedProjectSession({
    baseUrl,
    refreshToken: session.refreshToken,
    user: session.user
  });
}

async function restoreSharedProjectConnection(): Promise<SharedProjectConnection> {
  if (sharedProjectClient !== undefined) {
    return sharedProjectConnection;
  }

  const persisted = await readPersistedSharedProjectSession();
  if (persisted === undefined) {
    sharedProjectConnection = { connected: false };
    return sharedProjectConnection;
  }

  const client = createSharedProjectClient({
    baseUrl: persisted.baseUrl,
    ...(persisted.accessToken === undefined
      ? {}
      : { accessToken: persisted.accessToken }),
    ...(persisted.refreshToken === undefined
      ? {}
      : { refreshToken: persisted.refreshToken })
  });

  try {
    const session = await client.refreshSession(persisted.refreshToken);
    const user = session.user;
    sharedProjectClient = client;
    sharedProjectConnection = toSharedProjectConnection(persisted.baseUrl, user);
    await writePersistedSharedProjectSession({
      baseUrl: persisted.baseUrl,
      refreshToken: session.refreshToken,
      user
    });
  } catch {
    sharedProjectClient = undefined;
    sharedProjectConnection = { connected: false, baseUrl: persisted.baseUrl };
  }

  return sharedProjectConnection;
}

function getProjectMetadataStore() {
  return new ProjectMetadataStore(getProjectMetadataPath());
}

function getSharedProjectCache() {
  return new SharedProjectCache(app.getPath("userData"));
}

function toSharedProjectSummary(project: {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly mainFilePath?: string;
  readonly compiler?: SharedProjectSummary["compiler"];
  readonly role?: SharedProjectRole;
  readonly updatedAt: string;
}): SharedProjectSummary {
  return {
    id: project.id,
    name: project.name,
    ownerUserId: project.ownerUserId,
    ...(project.mainFilePath === undefined
      ? {}
      : { mainFilePath: project.mainFilePath }),
    ...(project.compiler === undefined ? {} : { compiler: project.compiler }),
    role: project.role ?? "owner",
    updatedAt: project.updatedAt
  };
}

function toSharedProjectSessionSummary(session: {
  readonly id: string;
  readonly userId: string;
  readonly current: boolean;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly createdAt: string;
}): SharedProjectSessionSummary {
  return {
    id: session.id,
    userId: session.userId,
    current: session.current,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    createdAt: session.createdAt
  };
}

function toSharedProjectInvitationSummary(invitation: {
  readonly id: string;
  readonly projectId: string;
  readonly email: string;
  readonly role: "editor" | "viewer";
  readonly status: "pending" | "accepted";
}): SharedProjectInvitationSummary {
  return {
    id: invitation.id,
    projectId: invitation.projectId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status
  };
}

function toSharedProjectMemberSummary(member: {
  readonly projectId: string;
  readonly userId: string;
  readonly role: "owner" | "editor" | "viewer";
  readonly email?: string;
  readonly name?: string;
  readonly joinedAt?: string;
}): SharedProjectMemberSummary {
  return {
    projectId: member.projectId,
    userId: member.userId,
    role: member.role,
    ...(member.email === undefined ? {} : { email: member.email }),
    ...(member.name === undefined ? {} : { name: member.name }),
    ...(member.joinedAt === undefined ? {} : { joinedAt: member.joinedAt })
  };
}

function toSharedProjectPresenceSummary(presence: {
  readonly projectId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly filePath?: string;
  readonly cursorLine?: number;
  readonly cursorColumn?: number;
  readonly updatedAt: string;
}): SharedProjectPresenceSummary {
  return {
    projectId: presence.projectId,
    userId: presence.userId,
    displayName: presence.displayName,
    ...(presence.filePath === undefined ? {} : { filePath: presence.filePath }),
    ...(presence.cursorLine === undefined ? {} : { cursorLine: presence.cursorLine }),
    ...(presence.cursorColumn === undefined
      ? {}
      : { cursorColumn: presence.cursorColumn }),
    updatedAt: presence.updatedAt
  };
}

function toSharedProjectBuildArtifactSummary(artifact: {
  readonly id: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly desktopClientId: string;
  readonly compiler: string;
  readonly engineVersion?: string;
  readonly latexmkVersion?: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly platform: NodeJS.Platform;
  readonly diagnostics: readonly unknown[];
  readonly pdfByteLength?: number;
  readonly createdAt: string;
}): SharedProjectBuildArtifactSummary {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    sourceRevisionId: artifact.sourceRevisionId,
    desktopClientId: artifact.desktopClientId,
    compiler: artifact.compiler,
    ...(artifact.engineVersion === undefined
      ? {}
      : { engineVersion: artifact.engineVersion }),
    ...(artifact.latexmkVersion === undefined
      ? {}
      : { latexmkVersion: artifact.latexmkVersion }),
    status: artifact.status,
    platform: artifact.platform,
    diagnosticCount: artifact.diagnostics.length,
    ...(artifact.pdfByteLength === undefined
      ? {}
      : { pdfByteLength: artifact.pdfByteLength }),
    createdAt: artifact.createdAt
  };
}

function toSharedProjectBuildArtifactDetails(artifact: {
  readonly id: string;
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly desktopClientId: string;
  readonly compiler: string;
  readonly engineVersion?: string;
  readonly latexmkVersion?: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly platform: NodeJS.Platform;
  readonly diagnostics: readonly {
    readonly severity: "error" | "warning";
    readonly message: string;
    readonly filePath?: string;
    readonly line?: number;
  }[];
  readonly rawLog: string;
  readonly pdfBase64?: string;
  readonly pdfByteLength?: number;
  readonly createdAt: string;
}): SharedProjectBuildArtifactDetails {
  return {
    ...toSharedProjectBuildArtifactSummary(artifact),
    rawLog: artifact.rawLog,
    diagnostics: artifact.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
    })),
    ...(artifact.pdfBase64 === undefined ? {} : { pdfBase64: artifact.pdfBase64 })
  };
}

function toSharedProjectActivitySummary(activity: {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly eventType: string;
  readonly message: string;
  readonly createdAt: string;
}): SharedProjectActivitySummary {
  return {
    id: activity.id,
    projectId: activity.projectId,
    actorUserId: activity.actorUserId,
    eventType: activity.eventType,
    message: activity.message,
    createdAt: activity.createdAt
  };
}

function toSharedProjectCommentSummary(comment: {
  readonly id: string;
  readonly projectId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly resolved: boolean;
  readonly resolvedByUserId?: string;
  readonly resolvedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}) {
  return {
    id: comment.id,
    projectId: comment.projectId,
    authorUserId: comment.authorUserId,
    body: comment.body,
    ...(comment.filePath === undefined ? {} : { filePath: comment.filePath }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
    resolved: comment.resolved,
    ...(comment.resolvedByUserId === undefined
      ? {}
      : { resolvedByUserId: comment.resolvedByUserId }),
    ...(comment.resolvedAt === undefined ? {} : { resolvedAt: comment.resolvedAt }),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt
  };
}

function toSharedProjectFileRevisionDetails(revision: {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly actorUserId: string;
  readonly createdAt: string;
  readonly contents: string;
  readonly contentEncoding?: "utf8" | "base64";
}) {
  return {
    id: revision.id,
    projectId: revision.projectId,
    path: revision.path,
    actorUserId: revision.actorUserId,
    createdAt: revision.createdAt,
    contents: revision.contents,
    ...(revision.contentEncoding === undefined
      ? {}
      : { contentEncoding: revision.contentEncoding }),
    byteLength:
      revision.contentEncoding === "base64"
        ? Buffer.from(revision.contents, "base64").byteLength
        : Buffer.byteLength(revision.contents, "utf8")
  };
}

function toSharedProjectAuditEventSummary(event: {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly eventType: string;
  readonly message: string;
  readonly agentRunId?: string;
  readonly changesetId?: string;
  readonly buildArtifactIds?: readonly string[];
  readonly createdAt: string;
}): SharedProjectAuditEventSummary {
  return {
    id: event.id,
    projectId: event.projectId,
    actorUserId: event.actorUserId,
    eventType: event.eventType,
    message: event.message,
    ...(event.agentRunId === undefined ? {} : { agentRunId: event.agentRunId }),
    ...(event.changesetId === undefined ? {} : { changesetId: event.changesetId }),
    ...(event.buildArtifactIds === undefined
      ? {}
      : { buildArtifactIds: event.buildArtifactIds }),
    createdAt: event.createdAt
  };
}

function toSharedProjectAgentRunSummary(agentRun: {
  readonly id: string;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly providerId: string;
  readonly mode: string;
  readonly promptHash: string;
  readonly status:
    | "running"
    | "waiting-for-review"
    | "completed"
    | "failed"
    | "cancelled";
  readonly changesetIds: readonly string[];
  readonly buildArtifactIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}): SharedProjectAgentRunSummary {
  return {
    id: agentRun.id,
    projectId: agentRun.projectId,
    actorUserId: agentRun.actorUserId,
    providerId: agentRun.providerId,
    mode: agentRun.mode,
    promptHash: agentRun.promptHash,
    status: agentRun.status,
    changesetIds: agentRun.changesetIds,
    buildArtifactIds: agentRun.buildArtifactIds,
    createdAt: agentRun.createdAt,
    updatedAt: agentRun.updatedAt
  };
}

function toSharedProjectAgentChangeSetSummary(changeset: {
  readonly id: string;
  readonly projectId: string;
  readonly agentRunId: string;
  readonly actorUserId: string;
  readonly filePath: string;
  readonly summary: string;
  readonly status: "proposed" | "applied" | "rejected" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly beforeContents: string;
  readonly afterContents: string;
  readonly appliedAt?: string;
  readonly appliedRevisionId?: string;
}): SharedProjectAgentChangeSetSummary {
  return {
    id: changeset.id,
    projectId: changeset.projectId,
    agentRunId: changeset.agentRunId,
    actorUserId: changeset.actorUserId,
    filePath: changeset.filePath,
    summary: changeset.summary,
    status: changeset.status,
    createdAt: changeset.createdAt,
    updatedAt: changeset.updatedAt,
    patchPreview: createSharedChangeSetPatchPreview(
      changeset.filePath,
      changeset.beforeContents,
      changeset.afterContents
    ),
    ...(changeset.appliedAt === undefined ? {} : { appliedAt: changeset.appliedAt }),
    ...(changeset.appliedRevisionId === undefined
      ? {}
      : { appliedRevisionId: changeset.appliedRevisionId })
  };
}

function createSharedChangeSetPatchPreview(
  filePath: string,
  beforeContents: string,
  afterContents: string
): string {
  if (beforeContents === afterContents) {
    return `--- a/${filePath}\n+++ b/${filePath}\n(no text changes)`;
  }

  const beforeLines = beforeContents.split(/\r?\n/u);
  const afterLines = afterContents.split(/\r?\n/u);
  const maxPreviewLines = 80;
  const diffLines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (
    (beforeIndex < beforeLines.length || afterIndex < afterLines.length) &&
    diffLines.length < maxPreviewLines
  ) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];

    if (beforeLine === afterLine) {
      diffLines.push(` ${beforeLine ?? ""}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLine !== undefined) {
      diffLines.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
    if (afterLine !== undefined) {
      diffLines.push(`+${afterLine}`);
      afterIndex += 1;
    }
  }

  if (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    diffLines.push("...diff preview truncated...");
  }

  return diffLines.join("\n");
}

async function readOptionalBuildPdfBase64(
  projectRoot: string,
  pdfPath: string
): Promise<string | undefined> {
  const resolvedPdfPath = isAbsolute(pdfPath) ? pdfPath : join(projectRoot, pdfPath);

  try {
    return await readFile(resolvedPdfPath, "base64");
  } catch {
    return undefined;
  }
}

function toSharedProjectDocumentSyncResult(
  result: {
    readonly revision: {
      readonly projectId: string;
      readonly path: string;
      readonly contents: string;
      readonly id: string;
    };
  },
  mtimeMs: number,
  metadata: {
    readonly lastUpdateId?: string;
    readonly remoteUpdateCount?: number;
    readonly remoteTextOperations?: readonly SharedProjectDocumentTextOperation[];
  } = {}
): SharedProjectDocumentSyncResult {
  return {
    projectId: result.revision.projectId,
    path: result.revision.path,
    contents: result.revision.contents,
    revisionId: result.revision.id,
    mtimeMs,
    ...metadata
  };
}

async function writeSharedDocumentRevisionToActiveCache(result: {
  readonly revision: {
    readonly projectId: string;
    readonly path: string;
    readonly contents: string;
    readonly id: string;
  };
  readonly update?: {
    readonly id: string;
  };
  readonly remoteUpdateCount?: number;
  readonly remoteTextOperations?: readonly SharedProjectDocumentTextOperation[];
}): Promise<SharedProjectDocumentSyncResult> {
  const sharedProject =
    activeSharedProject?.projectId === result.revision.projectId
      ? activeSharedProject
      : undefined;
  const localWrite =
    sharedProject === undefined
      ? { mtimeMs: Date.now() }
      : await writeProjectFile(
          sharedProject.localCachePath,
          result.revision.path,
          result.revision.contents
        );
  if (sharedProject !== undefined) {
    await getSharedProjectCache().recordFileRevision(
      result.revision.projectId,
      result.revision.path,
      result.revision.id
    );
  }

  return toSharedProjectDocumentSyncResult(result, localWrite.mtimeMs, {
    ...(result.update === undefined ? {} : { lastUpdateId: result.update.id }),
    ...(result.remoteUpdateCount === undefined
      ? {}
      : { remoteUpdateCount: result.remoteUpdateCount }),
    ...(result.remoteTextOperations === undefined
      ? {}
      : { remoteTextOperations: result.remoteTextOperations })
  });
}

function requireSharedProjectClient(): SharedProjectHttpClient {
  if (sharedProjectClient === undefined) {
    throw new Error("Sign in to a shared project server before using shared projects.");
  }

  return sharedProjectClient;
}

async function startSharedRealtimeSession(
  projectId: string,
  reconnectAttempt = 0
): Promise<{ readonly projectId: string; readonly subscribed: boolean }> {
  if (
    activeSharedRealtimeSession !== undefined &&
    activeSharedRealtimeProjectId === projectId
  ) {
    return { projectId, subscribed: true };
  }

  clearSharedRealtimeReconnectTimer();
  if (reconnectAttempt === 0) {
    await stopSharedRealtimeSession();
  }
  const session = await requireSharedProjectClient().openRealtimeSession(projectId, {
    onEvent: (event) => {
      if (event.type === "tree.updated") {
        clearSharedDocumentSessions();
      }
      broadcastSharedRealtimeEvent(toDesktopSharedRealtimeEvent(event));
    },
    onError: (error) => {
      broadcastSharedRealtimeEvent({
        type: "error",
        projectId,
        message: error.message
      });
    },
    onClose: (event) => {
      if (
        activeSharedRealtimeProjectId === projectId &&
        activeSharedRealtimeSession === session
      ) {
        activeSharedRealtimeSession = undefined;
        activeSharedRealtimeProjectId = undefined;
        scheduleSharedRealtimeReconnect(projectId, reconnectAttempt, event.code);
      }
    }
  });
  activeSharedRealtimeSession = session;
  activeSharedRealtimeProjectId = projectId;

  return { projectId, subscribed: true };
}

async function stopSharedRealtimeSession(
  projectId = activeSharedRealtimeProjectId
): Promise<{ readonly projectId: string; readonly subscribed: boolean }> {
  clearSharedRealtimeReconnectTimer();
  if (
    activeSharedRealtimeSession === undefined ||
    activeSharedRealtimeProjectId === undefined ||
    (projectId !== undefined && activeSharedRealtimeProjectId !== projectId)
  ) {
    if (projectId === undefined || activeSharedRealtimeProjectId === projectId) {
      activeSharedRealtimeProjectId = undefined;
    }
    return { projectId: projectId ?? "", subscribed: false };
  }

  const closingProjectId = activeSharedRealtimeProjectId;
  const session = activeSharedRealtimeSession;
  activeSharedRealtimeSession = undefined;
  activeSharedRealtimeProjectId = undefined;
  await session.close();

  return { projectId: closingProjectId, subscribed: false };
}

function scheduleSharedRealtimeReconnect(
  projectId: string,
  previousAttempt: number,
  closeCode: number
): void {
  if (closeCode === 4003 || sharedProjectClient === undefined) {
    return;
  }

  const nextAttempt = previousAttempt + 1;
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(nextAttempt - 1, 5));
  broadcastSharedRealtimeEvent({
    type: "error",
    projectId,
    message: `Shared realtime disconnected. Reconnecting in ${Math.round(
      delayMs / 1000
    )}s.`
  });
  activeSharedRealtimeProjectId = projectId;
  activeSharedRealtimeReconnectTimer = setTimeout(() => {
    activeSharedRealtimeReconnectTimer = undefined;
    void startSharedRealtimeSession(projectId, nextAttempt).catch((error) => {
      if (activeSharedRealtimeProjectId === projectId) {
        broadcastSharedRealtimeEvent({
          type: "error",
          projectId,
          message: `Shared realtime reconnect failed: ${getErrorMessage(error)}`
        });
        scheduleSharedRealtimeReconnect(projectId, nextAttempt, 1006);
      }
    });
  }, delayMs);
}

function clearSharedRealtimeReconnectTimer(): void {
  if (activeSharedRealtimeReconnectTimer === undefined) {
    return;
  }

  clearTimeout(activeSharedRealtimeReconnectTimer);
  activeSharedRealtimeReconnectTimer = undefined;
}

function broadcastSharedRealtimeEvent(event: SharedProjectRealtimeEvent): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(ipcChannels.sharedRealtimeEvent, event);
  });
}

function toDesktopSharedRealtimeEvent(
  event: ServerSharedProjectRealtimeEvent
): SharedProjectRealtimeEvent {
  if (event.type === "presence.updated") {
    return {
      type: event.type,
      projectId: event.projectId,
      presence: toSharedProjectPresenceSummary(event.presence)
    };
  }

  return event as SharedProjectRealtimeEvent;
}

function getSharedDocumentSessionKey(projectId: string, path: string): string {
  return `${projectId}\0${path}`;
}

function clearSharedDocumentSessions(): void {
  sharedDocumentSessions.clear();
}

async function getSharedDocumentSession(
  projectId: string,
  path: string
): Promise<SharedProjectDocumentSession> {
  const sessionKey = getSharedDocumentSessionKey(projectId, path);
  const existingSession = sharedDocumentSessions.get(sessionKey);
  if (existingSession !== undefined) {
    return existingSession;
  }

  const session = await SharedProjectDocumentSession.open(
    requireSharedProjectClient(),
    projectId,
    path
  );
  sharedDocumentSessions.set(sessionKey, session);
  return session;
}

function createRemoteTextOperations(
  beforeContents: string,
  afterContents: string
): readonly SharedProjectDocumentTextOperation[] {
  if (beforeContents === afterContents) {
    return [];
  }

  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < beforeContents.length &&
    sharedPrefixLength < afterContents.length &&
    beforeContents.charCodeAt(sharedPrefixLength) ===
      afterContents.charCodeAt(sharedPrefixLength)
  ) {
    sharedPrefixLength += 1;
  }

  let beforeSuffixOffset = beforeContents.length;
  let afterSuffixOffset = afterContents.length;
  while (
    beforeSuffixOffset > sharedPrefixLength &&
    afterSuffixOffset > sharedPrefixLength &&
    beforeContents.charCodeAt(beforeSuffixOffset - 1) ===
      afterContents.charCodeAt(afterSuffixOffset - 1)
  ) {
    beforeSuffixOffset -= 1;
    afterSuffixOffset -= 1;
  }

  return [
    {
      rangeOffset: sharedPrefixLength,
      rangeLength: beforeSuffixOffset - sharedPrefixLength,
      text: afterContents.slice(sharedPrefixLength, afterSuffixOffset)
    }
  ];
}

function getActiveSharedProject(projectRoot: string) {
  return activeSharedProject?.localCachePath === projectRoot
    ? activeSharedProject
    : undefined;
}

async function refreshProjectThroughActiveBackend(projectRoot: string) {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject === undefined) {
    const project = await refreshProject(projectRoot, getProjectMetadataStore());
    startProjectWatcher(project.project.rootPath);
    return project;
  }

  const client = requireSharedProjectClient();
  const [materialized, serverProject] = await Promise.all([
    getSharedProjectCache().materializeProject(client, sharedProject.projectId),
    client.getProject(sharedProject.projectId)
  ]);

  if (serverProject.mainFilePath !== undefined) {
    await setProjectMainFile(
      materialized.workingPath,
      getProjectMetadataStore(),
      serverProject.mainFilePath
    );
  }

  activeSharedProject = {
    projectId: sharedProject.projectId,
    localCachePath: materialized.workingPath
  };
  clearSharedDocumentSessions();

  const project = await refreshProject(
    materialized.workingPath,
    getProjectMetadataStore()
  );
  startProjectWatcher(project.project.rootPath);
  return project;
}

async function setProjectMainFileThroughActiveBackend(
  projectRoot: string,
  path: string
) {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject === undefined) {
    return setProjectMainFile(projectRoot, getProjectMetadataStore(), path);
  }

  await requireSharedProjectClient().updateProjectSettings(sharedProject.projectId, {
    mainFilePath: path
  });
  return refreshProjectThroughActiveBackend(projectRoot);
}

function assertAgentProjectContextMatchesActiveProject(request: AgentStartRequest) {
  const activeProject = getActiveSharedProject(request.projectRoot);

  if (activeProject !== undefined && request.projectContext === undefined) {
    throw new Error("Shared agent requests must include shared project context.");
  }

  if (request.projectContext === undefined) {
    return;
  }

  if (
    activeProject === undefined ||
    request.projectContext.sharedProjectId !== activeProject.projectId ||
    request.projectContext.localCachePath !== activeProject.localCachePath
  ) {
    throw new Error("Shared agent context does not match the active shared project.");
  }

  if (request.projectContext.role === "viewer" && request.mode !== "read-only") {
    throw new Error("Shared viewers can only start read-only agent sessions.");
  }
}

async function readProjectFileThroughActiveBackend(
  projectRoot: string,
  path: string
): Promise<ProjectFileSnapshot> {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject === undefined) {
    return await readProjectFile(projectRoot, path);
  }

  const revision = await requireSharedProjectClient().readFile(
    sharedProject.projectId,
    path
  );
  const syncResult = await writeSharedDocumentRevisionToActiveCache({ revision });

  return {
    path: revision.path,
    contents: revision.contents,
    mtimeMs: syncResult.mtimeMs
  };
}

async function writeProjectFileThroughActiveBackend(
  projectRoot: string,
  path: string,
  contents: string
) {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject !== undefined) {
    const cache = getSharedProjectCache();
    const expectedRevisionId = await cache.getCachedRevisionId(
      sharedProject.projectId,
      path
    );
    const revision = isSharedProjectCollaborativeDocumentPath(path)
      ? (
          await requireSharedProjectClient().replaceDocumentContents(
            sharedProject.projectId,
            path,
            contents,
            expectedRevisionId
          )
        ).revision
      : await requireSharedProjectClient().writeFile(
          sharedProject.projectId,
          path,
          contents,
          expectedRevisionId
        );
    await cache.recordFileRevision(sharedProject.projectId, revision.path, revision.id);
    sharedDocumentSessions.delete(
      getSharedDocumentSessionKey(sharedProject.projectId, path)
    );
  }

  return await writeProjectFile(projectRoot, path, contents);
}

async function deleteProjectEntryThroughActiveBackend(
  projectRoot: string,
  path: string
) {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject !== undefined) {
    const deletedPaths = await requireSharedProjectClient().deleteEntry(
      sharedProject.projectId,
      path
    );
    await refreshProjectThroughActiveBackend(projectRoot);
    return {
      deletedPath: path,
      backupPath: `shared-project:${sharedProject.projectId}:${deletedPaths.join(",")}`,
      deletedAt: new Date().toISOString()
    };
  }

  return await deleteProjectEntry(projectRoot, path);
}

async function moveProjectEntryThroughActiveBackend(
  projectRoot: string,
  fromPath: string,
  toPath: string
) {
  const sharedProject = getActiveSharedProject(projectRoot);

  if (sharedProject !== undefined) {
    await requireSharedProjectClient().moveEntry(
      sharedProject.projectId,
      fromPath,
      toPath
    );
    await refreshProjectThroughActiveBackend(projectRoot);
    return;
  }

  await moveProjectEntry(projectRoot, fromPath, toPath);
}

async function syncHistoryChangeSetToActiveSharedBackend(
  history: {
    getChangeSetWithContents: (changesetId: string) => {
      readonly projectRoot: string;
      readonly filePath: string;
      readonly afterContents: string;
      readonly id: string;
    };
    rollbackChangeSet: (changesetId: string) => Promise<unknown>;
  },
  changesetId: string
): Promise<void> {
  const changeset = history.getChangeSetWithContents(changesetId);
  const sharedProject = getActiveSharedProject(changeset.projectRoot);

  if (sharedProject === undefined) {
    return;
  }

  const expectedRevisionId = await getSharedProjectCache().getCachedRevisionId(
    sharedProject.projectId,
    changeset.filePath
  );
  try {
    const result = await requireSharedProjectClient().replaceDocumentContents(
      sharedProject.projectId,
      changeset.filePath,
      changeset.afterContents,
      expectedRevisionId
    );
    await writeSharedDocumentRevisionToActiveCache(result);
  } catch (error) {
    if (isSharedRevisionConflict(error)) {
      await history.rollbackChangeSet(changeset.id);
      await refreshProjectThroughActiveBackend(changeset.projectRoot);
    }

    throw error;
  }
}

function isSharedRevisionConflict(error: unknown): boolean {
  return (
    error instanceof SharedProjectClientError &&
    error.status === 409 &&
    error.code === "revision-conflict"
  );
}

function joinProjectEntryPath(parentPath: string, name: string) {
  return parentPath === "." ? name : `${parentPath.replace(/\/+$/u, "")}/${name}`;
}

function getHistoryDbPath() {
  return join(app.getPath("userData"), "history.sqlite");
}

function getHistoryStore() {
  return new HistoryStore(getHistoryDbPath());
}

function getPrivacySummary(): PrivacySummary {
  const history = getHistoryStore();
  try {
    return {
      dataLocation: app.getPath("userData"),
      ...history.getPrivacySummary()
    };
  } finally {
    history.close();
  }
}

function clearLocalHistory(): PrivacySummary {
  const history = getHistoryStore();
  try {
    const summary = history.clearAll();
    return {
      dataLocation: app.getPath("userData"),
      ...summary
    };
  } finally {
    history.close();
  }
}

function startProjectWatcher(projectRoot: string) {
  activeProjectWatcher?.close();
  projectChangeDebouncer?.dispose();
  activeProjectRoot = projectRoot;
  const debouncer = new ProjectChangeDebouncer(projectRoot, (event) =>
    dispatchProjectChange(event.projectRoot, event.paths)
  );
  projectChangeDebouncer = debouncer;

  try {
    activeProjectWatcher = watch(
      projectRoot,
      { recursive: true },
      (_eventType, filename) => {
        debouncer.notify(filename);
      }
    );
  } catch {
    activeProjectWatcher = undefined;
    debouncer.dispose();
    projectChangeDebouncer = undefined;
  }
}

function dispatchProjectChange(projectRoot: string, paths: readonly string[]): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(ipcChannels.projectChanged, {
      projectRoot,
      paths
    });
  });
}

async function readEditorProjectState(
  projectRoot: string
): Promise<EditorProjectState> {
  try {
    const contents = await readFile(getEditorStatePath(), "utf8");
    const parsed = JSON.parse(contents) as unknown;
    const stateByRoot =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    return normalizeEditorProjectState(projectRoot, stateByRoot[projectRoot]);
  } catch {
    return {
      projectRoot,
      openFilePaths: []
    };
  }
}

async function writeEditorProjectState(
  state: EditorProjectState
): Promise<EditorProjectState> {
  const normalizedState = normalizeEditorProjectState(state.projectRoot, state);
  let stateByRoot: Record<string, unknown> = {};

  try {
    const contents = await readFile(getEditorStatePath(), "utf8");
    const parsed = JSON.parse(contents) as unknown;
    stateByRoot =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    stateByRoot = {};
  }

  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(
    getEditorStatePath(),
    JSON.stringify(
      {
        ...stateByRoot,
        [normalizedState.projectRoot]: normalizedState
      },
      null,
      2
    ),
    "utf8"
  );

  return normalizedState;
}

function normalizeEditorProjectState(
  projectRoot: string,
  value: unknown
): EditorProjectState {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Partial<EditorProjectState>)
      : {};
  const openFilePaths = Array.isArray(candidate.openFilePaths)
    ? candidate.openFilePaths.filter(
        (path): path is string => typeof path === "string" && path.length > 0
      )
    : [];
  const activeFilePath =
    typeof candidate.activeFilePath === "string" &&
    openFilePaths.includes(candidate.activeFilePath)
      ? candidate.activeFilePath
      : openFilePaths[0];

  return activeFilePath === undefined
    ? {
        projectRoot,
        openFilePaths
      }
    : {
        projectRoot,
        openFilePaths,
        activeFilePath
      };
}

async function fetchExternalTemplateMainTex(sourceUrl: string): Promise<string> {
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "text/x-tex,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`Could not fetch external template (${response.status}).`);
  }

  const contents = await response.text();

  if (
    contents.length < 1_000 ||
    contents.length > 200_000 ||
    !contents.includes("\\documentclass") ||
    !contents.includes("IEEEtran")
  ) {
    throw new Error("Fetched template did not look like a valid IEEEtran source.");
  }

  return [
    "% Source: CTAN IEEEtran journal skeleton fetched by ZeroLeaf.",
    `% URL: ${sourceUrl}`,
    "",
    contents.trimEnd(),
    ""
  ].join("\n");
}

async function fetchApprovedAgentNetworkResource(
  resource: string,
  prompt: string
): Promise<AgentNetworkFetchResult> {
  const fetchedAt = new Date().toISOString();

  try {
    const doi = /\b10\.\d{4,9}\/[^\s`'"]+/iu.exec(`${resource} ${prompt}`)?.[0];
    const directUrl = /https?:\/\/[^\s`'"]+/iu.exec(`${resource} ${prompt}`)?.[0];

    if (doi !== undefined) {
      const normalizedDoi = doi.replace(/[),.;]+$/u, "");
      const bibtexUrl = `https://api.crossref.org/works/${encodeURIComponent(
        normalizedDoi
      )}/transform/application/x-bibtex`;
      return {
        fetched: true,
        resource,
        sourceUrl: `https://doi.org/${normalizedDoi}`,
        contentType: "application/x-bibtex",
        content: await fetchTextWithLimit(bibtexUrl, "application/x-bibtex"),
        fetchedAt
      };
    }

    if (directUrl !== undefined) {
      const sourceUrl = directUrl.replace(/[),.;]+$/u, "");
      const fetched = await fetchReadableText(sourceUrl);
      return {
        fetched: true,
        resource,
        sourceUrl,
        contentType: fetched.contentType,
        content: fetched.content,
        fetchedAt
      };
    }

    const searchResult = await fetchSearchContext(resource, prompt);
    return {
      fetched: true,
      resource,
      sourceUrl: searchResult.sourceUrl,
      contentType: searchResult.contentType,
      content: searchResult.content,
      fetchedAt
    };
  } catch (error) {
    return {
      fetched: false,
      resource,
      reason: getErrorMessage(error),
      fetchedAt
    };
  }
}

async function fetchSearchContext(
  resource: string,
  prompt: string
): Promise<{
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly content: string;
}> {
  const query = createAgentNetworkSearchQuery(resource, prompt);
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchTextWithLimit(searchUrl, "text/html");
  const results = extractDuckDuckGoResults(html).slice(0, 3);

  if (results.length === 0) {
    throw new Error(`No search results found for "${query}".`);
  }

  const fetchedPages = await Promise.all(
    results.map(async (result) => {
      try {
        const fetched = await fetchReadableText(result.url);
        return [
          `Result: ${result.title}`,
          `URL: ${result.url}`,
          "",
          fetched.content.slice(0, 24_000)
        ].join("\n");
      } catch (error) {
        return [
          `Result: ${result.title}`,
          `URL: ${result.url}`,
          `Fetch failed: ${getErrorMessage(error)}`
        ].join("\n");
      }
    })
  );

  return {
    sourceUrl: searchUrl,
    contentType: "text/plain",
    content: [
      `Search query: ${query}`,
      "",
      "Search results:",
      ...results.map(
        (result, index) => `${index + 1}. ${result.title} - ${result.url}`
      ),
      "",
      "Fetched result context:",
      ...fetchedPages
    ].join("\n\n")
  };
}

function createAgentNetworkSearchQuery(resource: string, prompt: string): string {
  const normalizedPrompt = prompt.replace(/\s+/gu, " ").trim();

  if (/progress in photovoltaics/iu.test(normalizedPrompt)) {
    return "Progress in Photovoltaics latex template author guidelines";
  }

  if (/template/iu.test(normalizedPrompt)) {
    return `${normalizedPrompt} latex template`;
  }

  return `${resource} ${normalizedPrompt}`.slice(0, 240);
}

async function fetchReadableText(
  sourceUrl: string
): Promise<{ readonly contentType: string; readonly content: string }> {
  const response = await fetchWithTimeout(
    sourceUrl,
    "text/html,text/plain,application/json,application/xml,*/*"
  );
  const contentType = response.headers.get("content-type") ?? "text/plain";
  const text = (await response.text()).slice(0, 120_000);
  const trimmed = text.trim();
  const readable =
    /<html|<body|<main|<article/iu.test(trimmed) || /<\/[a-z][\s\S]*>/iu.test(trimmed)
      ? stripHtmlToText(trimmed)
      : trimmed;

  return {
    contentType,
    content: readable.slice(0, 80_000)
  };
}

async function fetchTextWithLimit(sourceUrl: string, accept: string): Promise<string> {
  const response = await fetchWithTimeout(sourceUrl, accept);
  return (await response.text()).slice(0, 120_000);
}

async function fetchWithTimeout(sourceUrl: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept,
        "user-agent": `${appName}/0.0 (+https://local-first-latex-editor.invalid)`
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}.`);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function extractDuckDuckGoResults(
  html: string
): readonly { readonly title: string; readonly url: string }[] {
  const results: { title: string; url: string }[] = [];
  const resultPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;

  while ((match = resultPattern.exec(html)) !== null && results.length < 5) {
    const rawUrl = decodeHtmlEntities(match[1] ?? "");
    const title = stripHtmlToText(match[2] ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    const url = normalizeDuckDuckGoResultUrl(rawUrl);

    if (title.length > 0 && url.startsWith("http")) {
      results.push({ title, url });
    }
  }

  return results;
}

function normalizeDuckDuckGoResultUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ?? parsed.toString();
  } catch {
    return rawUrl;
  }
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#x2F;/giu, "/");
}

function handleIpc<TChannel extends IpcChannel>(
  channel: TChannel,
  handler: (
    event: IpcMainInvokeEvent,
    payload: IpcRequestMap[TChannel]
  ) => Promise<IpcResponseMap[TChannel]> | IpcResponseMap[TChannel]
) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    return handler(event, payload as IpcRequestMap[TChannel]);
  });
}

async function checkForAppUpdates(): Promise<AppUpdateCheckResult> {
  const checkedAt = new Date().toISOString();
  const currentVersion = app.getVersion();
  const manifestUrl = parseHttpUrl(await getConfiguredUpdateManifestUrl());

  if (manifestUrl === undefined) {
    return {
      checkedAt,
      currentVersion,
      state: "not-configured",
      message:
        "Update checks are not configured. Set ZEROLEAF_UPDATE_MANIFEST_URL for release builds."
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(manifestUrl, {
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Update manifest returned HTTP ${response.status}.`);
      }

      const manifest = parseUpdateManifest(await response.json());
      const updateAvailable =
        compareAppVersions(manifest.latestVersion, currentVersion) > 0;

      return {
        checkedAt,
        currentVersion,
        state: updateAvailable ? "available" : "current",
        message: updateAvailable
          ? (manifest.message ?? `Version ${manifest.latestVersion} is available.`)
          : `ZeroLeaf ${currentVersion} is up to date.`,
        latestVersion: manifest.latestVersion,
        downloadUrl: manifest.downloadUrl,
        ...(manifest.releaseNotesUrl === undefined
          ? {}
          : { releaseNotesUrl: manifest.releaseNotesUrl })
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      checkedAt,
      currentVersion,
      state: "error",
      message: `Update check failed: ${getErrorMessage(error)}`
    };
  }
}

async function getConfiguredUpdateManifestUrl(): Promise<string | undefined> {
  const environmentUrl = process.env["ZEROLEAF_UPDATE_MANIFEST_URL"]?.trim();
  if (environmentUrl !== undefined && environmentUrl.length > 0) {
    return environmentUrl;
  }

  try {
    const packageContents = await readFile(
      join(app.getAppPath(), "package.json"),
      "utf8"
    );
    const packageJson = JSON.parse(packageContents) as {
      readonly zeroLeaf?: {
        readonly updateManifestUrl?: unknown;
      };
    };
    const bundledUrl = packageJson.zeroLeaf?.updateManifestUrl;

    return typeof bundledUrl === "string" && bundledUrl.trim().length > 0
      ? bundledUrl.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseUpdateManifest(value: unknown): {
  readonly latestVersion: string;
  readonly downloadUrl: string;
  readonly releaseNotesUrl?: string;
  readonly message?: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Update manifest was not a JSON object.");
  }

  const candidate = value as {
    readonly latestVersion?: unknown;
    readonly downloadUrl?: unknown;
    readonly releaseNotesUrl?: unknown;
    readonly message?: unknown;
  };
  const latestVersion =
    typeof candidate.latestVersion === "string" ? candidate.latestVersion.trim() : "";
  const downloadUrl =
    typeof candidate.downloadUrl === "string" ? candidate.downloadUrl.trim() : "";
  const releaseNotesUrl =
    typeof candidate.releaseNotesUrl === "string"
      ? candidate.releaseNotesUrl.trim()
      : "";
  const message =
    typeof candidate.message === "string" && candidate.message.trim().length > 0
      ? candidate.message.trim()
      : undefined;

  if (latestVersion.length === 0) {
    throw new Error("Update manifest is missing latestVersion.");
  }

  if (parseHttpUrl(downloadUrl) === undefined) {
    throw new Error("Update manifest is missing a valid downloadUrl.");
  }

  if (releaseNotesUrl.length > 0 && parseHttpUrl(releaseNotesUrl) === undefined) {
    throw new Error("Update manifest has an invalid releaseNotesUrl.");
  }

  return {
    latestVersion,
    downloadUrl,
    ...(releaseNotesUrl.length === 0 ? {} : { releaseNotesUrl }),
    ...(message === undefined ? {} : { message })
  };
}

function parseHttpUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

async function installAppUpdateFromDmg(downloadUrlValue: string): Promise<{
  readonly scheduled: true;
  readonly installerPath: string;
  readonly targetAppPath: string;
  readonly message: string;
}> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic update installation is only available on macOS.");
  }

  const downloadUrl = parseHttpUrl(downloadUrlValue);
  if (downloadUrl === undefined) {
    throw new Error("Update download URL must be an http or https URL.");
  }

  if (!downloadUrl.pathname.toLowerCase().endsWith(".dmg")) {
    throw new Error("Automatic update installation expects a macOS DMG download.");
  }

  const updateRoot = await mkdtemp(join(tmpdir(), "zeroleaf-update-"));
  const dmgName = basename(downloadUrl.pathname) || "ZeroLeaf-update.dmg";
  const dmgPath = join(updateRoot, dmgName);
  const installerPath = join(updateRoot, "install-zeroleaf-update.sh");
  const targetAppPath = getCurrentAppBundlePath() ?? "/Applications/ZeroLeaf.app";

  await downloadUpdateAsset(downloadUrl, dmgPath);
  await writeFile(
    installerPath,
    createMacDmgInstallerScript({
      appName,
      dmgPath,
      targetAppPath,
      currentPid: process.pid
    }),
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(installerPath, 0o700);
  await spawnDetached("/bin/bash", [installerPath]);

  setTimeout(() => {
    activeProjectWatcher?.close();
    projectChangeDebouncer?.dispose();
    agentHostClient.stop();
    app.quit();
  }, 500);

  return {
    scheduled: true,
    installerPath,
    targetAppPath,
    message: `ZeroLeaf will quit, install the update into ${targetAppPath}, and relaunch.`
  };
}

async function downloadUpdateAsset(downloadUrl: URL, destinationPath: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(downloadUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/x-apple-diskimage,application/octet-stream,*/*",
        "user-agent": `${appName}/0.0 (+https://local-first-latex-editor.invalid)`
      }
    });

    if (!response.ok) {
      throw new Error(`Update download failed with HTTP ${response.status}.`);
    }

    if (response.body === null) {
      throw new Error("Update download returned an empty response.");
    }

    await writeFile(destinationPath, new Uint8Array(await response.arrayBuffer()));
  } finally {
    clearTimeout(timeout);
  }
}

function getCurrentAppBundlePath(): string | undefined {
  const marker = ".app/Contents/MacOS";
  const markerIndex = process.execPath.indexOf(marker);

  return markerIndex === -1
    ? undefined
    : process.execPath.slice(0, markerIndex + ".app".length);
}

function createMacDmgInstallerScript({
  appName: installAppName,
  dmgPath,
  targetAppPath,
  currentPid
}: {
  readonly appName: string;
  readonly dmgPath: string;
  readonly targetAppPath: string;
  readonly currentPid: number;
}): string {
  const targetDirectory = dirname(targetAppPath);

  return `#!/bin/bash
set -euo pipefail

APP_PID=${currentPid}
DMG_PATH=${shellQuote(dmgPath)}
TARGET_APP=${shellQuote(targetAppPath)}
TARGET_DIR=${shellQuote(targetDirectory)}
APP_NAME=${shellQuote(installAppName)}
LOG_PATH="\${TMPDIR:-/tmp}/zeroleaf-update-install.log"

exec >> "$LOG_PATH" 2>&1
echo "Starting $APP_NAME update install at $(date)"

for _ in {1..120}; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

MOUNT_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/zeroleaf-update-mount.XXXXXX")"
cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet || true
  rmdir "$MOUNT_DIR" || true
}
trap cleanup EXIT

hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR"
SOURCE_APP="$MOUNT_DIR/$APP_NAME.app"
if [ ! -d "$SOURCE_APP" ]; then
  SOURCE_APP="$(find "$MOUNT_DIR" -maxdepth 2 -name "*.app" -type d | head -n 1)"
fi
if [ -z "$SOURCE_APP" ] || [ ! -d "$SOURCE_APP" ]; then
  echo "No app bundle found in update DMG."
  exit 1
fi

mkdir -p "$TARGET_DIR"
rm -rf "$TARGET_APP"
ditto "$SOURCE_APP" "$TARGET_APP"
open "$TARGET_APP"
echo "Finished $APP_NAME update install at $(date)"
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function compareAppVersions(left: string, right: string): number {
  const leftVersion = parseAppVersion(left);
  const rightVersion = parseAppVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  if (leftVersion.preRelease === rightVersion.preRelease) {
    return 0;
  }

  if (leftVersion.preRelease === undefined) {
    return 1;
  }

  if (rightVersion.preRelease === undefined) {
    return -1;
  }

  return compareVersionIdentifiers(leftVersion.preRelease, rightVersion.preRelease);
}

function parseAppVersion(version: string): {
  readonly core: readonly [number, number, number];
  readonly preRelease?: readonly string[];
} {
  const normalized = version.trim().replace(/^v/iu, "");
  const [coreVersion = "", preReleaseAndBuild] = normalized.split("-", 2);
  const coreParts = coreVersion.split(".").map((part) => Number.parseInt(part, 10));
  const preRelease = preReleaseAndBuild?.split("+", 1)[0]?.split(".");

  return {
    core: [
      getVersionCorePart(coreParts, 0),
      getVersionCorePart(coreParts, 1),
      getVersionCorePart(coreParts, 2)
    ],
    ...(preRelease === undefined || preRelease.length === 0 ? {} : { preRelease })
  };
}

function getVersionCorePart(parts: readonly number[], index: number): number {
  const part = parts[index];
  return part === undefined || !Number.isFinite(part) ? 0 : part;
}

function compareVersionIdentifiers(
  leftIdentifiers: readonly string[],
  rightIdentifiers: readonly string[]
): number {
  const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftIdentifiers[index];
    const right = rightIdentifiers[index];

    if (left === undefined) {
      return -1;
    }

    if (right === undefined) {
      return 1;
    }

    if (left === right) {
      continue;
    }

    const leftNumber = /^\d+$/u.test(left) ? Number.parseInt(left, 10) : undefined;
    const rightNumber = /^\d+$/u.test(right) ? Number.parseInt(right, 10) : undefined;

    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }

    if (leftNumber !== undefined) {
      return -1;
    }

    if (rightNumber !== undefined) {
      return 1;
    }

    return left.localeCompare(right);
  }

  return 0;
}

function registerIpcHandlers() {
  handleIpc(ipcChannels.appGetInfo, () => ({
    appName,
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged
  }));

  handleIpc(ipcChannels.appCheckForUpdates, () => checkForAppUpdates());

  handleIpc(ipcChannels.appOpenUpdateDownload, async (_event, request) => {
    const downloadUrl = parseHttpUrl(request.url);
    if (downloadUrl === undefined) {
      throw new Error("Update download URL must be an http or https URL.");
    }

    await shell.openExternal(downloadUrl.toString());
    return { opened: true };
  });

  handleIpc(ipcChannels.appInstallUpdate, async (_event, request) =>
    installAppUpdateFromDmg(request.url)
  );

  handleIpc(ipcChannels.workbenchLoadLayout, () => readWorkbenchLayout());
  handleIpc(ipcChannels.workbenchSaveLayout, (_event, layout) =>
    writeWorkbenchLayout(layout)
  );

  handleIpc(ipcChannels.settingsLoad, () => readAppSettings());
  handleIpc(ipcChannels.settingsSave, (_event, settings) => writeAppSettings(settings));
  handleIpc(ipcChannels.settingsGetPrivacySummary, () => getPrivacySummary());
  handleIpc(ipcChannels.settingsClearLocalHistory, () => clearLocalHistory());

  handleIpc(ipcChannels.editorLoadProjectState, (_event, request) =>
    readEditorProjectState(request.projectRoot)
  );
  handleIpc(ipcChannels.editorSaveProjectState, (_event, state) =>
    writeEditorProjectState(state)
  );

  handleIpc(ipcChannels.projectGetState, async () => ({
    recentProjects: await getProjectMetadataStore().listRecentProjects()
  }));

  handleIpc(ipcChannels.projectOpen, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "Open LaTeX Project",
      properties: ["openDirectory", "createDirectory"]
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(dialogOptions)
        : await dialog.showOpenDialog(window, dialogOptions);

    if (result.canceled || result.filePaths[0] === undefined) {
      return undefined;
    }

    const project = await openProject(result.filePaths[0], getProjectMetadataStore());
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.projectOpenRecent, async (_event, request) => {
    const project = await openProject(request.rootPath, getProjectMetadataStore());
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.projectClearRecent, async () => ({
    recentProjects: await getProjectMetadataStore().clearRecentProjects()
  }));

  handleIpc(ipcChannels.projectRefresh, async (_event, request) => {
    return refreshProjectThroughActiveBackend(request.projectRoot);
  });

  handleIpc(ipcChannels.projectCreateEntry, async (_event, request) => {
    const sharedProject = getActiveSharedProject(request.projectRoot);

    if (sharedProject !== undefined) {
      const path = joinProjectEntryPath(request.parentPath, request.name);
      if (request.kind === "directory") {
        await requireSharedProjectClient().createDirectory(
          sharedProject.projectId,
          path
        );
      } else {
        await requireSharedProjectClient().createFile(
          sharedProject.projectId,
          path,
          ""
        );
      }
      return refreshProjectThroughActiveBackend(request.projectRoot);
    }

    await createProjectEntry(
      request.projectRoot,
      request.parentPath,
      request.name,
      request.kind
    );
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectRenameEntry, async (_event, request) => {
    const sharedProject = getActiveSharedProject(request.projectRoot);
    if (sharedProject !== undefined) {
      await requireSharedProjectClient().renameEntry(
        sharedProject.projectId,
        request.path,
        request.newName
      );
      return refreshProjectThroughActiveBackend(request.projectRoot);
    }
    await renameProjectEntry(request.projectRoot, request.path, request.newName);
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectMoveEntry, async (_event, request) => {
    const sharedProject = getActiveSharedProject(request.projectRoot);
    if (sharedProject !== undefined) {
      await requireSharedProjectClient().moveEntry(
        sharedProject.projectId,
        request.path,
        request.newPath
      );
      return refreshProjectThroughActiveBackend(request.projectRoot);
    }
    await moveProjectEntry(request.projectRoot, request.path, request.newPath);
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectDeleteEntry, async (_event, request) => {
    const sharedProject = getActiveSharedProject(request.projectRoot);
    if (sharedProject !== undefined) {
      const deletedPaths = await requireSharedProjectClient().deleteEntry(
        sharedProject.projectId,
        request.path
      );
      const result = await refreshProjectThroughActiveBackend(request.projectRoot);
      return {
        ...result,
        deletedEntry: {
          deletedPath: request.path,
          backupPath: `shared-project:${sharedProject.projectId}:${deletedPaths.join(
            ","
          )}`,
          deletedAt: new Date().toISOString()
        }
      };
    }
    const deletedEntry = await deleteProjectEntry(request.projectRoot, request.path);
    const result = await refreshProject(request.projectRoot, getProjectMetadataStore());
    return { ...result, deletedEntry };
  });

  handleIpc(ipcChannels.projectSetMainFile, async (_event, request) => {
    return setProjectMainFileThroughActiveBackend(request.projectRoot, request.path);
  });

  handleIpc(ipcChannels.sharedGetConnection, () => restoreSharedProjectConnection());

  handleIpc(ipcChannels.sharedSignIn, async (_event, request) => {
    const client = createSharedProjectClient({ baseUrl: request.baseUrl });
    const result = await client.signIn(request.email, request.name);
    sharedProjectClient = client;
    sharedProjectConnection = toSharedProjectConnection(request.baseUrl, result.user);
    await writePersistedSharedProjectSession({
      baseUrl: request.baseUrl,
      refreshToken: result.refreshToken,
      user: result.user
    });

    return sharedProjectConnection;
  });

  handleIpc(ipcChannels.sharedSignOut, async () => {
    const client = sharedProjectClient;
    await stopSharedRealtimeSession();
    clearSharedDocumentSessions();
    activeSharedProject = undefined;
    sharedProjectClient = undefined;
    sharedProjectConnection = { connected: false };
    await clearPersistedSharedProjectSession();

    try {
      await client?.signOut();
    } catch {
      // Local sign-out must still clear credentials if the remote session is stale.
    }

    return sharedProjectConnection;
  });

  handleIpc(ipcChannels.sharedListSessions, async () =>
    (await requireSharedProjectClient().listSessions()).map(
      toSharedProjectSessionSummary
    )
  );

  handleIpc(ipcChannels.sharedRevokeSession, async (_event, request) =>
    requireSharedProjectClient().revokeSession(request.sessionId)
  );

  handleIpc(ipcChannels.sharedListProjects, async () =>
    (await requireSharedProjectClient().listProjects()).map(toSharedProjectSummary)
  );

  handleIpc(ipcChannels.sharedCreateProject, async (_event, request) =>
    toSharedProjectSummary({
      ...(await requireSharedProjectClient().createProject(request)),
      role: "owner"
    })
  );

  handleIpc(ipcChannels.sharedUpdateProjectSettings, async (_event, request) => {
    const { projectId, ...settings } = request;
    const [project, projects] = await Promise.all([
      requireSharedProjectClient().updateProjectSettings(projectId, settings),
      requireSharedProjectClient().listProjects()
    ]);
    const role = projects.find((candidate) => candidate.id === projectId)?.role;
    return toSharedProjectSummary({
      ...project,
      ...(role === undefined ? {} : { role })
    });
  });

  handleIpc(ipcChannels.sharedCreateFromLocalProject, async (_event, request) => {
    const sourceFiles = await collectSharedProjectSourceFiles({
      projectRoot: request.projectRoot
    });

    if (sourceFiles.files.length === 0) {
      throw new Error("No shareable UTF-8 source files were found in this project.");
    }

    const localProject = await openProject(
      request.projectRoot,
      getProjectMetadataStore()
    );
    const mainFilePath =
      localProject.project.mainFilePath !== undefined &&
      sourceFiles.files.some((file) => file.path === localProject.project.mainFilePath)
        ? localProject.project.mainFilePath
        : undefined;
    const project = await requireSharedProjectClient().createProject({
      name: request.name,
      ...(mainFilePath === undefined ? {} : { mainFilePath }),
      directories: sourceFiles.directories,
      files: sourceFiles.files
    });

    return {
      project: toSharedProjectSummary({ ...project, role: "owner" }),
      importedFileCount: sourceFiles.files.length,
      importedDirectoryCount: sourceFiles.directories.length,
      skippedFilePaths: sourceFiles.skippedFilePaths
    };
  });

  handleIpc(ipcChannels.sharedCreateFromSourceZip, async (event, request) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const zipDialogOptions: OpenDialogOptions = {
      title: "Import ZIP as Shared Project",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archives", extensions: ["zip"] }]
    };
    const zipResult =
      window === null
        ? await dialog.showOpenDialog(zipDialogOptions)
        : await dialog.showOpenDialog(window, zipDialogOptions);

    if (zipResult.canceled || zipResult.filePaths[0] === undefined) {
      return undefined;
    }

    const requestedName = request.name?.trim();
    const tempParentPath = await mkdtemp(join(tmpdir(), "zeroleaf-shared-zip-"));
    try {
      const imported = await importProjectZip({
        zipPath: zipResult.filePaths[0],
        destinationParentPath: tempParentPath,
        ...(requestedName === undefined || requestedName.length === 0
          ? {}
          : { projectName: requestedName })
      });
      const sourceFiles = await collectSharedProjectSourceFiles({
        projectRoot: imported.projectRoot
      });

      if (sourceFiles.files.length === 0) {
        throw new Error("No shareable source files were found in this ZIP archive.");
      }

      const mainFilePath = await detectShareableMainFilePath(
        imported.projectRoot,
        sourceFiles.files
      );
      const project = await requireSharedProjectClient().createProject({
        name:
          requestedName === undefined || requestedName.length === 0
            ? basename(imported.projectRoot)
            : requestedName,
        ...(mainFilePath === undefined ? {} : { mainFilePath }),
        directories: sourceFiles.directories,
        files: sourceFiles.files
      });

      return {
        project: toSharedProjectSummary({ ...project, role: "owner" }),
        importedFileCount: sourceFiles.files.length,
        importedDirectoryCount: sourceFiles.directories.length,
        skippedFilePaths: sourceFiles.skippedFilePaths
      };
    } finally {
      await rm(tempParentPath, { recursive: true, force: true });
    }
  });

  handleIpc(ipcChannels.sharedDeleteProject, async (_event, request) => {
    const deletedProject = await requireSharedProjectClient().deleteProject(
      request.projectId
    );
    if (activeSharedProject?.projectId === request.projectId) {
      activeSharedProject = undefined;
      clearSharedDocumentSessions();
      await stopSharedRealtimeSession(request.projectId);
    }

    return toSharedProjectSummary({ ...deletedProject, role: "owner" });
  });

  handleIpc(ipcChannels.sharedExportSourceZip, async (event, request) => {
    const sourceExport = await requireSharedProjectClient().exportProjectSource(
      request.projectId
    );
    const window = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = join(
      app.getPath("downloads"),
      `${toSafeExportFileBaseName(sourceExport.project.name)}-shared-source.zip`
    );
    const dialogOptions = {
      title: "Export Shared Source ZIP",
      defaultPath,
      filters: [{ name: "ZIP Archives", extensions: ["zip"] }]
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(dialogOptions)
        : await dialog.showSaveDialog(window, dialogOptions);

    if (result.canceled || result.filePath === undefined) {
      return undefined;
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "zeroleaf-shared-export-"));
    try {
      await writeSharedProjectSourceExportFiles(
        tempRoot,
        sourceExport.files,
        sourceExport.directories
      );
      return await exportSourceZip({
        projectRoot: tempRoot,
        destinationPath: result.filePath,
        includeBuildArtifacts: false
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  handleIpc(ipcChannels.sharedOpenProject, async (_event, request) => {
    const client = requireSharedProjectClient();
    const [materialized, sharedProject, sharedProjects] = await Promise.all([
      getSharedProjectCache().materializeProject(client, request.projectId),
      client.getProject(request.projectId),
      client.listProjects()
    ]);
    const role =
      sharedProjects.find((project) => project.id === request.projectId)?.role ??
      "viewer";
    if (sharedProject.mainFilePath !== undefined) {
      await setProjectMainFile(
        materialized.workingPath,
        getProjectMetadataStore(),
        sharedProject.mainFilePath
      );
    }
    const project = await openProject(
      materialized.workingPath,
      getProjectMetadataStore()
    );
    activeSharedProject = {
      projectId: request.projectId,
      localCachePath: materialized.workingPath
    };
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);

    return {
      ...project,
      sharedProjectId: request.projectId,
      localCachePath: materialized.workingPath,
      role,
      ...(sharedProject.compiler === undefined
        ? {}
        : { compiler: sharedProject.compiler })
    };
  });

  handleIpc(ipcChannels.sharedStartRealtime, async (_event, request) =>
    startSharedRealtimeSession(request.projectId)
  );

  handleIpc(ipcChannels.sharedStopRealtime, async (_event, request) =>
    stopSharedRealtimeSession(request.projectId)
  );

  handleIpc(ipcChannels.sharedInvite, async (_event, request) =>
    toSharedProjectInvitationSummary(
      await requireSharedProjectClient().invite(
        request.projectId,
        request.email,
        request.role
      )
    )
  );

  handleIpc(ipcChannels.sharedAcceptInvitation, async (_event, request) =>
    toSharedProjectMemberSummary(
      await requireSharedProjectClient().acceptInvitation(request.invitationId)
    )
  );

  handleIpc(ipcChannels.sharedListMembers, async (_event, request) =>
    (await requireSharedProjectClient().listMembers(request.projectId)).map(
      toSharedProjectMemberSummary
    )
  );

  handleIpc(ipcChannels.sharedUpdateMemberRole, async (_event, request) =>
    toSharedProjectMemberSummary(
      await requireSharedProjectClient().updateMemberRole(
        request.projectId,
        request.userId,
        request.role
      )
    )
  );

  handleIpc(ipcChannels.sharedTransferOwnership, async (_event, request) =>
    (
      await requireSharedProjectClient().transferOwnership(
        request.projectId,
        request.userId
      )
    ).map(toSharedProjectMemberSummary)
  );

  handleIpc(ipcChannels.sharedRemoveMember, async (_event, request) =>
    toSharedProjectMemberSummary(
      await requireSharedProjectClient().removeMember(request.projectId, request.userId)
    )
  );

  handleIpc(ipcChannels.sharedListPresence, async (_event, request) =>
    (await requireSharedProjectClient().listPresence(request.projectId)).map(
      toSharedProjectPresenceSummary
    )
  );

  handleIpc(ipcChannels.sharedUpdatePresence, async (_event, request) =>
    toSharedProjectPresenceSummary(
      await requireSharedProjectClient().updatePresence(request.projectId, {
        ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
        ...(request.cursorLine === undefined ? {} : { cursorLine: request.cursorLine }),
        ...(request.cursorColumn === undefined
          ? {}
          : { cursorColumn: request.cursorColumn })
      })
    )
  );

  handleIpc(ipcChannels.sharedListActivity, async (_event, request) =>
    (await requireSharedProjectClient().listActivity(request.projectId))
      .map(toSharedProjectActivitySummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  );

  handleIpc(ipcChannels.sharedListComments, async (_event, request) =>
    (await requireSharedProjectClient().listComments(request.projectId))
      .map(toSharedProjectCommentSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );

  handleIpc(ipcChannels.sharedCreateComment, async (_event, request) =>
    toSharedProjectCommentSummary(
      await requireSharedProjectClient().createComment(request.projectId, {
        body: request.body,
        ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
        ...(request.line === undefined ? {} : { line: request.line })
      })
    )
  );

  handleIpc(ipcChannels.sharedResolveComment, async (_event, request) =>
    toSharedProjectCommentSummary(
      await requireSharedProjectClient().resolveComment(
        request.projectId,
        request.commentId
      )
    )
  );

  handleIpc(ipcChannels.sharedListAuditEvents, async (_event, request) =>
    (await requireSharedProjectClient().listAuditEvents(request.projectId))
      .map(toSharedProjectAuditEventSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  );

  handleIpc(ipcChannels.sharedPublishAgentRun, async (_event, request) => {
    const client = requireSharedProjectClient();
    const agentRun =
      request.agentRunId === undefined
        ? await client.createAgentRun(request.projectId, {
            providerId: request.providerId,
            mode: request.mode,
            prompt: request.prompt,
            status: request.status,
            ...(request.buildArtifactIds === undefined
              ? {}
              : { buildArtifactIds: request.buildArtifactIds })
          })
        : await client.updateAgentRunStatus(request.projectId, request.agentRunId, {
            status: "running"
          });
    const history = getHistoryStore();

    try {
      const changesets = [];
      for (const localChangeSetId of request.changesetIds) {
        const localChangeSet = history.getChangeSetWithContents(localChangeSetId);
        const beforeRevisionId = await getSharedProjectCache().getCachedRevisionId(
          request.projectId,
          localChangeSet.filePath
        );
        const sharedChangeSet = await client.createChangeSet(request.projectId, {
          agentRunId: agentRun.id,
          filePath: localChangeSet.filePath,
          ...(beforeRevisionId === undefined ? {} : { beforeRevisionId }),
          beforeContents: localChangeSet.beforeContents,
          afterContents: localChangeSet.afterContents,
          summary: localChangeSet.summary
        });

        changesets.push({
          ...toSharedProjectAgentChangeSetSummary(sharedChangeSet),
          localChangeSetId
        });
      }

      let updatedAgentRun = agentRun;
      if (request.agentRunId !== undefined) {
        for (const artifactId of request.buildArtifactIds ?? []) {
          updatedAgentRun = await client.attachBuildArtifactToAgentRun(
            request.projectId,
            request.agentRunId,
            { artifactId }
          );
        }

        updatedAgentRun = await client.updateAgentRunStatus(
          request.projectId,
          request.agentRunId,
          {
            status:
              request.changesetIds.length === 0 ? request.status : "waiting-for-review"
          }
        );
      }

      return {
        agentRun: toSharedProjectAgentRunSummary(updatedAgentRun),
        changesets
      };
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.sharedUpdateAgentRunStatus, async (_event, request) =>
    toSharedProjectAgentRunSummary(
      await requireSharedProjectClient().updateAgentRunStatus(
        request.projectId,
        request.agentRunId,
        { status: request.status }
      )
    )
  );

  handleIpc(ipcChannels.sharedListAgentRuns, async (_event, request) =>
    (await requireSharedProjectClient().listAgentRuns(request.projectId))
      .map(toSharedProjectAgentRunSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );

  handleIpc(ipcChannels.sharedListAgentChangeSets, async (_event, request) =>
    (await requireSharedProjectClient().listChangeSets(request.projectId))
      .map(toSharedProjectAgentChangeSetSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );

  handleIpc(ipcChannels.sharedApplyAgentChangeSet, async (_event, request) => {
    const client = requireSharedProjectClient();
    const changeset = await client.applyChangeSet(
      request.projectId,
      request.changesetId
    );
    const revision = await client.readFile(request.projectId, changeset.filePath);
    const fileRevision = await writeSharedDocumentRevisionToActiveCache({
      revision: {
        projectId: revision.projectId,
        path: revision.path,
        contents: revision.contents,
        id: revision.id
      }
    });

    return {
      changeset: toSharedProjectAgentChangeSetSummary(changeset),
      fileRevision
    };
  });

  handleIpc(ipcChannels.sharedRejectAgentChangeSet, async (_event, request) =>
    toSharedProjectAgentChangeSetSummary(
      await requireSharedProjectClient().rejectChangeSet(
        request.projectId,
        request.changesetId
      )
    )
  );

  handleIpc(ipcChannels.sharedListBuildArtifacts, async (_event, request) =>
    (await requireSharedProjectClient().listBuildArtifacts(request.projectId))
      .map(toSharedProjectBuildArtifactSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  );

  handleIpc(ipcChannels.sharedGetBuildArtifact, async (_event, request) =>
    toSharedProjectBuildArtifactDetails(
      await requireSharedProjectClient().getBuildArtifact(
        request.projectId,
        request.artifactId
      )
    )
  );

  handleIpc(ipcChannels.sharedPublishBuildArtifact, async (_event, request) => {
    if (request.buildResult.status === "running") {
      throw new Error("Cannot publish a running build artifact.");
    }

    const client = requireSharedProjectClient();
    const sourceRevisionId =
      request.sourceRevisionId ??
      (await client.readFile(request.projectId, request.mainFilePath)).id;
    const toolchain = await detectLatexToolchain();
    const pdfBase64 =
      request.buildResult.status === "succeeded" &&
      request.buildResult.artifact !== undefined
        ? await readOptionalBuildPdfBase64(
            request.projectRoot,
            request.buildResult.artifact.pdfPath
          )
        : undefined;
    const artifact = await client.uploadBuildArtifact(request.projectId, {
      sourceRevisionId,
      desktopClientId: await getSharedDesktopClientId(),
      compiler: request.buildResult.compiler,
      ...(toolchain.compilerVersions?.[request.buildResult.compiler] === undefined
        ? {}
        : {
            engineVersion: toolchain.compilerVersions[request.buildResult.compiler]
          }),
      ...(toolchain.latexmkVersion === undefined
        ? {}
        : { latexmkVersion: toolchain.latexmkVersion }),
      status: request.buildResult.status,
      platform: process.platform,
      rawLog: request.buildResult.rawLog,
      diagnostics: request.buildResult.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line })
      })),
      ...(pdfBase64 === undefined
        ? {}
        : {
            pdfBase64,
            pdfByteLength: Buffer.byteLength(pdfBase64, "base64")
          })
    });

    return toSharedProjectBuildArtifactSummary(artifact);
  });

  handleIpc(ipcChannels.sharedAttachAgentRunBuildArtifact, async (_event, request) =>
    toSharedProjectAgentRunSummary(
      await requireSharedProjectClient().attachBuildArtifactToAgentRun(
        request.projectId,
        request.agentRunId,
        { artifactId: request.artifactId }
      )
    )
  );

  handleIpc(ipcChannels.sharedGetFileRevision, async (_event, request) => {
    const revision = await requireSharedProjectClient().readFile(
      request.projectId,
      request.path
    );

    return {
      projectId: revision.projectId,
      path: revision.path,
      revisionId: revision.id
    };
  });

  handleIpc(ipcChannels.sharedListFileRevisions, async (_event, request) =>
    requireSharedProjectClient().listFileRevisions(request.projectId, request.path)
  );

  handleIpc(ipcChannels.sharedGetFileRevisionDetails, async (_event, request) =>
    toSharedProjectFileRevisionDetails(
      await requireSharedProjectClient().getFileRevision(
        request.projectId,
        request.revisionId
      )
    )
  );

  handleIpc(ipcChannels.sharedRestoreFileRevision, async (_event, request) => {
    const revision = await requireSharedProjectClient().restoreFileRevision(
      request.projectId,
      request.revisionId
    );

    return writeSharedDocumentRevisionToActiveCache({
      revision: {
        projectId: revision.projectId,
        path: revision.path,
        contents: revision.contents,
        id: revision.id
      }
    });
  });

  handleIpc(ipcChannels.sharedSyncDocumentContents, async (_event, request) => {
    const cache = getSharedProjectCache();
    const result = await requireSharedProjectClient().replaceDocumentContents(
      request.projectId,
      request.path,
      request.contents,
      await cache.getCachedRevisionId(request.projectId, request.path)
    );
    sharedDocumentSessions.delete(
      getSharedDocumentSessionKey(request.projectId, request.path)
    );

    return writeSharedDocumentRevisionToActiveCache(result);
  });

  handleIpc(ipcChannels.sharedApplyDocumentTextOperations, async (_event, request) => {
    const session = await getSharedDocumentSession(request.projectId, request.path);
    const result = await session.applyTextOperations(
      request.operations,
      request.clientOperationId
    );

    return writeSharedDocumentRevisionToActiveCache(result);
  });

  handleIpc(ipcChannels.sharedPullDocumentContents, async (_event, request) => {
    const session = await getSharedDocumentSession(request.projectId, request.path);
    const beforeContents = session.contents;
    const feed = await session.pullRemoteUpdates(request.afterUpdateId);
    const remoteTextOperations = createRemoteTextOperations(
      beforeContents,
      session.contents
    );
    const state = feed.state;
    const revision =
      state.revisionId === undefined
        ? await requireSharedProjectClient().writeFile(
            request.projectId,
            request.path,
            session.contents
          )
        : await requireSharedProjectClient().readFile(request.projectId, request.path);

    return writeSharedDocumentRevisionToActiveCache({
      revision: {
        projectId: revision.projectId,
        path: revision.path,
        contents: session.contents,
        id: revision.id
      },
      ...(session.updateCursor === undefined
        ? {}
        : { update: { id: session.updateCursor } }),
      remoteUpdateCount: feed.updates.length,
      remoteTextOperations
    });
  });

  handleIpc(ipcChannels.fileRead, (_event, request) =>
    readProjectFile(request.projectRoot, request.path)
  );

  handleIpc(ipcChannels.fileWrite, (_event, request) =>
    writeProjectFileThroughActiveBackend(
      request.projectRoot,
      request.path,
      request.contents
    )
  );

  handleIpc(ipcChannels.wordRead, (_event, request) =>
    readWordDocument(request.projectRoot, request.path)
  );

  handleIpc(ipcChannels.wordSave, (_event, request) =>
    saveWordDocument(request.projectRoot, request.path, request.blocks)
  );

  handleIpc(ipcChannels.wordCreateChangeSet, async (_event, request) => {
    const changeset = await createWordChangeSet({
      projectRoot: request.projectRoot,
      filePath: request.filePath,
      baseBlocks: request.baseBlocks,
      operations: request.operations,
      summary: request.summary
    });
    const history = getHistoryStore();
    try {
      return await history.createWordChangeSet(changeset);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.wordApplyChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      const persistedChangeSet = await history.createWordChangeSet(request.changeset);
      const beforeSnapshot = await history.createWordDocumentSnapshot(
        persistedChangeSet.projectRoot,
        persistedChangeSet.filePath
      );
      const result = await applyWordChangeSet(persistedChangeSet);
      const appliedChangeSet = await history.markWordChangeSetApplied(
        result.changeset,
        beforeSnapshot.id
      );
      return {
        ...result,
        changeset: appliedChangeSet
      };
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.wordRollbackChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      const changeset = await history.rollbackWordChangeSet(request.changesetId);
      return {
        changeset,
        document: await readWordDocument(changeset.projectRoot, changeset.filePath)
      };
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.onlyOfficeGetStatus, async () => {
    await configureOnlyOfficeBridge();
    return onlyOfficeBridge.getStatus();
  });

  handleIpc(ipcChannels.onlyOfficeCreateSession, async (_event, request) => {
    await configureOnlyOfficeBridge();
    return onlyOfficeBridge.createEditorSession(request);
  });

  handleIpc(ipcChannels.onlyOfficeForceSave, async (_event, request) => {
    await configureOnlyOfficeBridge();
    return onlyOfficeBridge.forceSave(request.sessionId);
  });

  handleIpc(ipcChannels.onlyOfficeExportPdf, async (_event, request) => {
    await configureOnlyOfficeBridge();
    return onlyOfficeBridge.exportPdf(request.sessionId);
  });

  handleIpc(ipcChannels.buildDetectToolchain, () => detectLatexToolchain());

  handleIpc(ipcChannels.buildRun, (_event, request) => runLatexBuild(request));

  handleIpc(ipcChannels.buildStop, (_event, request) => ({
    stopped: stopLatexBuild(request.jobId)
  }));

  handleIpc(ipcChannels.pdfReadArtifact, (_event, request) =>
    readPdfArtifact(request.projectRoot, request.pdfPath)
  );

  handleIpc(ipcChannels.pdfReportPreviewBounds, (event, request) => {
    pdfPreviewCaptureStore.report(event.sender.id, request);
    return { reported: true };
  });

  handleIpc(ipcChannels.synctexForward, (_event, request) =>
    runSyncTexForward(request)
  );

  handleIpc(ipcChannels.synctexReverse, (_event, request) =>
    runSyncTexReverse(request)
  );

  handleIpc(ipcChannels.historyListChangeSets, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.listChangeSets(request.projectRoot);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historySnapshotFile, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.snapshotFile(request);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyCreateChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.createChangeSet(request);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyCreateAppliedChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.createAppliedChangeSet(request);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyApplyChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      const changeset = await history.applyChangeSet(request.changesetId);
      await syncHistoryChangeSetToActiveSharedBackend(history, changeset.id);
      return changeset;
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyApplyChangeSetHunks, async (_event, request) => {
    const history = getHistoryStore();
    try {
      const changeset = await history.applyChangeSetHunks(request);
      await syncHistoryChangeSetToActiveSharedBackend(history, changeset.id);
      return changeset;
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyRejectChangeSet, (_event, request) => {
    const history = getHistoryStore();
    try {
      return history.rejectChangeSet(request.changesetId);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyRollbackChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.rollbackChangeSet(request.changesetId);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyListWordChangeSets, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.listWordChangeSets(request.projectRoot);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyCreateWordChangeSet, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.createWordChangeSet(request.changeset);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyMarkWordChangeSetApplied, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.markWordChangeSetApplied(request.changeset);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyRejectWordChangeSet, (_event, request) => {
    const history = getHistoryStore();
    try {
      return history.rejectWordChangeSet(request.changesetId);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyListAuditEvents, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.listAuditEvents(request.projectRoot);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.referencesAnalyze, async (_event, request) => {
    return await analyzeProjectReferences(request.projectRoot);
  });

  handleIpc(ipcChannels.referencesSearch, async (_event, request) => {
    return await searchProjectReferences(request.projectRoot, request.query);
  });

  handleIpc(ipcChannels.referencesRemoveUnused, async (_event, request) => {
    return await removeUnusedReferenceEntry(request.projectRoot, {
      filePath: request.filePath,
      key: request.key
    });
  });

  handleIpc(ipcChannels.lifecycleListTemplates, () => projectTemplates);

  handleIpc(ipcChannels.lifecycleExportSourceZip, async (event, request) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = join(
      app.getPath("downloads"),
      `${basename(request.projectRoot)}-source.zip`
    );
    const dialogOptions = {
      title: "Export Source ZIP",
      defaultPath,
      filters: [{ name: "ZIP Archives", extensions: ["zip"] }]
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(dialogOptions)
        : await dialog.showSaveDialog(window, dialogOptions);

    if (result.canceled || result.filePath === undefined) {
      return undefined;
    }

    return await exportSourceZip({
      projectRoot: request.projectRoot,
      destinationPath: result.filePath,
      ...(request.includeBuildArtifacts === undefined
        ? {}
        : { includeBuildArtifacts: request.includeBuildArtifacts })
    });
  });

  handleIpc(ipcChannels.lifecycleExportPdf, async (event, request) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = join(app.getPath("downloads"), basename(request.pdfPath));
    const dialogOptions = {
      title: "Export PDF",
      defaultPath,
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }]
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(dialogOptions)
        : await dialog.showSaveDialog(window, dialogOptions);

    if (result.canceled || result.filePath === undefined) {
      return undefined;
    }

    const exportResult = await exportLifecyclePdf({
      pdfPath: request.pdfPath,
      destinationPath: result.filePath
    });
    const viewerOpenError = await shell.openPath(exportResult.destinationPath);

    return viewerOpenError.length === 0
      ? { ...exportResult, openedInViewer: true }
      : {
          ...exportResult,
          openedInViewer: false,
          viewerOpenError
        };
  });

  handleIpc(ipcChannels.lifecycleImportSourceZip, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const zipDialogOptions: OpenDialogOptions = {
      title: "Import Source ZIP",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archives", extensions: ["zip"] }]
    };
    const destinationDialogOptions: OpenDialogOptions = {
      title: "Choose Import Destination",
      properties: ["openDirectory", "createDirectory"]
    };
    const zipResult =
      window === null
        ? await dialog.showOpenDialog(zipDialogOptions)
        : await dialog.showOpenDialog(window, zipDialogOptions);

    if (zipResult.canceled || zipResult.filePaths[0] === undefined) {
      return undefined;
    }

    const destinationResult =
      window === null
        ? await dialog.showOpenDialog(destinationDialogOptions)
        : await dialog.showOpenDialog(window, destinationDialogOptions);

    if (destinationResult.canceled || destinationResult.filePaths[0] === undefined) {
      return undefined;
    }

    const importedProject = await importProjectZip({
      zipPath: zipResult.filePaths[0],
      destinationParentPath: destinationResult.filePaths[0],
      projectName: basename(zipResult.filePaths[0], extname(zipResult.filePaths[0]))
    });
    const project = await openProject(
      importedProject.projectRoot,
      getProjectMetadataStore()
    );
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.lifecycleCreateForAgent, async (event, request) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "Choose Project Location",
      properties: ["openDirectory", "createDirectory"]
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(dialogOptions)
        : await dialog.showOpenDialog(window, dialogOptions);

    if (result.canceled || result.filePaths[0] === undefined) {
      return undefined;
    }

    const createdProject = await createEmptyProject({
      projectName: request.projectName,
      destinationParentPath: result.filePaths[0]
    });
    const project = await openProject(
      createdProject.projectRoot,
      getProjectMetadataStore()
    );
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.lifecycleCreateFromTemplate, async (event, request) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "Choose Project Location",
      properties: ["openDirectory", "createDirectory"]
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(dialogOptions)
        : await dialog.showOpenDialog(window, dialogOptions);

    if (result.canceled || result.filePaths[0] === undefined) {
      return undefined;
    }

    const createdProject = await createProjectFromTemplate({
      templateId: request.templateId,
      projectName: request.projectName,
      destinationParentPath: result.filePaths[0]
    });
    const project = await openProject(
      createdProject.projectRoot,
      getProjectMetadataStore()
    );
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.lifecycleCreateFromExternalTemplate, async (event, request) => {
    const template = externalProjectTemplates[request.templateId];
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "Choose Project Location",
      properties: ["openDirectory", "createDirectory"]
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(dialogOptions)
        : await dialog.showOpenDialog(window, dialogOptions);

    if (result.canceled || result.filePaths[0] === undefined) {
      return undefined;
    }

    const createdProject = await createProjectFromTemplate({
      templateId: template.baseTemplateId,
      projectName: request.projectName,
      destinationParentPath: result.filePaths[0]
    });
    const templateContents = await fetchExternalTemplateMainTex(template.sourceUrl);

    await writeProjectFile(
      createdProject.projectRoot,
      template.mainFilePath,
      templateContents
    );
    const project = await openProject(
      createdProject.projectRoot,
      getProjectMetadataStore()
    );
    activeSharedProject = undefined;
    clearSharedDocumentSessions();
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.lifecycleCheckSubmission, async (_event, request) => {
    return await checkSubmissionBundle(request.projectRoot, request.mainFilePath);
  });

  handleIpc(ipcChannels.agentGetAuthStatus, async (_event, request) => {
    if (!isKnownAgentProviderId(request.providerId)) {
      throw new Error("Unknown agent provider.");
    }

    return await agentHostClient.getAuthStatus(request.providerId);
  });

  handleIpc(ipcChannels.agentOpenProviderSetupTerminal, async (_event, request) => {
    if (
      request.providerId !== "openai-codex" &&
      request.providerId !== "anthropic-claude"
    ) {
      throw new Error("This provider does not need CLI setup.");
    }

    const command = getProviderSetupCommand(
      request.providerId,
      request.action,
      process.platform
    );
    await openSetupTerminal(command, process.platform);

    return {
      opened: true,
      command,
      providerId: request.providerId,
      action: request.action
    };
  });

  handleIpc(ipcChannels.agentStart, async (_event, request) => {
    if (!isKnownAgentProviderId(request.providerId)) {
      throw new Error("Unknown agent provider.");
    }
    assertAgentProjectContextMatchesActiveProject(request);

    await recordAgentAudit(
      request.projectRoot,
      "agent.session.started",
      `Started ${request.providerId} in ${request.mode}`
    );
    const result = await agentHostClient.startSession(request);
    await recordAgentEvents(request.projectRoot, result.events, result.changeset?.id);
    return result;
  });

  handleIpc(ipcChannels.agentRespondApproval, async (_event, request) => {
    const result = await agentHostClient.respondApproval(request);

    if (result.events[0] !== undefined) {
      await recordAgentEvents(
        result.changeset?.projectRoot ?? activeProjectRoot ?? "",
        result.events,
        result.changeset?.id
      );
    }

    return result;
  });

  handleIpc(ipcChannels.agentCancel, async (_event, request) => ({
    cancelled: (await agentHostClient.cancelSession(request.sessionId)).cancelled
  }));
}

async function handleAgentHostToolRequest(message: AgentHostToolRequestMessage) {
  const projectRoot = message.context.projectRoot;
  const approved = "approved" in message.payload && message.payload.approved === true;

  if (!isAgentToolAllowed(message.context.mode, message.toolName, approved)) {
    await recordAgentAudit(
      projectRoot,
      "agent.tool.blocked",
      `${message.toolName} blocked in ${message.context.mode}`
    );
    throw new Error(`${message.toolName} is blocked in ${message.context.mode}.`);
  }

  await recordAgentAudit(
    projectRoot,
    "agent.tool.started",
    `${message.toolName} (${getAgentToolRisk(message.toolName)} risk)`
  );

  try {
    switch (message.toolName) {
      case "read-file": {
        const payload = message.payload as AgentToolRequestPayloadMap["read-file"];
        return await readProjectFileThroughActiveBackend(projectRoot, payload.path);
      }
      case "search-project": {
        const payload = message.payload as AgentToolRequestPayloadMap["search-project"];
        return await searchProjectFiles(projectRoot, payload.query);
      }
      case "capture-pdf-preview":
        return await pdfPreviewCaptureStore.capture(projectRoot);
      case "delete-entry": {
        const payload = message.payload as AgentToolRequestPayloadMap["delete-entry"];
        const deletedEntry = await deleteProjectEntryThroughActiveBackend(
          projectRoot,
          payload.path
        );
        if (activeProjectRoot === projectRoot) {
          await refreshProjectThroughActiveBackend(projectRoot);
        }
        return { path: deletedEntry.deletedPath };
      }
      case "move-entry": {
        const payload = message.payload as AgentToolRequestPayloadMap["move-entry"];
        await moveProjectEntryThroughActiveBackend(
          projectRoot,
          payload.fromPath,
          payload.toPath
        );
        if (activeProjectRoot === projectRoot) {
          await refreshProjectThroughActiveBackend(projectRoot);
        }
        return {
          fromPath: payload.fromPath,
          toPath: payload.toPath
        };
      }
      case "set-main-file": {
        const payload = message.payload as AgentToolRequestPayloadMap["set-main-file"];
        const result = await setProjectMainFileThroughActiveBackend(
          projectRoot,
          payload.path
        );
        return { path: result.project.mainFilePath ?? payload.path };
      }
      case "network-fetch": {
        const payload = message.payload as AgentToolRequestPayloadMap["network-fetch"];
        return await fetchApprovedAgentNetworkResource(
          payload.resource,
          payload.prompt
        );
      }
      case "codex-exec":
        throw new Error("Codex execution is provider-local, not an app tool.");
      case "claude-code":
        throw new Error("Claude Code execution is provider-local, not an app tool.");
      case "propose-patch": {
        const payload = message.payload as AgentToolRequestPayloadMap["propose-patch"];
        const history = getHistoryStore();
        try {
          return await history.createChangeSet({
            projectRoot,
            filePath: payload.filePath,
            beforeContents: payload.beforeContents,
            afterContents: payload.afterContents,
            summary: payload.summary
          });
        } finally {
          history.close();
        }
      }
      case "reject-patch": {
        const payload = message.payload as AgentToolRequestPayloadMap["reject-patch"];
        const history = getHistoryStore();
        try {
          return history.rejectChangeSet(payload.changesetId);
        } finally {
          history.close();
        }
      }
      case "apply-patch": {
        const payload = message.payload as AgentToolRequestPayloadMap["apply-patch"];
        const history = getHistoryStore();
        try {
          const changeset = await history.applyChangeSet(payload.changesetId);
          await syncHistoryChangeSetToActiveSharedBackend(history, changeset.id);
          return changeset;
        } finally {
          history.close();
        }
      }
      case "run-compile": {
        const mainFilePath =
          message.context.mainFilePath ??
          (await detectAgentCompileMainFile(projectRoot));

        if (mainFilePath === undefined) {
          throw new Error("Choose a main .tex file before compiling.");
        }

        return await runLatexBuild({
          projectRoot,
          mainFilePath,
          compiler: message.context.compiler ?? "pdflatex"
        });
      }
    }
  } catch (error) {
    await recordAgentAudit(projectRoot, "agent.tool.failed", getErrorMessage(error));
    throw error;
  }
}

async function detectAgentCompileMainFile(
  projectRoot: string
): Promise<string | undefined> {
  const refreshed = await refreshProjectThroughActiveBackend(projectRoot);

  return refreshed.project.mainFilePath;
}

async function searchProjectFiles(projectRoot: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const sharedProject = getActiveSharedProject(projectRoot);
  const tree =
    sharedProject === undefined
      ? await listProjectTree(projectRoot)
      : await requireSharedProjectClient().getTree(sharedProject.projectId);
  const searchableFiles = flattenProjectTree(tree)
    .filter((node) => node.kind === "file")
    .filter((node) => /\.(bib|cls|sty|tex)$/u.test(node.path))
    .slice(0, 200);
  const snapshots = await Promise.all(
    searchableFiles.map((node) =>
      readProjectFileThroughActiveBackend(projectRoot, node.path)
    )
  );

  return snapshots
    .filter(
      (snapshot) =>
        snapshot.path.toLowerCase().includes(normalizedQuery) ||
        snapshot.contents.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, 50);
}

function getProviderSetupCommand(
  providerId: Exclude<AgentProviderId, "mock" | "openrouter-design">,
  action: AgentProviderSetupAction,
  platform: NodeJS.Platform
): string {
  if (action === "login") {
    return providerId === "openai-codex" ? "codex login" : "claude";
  }

  if (providerId === "openai-codex") {
    return platform === "win32"
      ? "irm https://chatgpt.com/codex/install.ps1 | iex"
      : "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
  }

  return platform === "win32"
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash";
}

function isKnownAgentProviderId(providerId: AgentProviderId): boolean {
  return agentProviderIds.includes(providerId);
}

async function openSetupTerminal(
  command: string,
  platform: NodeJS.Platform
): Promise<void> {
  if (platform === "darwin") {
    await spawnDetached("osascript", [
      "-e",
      `tell application "Terminal" to do script "${escapeAppleScriptString(command)}"`,
      "-e",
      'tell application "Terminal" to activate'
    ]);
    return;
  }

  if (platform === "win32") {
    await spawnDetached("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',${quotePowerShellString(command)}`
    ]);
    return;
  }

  const wrappedCommand = `${command}; printf '\\nSetup command finished. You can close this window.\\n'; exec bash`;
  const terminals: readonly (readonly string[])[] = [
    ["x-terminal-emulator", "-e", "bash", "-lc", wrappedCommand],
    ["gnome-terminal", "--", "bash", "-lc", wrappedCommand],
    ["konsole", "-e", "bash", "-lc", wrappedCommand],
    ["xterm", "-e", "bash", "-lc", wrappedCommand]
  ];
  const failures: string[] = [];

  for (const terminalArgs of terminals) {
    const [terminal, ...args] = terminalArgs;

    if (terminal === undefined) {
      continue;
    }

    try {
      await spawnDetached(terminal, args);
      return;
    } catch (error) {
      failures.push(getErrorMessage(error));
    }
  }

  throw new Error(
    `Could not open a terminal window. Run this command manually: ${command}. ${failures.join(" ")}`
  );
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

async function recordAgentEvents(
  projectRoot: string,
  events: readonly AgentEvent[],
  changesetId: string | undefined
) {
  if (projectRoot.length === 0) {
    return;
  }

  const settings = await readAppSettings();
  const storableEvents = settings.privacy.storeAgentTranscripts
    ? events
    : events.filter((event) => event.type !== "message");

  await Promise.all(
    storableEvents.map((event) =>
      recordAgentAudit(
        projectRoot,
        `agent.${event.type}`,
        summarizeAgentEvent(event),
        changesetId
      )
    )
  );
}

async function recordAgentAudit(
  projectRoot: string,
  eventType: string,
  message: string,
  changesetId?: string
) {
  const sharedProject = getActiveSharedProject(projectRoot);
  if (sharedProject !== undefined) {
    try {
      await requireSharedProjectClient().recordAuditEvent(sharedProject.projectId, {
        eventType,
        message,
        ...(changesetId === undefined ? {} : { changesetId })
      });
    } catch {
      // Local audit remains authoritative if the collaboration audit endpoint is unavailable.
    }
  }

  const history = getHistoryStore();
  try {
    await history.recordAuditEvent({
      projectRoot,
      eventType,
      message,
      ...(changesetId === undefined ? {} : { changesetId })
    });
  } finally {
    history.close();
  }
}

function summarizeAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case "message":
      return `${event.role}: ${event.content}`;
    case "tool-call":
      return `${event.toolName} ${event.status}: ${event.summary}`;
    case "patch":
      return `${event.status}: ${event.filePath} · ${event.summary}`;
    case "approval":
      return `${event.toolName} ${event.status}: ${event.prompt}`;
    case "verification":
      return `${event.status}: ${event.summary}${
        event.buildJobId === undefined ? "" : ` · build ${event.buildJobId}`
      }`;
    case "error":
      return event.message;
  }
}

function flattenProjectTree(
  nodes: readonly ProjectFileTreeNode[]
): readonly ProjectFileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children === undefined ? [] : flattenProjectTree(node.children))
  ]);
}

async function createMainWindow() {
  nativeTheme.themeSource = "light";

  const mainWindow = new BrowserWindow({
    width: 1800,
    height: 1024,
    minWidth: 1280,
    minHeight: 840,
    title: appName,
    icon: appIconPath,
    backgroundColor: "#f6f7f8",
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (rendererDevServerUrl !== undefined) {
    await mainWindow.loadURL(rendererDevServerUrl);
  } else {
    await mainWindow.loadURL(packagedRendererUrl);
  }
}

registerIpcHandlers();

void app.whenReady().then(async () => {
  if (rendererDevServerUrl === undefined) {
    registerPackagedRendererProtocol();
  }
  await configureOnlyOfficeBridge();
  try {
    await onlyOfficeBridge.start();
  } catch (error) {
    console.warn(
      `[OnlyOfficeBridge] Startup bridge warm-up failed: ${getErrorMessage(error)}`
    );
  }
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  activeProjectWatcher?.close();
  projectChangeDebouncer?.dispose();
  agentHostClient.stop();
  void onlyOfficeBridge.stop();

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void onlyOfficeBridge.stop();
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent host tool failed.";
}
