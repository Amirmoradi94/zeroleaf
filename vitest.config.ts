import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@latex-agent/ipc-contracts": fileURLToPath(
        new URL("./packages/ipc-contracts/src/index.ts", import.meta.url)
      ),
      "@latex-agent/history-service": fileURLToPath(
        new URL("./packages/history-service/src/index.ts", import.meta.url)
      ),
      "@latex-agent/latex-service": fileURLToPath(
        new URL("./packages/latex-service/src/index.ts", import.meta.url)
      ),
      "@latex-agent/project-service": fileURLToPath(
        new URL("./packages/project-service/src/index.ts", import.meta.url)
      ),
      "@latex-agent/ui": fileURLToPath(
        new URL("./packages/ui/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    globals: false,
    environment: "node",
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
