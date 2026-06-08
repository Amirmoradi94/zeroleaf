import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: appRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@latex-agent/ipc-contracts": `${workspaceRoot}/packages/ipc-contracts/src/index.ts`,
      "@latex-agent/ui": `${workspaceRoot}/packages/ui/src/index.ts`
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false
  }
});
