import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { OnlyOfficeBridgeService } from "./index.js";

const services: OnlyOfficeBridgeService[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise, rejectPromise) => {
          server.close((error) => {
            if (error === undefined) {
              resolvePromise();
            } else {
              rejectPromise(error);
            }
          });
        })
    )
  );
});

describe("OnlyOfficeBridgeService", () => {
  it("creates an editor config for a project-scoped .docx", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-config-"));
    await writeFile(join(projectRoot, "paper.docx"), Buffer.from("docx-bytes"));
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: "http://127.0.0.1:8082/",
      jwtSecret: "test-secret"
    });
    services.push(service);

    const session = await service.createEditorSession({
      projectRoot,
      filePath: "paper.docx"
    });

    expect(session.documentServerUrl).toBe("http://127.0.0.1:8082");
    expect(session.config.document.fileType).toBe("docx");
    expect(session.config.document.url).toContain("/onlyoffice/sessions/");
    expect(session.config.editorConfig.callbackUrl).toContain("/onlyoffice/sessions/");
    expect(session.config.document.url).not.toContain("?token=");
    expect(session.config.editorConfig.callbackUrl).not.toContain("?token=");
    expect(new URL(session.config.document.url).pathname).toMatch(
      /^\/onlyoffice\/sessions\/[^/]+\/[^/]+\/document$/u
    );
    expect(new URL(session.config.editorConfig.callbackUrl).pathname).toMatch(
      /^\/onlyoffice\/sessions\/[^/]+\/[^/]+\/callback$/u
    );
    expect(session.config.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    await expect(service.getStatus()).resolves.toMatchObject({
      bridgeListening: true,
      configured: true
    });
  });

  it("repairs legacy blank documents before creating an editor session", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-repair-"));
    const documentPath = join(projectRoot, "blank.docx");
    const archive = new JSZip();
    archive.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p></w:body></w:document>'
    );
    await writeFile(documentPath, await archive.generateAsync({ type: "nodebuffer" }));
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: "http://127.0.0.1:8082/"
    });
    services.push(service);

    await service.createEditorSession({
      projectRoot,
      filePath: "blank.docx"
    });

    const repairedArchive = await JSZip.loadAsync(await readFile(documentPath));
    const repairedXml = await repairedArchive
      .file("word/document.xml")
      ?.async("string");
    expect(repairedXml).toContain('<w:t xml:space="preserve"> </w:t>');
    expect(repairedXml).not.toContain('<w:t xml:space="preserve"></w:t>');
  });

  it("uses a fresh document key for each editor session", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-key-"));
    await writeFile(join(projectRoot, "paper.docx"), Buffer.from("docx-bytes"));
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: "http://127.0.0.1:8082/"
    });
    services.push(service);

    const firstSession = await service.createEditorSession({
      projectRoot,
      filePath: "paper.docx"
    });
    const secondSession = await service.createEditorSession({
      projectRoot,
      filePath: "paper.docx"
    });

    expect(firstSession.config.document.key).toMatch(/^[A-Za-z0-9_-]{32,48}$/u);
    expect(secondSession.config.document.key).toMatch(/^[A-Za-z0-9_-]{32,48}$/u);
    expect(secondSession.config.document.key).not.toBe(
      firstSession.config.document.key
    );
  });

  it("writes saved ONLYOFFICE callback bytes back to the .docx file", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-save-"));
    const documentPath = join(projectRoot, "brief.docx");
    await writeFile(documentPath, Buffer.from("before-docx"));
    const savedBytes = Buffer.from("after-docx");
    const savedServer = await listen((request, response) => {
      if (request.url === "/saved.docx") {
        response.writeHead(200, {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        });
        response.end(savedBytes);
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const saveEvents: string[] = [];
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: "http://127.0.0.1:8082",
      onBeforeDocumentSave: ({ filePath }) => {
        saveEvents.push(`before:${filePath}`);
      },
      onAfterDocumentSave: ({ filePath }) => {
        saveEvents.push(`after:${filePath}`);
      }
    });
    services.push(service);

    const session = await service.createEditorSession({
      projectRoot,
      filePath: "brief.docx"
    });
    const response = await fetch(session.config.editorConfig.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: 2,
        url: `${savedServer.url}/saved.docx`
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ error: 0 });
    await expect(readFile(documentPath, "utf8")).resolves.toBe("after-docx");
    expect(saveEvents).toEqual(["before:brief.docx", "after:brief.docx"]);
  });

  it("rewrites loopback callback download URLs through the configured Document Server", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "zeroleaf-onlyoffice-loopback-save-")
    );
    const documentPath = join(projectRoot, "brief.docx");
    await writeFile(documentPath, Buffer.from("before-docx"));
    const savedBytes = Buffer.from("after-docx");
    const savedServer = await listen((request, response) => {
      if (request.url === "/cache/saved.docx") {
        response.writeHead(200, {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        });
        response.end(savedBytes);
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: savedServer.url
    });
    services.push(service);

    const session = await service.createEditorSession({
      projectRoot,
      filePath: "brief.docx"
    });
    const response = await fetch(session.config.editorConfig.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: 2,
        url: "http://127.0.0.1/cache/saved.docx"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ error: 0 });
    await expect(readFile(documentPath, "utf8")).resolves.toBe("after-docx");
  });

  it("exports an active ONLYOFFICE session to a project-local PDF", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-pdf-"));
    await writeFile(join(projectRoot, "findings.docx"), Buffer.from("docx"));
    const pdfBytes = Buffer.from("%PDF-1.7\n% ZeroLeaf test PDF\n");
    const conversionRequests: unknown[] = [];
    let documentServerUrl = "";
    const documentServer = await listen(async (request, response) => {
      if (request.url === "/coauthoring/CommandService.ashx") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: 1 }));
        return;
      }

      if (request.url?.startsWith("/converter") === true) {
        const body = await readRequestText(request);
        conversionRequests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            endConvert: true,
            fileUrl: `${documentServerUrl}/cache/findings.pdf`,
            percent: 100
          })
        );
        return;
      }

      if (request.url === "/cache/findings.pdf") {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(pdfBytes);
        return;
      }

      response.writeHead(404);
      response.end();
    });
    documentServerUrl = documentServer.url;
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: documentServer.url
    });
    services.push(service);
    const session = await service.createEditorSession({
      projectRoot,
      filePath: "findings.docx"
    });

    const result = await service.exportPdf(session.sessionId);

    expect(result.filePath).toBe("findings.docx");
    expect(result.pdfPath).toContain(".zeroleaf/word-pdf/findings-");
    await expect(readFile(result.pdfPath)).resolves.toEqual(pdfBytes);
    expect(conversionRequests).toHaveLength(1);
    expect(conversionRequests[0]).toMatchObject({
      async: false,
      filetype: "docx",
      outputtype: "pdf",
      title: "findings.docx"
    });
    expect(String((conversionRequests[0] as { readonly url?: unknown }).url)).toContain(
      "/onlyoffice/sessions/"
    );
  });

  it("rejects document paths outside the project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-root-"));
    const service = new OnlyOfficeBridgeService();
    services.push(service);

    await expect(
      service.createEditorSession({
        projectRoot,
        filePath: "../outside.docx"
      })
    ).rejects.toThrow(/outside/iu);
  });

  it("reports disabled status and blocks new sessions when disabled", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-disabled-"));
    await writeFile(join(projectRoot, "disabled.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService({ enabled: false });
    services.push(service);

    await expect(service.getStatus()).resolves.toMatchObject({
      configured: false,
      documentServerReachable: false,
      bridgeListening: false
    });
    await expect(
      service.createEditorSession({
        projectRoot,
        filePath: "disabled.docx"
      })
    ).rejects.toThrow(/disabled/iu);
  });

  it("points local development to the ONLYOFFICE start command when unreachable", async () => {
    const unavailableServer = await listen((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: unavailableServer.url
    });
    services.push(service);

    await expect(service.getStatus()).resolves.toMatchObject({
      configured: true,
      documentServerReachable: false,
      message:
        "ONLYOFFICE Document Server is not reachable. For local development, run npm run onlyoffice:start."
    });
  });

  it("restarts the bridge when callback port settings change", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-restart-"));
    await writeFile(join(projectRoot, "restart.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService();
    services.push(service);

    const firstSession = await service.createEditorSession({
      projectRoot,
      filePath: "restart.docx"
    });
    const firstPort = new URL(firstSession.config.document.url).port;

    await service.configure({
      bridgePublicBaseUrl: "http://127.0.0.1:27172",
      bridgeHost: "127.0.0.1",
      preferredPort: 27172
    });
    const secondSession = await service.createEditorSession({
      projectRoot,
      filePath: "restart.docx"
    });

    expect(new URL(secondSession.config.document.url).port).toBe("27172");
    expect(new URL(secondSession.config.document.url).port).not.toBe(firstPort);
  });

  it("blocks editor sessions when the public bridge URL is unreachable", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "zeroleaf-onlyoffice-bridge-health-")
    );
    await writeFile(join(projectRoot, "paper.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService({
      bridgePublicBaseUrl: "http://127.0.0.1:9"
    });
    services.push(service);

    await expect(
      service.createEditorSession({
        projectRoot,
        filePath: "paper.docx"
      })
    ).rejects.toThrow(/bridge callback URL is not reachable/iu);
  });

  it("extracts paragraph and table structure via a Document Builder round trip", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-structure-"));
    await writeFile(join(projectRoot, "report.docx"), Buffer.from("docx"));

    const rawElements = [
      {
        type: "paragraph",
        index: 0,
        text: "Executive Summary",
        styleName: "Heading 1",
        hasNonTextContent: false
      },
      {
        type: "table",
        index: 1,
        rowCount: 2,
        columnCount: 2,
        cells: [
          { rowIndex: 0, columnIndex: 0, text: "Name" },
          { rowIndex: 0, columnIndex: 1, text: "Score" },
          { rowIndex: 1, columnIndex: 0, text: "Ada" },
          { rowIndex: 1, columnIndex: 1, text: "97" }
        ]
      }
    ];
    const resultDocx = await buildStructureResultDocx(rawElements);

    const docBuilderRequests: Array<{ readonly url: unknown; readonly async: unknown }> =
      [];
    let documentServerUrl = "";
    const documentServer = await listen(async (request, response) => {
      if (request.url === "/docbuilder") {
        const body = JSON.parse(await readRequestText(request)) as {
          readonly url: unknown;
          readonly async: unknown;
        };
        docBuilderRequests.push(body);

        const scriptResponse = await fetch(String(body.url));
        const scriptText = await scriptResponse.text();
        expect(scriptResponse.status).toBe(200);
        expect(scriptText).toContain("builder.OpenFile(");
        expect(scriptText).toContain("/onlyoffice/sessions/");

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            key: "bld_test",
            end: true,
            urls: { "structure-result.docx": `${documentServerUrl}/structure-result.docx` }
          })
        );
        return;
      }

      if (request.url === "/structure-result.docx") {
        response.writeHead(200, {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        });
        response.end(resultDocx);
        return;
      }

      response.writeHead(404);
      response.end();
    });
    documentServerUrl = documentServer.url;
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: documentServer.url
    });
    services.push(service);

    const result = await service.extractWordStructure({
      projectRoot,
      filePath: "report.docx"
    });

    expect(docBuilderRequests).toHaveLength(1);
    expect(docBuilderRequests[0]?.async).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.structure).toHaveLength(2);

    const [heading, table] = result.structure;
    expect(heading).toMatchObject({
      type: "paragraph",
      text: "Executive Summary",
      headingLevel: 1,
      styleName: "Heading 1"
    });
    expect(heading?.id).toMatch(/^para-0-[0-9a-f]{12}$/u);

    expect(table).toMatchObject({ type: "table", rowCount: 2, columnCount: 2 });
    if (table?.type !== "table") {
      throw new Error("expected a table node");
    }
    expect(table.cells).toHaveLength(4);
    expect(table.cells.map((cell) => cell.text)).toEqual(["Name", "Score", "Ada", "97"]);
    expect(table.cells[0]?.id).toMatch(/^tbl-1-r0c0-[0-9a-f]{12}$/u);
  });

  it("degrades to an empty structure with a warning when disabled", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "zeroleaf-onlyoffice-structure-disabled-")
    );
    await writeFile(join(projectRoot, "report.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService({ enabled: false });
    services.push(service);

    const result = await service.extractWordStructure({
      projectRoot,
      filePath: "report.docx"
    });

    expect(result.structure).toEqual([]);
    expect(result.warnings[0]).toMatch(/disabled/iu);
  });

  it("degrades to an empty structure with a warning when Document Server is unreachable", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "zeroleaf-onlyoffice-structure-unreachable-")
    );
    await writeFile(join(projectRoot, "report.docx"), Buffer.from("docx"));
    const unavailableServer = await listen((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: unavailableServer.url
    });
    services.push(service);

    const result = await service.extractWordStructure({
      projectRoot,
      filePath: "report.docx"
    });

    expect(result.structure).toEqual([]);
    expect(result.warnings[0]).toMatch(/structure extraction (request failed|is unavailable)/iu);
  });

  it("applies table operations via a Document Builder round trip and writes the result to disk", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-table-write-"));
    const documentPath = join(projectRoot, "report.docx");
    await writeFile(documentPath, Buffer.from("before-docx"));

    const writtenBytes = Buffer.from("after-table-write");
    const docBuilderRequests: Array<{ readonly url: unknown; readonly async: unknown }> =
      [];
    let documentServerUrl = "";
    let capturedScript = "";
    const documentServer = await listen(async (request, response) => {
      if (request.url === "/docbuilder") {
        const body = JSON.parse(await readRequestText(request)) as {
          readonly url: unknown;
          readonly async: unknown;
        };
        docBuilderRequests.push(body);

        const scriptResponse = await fetch(String(body.url));
        capturedScript = await scriptResponse.text();
        expect(scriptResponse.status).toBe(200);

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            key: "bld_test",
            end: true,
            urls: {
              "table-write-result.docx": `${documentServerUrl}/table-write-result.docx`
            }
          })
        );
        return;
      }

      if (request.url === "/table-write-result.docx") {
        response.writeHead(200, {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        });
        response.end(writtenBytes);
        return;
      }

      response.writeHead(404);
      response.end();
    });
    documentServerUrl = documentServer.url;

    const saveEvents: string[] = [];
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: documentServer.url,
      onBeforeDocumentSave: ({ filePath }) => {
        saveEvents.push(`before:${filePath}`);
      },
      onAfterDocumentSave: ({ filePath }) => {
        saveEvents.push(`after:${filePath}`);
      }
    });
    services.push(service);

    const result = await service.applyWordTableOperations({
      projectRoot,
      filePath: "report.docx",
      operations: [
        {
          type: "replace-table-cell",
          tableId: "tbl-2-abc123def456",
          rowIndex: 0,
          columnIndex: 1,
          afterText: "Updated"
        }
      ]
    });

    expect(result).toEqual({ ok: true });
    expect(docBuilderRequests).toHaveLength(1);
    expect(docBuilderRequests[0]?.async).toBe(false);
    expect(capturedScript).toContain("builder.OpenFile(");
    expect(capturedScript).toContain('"elementIndex":2');
    expect(capturedScript).toContain('"type":"replace-table-cell"');
    await expect(readFile(documentPath, "utf8")).resolves.toBe("after-table-write");
    expect(saveEvents).toEqual(["before:report.docx", "after:report.docx"]);
  });

  it("rejects a table operation with a malformed table id without contacting the Document Server", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-onlyoffice-table-badid-"));
    await writeFile(join(projectRoot, "report.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService({
      documentServerUrl: "http://127.0.0.1:1"
    });
    services.push(service);

    const result = await service.applyWordTableOperations({
      projectRoot,
      filePath: "report.docx",
      operations: [{ type: "delete-table-row", tableId: "not-a-table-id", rowIndex: 0 }]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not a recognized structural table id/iu);
    }
  });

  it("returns an error for table operations when ONLYOFFICE is disabled", async () => {
    const service = new OnlyOfficeBridgeService({ enabled: false });
    services.push(service);

    const result = await service.applyWordTableOperations({
      projectRoot: "/tmp/does-not-matter",
      filePath: "report.docx",
      operations: [{ type: "delete-table-row", tableId: "tbl-0-aaa", rowIndex: 0 }]
    });

    expect(result).toEqual({ ok: false, error: "ONLYOFFICE integration is disabled." });
  });

  it("probes host.docker.internal bridge URLs through the local listener", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "zeroleaf-onlyoffice-docker-host-")
    );
    const bridgePort = await getUnusedPort();
    await writeFile(join(projectRoot, "paper.docx"), Buffer.from("docx"));
    const service = new OnlyOfficeBridgeService({
      bridgeHost: "0.0.0.0",
      bridgePublicBaseUrl: `http://host.docker.internal:${bridgePort}`,
      preferredPort: bridgePort
    });
    services.push(service);

    const session = await service.createEditorSession({
      projectRoot,
      filePath: "paper.docx"
    });

    expect(session.config.document.url).toContain("host.docker.internal");
    expect(session.config.editorConfig.callbackUrl).toContain("host.docker.internal");
  });
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Test server did not expose a TCP port.");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function buildStructureResultDocx(elements: readonly unknown[]): Promise<Buffer> {
  const startMarker = "__ZEROLEAF_STRUCTURE_JSON_START__";
  const endMarker = "__ZEROLEAF_STRUCTURE_JSON_END__";
  const payload = `${startMarker}${JSON.stringify(elements)}${endMarker}`;
  const archive = new JSZip();
  archive.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t xml:space=\"preserve\">" +
      escapeXmlText(payload) +
      "</w:t></w:r></w:p></w:body></w:document>"
  );
  return archive.generateAsync({ type: "nodebuffer" });
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
  });
  if (typeof address !== "object" || address === null) {
    throw new Error("Test server did not expose a TCP port.");
  }

  return address.port;
}
