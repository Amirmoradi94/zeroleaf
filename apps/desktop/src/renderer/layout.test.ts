import { describe, expect, it } from "vitest";

import {
  clampPaneSizes,
  constrainWorkbenchLayoutToContentWidth,
  contentRowGutterWidth,
  initialWorkbenchLayout,
  paneConstraints,
  resizeWorkbenchPane
} from "./layout.js";

describe("workbench layout", () => {
  it("clamps pane sizes to stable editor bounds", () => {
    expect(
      clampPaneSizes({
        sidebarWidth: 10,
        pdfWidth: 2_000,
        agentWidth: 100,
        bottomPanelHeight: 900
      })
    ).toEqual({
      sidebarWidth: 220,
      pdfWidth: 1_400,
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

    expect(resizeWorkbenchPane("pdf", layout, { x: -1_000, y: 0 }).pdfWidth).toBe(
      1_400
    );
    expect(resizeWorkbenchPane("pdf", layout, { x: 400, y: 0 }).pdfWidth).toBe(320);
  });

  it("caps secondary panes so the source editor keeps a readable width", () => {
    const contentWidth = 1_502;
    const constrainedLayout = constrainWorkbenchLayoutToContentWidth(
      {
        ...initialWorkbenchLayout,
        pdfWidth: 1_000
      },
      contentWidth
    );

    const editorWidth =
      contentWidth -
      contentRowGutterWidth -
      constrainedLayout.pdfWidth -
      constrainedLayout.agentWidth;

    expect(editorWidth).toBeGreaterThanOrEqual(paneConstraints.editorWidth.min);
    expect(constrainedLayout.pdfWidth).toBeLessThan(1_000);
  });
});
