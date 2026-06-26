import type { DesktopApi } from "@latex-agent/ipc-contracts";

declare global {
  type OnlyOfficeDocumentStateChangeEvent = {
    readonly data?: boolean;
  };

  type OnlyOfficeInfoEvent = {
    readonly data?: {
      readonly mode?: "view" | "edit";
    };
  };

  type OnlyOfficeErrorEvent = {
    readonly data?: unknown;
  };

  type OnlyOfficeEditorEvents = {
    readonly onDocumentReady?: () => void;
    readonly onDocumentStateChange?: (
      event: OnlyOfficeDocumentStateChangeEvent
    ) => void;
    readonly onError?: (event: OnlyOfficeErrorEvent) => void;
    readonly onInfo?: (event: OnlyOfficeInfoEvent) => void;
    readonly onOutdatedVersion?: () => void;
    readonly onRequestClose?: () => void;
    readonly onRequestRefreshFile?: () => void;
  };

  type OnlyOfficeDocEditorInstance = {
    destroyEditor?: () => void;
  };

  interface Window {
    readonly latexAgent?: DesktopApi;
    readonly DocsAPI?: {
      readonly DocEditor: new (
        elementId: string,
        config: unknown
      ) => OnlyOfficeDocEditorInstance;
    };
  }
}

export {};
