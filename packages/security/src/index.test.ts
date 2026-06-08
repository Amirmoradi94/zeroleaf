import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { requiresApproval } from "./index.js";

describe("MVP security posture", () => {
  it("keeps dangerous tool classes approval-gated", () => {
    expect(requiresApproval("read")).toBe(false);
    expect(requiresApproval("build")).toBe(true);
    expect(requiresApproval("write")).toBe(true);
    expect(requiresApproval("external")).toBe(true);
    expect(requiresApproval("dangerous")).toBe(true);
  });

  it("keeps renderer sandboxed and shell escape disabled", async () => {
    const mainSource = await readFile(
      resolve("apps/desktop/src/main/index.ts"),
      "utf8"
    );
    const contractsSource = await readFile(
      resolve("packages/ipc-contracts/src/index.ts"),
      "utf8"
    );

    expect(mainSource).toContain("nodeIntegration: false");
    expect(mainSource).toContain("contextIsolation: true");
    expect(mainSource).toContain("sandbox: true");
    expect(mainSource).toContain(
      'webContents.setWindowOpenHandler(() => ({ action: "deny" }))'
    );
    expect(contractsSource).toContain("readonly shellEscape: false");
    expect(contractsSource).toContain("external-cli-login");
  });
});
