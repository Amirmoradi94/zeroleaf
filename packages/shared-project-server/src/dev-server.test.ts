import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("shared project dev server entrypoint", () => {
  it("keeps the desktop default URL and persistent store configurable", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./dev-server.ts", import.meta.url)),
      "utf8"
    );
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
    ) as { readonly scripts: Record<string, string> };
    const rootPackageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../../package.json", import.meta.url)),
        "utf8"
      )
    ) as { readonly scripts: Record<string, string> };

    expect(source).toContain('const defaultHost = "127.0.0.1";');
    expect(source).toContain("const defaultPort = 3768;");
    expect(source).toContain("ZEROLEAF_SHARED_PROJECT_HOST");
    expect(source).toContain("ZEROLEAF_SHARED_PROJECT_PORT");
    expect(source).toContain("ZEROLEAF_SHARED_PROJECT_DATA_PATH");
    expect(source).toContain(".zeroleaf");
    expect(source).toContain("shared-projects.json");
    expect(packageJson.scripts.dev).toBe("tsx src/dev-server.ts");
    expect(rootPackageJson.scripts["shared:start"]).toBe(
      "npm run dev --workspace @latex-agent/shared-project-server"
    );
  });
});
