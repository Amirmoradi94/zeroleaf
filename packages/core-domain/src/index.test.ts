import { describe, expect, it } from "vitest";
import { describePackageBoundary } from "./index.js";

describe("describePackageBoundary", () => {
  it("formats a package boundary for diagnostics", () => {
    expect(describePackageBoundary({ name: "core-domain", layer: "domain" })).toBe(
      "core-domain:domain"
    );
  });
});
