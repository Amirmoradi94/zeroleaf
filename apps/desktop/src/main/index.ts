import { watch, type FSWatcher } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
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
  analyzeProjectReferences,
  removeUnusedReferenceEntry,
  searchProjectReferences
} from "@latex-agent/reference-service";
import {
  checkSubmissionBundle,
  createProjectFromTemplate,
  exportPdf as exportLifecyclePdf,
  exportSourceZip,
  importProjectZip,
  projectTemplates
} from "@latex-agent/project-lifecycle-service";

import {
  defaultAppSettings,
  defaultWorkbenchLayout,
  ipcChannels,
  type AgentProviderId,
  type AgentProviderSetupAction,
  type AgentEvent,
  type AgentNetworkFetchResult,
  type AppSettings,
  type AppUpdateCheckResult,
  type EditorProjectState,
  type ExternalProjectTemplateId,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
  type PrivacySummary,
  type ProjectFileTreeNode,
  type WorkbenchLayout
} from "@latex-agent/ipc-contracts";
import { ProjectChangeDebouncer } from "./projectWatcher.js";
import { PdfPreviewCaptureStore } from "./pdfPreviewCapture.js";

const rendererDevServerUrl = process.env["VITE_DEV_SERVER_URL"];
const mainDir = fileURLToPath(new URL(".", import.meta.url));
const preloadPath = join(mainDir, "../preload/index.cjs");
const rendererIndexPath = join(mainDir, "../renderer/index.html");
const appIconPath = fileURLToPath(
  new URL("../../assets/zeroleaf-icon.png", import.meta.url)
);
const agentHostProcessPath = fileURLToPath(
  import.meta.resolve("@latex-agent/agent-host/host-process")
);
const appName = "ZeroLeaf";
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
const agentProviderIds = ["mock", "openai-codex", "anthropic-claude"] as const;
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

function getProjectMetadataStore() {
  return new ProjectMetadataStore(getProjectMetadataPath());
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
  const debouncer = new ProjectChangeDebouncer(projectRoot, (event) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send(ipcChannels.projectChanged, event);
    });
  });
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
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.projectOpenRecent, async (_event, request) => {
    const project = await openProject(request.rootPath, getProjectMetadataStore());
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.projectRefresh, async (_event, request) => {
    const project = await refreshProject(
      request.projectRoot,
      getProjectMetadataStore()
    );
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.projectCreateEntry, async (_event, request) => {
    await createProjectEntry(
      request.projectRoot,
      request.parentPath,
      request.name,
      request.kind
    );
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectRenameEntry, async (_event, request) => {
    await renameProjectEntry(request.projectRoot, request.path, request.newName);
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectMoveEntry, async (_event, request) => {
    await moveProjectEntry(request.projectRoot, request.path, request.newPath);
    return refreshProject(request.projectRoot, getProjectMetadataStore());
  });

  handleIpc(ipcChannels.projectDeleteEntry, async (_event, request) => {
    const deletedEntry = await deleteProjectEntry(request.projectRoot, request.path);
    const result = await refreshProject(request.projectRoot, getProjectMetadataStore());
    return { ...result, deletedEntry };
  });

  handleIpc(ipcChannels.projectSetMainFile, (_event, request) =>
    setProjectMainFile(request.projectRoot, getProjectMetadataStore(), request.path)
  );

  handleIpc(ipcChannels.fileRead, (_event, request) =>
    readProjectFile(request.projectRoot, request.path)
  );

  handleIpc(ipcChannels.fileWrite, (_event, request) =>
    writeProjectFile(request.projectRoot, request.path, request.contents)
  );

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
      return await history.applyChangeSet(request.changesetId);
    } finally {
      history.close();
    }
  });

  handleIpc(ipcChannels.historyApplyChangeSetHunks, async (_event, request) => {
    const history = getHistoryStore();
    try {
      return await history.applyChangeSetHunks(request);
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
    startProjectWatcher(project.project.rootPath);
    return project;
  });

  handleIpc(ipcChannels.lifecycleCheckSubmission, async (_event, request) => {
    return await checkSubmissionBundle(request.projectRoot, request.mainFilePath);
  });

  handleIpc(ipcChannels.agentGetAuthStatus, async (_event, request) => {
    if (
      request.providerId !== "mock" &&
      request.providerId !== "openai-codex" &&
      request.providerId !== "anthropic-claude"
    ) {
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
    if (
      request.providerId !== "mock" &&
      request.providerId !== "openai-codex" &&
      request.providerId !== "anthropic-claude"
    ) {
      throw new Error("Unknown agent provider.");
    }

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
        return await readProjectFile(projectRoot, payload.path);
      }
      case "search-project": {
        const payload = message.payload as AgentToolRequestPayloadMap["search-project"];
        return await searchProjectFiles(projectRoot, payload.query);
      }
      case "capture-pdf-preview":
        return await pdfPreviewCaptureStore.capture(projectRoot);
      case "delete-entry": {
        const payload = message.payload as AgentToolRequestPayloadMap["delete-entry"];
        const deletedEntry = await deleteProjectEntry(projectRoot, payload.path);
        if (activeProjectRoot === projectRoot) {
          const refreshed = await refreshProject(
            projectRoot,
            getProjectMetadataStore()
          );
          startProjectWatcher(refreshed.project.rootPath);
        }
        return { path: deletedEntry.deletedPath };
      }
      case "move-entry": {
        const payload = message.payload as AgentToolRequestPayloadMap["move-entry"];
        await moveProjectEntry(projectRoot, payload.fromPath, payload.toPath);
        return {
          fromPath: payload.fromPath,
          toPath: payload.toPath
        };
      }
      case "set-main-file": {
        const payload = message.payload as AgentToolRequestPayloadMap["set-main-file"];
        const result = await setProjectMainFile(
          projectRoot,
          getProjectMetadataStore(),
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
          return await history.applyChangeSet(payload.changesetId);
        } finally {
          history.close();
        }
      }
      case "run-compile": {
        if (message.context.mainFilePath === undefined) {
          throw new Error("Choose a main .tex file before compiling.");
        }

        return await runLatexBuild({
          projectRoot,
          mainFilePath: message.context.mainFilePath,
          compiler: message.context.compiler ?? "pdflatex"
        });
      }
    }
  } catch (error) {
    await recordAgentAudit(projectRoot, "agent.tool.failed", getErrorMessage(error));
    throw error;
  }
}

async function searchProjectFiles(projectRoot: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  const tree = await listProjectTree(projectRoot);
  const searchableFiles = flattenProjectTree(tree)
    .filter((node) => node.kind === "file")
    .filter((node) => /\.(bib|cls|sty|tex)$/u.test(node.path))
    .slice(0, 200);
  const snapshots = await Promise.all(
    searchableFiles.map((node) => readProjectFile(projectRoot, node.path))
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
  providerId: Exclude<AgentProviderId, "mock">,
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
    await mainWindow.loadFile(rendererIndexPath);
  }
}

registerIpcHandlers();

void app.whenReady().then(async () => {
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

  if (process.platform !== "darwin") {
    app.quit();
  }
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent host tool failed.";
}
