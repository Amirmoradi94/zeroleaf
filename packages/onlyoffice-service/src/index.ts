import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import JSZip from "jszip";

import type {
  OnlyOfficeEditorConfig,
  OnlyOfficeEditorSession,
  OnlyOfficeExportPdfResult,
  OnlyOfficeForceSaveResult,
  OnlyOfficeStatus,
  WordStructureNode,
  WordStructureTableCell,
  WordTableOperation
} from "@latex-agent/ipc-contracts";

export type OnlyOfficeBridgeOptions = {
  readonly enabled?: boolean;
  readonly documentServerUrl?: string;
  readonly jwtSecret?: string;
  readonly bridgeHost?: string;
  readonly bridgePublicBaseUrl?: string;
  readonly preferredPort?: number;
  readonly sessionTtlMs?: number;
  readonly onBeforeDocumentSave?: (
    event: OnlyOfficeDocumentSaveEvent
  ) => Promise<void> | void;
  readonly onAfterDocumentSave?: (
    event: OnlyOfficeDocumentSaveEvent
  ) => Promise<void> | void;
};

export type OnlyOfficeDocumentSaveEvent = {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly sessionId: string;
};

type OnlyOfficeSession = {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly absolutePath: string;
  readonly accessToken: string;
  readonly documentKey: string;
  readonly expiresAtMs: number;
};

type CallbackPayload = {
  readonly status?: unknown;
  readonly url?: unknown;
};

type SessionSaveWaiter = {
  readonly minimumSavedAtMs: number;
  readonly resolve: () => void;
};

type ConversionResponse = {
  readonly endConvert?: unknown;
  readonly fileUrl?: unknown;
  readonly percent?: unknown;
  readonly error?: unknown;
};

type BuilderScriptEntry = {
  readonly script: string;
  readonly token: string;
  readonly expiresAtMs: number;
};

type WordStructureExtractionResult = {
  readonly structure: readonly WordStructureNode[];
  readonly warnings: readonly string[];
};

export type WordTableOperationsApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

type RawStructureParagraphElement = {
  readonly type: "paragraph";
  readonly index: number;
  readonly text: string;
  readonly styleName: string | null;
  readonly hasNonTextContent: boolean;
};

type RawStructureTableElement = {
  readonly type: "table";
  readonly index: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cells: readonly {
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly text: string;
  }[];
};

type RawStructureElement = RawStructureParagraphElement | RawStructureTableElement;

const defaultDocumentServerUrl = "http://127.0.0.1:8082";
const defaultSessionTtlMs = 12 * 60 * 60 * 1_000;
const builderScriptTtlMs = 2 * 60 * 1_000;
const maxCallbackBodyBytes = 2_000_000;
const docxContentType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const saveStatuses = new Set([2, 3, 6, 7]);
const bridgeHealthTimeoutMs = 2_000;
const bridgeWarmupDelayMs = 750;
const forceSaveBeforeExportWaitMs = 1_500;
const structureResultFilename = "structure-result.docx";
const structureJsonStartMarker = "__ZEROLEAF_STRUCTURE_JSON_START__";
const structureJsonEndMarker = "__ZEROLEAF_STRUCTURE_JSON_END__";
const tableWriteResultFilename = "table-write-result.docx";

export class OnlyOfficeBridgeService {
  private enabled: boolean;
  private documentServerUrl: string;
  private jwtSecret: string | undefined;
  private bridgeHost: string;
  private bridgePublicBaseUrl: string | undefined;
  private preferredPort: number;
  private sessionTtlMs: number;
  private readonly sessions = new Map<string, OnlyOfficeSession>();
  private readonly sessionSavedAtMs = new Map<string, number>();
  private readonly sessionSaveWaiters = new Map<string, Set<SessionSaveWaiter>>();
  private readonly builderScripts = new Map<string, BuilderScriptEntry>();
  private readonly onBeforeDocumentSave:
    | OnlyOfficeBridgeOptions["onBeforeDocumentSave"]
    | undefined;
  private readonly onAfterDocumentSave:
    | OnlyOfficeBridgeOptions["onAfterDocumentSave"]
    | undefined;
  private server: Server | undefined;
  private port: number | undefined;

  constructor(options: OnlyOfficeBridgeOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.documentServerUrl = trimTrailingSlash(
      options.documentServerUrl ?? defaultDocumentServerUrl
    );
    this.jwtSecret = normalizeSecret(options.jwtSecret);
    this.bridgeHost = options.bridgeHost ?? "127.0.0.1";
    this.bridgePublicBaseUrl = options.bridgePublicBaseUrl;
    this.preferredPort = options.preferredPort ?? 0;
    this.sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
    this.onBeforeDocumentSave = options.onBeforeDocumentSave;
    this.onAfterDocumentSave = options.onAfterDocumentSave;
  }

  async configure(options: OnlyOfficeBridgeOptions): Promise<void> {
    const nextBridgeHost = options.bridgeHost ?? this.bridgeHost;
    const nextPreferredPort = options.preferredPort ?? this.preferredPort;
    const bridgePublicBaseUrlChanged =
      options.bridgePublicBaseUrl !== undefined &&
      trimTrailingSlash(options.bridgePublicBaseUrl) !== this.bridgePublicBaseUrl;
    const listenerChanged =
      nextBridgeHost !== this.bridgeHost ||
      nextPreferredPort !== this.preferredPort ||
      bridgePublicBaseUrlChanged;

    if (listenerChanged) {
      await this.stop();
      this.sessions.clear();
      this.sessionSavedAtMs.clear();
      this.sessionSaveWaiters.clear();
    }

    this.enabled = options.enabled ?? this.enabled;
    this.documentServerUrl = trimTrailingSlash(
      options.documentServerUrl ?? this.documentServerUrl
    );
    this.jwtSecret =
      options.jwtSecret === undefined
        ? this.jwtSecret
        : normalizeSecret(options.jwtSecret);
    this.bridgeHost = nextBridgeHost;
    this.bridgePublicBaseUrl =
      options.bridgePublicBaseUrl === undefined
        ? this.bridgePublicBaseUrl
        : trimTrailingSlash(options.bridgePublicBaseUrl);
    this.preferredPort = nextPreferredPort;
    this.sessionTtlMs = options.sessionTtlMs ?? this.sessionTtlMs;
  }

  async getStatus(): Promise<OnlyOfficeStatus> {
    const reachable = this.enabled
      ? await isDocumentServerReachable(this.documentServerUrl)
      : false;
    const message = !this.enabled
      ? "ONLYOFFICE integration is disabled."
      : !reachable
        ? "ONLYOFFICE Document Server is not reachable. For local development, run npm run onlyoffice:start."
        : this.server === undefined
          ? "ONLYOFFICE bridge is ready and will start when a Word document opens."
          : "ONLYOFFICE bridge is listening for document callbacks.";

    return {
      configured: this.enabled,
      bridgeListening: this.server !== undefined && this.port !== undefined,
      documentServerReachable: reachable,
      documentServerUrl: this.documentServerUrl,
      ...(this.port === undefined ? {} : { bridgePort: this.port }),
      ...(this.port === undefined
        ? {}
        : { bridgePublicBaseUrl: this.getPublicBaseUrl() }),
      message
    };
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const started = await this.ensureStarted();
    if (started) {
      await delay(bridgeWarmupDelayMs);
    }
    await this.verifyPublicBridgeReachable();
  }

  async createEditorSession(request: {
    readonly projectRoot: string;
    readonly filePath: string;
  }): Promise<OnlyOfficeEditorSession> {
    if (!this.enabled) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE integration is disabled.",
        "disabled"
      );
    }

    const started = await this.ensureStarted();
    if (started) {
      await delay(bridgeWarmupDelayMs);
    }
    await this.verifyPublicBridgeReachable();

    const projectRoot = await realpath(request.projectRoot);
    const absolutePath = await resolveReadableDocxPath(projectRoot, request.filePath);
    await repairEditableBlankDocx(absolutePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE can only open .docx files.",
        "not-file"
      );
    }

    this.pruneExpiredSessions();

    const sessionId = randomUUID();
    const accessToken = randomBytes(24).toString("base64url");
    const documentKey = createDocumentKey(
      projectRoot,
      request.filePath,
      fileStat,
      sessionId
    );
    const expiresAtMs = Date.now() + this.sessionTtlMs;
    const session: OnlyOfficeSession = {
      sessionId,
      projectRoot,
      filePath: normalizeProjectPath(request.filePath),
      absolutePath,
      accessToken,
      documentKey,
      expiresAtMs
    };
    this.sessions.set(sessionId, session);

    const publicBaseUrl = this.getPublicBaseUrl();
    const documentUrl = `${publicBaseUrl}/onlyoffice/sessions/${sessionId}/${accessToken}/document`;
    const callbackUrl = `${publicBaseUrl}/onlyoffice/sessions/${sessionId}/${accessToken}/callback`;
    const configWithoutToken: Omit<OnlyOfficeEditorConfig, "token"> = {
      type: "desktop",
      documentType: "word",
      width: "100%",
      height: "100%",
      document: {
        fileType: "docx",
        key: documentKey,
        title: basename(request.filePath),
        url: documentUrl,
        permissions: {
          edit: true,
          download: true,
          print: true
        }
      },
      editorConfig: {
        mode: "edit",
        callbackUrl,
        lang: "en",
        user: {
          id: "zeroleaf-local-user",
          name: "ZeroLeaf"
        },
        customization: {
          autosave: true,
          forcesave: true
        }
      }
    };
    const config: OnlyOfficeEditorConfig =
      this.jwtSecret === undefined
        ? configWithoutToken
        : {
            ...configWithoutToken,
            token: signOnlyOfficeJwt(configWithoutToken, this.jwtSecret)
          };

    return {
      sessionId,
      documentServerUrl: this.documentServerUrl,
      config,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async extractWordStructure(request: {
    readonly projectRoot: string;
    readonly filePath: string;
  }): Promise<WordStructureExtractionResult> {
    if (!this.enabled) {
      return {
        structure: [],
        warnings: ["ONLYOFFICE integration is disabled."]
      };
    }

    let session: OnlyOfficeEditorSession;
    try {
      const started = await this.ensureStarted();
      if (started) {
        await delay(bridgeWarmupDelayMs);
      }
      await this.verifyPublicBridgeReachable();
      session = await this.createEditorSession(request);
    } catch (error) {
      return {
        structure: [],
        warnings: [
          `ONLYOFFICE structure extraction is unavailable: ${getErrorMessage(error)}`
        ]
      };
    }

    const scriptId = randomUUID();
    const scriptToken = randomBytes(24).toString("base64url");
    this.builderScripts.set(scriptId, {
      script: buildStructureExtractionScript(session.config.document.url),
      token: scriptToken,
      expiresAtMs: Date.now() + builderScriptTtlMs
    });

    try {
      const scriptUrl = `${this.getPublicBaseUrl()}/onlyoffice/builder-scripts/${scriptId}/${scriptToken}`;
      const requestBodyWithoutToken = { async: false, url: scriptUrl };
      const requestToken =
        this.jwtSecret === undefined
          ? undefined
          : signOnlyOfficeJwt(requestBodyWithoutToken, this.jwtSecret);
      const requestBody =
        requestToken === undefined
          ? requestBodyWithoutToken
          : { ...requestBodyWithoutToken, token: requestToken };

      const response = await fetch(`${this.documentServerUrl}/docbuilder`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(requestToken === undefined ? {} : { authorization: `Bearer ${requestToken}` })
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        return {
          structure: [],
          warnings: [
            `ONLYOFFICE structure extraction request failed with HTTP ${response.status}.`
          ]
        };
      }

      const result = (await response.json().catch(() => ({}))) as {
        readonly error?: unknown;
        readonly urls?: Readonly<Record<string, unknown>>;
      };
      const errorCode =
        typeof result.error === "number" && result.error !== 0 ? result.error : undefined;
      if (errorCode !== undefined) {
        return {
          structure: [],
          warnings: [`ONLYOFFICE structure extraction failed with error ${errorCode}.`]
        };
      }

      const resultUrl = result.urls?.[structureResultFilename];
      if (typeof resultUrl !== "string" || resultUrl.length === 0) {
        return {
          structure: [],
          warnings: ["ONLYOFFICE structure extraction did not return a result file."]
        };
      }

      const resultBytes = await downloadBinary(
        normalizeOnlyOfficeDownloadUrl(resultUrl, this.documentServerUrl)
      );
      return await parseStructureExtractionResult(resultBytes);
    } catch (error) {
      return {
        structure: [],
        warnings: [`ONLYOFFICE structure extraction failed: ${getErrorMessage(error)}`]
      };
    } finally {
      this.builderScripts.delete(scriptId);
      this.sessions.delete(session.sessionId);
    }
  }

  async applyWordTableOperations(request: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly operations: readonly WordTableOperation[];
  }): Promise<WordTableOperationsApplyResult> {
    if (!this.enabled) {
      return { ok: false, error: "ONLYOFFICE integration is disabled." };
    }

    if (request.operations.length === 0) {
      return { ok: false, error: "Table changeset requires at least one operation." };
    }

    let elementIndexByOperation: readonly number[];
    try {
      elementIndexByOperation = request.operations.map((operation) =>
        parseTableElementIndex(operation.tableId)
      );
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }

    let session: OnlyOfficeEditorSession;
    let internalSession: OnlyOfficeSession;
    try {
      const started = await this.ensureStarted();
      if (started) {
        await delay(bridgeWarmupDelayMs);
      }
      await this.verifyPublicBridgeReachable();
      session = await this.createEditorSession(request);
      internalSession = this.sessions.get(session.sessionId)!;
    } catch (error) {
      return {
        ok: false,
        error: `ONLYOFFICE table edit is unavailable: ${getErrorMessage(error)}`
      };
    }

    const scriptId = randomUUID();
    const scriptToken = randomBytes(24).toString("base64url");
    this.builderScripts.set(scriptId, {
      script: buildTableWriteScript(
        session.config.document.url,
        request.operations,
        elementIndexByOperation
      ),
      token: scriptToken,
      expiresAtMs: Date.now() + builderScriptTtlMs
    });

    try {
      const scriptUrl = `${this.getPublicBaseUrl()}/onlyoffice/builder-scripts/${scriptId}/${scriptToken}`;
      const requestBodyWithoutToken = { async: false, url: scriptUrl };
      const requestToken =
        this.jwtSecret === undefined
          ? undefined
          : signOnlyOfficeJwt(requestBodyWithoutToken, this.jwtSecret);
      const requestBody =
        requestToken === undefined
          ? requestBodyWithoutToken
          : { ...requestBodyWithoutToken, token: requestToken };

      const response = await fetch(`${this.documentServerUrl}/docbuilder`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(requestToken === undefined ? {} : { authorization: `Bearer ${requestToken}` })
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        return {
          ok: false,
          error: `ONLYOFFICE table edit request failed with HTTP ${response.status}.`
        };
      }

      const result = (await response.json().catch(() => ({}))) as {
        readonly error?: unknown;
        readonly urls?: Readonly<Record<string, unknown>>;
      };
      const errorCode =
        typeof result.error === "number" && result.error !== 0 ? result.error : undefined;
      if (errorCode !== undefined) {
        return { ok: false, error: `ONLYOFFICE table edit failed with error ${errorCode}.` };
      }

      const resultUrl = result.urls?.[tableWriteResultFilename];
      if (typeof resultUrl !== "string" || resultUrl.length === 0) {
        return { ok: false, error: "ONLYOFFICE table edit did not return a result file." };
      }

      await this.writeSavedDocument(
        internalSession,
        normalizeOnlyOfficeDownloadUrl(resultUrl, this.documentServerUrl)
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `ONLYOFFICE table edit failed: ${getErrorMessage(error)}` };
    } finally {
      this.builderScripts.delete(scriptId);
      this.sessions.delete(session.sessionId);
    }
  }

  async forceSave(sessionId: string): Promise<OnlyOfficeForceSaveResult> {
    const session = this.requireActiveSession(sessionId);

    const command = { c: "forcesave", key: session.documentKey };
    const commandToken =
      this.jwtSecret === undefined
        ? undefined
        : signOnlyOfficeJwt(command, this.jwtSecret);
    const commandWithToken =
      commandToken === undefined ? command : { ...command, token: commandToken };
    const response = await fetch(
      `${this.documentServerUrl}/coauthoring/CommandService.ashx`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(commandToken === undefined
            ? {}
            : { authorization: `Bearer ${commandToken}` })
        },
        body: JSON.stringify(commandWithToken)
      }
    );

    const result = (await response.json().catch(() => ({}))) as {
      readonly error?: unknown;
    };
    const error = typeof result.error === "number" ? result.error : undefined;

    return {
      requested: response.ok && (error === undefined || error === 0),
      ...(error === undefined ? {} : { error }),
      message:
        response.ok && (error === undefined || error === 0)
          ? "ONLYOFFICE force-save request was accepted."
          : `ONLYOFFICE force-save request failed with HTTP ${response.status}.`
    };
  }

  async exportPdf(sessionId: string): Promise<OnlyOfficeExportPdfResult> {
    const session = this.requireActiveSession(sessionId);
    const forceSaveRequestedAtMs = Date.now();
    const saveResult = await this.forceSave(sessionId);
    if (saveResult.requested) {
      await this.waitForSessionSave(
        sessionId,
        forceSaveRequestedAtMs,
        forceSaveBeforeExportWaitMs
      );
    }

    const documentUrl = `${this.getPublicBaseUrl()}/onlyoffice/sessions/${session.sessionId}/${session.accessToken}/document`;
    const conversionKey = createConversionKey(session);
    const conversionRequestWithoutToken = {
      async: false,
      filetype: "docx",
      key: conversionKey,
      outputtype: "pdf",
      title: basename(session.filePath),
      url: documentUrl
    };
    const conversionToken =
      this.jwtSecret === undefined
        ? undefined
        : signOnlyOfficeJwt(conversionRequestWithoutToken, this.jwtSecret);
    const conversionRequest =
      conversionToken === undefined
        ? conversionRequestWithoutToken
        : { ...conversionRequestWithoutToken, token: conversionToken };
    const conversionResponse = await this.requestConversion(
      conversionKey,
      conversionRequest,
      conversionToken
    );
    const conversionError = getConversionError(conversionResponse);
    if (conversionError !== undefined) {
      throw new OnlyOfficeBridgeError(
        `ONLYOFFICE PDF conversion failed with error ${conversionError}.`,
        "server"
      );
    }

    const fileUrl =
      typeof conversionResponse.fileUrl === "string"
        ? conversionResponse.fileUrl
        : undefined;
    if (fileUrl === undefined || fileUrl.length === 0) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE PDF conversion finished without a PDF URL.",
        "server"
      );
    }

    const pdfBytes = await downloadBinary(
      normalizeOnlyOfficeDownloadUrl(fileUrl, this.documentServerUrl),
      "application/pdf,application/octet-stream,*/*",
      "converted PDF"
    );
    const outputDirectory = resolve(session.projectRoot, ".zeroleaf", "word-pdf");
    const outputPath = resolve(
      outputDirectory,
      `${basename(session.filePath, ".docx")}-${createHash("sha256")
        .update(session.filePath)
        .digest("hex")
        .slice(0, 8)}.pdf`
    );
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, pdfBytes);

    return {
      filePath: session.filePath,
      pdfPath: outputPath,
      byteLength: pdfBytes.byteLength,
      message: `I converted ${session.filePath} to PDF.`
    };
  }

  async stop(): Promise<void> {
    if (this.server === undefined) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error === undefined) {
          resolvePromise();
        } else {
          rejectPromise(error);
        }
      });
    });
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.server !== undefined) {
      return false;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.preferredPort, this.bridgeHost, () => {
        server.off("error", rejectPromise);
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          rejectPromise(
            new OnlyOfficeBridgeError(
              "ONLYOFFICE bridge did not expose a TCP port.",
              "server"
            )
          );
          return;
        }

        this.server = server;
        this.port = address.port;
        resolvePromise();
      });
    });
    return true;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", this.getPublicBaseUrl());

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      const documentMatch =
        /^\/onlyoffice\/sessions\/([^/]+)\/([^/]+)\/document$/u.exec(
          requestUrl.pathname
        ) ?? /^\/onlyoffice\/sessions\/([^/]+)\/document$/u.exec(requestUrl.pathname);
      if (request.method === "GET" && documentMatch !== null) {
        await this.handleDocumentDownload(
          documentMatch[1]!,
          documentMatch[2],
          requestUrl,
          response
        );
        return;
      }

      const builderScriptMatch = /^\/onlyoffice\/builder-scripts\/([^/]+)\/([^/]+)$/u.exec(
        requestUrl.pathname
      );
      if (request.method === "GET" && builderScriptMatch !== null) {
        this.handleBuilderScriptDownload(
          builderScriptMatch[1]!,
          builderScriptMatch[2]!,
          response
        );
        return;
      }

      const callbackMatch =
        /^\/onlyoffice\/sessions\/([^/]+)\/([^/]+)\/callback$/u.exec(
          requestUrl.pathname
        ) ?? /^\/onlyoffice\/sessions\/([^/]+)\/callback$/u.exec(requestUrl.pathname);
      if (request.method === "POST" && callbackMatch !== null) {
        await this.handleCallback(
          callbackMatch[1]!,
          callbackMatch[2],
          request,
          requestUrl,
          response
        );
        return;
      }

      writeJson(response, 404, { error: "not-found" });
    } catch (error) {
      console.warn(
        `[OnlyOfficeBridge] ${request.method ?? "UNKNOWN"} ${request.url ?? "/"} failed: ${getErrorMessage(error)}`
      );
      writeJson(response, 500, { error: getErrorMessage(error) });
    }
  }

  private handleBuilderScriptDownload(
    scriptId: string,
    token: string,
    response: ServerResponse
  ): void {
    const entry = this.builderScripts.get(scriptId);
    if (entry === undefined || entry.token !== token) {
      writeJson(response, 404, { error: "not-found" });
      return;
    }

    if (Date.now() > entry.expiresAtMs) {
      this.builderScripts.delete(scriptId);
      writeJson(response, 404, { error: "expired" });
      return;
    }

    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(entry.script);
  }

  private async handleDocumentDownload(
    sessionId: string,
    pathToken: string | undefined,
    requestUrl: URL,
    response: ServerResponse
  ): Promise<void> {
    const session = this.requireSession(sessionId, pathToken, requestUrl);
    const contents = await readFile(session.absolutePath);
    response.writeHead(200, {
      "content-type": docxContentType,
      "content-length": String(contents.byteLength),
      "cache-control": "no-store"
    });
    response.end(contents);
  }

  private async handleCallback(
    sessionId: string,
    pathToken: string | undefined,
    request: IncomingMessage,
    requestUrl: URL,
    response: ServerResponse
  ): Promise<void> {
    const session = this.requireSession(sessionId, pathToken, requestUrl);
    const payload = JSON.parse(await readRequestBody(request)) as CallbackPayload;
    const status = typeof payload.status === "number" ? payload.status : undefined;

    if (status !== undefined && saveStatuses.has(status)) {
      if (typeof payload.url !== "string" || payload.url.length === 0) {
        writeJson(response, 400, { error: 1 });
        return;
      }

      await this.writeSavedDocument(session, payload.url);
    }

    writeJson(response, 200, { error: 0 });
  }

  private async writeSavedDocument(
    session: OnlyOfficeSession,
    downloadUrl: string
  ): Promise<void> {
    const event = {
      projectRoot: session.projectRoot,
      filePath: session.filePath,
      sessionId: session.sessionId
    };
    await this.onBeforeDocumentSave?.(event);
    const savedBytes = await downloadBinary(
      normalizeOnlyOfficeDownloadUrl(downloadUrl, this.documentServerUrl)
    );
    const tempPath = resolve(
      dirname(session.absolutePath),
      `.zeroleaf-onlyoffice-${session.sessionId}.tmp`
    );
    await mkdir(dirname(session.absolutePath), { recursive: true });
    await writeFile(tempPath, savedBytes);
    await rename(tempPath, session.absolutePath);
    await this.onAfterDocumentSave?.(event);
    this.notifySessionSaved(session.sessionId);
  }

  private async requestConversion(
    conversionKey: string,
    requestBody: unknown,
    token: string | undefined
  ): Promise<ConversionResponse> {
    const endpoints = [
      `${this.documentServerUrl}/converter?shardkey=${encodeURIComponent(conversionKey)}`,
      `${this.documentServerUrl}/ConvertService.ashx`
    ];
    let lastError: Error | undefined;

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
          },
          body: JSON.stringify(requestBody)
        });

        if (response.status === 404 && endpoint.includes("/converter")) {
          continue;
        }

        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${responseText}`);
        }

        return parseConversionResponse(responseText);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new OnlyOfficeBridgeError(
      `ONLYOFFICE PDF conversion request failed: ${lastError?.message ?? "unknown error"}`,
      "server"
    );
  }

  private requireActiveSession(sessionId: string): OnlyOfficeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new OnlyOfficeBridgeError("ONLYOFFICE session was not found.", "not-found");
    }

    if (Date.now() > session.expiresAtMs) {
      this.sessions.delete(sessionId);
      throw new OnlyOfficeBridgeError("ONLYOFFICE session expired.", "expired");
    }

    return session;
  }

  private async waitForSessionSave(
    sessionId: string,
    minimumSavedAtMs: number,
    timeoutMs: number
  ): Promise<void> {
    if ((this.sessionSavedAtMs.get(sessionId) ?? 0) >= minimumSavedAtMs) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      const waiter: SessionSaveWaiter = {
        minimumSavedAtMs,
        resolve: resolvePromise
      };
      const waiters = this.sessionSaveWaiters.get(sessionId) ?? new Set();
      waiters.add(waiter);
      this.sessionSaveWaiters.set(sessionId, waiters);
      setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.sessionSaveWaiters.delete(sessionId);
        }
        resolvePromise();
      }, timeoutMs);
    });
  }

  private notifySessionSaved(sessionId: string): void {
    const savedAtMs = Date.now();
    this.sessionSavedAtMs.set(sessionId, savedAtMs);
    const waiters = this.sessionSaveWaiters.get(sessionId);
    if (waiters === undefined) {
      return;
    }

    for (const waiter of waiters) {
      if (savedAtMs >= waiter.minimumSavedAtMs) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }

    if (waiters.size === 0) {
      this.sessionSaveWaiters.delete(sessionId);
    }
  }

  private requireSession(
    sessionId: string,
    pathToken: string | undefined,
    requestUrl: URL
  ): OnlyOfficeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new OnlyOfficeBridgeError("ONLYOFFICE session was not found.", "not-found");
    }

    if (Date.now() > session.expiresAtMs) {
      this.sessions.delete(sessionId);
      throw new OnlyOfficeBridgeError("ONLYOFFICE session expired.", "expired");
    }

    const requestToken = pathToken ?? requestUrl.searchParams.get("token");
    if (requestToken !== session.accessToken) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE session token is invalid.",
        "forbidden"
      );
    }

    return session;
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAtMs < now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private getPublicBaseUrl(): string {
    if (this.bridgePublicBaseUrl !== undefined) {
      return trimTrailingSlash(this.bridgePublicBaseUrl);
    }

    const port = this.port;
    if (port === undefined) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE bridge has not started yet.",
        "server"
      );
    }

    return `http://127.0.0.1:${port}`;
  }

  private async verifyPublicBridgeReachable(): Promise<void> {
    const publicBaseUrl = this.getPublicBaseUrl();
    const healthUrl = `${getLocalBridgeProbeBaseUrl(publicBaseUrl)}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), bridgeHealthTimeoutMs);

    try {
      const response = await fetch(healthUrl, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch {
      throw new OnlyOfficeBridgeError(
        `ONLYOFFICE bridge callback URL is not reachable at ${healthUrl}. Check the Word settings bridge URL and make sure the bridge host is reachable from the Document Server.`,
        "server"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function getLocalBridgeProbeBaseUrl(publicBaseUrl: string): string {
  const parsedUrl = new URL(publicBaseUrl);
  if (parsedUrl.hostname !== "host.docker.internal") {
    return trimTrailingSlash(publicBaseUrl);
  }

  parsedUrl.hostname = "127.0.0.1";
  return trimTrailingSlash(parsedUrl.toString());
}

export class OnlyOfficeBridgeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "expired"
      | "disabled"
      | "forbidden"
      | "invalid-path"
      | "not-file"
      | "not-found"
      | "outside-root"
      | "server"
  ) {
    super(message);
    this.name = "OnlyOfficeBridgeError";
  }
}

export function signOnlyOfficeJwt(payload: unknown, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function createDocumentKey(
  projectRoot: string,
  filePath: string,
  fileStat: { readonly mtimeMs: number; readonly size: number },
  sessionId: string
): string {
  return createHash("sha256")
    .update(projectRoot)
    .update("\0")
    .update(normalizeProjectPath(filePath))
    .update("\0")
    .update(String(fileStat.mtimeMs))
    .update("\0")
    .update(String(fileStat.size))
    .update("\0")
    .update(sessionId)
    .digest("base64url")
    .slice(0, 48);
}

function createConversionKey(session: OnlyOfficeSession): string {
  return createHash("sha256")
    .update(session.projectRoot)
    .update("\0")
    .update(session.filePath)
    .update("\0")
    .update(session.sessionId)
    .update("\0")
    .update(String(Date.now()))
    .digest("base64url")
    .slice(0, 48);
}

async function resolveReadableDocxPath(
  projectRoot: string,
  filePath: string
): Promise<string> {
  const normalizedPath = normalizeProjectPath(filePath);
  if (!normalizedPath.toLowerCase().endsWith(".docx")) {
    throw new OnlyOfficeBridgeError(
      "ONLYOFFICE only supports .docx files in this editor path.",
      "invalid-path"
    );
  }

  const absolutePath = resolve(projectRoot, normalizedPath);
  if (!isInsideRoot(projectRoot, absolutePath)) {
    throw new OnlyOfficeBridgeError(
      "ONLYOFFICE document path is outside the project root.",
      "outside-root"
    );
  }

  const realPath = await realpath(absolutePath);
  if (!isInsideRoot(projectRoot, realPath)) {
    throw new OnlyOfficeBridgeError(
      "ONLYOFFICE document path resolves outside the project root.",
      "outside-root"
    );
  }

  return realPath;
}

function normalizeProjectPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) {
    throw new OnlyOfficeBridgeError(
      "ONLYOFFICE document path must be project-relative.",
      "invalid-path"
    );
  }

  return trimmed
    .split(/[\\/]+/u)
    .filter(Boolean)
    .join("/");
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxCallbackBodyBytes) {
      throw new OnlyOfficeBridgeError(
        "ONLYOFFICE callback body is too large.",
        "server"
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function downloadBinary(
  downloadUrl: string,
  accept = `${docxContentType},application/octet-stream,*/*`,
  label = "saved document"
): Promise<Buffer> {
  const response = await fetch(downloadUrl, {
    redirect: "follow",
    headers: {
      accept
    }
  });
  if (!response.ok) {
    throw new Error(`ONLYOFFICE ${label} download failed: HTTP ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function parseConversionResponse(responseText: string): ConversionResponse {
  const trimmed = responseText.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Readonly<Record<string, unknown>>;
    return {
      endConvert: parsed["endConvert"] ?? parsed["EndConvert"],
      fileUrl: parsed["fileUrl"] ?? parsed["FileUrl"],
      percent: parsed["percent"] ?? parsed["Percent"],
      error: parsed["error"] ?? parsed["Error"]
    };
  }

  return {
    endConvert: getXmlValue(trimmed, "EndConvert"),
    fileUrl: decodeXmlText(getXmlValue(trimmed, "FileUrl") ?? ""),
    percent: getXmlValue(trimmed, "Percent"),
    error: getXmlValue(trimmed, "Error")
  };
}

function getConversionError(response: ConversionResponse): string | undefined {
  if (response.error === undefined || response.error === null || response.error === 0) {
    return undefined;
  }

  const error = String(response.error).trim();
  return error.length === 0 || error === "0" ? undefined : error;
}

function getXmlValue(xml: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "iu");
  return pattern.exec(xml)?.[1];
}

async function repairEditableBlankDocx(absolutePath: string): Promise<void> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(await readFile(absolutePath));
  } catch {
    return;
  }

  const documentXmlFile = archive.file("word/document.xml");
  if (documentXmlFile === null) {
    return;
  }

  const documentXml = await documentXmlFile.async("string");
  const textMatches = Array.from(
    documentXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)
  );
  if (textMatches.length === 0) {
    return;
  }

  const hasVisibleText = textMatches.some(
    (match) => decodeXmlText(match[1] ?? "").trim().length > 0
  );
  if (hasVisibleText) {
    return;
  }

  const repairedXml = documentXml.replace(
    /<w:t\b([^>]*)><\/w:t>/u,
    (_match, attributes: string) =>
      attributes.includes("xml:space=")
        ? `<w:t${attributes}> </w:t>`
        : `<w:t${attributes} xml:space="preserve"> </w:t>`
  );
  if (repairedXml === documentXml) {
    return;
  }

  archive.file("word/document.xml", repairedXml);
  await writeFile(absolutePath, await archive.generateAsync({ type: "nodebuffer" }));
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function parseTableElementIndex(tableId: string): number {
  const match = /^tbl-(\d+)-/u.exec(tableId);
  if (match === null) {
    throw new Error(`Table id ${tableId} is not a recognized structural table id.`);
  }
  return Number(match[1]);
}

function buildTableWriteScript(
  documentUrl: string,
  operations: readonly WordTableOperation[],
  elementIndexByOperation: readonly number[]
): string {
  const operationsWithElementIndex = operations.map((operation, index) => ({
    ...operation,
    elementIndex: elementIndexByOperation[index]
  }));

  return `
builder.OpenFile(${JSON.stringify(documentUrl)});

var oDocument = Api.GetDocument();
var operations = ${JSON.stringify(operationsWithElementIndex)};

function zeroleafGetTable(elementIndex) {
  var oElement = oDocument.GetElement(elementIndex);
  if (!oElement || oElement.GetClassType() !== "table") {
    throw new Error("Element " + elementIndex + " is not a table.");
  }
  return oElement;
}

for (var i = 0; i < operations.length; i++) {
  var op = operations[i];
  var oTable = zeroleafGetTable(op.elementIndex);

  if (op.type === "replace-table-cell") {
    oTable.GetRow(op.rowIndex).GetCell(op.columnIndex).SetText(op.afterText);
  } else if (op.type === "insert-table-row") {
    oTable.GetRow(op.anchorRowIndex).AddRows(1, op.position === "before");
  } else if (op.type === "delete-table-row") {
    oTable.GetRow(op.rowIndex).Remove();
  } else if (op.type === "insert-table-column") {
    oTable.GetRow(0).GetCell(op.anchorColumnIndex).AddColumns(1, op.position === "before");
  } else if (op.type === "delete-table-column") {
    oTable.GetRow(0).GetCell(op.columnIndex).RemoveColumn();
  } else if (op.type === "merge-table-cells") {
    var cellsToMerge = [];
    for (var c = 0; c < op.cells.length; c++) {
      cellsToMerge.push(oTable.GetRow(op.cells[c].rowIndex).GetCell(op.cells[c].columnIndex));
    }
    oTable.MergeCells(cellsToMerge);
  } else {
    throw new Error("Unsupported table operation: " + op.type);
  }
}

builder.SaveFile("docx", ${JSON.stringify(tableWriteResultFilename)});
builder.CloseFile();
`;
}

function buildStructureExtractionScript(documentUrl: string): string {
  return `
builder.OpenFile(${JSON.stringify(documentUrl)});

var oDocument = Api.GetDocument();
var elements = [];
var elementsCount = oDocument.GetElementsCount();

function zeroleafReadParagraphText(oParagraph) {
  try {
    return String(oParagraph.GetText()).replace(/\\r\\n/g, "\\n").trim();
  } catch (e) {
    return "";
  }
}

function zeroleafReadCellText(oCell) {
  var content = oCell.GetContent();
  var count = content.GetElementsCount();
  var parts = [];
  for (var i = 0; i < count; i++) {
    var child = content.GetElement(i);
    if (child.GetClassType() === "paragraph") {
      parts.push(zeroleafReadParagraphText(child));
    }
  }
  return parts.join("\\n").trim();
}

for (var i = 0; i < elementsCount; i++) {
  var oElement = oDocument.GetElement(i);
  var classType = oElement.GetClassType();

  if (classType === "paragraph") {
    var text = zeroleafReadParagraphText(oElement);
    var styleName = null;
    try {
      var oStyle = oElement.GetStyle();
      styleName = oStyle ? oStyle.GetName() : null;
    } catch (e) {
      styleName = null;
    }
    var elementsInParagraph = 0;
    try {
      elementsInParagraph = oElement.GetElementsCount();
    } catch (e) {
      elementsInParagraph = 0;
    }
    elements.push({
      type: "paragraph",
      index: i,
      text: text,
      styleName: styleName,
      hasNonTextContent: text.length === 0 && elementsInParagraph > 0
    });
  } else if (classType === "table") {
    var rowCount = oElement.GetRowsCount();
    var columnCount = 0;
    var cells = [];
    for (var r = 0; r < rowCount; r++) {
      var oRow = oElement.GetRow(r);
      var cellCount = oRow.GetCellsCount();
      if (cellCount > columnCount) {
        columnCount = cellCount;
      }
      for (var c = 0; c < cellCount; c++) {
        cells.push({
          rowIndex: r,
          columnIndex: c,
          text: zeroleafReadCellText(oRow.GetCell(c))
        });
      }
    }
    elements.push({
      type: "table",
      index: i,
      rowCount: rowCount,
      columnCount: columnCount,
      cells: cells
    });
  }
}

var oJsonParagraph = Api.CreateParagraph();
oJsonParagraph.AddText(${JSON.stringify(structureJsonStartMarker)} + JSON.stringify(elements) + ${JSON.stringify(structureJsonEndMarker)});
oDocument.Push(oJsonParagraph);

builder.SaveFile("docx", ${JSON.stringify(structureResultFilename)});
builder.CloseFile();
`;
}

async function parseStructureExtractionResult(
  resultBytes: Buffer
): Promise<WordStructureExtractionResult> {
  const archive = await JSZip.loadAsync(resultBytes);
  const documentXmlFile = archive.file("word/document.xml");
  if (documentXmlFile === null) {
    return {
      structure: [],
      warnings: ["ONLYOFFICE structure result was missing word/document.xml."]
    };
  }

  const documentXml = await documentXmlFile.async("string");
  const rawText = Array.from(documentXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu))
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("");

  const startIndex = rawText.indexOf(structureJsonStartMarker);
  const endIndex = rawText.indexOf(structureJsonEndMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      structure: [],
      warnings: ["ONLYOFFICE structure result did not include a structure payload."]
    };
  }

  const jsonText = rawText.slice(startIndex + structureJsonStartMarker.length, endIndex);

  let rawElements: readonly RawStructureElement[];
  try {
    rawElements = JSON.parse(jsonText) as readonly RawStructureElement[];
  } catch {
    return {
      structure: [],
      warnings: ["ONLYOFFICE structure result payload could not be parsed."]
    };
  }

  return { structure: rawElements.map(toStructureNode), warnings: [] };
}

function toStructureNode(element: RawStructureElement): WordStructureNode {
  if (element.type === "paragraph") {
    const headingLevel = parseHeadingLevel(element.styleName);
    return {
      type: "paragraph",
      id: createStructureId(`para-${element.index}`, element.text),
      text: element.text,
      ...(headingLevel === undefined ? {} : { headingLevel }),
      ...(element.styleName === null ? {} : { styleName: element.styleName }),
      ...(element.hasNonTextContent ? { hasNonTextContent: true } : {})
    };
  }

  const tableId = createStructureId(
    `tbl-${element.index}`,
    `${element.rowCount}x${element.columnCount}`
  );
  const cells: WordStructureTableCell[] = element.cells.map((cell) => ({
    id: createStructureId(
      `tbl-${element.index}-r${cell.rowIndex}c${cell.columnIndex}`,
      cell.text
    ),
    rowIndex: cell.rowIndex,
    columnIndex: cell.columnIndex,
    text: cell.text
  }));

  return {
    type: "table",
    id: tableId,
    rowCount: element.rowCount,
    columnCount: element.columnCount,
    cells
  };
}

function parseHeadingLevel(styleName: string | null): number | undefined {
  if (styleName === null) {
    return undefined;
  }

  const match = /^heading\s*(\d+)$/iu.exec(styleName.trim());
  if (match === null) {
    return undefined;
  }

  const level = Number(match[1]);
  return Number.isFinite(level) && level > 0 ? level : undefined;
}

function createStructureId(prefix: string, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function normalizeOnlyOfficeDownloadUrl(
  downloadUrl: string,
  documentServerUrl: string
): string {
  const parsedUrl = new URL(downloadUrl);
  const isLoopbackHost =
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "::1";

  if (!isLoopbackHost || parsedUrl.port.length > 0) {
    return downloadUrl;
  }

  const serverUrl = new URL(documentServerUrl);
  parsedUrl.protocol = serverUrl.protocol;
  parsedUrl.host = serverUrl.host;
  return parsedUrl.toString();
}

async function isDocumentServerReachable(documentServerUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);

  try {
    const response = await fetch(
      `${trimTrailingSlash(documentServerUrl)}/web-apps/apps/api/documents/api.js`,
      {
        signal: controller.signal,
        headers: {
          accept: "application/javascript,text/javascript,*/*"
        }
      }
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body))
  });
  response.end(body);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeSecret(secret: string | undefined): string | undefined {
  const trimmed = secret?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
