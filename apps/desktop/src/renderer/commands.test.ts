import { describe, expect, it } from "vitest";

import { commandDefinitions } from "./commands.js";

describe("commandDefinitions", () => {
  it("includes keyboard-accessible agent entry points", () => {
    expect(commandDefinitions).toContainEqual(
      expect.objectContaining({
        id: "focus-agent",
        title: "Focus Agent",
        group: "Agent",
        shortcut: "Cmd I"
      })
    );
    expect(commandDefinitions).toContainEqual(
      expect.objectContaining({
        id: "fix-top-diagnostic",
        title: "Fix Top Diagnostic with AI",
        group: "Agent"
      })
    );
  });
});
