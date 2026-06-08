import type { DesktopApi } from "@latex-agent/ipc-contracts";

declare global {
  interface Window {
    readonly latexAgent?: DesktopApi;
  }
}

export {};
