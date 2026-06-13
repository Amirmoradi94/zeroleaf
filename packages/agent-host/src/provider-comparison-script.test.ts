import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("agent provider comparison harness", () => {
  it("defaults to comparing Codex and Claude and records provider results independently", async () => {
    const source = await readFile(
      fileURLToPath(
        new URL("../../../scripts/agent-provider-comparison.mjs", import.meta.url)
      ),
      "utf8"
    );

    expect(source).toContain(
      'parseListArg("--providers", ["openai-codex", "anthropic-claude"])'
    );
    expect(source).toContain("for (const providerId of providers)");
    expect(source).toContain("try {");
    expect(source).toContain("} catch (error) {");
    expect(source).toContain("results.push({");
    expect(source).toContain("message: getErrorMessage(error)");
    expect(source).toContain("console.log(`FAIL ${providerId}: ${start.status}`)");
    expect(source).toContain("continue;");
    expect(source).toContain("passedRealProviderResults");
    expect(source).toContain("realProviderSignaturesMatch");
  });
});
