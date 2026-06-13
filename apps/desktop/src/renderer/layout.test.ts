import { describe, expect, it } from "vitest";

import {
  clampPaneSizes,
  initialWorkbenchLayout,
  resizeWorkbenchPane
} from "./layout.js";

describe("workbench layout", () => {
  it("clamps pane sizes to stable editor bounds", () => {
    expect(
      clampPaneSizes({
        sidebarWidth: 10,
        pdfWidth: 900,
        agentWidth: 100,
        bottomPanelHeight: 900
      })
    ).toEqual({
      sidebarWidth: 220,
      pdfWidth: 720,
      agentWidth: 340,
      bottomPanelHeight: 360
    });
  });

  it("resizes the sidebar from the separator delta", () => {
    expect(
      resizeWorkbenchPane("sidebar", initialWorkbenchLayout, { x: 24, y: 0 })
        .sidebarWidth
    ).toBe(initialWorkbenchLayout.sidebarWidth + 24);
  });

  it("resizes the PDF preview from the left separator delta", () => {
    const layout = {
      ...initialWorkbenchLayout,
      pdfWidth: 560
    };

    expect(resizeWorkbenchPane("pdf", layout, { x: -40, y: 0 }).pdfWidth).toBe(600);
    expect(resizeWorkbenchPane("pdf", layout, { x: 40, y: 0 }).pdfWidth).toBe(520);
  });

  it("keeps PDF preview resizing within stable pane bounds", () => {
    const layout = {
      ...initialWorkbenchLayout,
      pdfWidth: 560
    };

    expect(resizeWorkbenchPane("pdf", layout, { x: -400, y: 0 }).pdfWidth).toBe(720);
    expect(resizeWorkbenchPane("pdf", layout, { x: 400, y: 0 }).pdfWidth).toBe(320);
  });
});
