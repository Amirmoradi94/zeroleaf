import { describe, expect, it } from "vitest";

import { defaultWorkbenchLayout, ipcChannels } from "./index.js";

describe("ipc contracts", () => {
  it("exposes a stable app info channel", () => {
    expect(ipcChannels.appGetInfo).toBe("app.getInfo");
  });

  it("defines default workbench pane sizes", () => {
    expect(defaultWorkbenchLayout.sidebarWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.pdfWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.agentWidth).toBeGreaterThan(0);
    expect(defaultWorkbenchLayout.bottomPanelHeight).toBeGreaterThan(0);
  });
});
