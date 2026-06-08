import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("App renderer shell", () => {
  it("renders the primary workbench and lifecycle entry points", async () => {
    globalThis.window = {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined
      }
    } as unknown as Window & typeof globalThis;
    globalThis.DOMMatrix = class DOMMatrix {} as unknown as typeof DOMMatrix;
    globalThis.ImageData = class ImageData {} as unknown as typeof ImageData;
    globalThis.Path2D = class Path2D {} as unknown as typeof Path2D;

    const { App } = await import("./App.js");
    const html = renderToString(<App />);

    expect(html).toContain("AI LaTeX Editor");
    expect(html).toContain("Command Palette");
    expect(html).toContain("Open Folder");
    expect(html).toContain("Import ZIP");
    expect(html).toContain("Create Project");
    expect(html).toContain("PDF Preview");
    expect(html).toContain("Agent");
  }, 20_000);
});
