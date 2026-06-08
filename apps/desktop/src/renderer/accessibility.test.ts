import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererDir = dirname(fileURLToPath(import.meta.url));

describe("renderer accessibility hardening", () => {
  it("keeps visible focus styling and high-contrast light mode", async () => {
    const styles = await readFile(join(rendererDir, "styles.css"), "utf8");

    expect(styles).toContain(":focus-visible");
    expect(styles).toContain(".app-shell.high-contrast-light");
    expect(styles).toContain("outline:");
  });

  it("keeps icon buttons labelled and major regions named", async () => {
    const appSource = await readFile(join(rendererDir, "App.tsx"), "utf8");

    expect(appSource).toContain("aria-label={label}");
    expect(appSource).toContain('aria-label="Project files"');
    expect(appSource).toContain('aria-label="Source editor"');
    expect(appSource).toContain('aria-label="PDF preview"');
    expect(appSource).toContain('aria-label="AI agent"');
    expect(appSource).toContain('aria-label="Bottom panel"');
  });
});
