import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Play, RefreshCw, Settings, X } from "lucide-react";

import { desktopApi } from "../desktopApi.js";

type OnlyOfficePaneState =
  | {
      readonly kind: "loading";
      readonly message: string;
    }
  | {
      readonly kind: "ready";
      readonly sessionId: string;
      readonly documentServerUrl: string;
      readonly config: unknown;
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly message: string;
    };

export function OnlyOfficeWordEditorPane({
  displayName,
  filePath,
  projectRoot,
  onClose,
  onDirtyStateChange,
  onExportPdf,
  onOpenSettings,
  readOnly = false,
  onSessionStateChange,
  onStatusMessage
}: {
  readonly displayName: string;
  readonly filePath: string;
  readonly projectRoot: string | undefined;
  readonly onClose: () => void;
  readonly onDirtyStateChange: (filePath: string, dirty: boolean) => void;
  readonly onExportPdf: (filePath: string, sessionId: string) => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly readOnly?: boolean;
  readonly onSessionStateChange: (filePath: string, sessionId: string | null) => void;
  readonly onStatusMessage: (message: string) => void;
}) {
  const editorElementId = useOnlyOfficeElementId();
  const [state, setState] = useState<OnlyOfficePaneState>({
    kind: "loading",
    message: "Preparing ONLYOFFICE editor..."
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [exportRunning, setExportRunning] = useState(false);
  const editorInstanceRef = useRef<OnlyOfficeDocEditorInstance | null>(null);
  const dirtyRef = useRef(false);
  const stateRef = useRef<OnlyOfficePaneState>(state);
  const onCloseRef = useLatestRef(onClose);
  const onDirtyStateChangeRef = useLatestRef(onDirtyStateChange);
  const onExportPdfRef = useLatestRef(onExportPdf);
  const onSessionStateChangeRef = useLatestRef(onSessionStateChange);
  const onStatusMessageRef = useLatestRef(onStatusMessage);
  const sessionKey = state.kind === "ready" ? state.sessionId : "";

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setDirty = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      onDirtyStateChangeRef.current(filePath, dirty);
    },
    [filePath, onDirtyStateChangeRef]
  );

  const destroyEditor = useCallback(() => {
    editorInstanceRef.current?.destroyEditor?.();
    editorInstanceRef.current = null;
  }, []);

  const requestReload = useCallback(
    (message: string) => {
      destroyEditor();
      setDirty(false);
      onSessionStateChangeRef.current(filePath, null);
      setState({
        kind: "loading",
        message
      });
      setReloadNonce((nonce) => nonce + 1);
      onStatusMessageRef.current(message);
    },
    [destroyEditor, filePath, onSessionStateChangeRef, onStatusMessageRef, setDirty]
  );

  const forceSaveSession = useCallback(
    async (sessionId: string) => {
      const result = await desktopApi.onlyOffice.forceSave({ sessionId });
      const message = result.message;
      setState((currentState) =>
        currentState.kind === "ready"
          ? {
              ...currentState,
              message
            }
          : currentState
      );
      onStatusMessageRef.current(message);
      if (result.requested) {
        setDirty(false);
      }
      return result;
    },
    [onStatusMessageRef, setDirty]
  );

  const exportPdf = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState.kind !== "ready" || exportRunning) {
      return;
    }

    setExportRunning(true);
    const message = "Converting Word document to PDF...";
    setState((stateValue) =>
      stateValue.kind === "ready"
        ? {
            ...stateValue,
            message
          }
        : stateValue
    );
    onStatusMessageRef.current(message);
    void onExportPdfRef
      .current(filePath, currentState.sessionId)
      .catch((error) => {
        const errorMessage = getErrorMessage(error);
        setState((stateValue) =>
          stateValue.kind === "ready"
            ? {
                ...stateValue,
                message: errorMessage
              }
            : stateValue
        );
        onStatusMessageRef.current(errorMessage);
      })
      .finally(() => setExportRunning(false));
  }, [exportRunning, filePath, onExportPdfRef, onStatusMessageRef]);

  useEffect(() => {
    let cancelled = false;

    async function createOnlyOfficeSession() {
      if (projectRoot === undefined) {
        const message = "Open a project before starting ONLYOFFICE.";
        setState({
          kind: "unavailable",
          message
        });
        onSessionStateChangeRef.current(filePath, null);
        onStatusMessageRef.current(message);
        setDirty(false);
        return;
      }

      setState({
        kind: "loading",
        message: "Starting ONLYOFFICE editor session..."
      });
      onSessionStateChangeRef.current(filePath, null);

      try {
        const status = await desktopApi.onlyOffice.getStatus();
        if (!status.configured || !status.documentServerReachable) {
          throw new Error(status.message);
        }

        const session = await desktopApi.onlyOffice.createSession({
          projectRoot,
          filePath
        });
        if (cancelled) {
          return;
        }

        setState({
          kind: "ready",
          sessionId: session.sessionId,
          documentServerUrl: session.documentServerUrl,
          config: session.config,
          message: "ONLYOFFICE editor session is ready."
        });
        onSessionStateChangeRef.current(filePath, session.sessionId);
        onStatusMessageRef.current("ONLYOFFICE editor session is ready.");
      } catch (error) {
        if (!cancelled) {
          const message = getErrorMessage(error);
          setState({
            kind: "unavailable",
            message
          });
          onSessionStateChangeRef.current(filePath, null);
          onStatusMessageRef.current(message);
          setDirty(false);
        }
      }
    }

    void createOnlyOfficeSession();

    return () => {
      cancelled = true;
    };
  }, [
    filePath,
    onSessionStateChangeRef,
    onStatusMessageRef,
    projectRoot,
    reloadNonce,
    setDirty
  ]);

  useEffect(() => {
    if (state.kind !== "ready") {
      return undefined;
    }

    const readyState = state;
    let cancelled = false;

    async function mountOnlyOfficeEditor() {
      try {
        await loadOnlyOfficeApi(readyState.documentServerUrl);
        if (cancelled) {
          return;
        }

        destroyEditor();
        editorInstanceRef.current = new window.DocsAPI!.DocEditor(
          editorElementId,
          withOnlyOfficeEvents(withOnlyOfficeReadOnly(readyState.config, readOnly), {
            onDocumentReady: () => {
              const message = readOnly
                ? "ONLYOFFICE document is ready in read-only mode."
                : "ONLYOFFICE document is ready.";
              setState((currentState) =>
                currentState.kind === "ready"
                  ? {
                      ...currentState,
                      message
                    }
                  : currentState
              );
              onStatusMessageRef.current(message);
              focusOnlyOfficeFrame(editorElementId);
            },
            onDocumentStateChange: (event) => {
              if (readOnly) {
                setDirty(false);
                return;
              }

              const dirty = event.data === true;
              setDirty(dirty);
              const message = dirty
                ? "Word document has unsaved ONLYOFFICE changes."
                : "Word changes were sent to ONLYOFFICE service.";
              setState((currentState) =>
                currentState.kind === "ready"
                  ? {
                      ...currentState,
                      message
                    }
                  : currentState
              );
              onStatusMessageRef.current(message);
            },
            onError: (event) => {
              const detail = formatOnlyOfficeErrorData(event.data);
              const message = `ONLYOFFICE error${detail.length === 0 ? "" : `: ${detail}`}`;
              setState({
                kind: "unavailable",
                message
              });
              onStatusMessageRef.current(message);
              onSessionStateChangeRef.current(filePath, null);
            },
            onInfo: (event) => {
              const mode = event.data?.mode;
              const message =
                mode === undefined
                  ? "ONLYOFFICE editor opened."
                  : `ONLYOFFICE editor opened in ${mode} mode.`;
              setState((currentState) =>
                currentState.kind === "ready"
                  ? {
                      ...currentState,
                      message
                    }
                  : currentState
              );
              onStatusMessageRef.current(message);
            },
            onOutdatedVersion: () => {
              requestReload("ONLYOFFICE requested a fresh document version.");
            },
            onRequestClose: () => {
              void (async () => {
                const currentState = stateRef.current;
                if (currentState.kind === "ready" && dirtyRef.current) {
                  await forceSaveSession(currentState.sessionId);
                }
                destroyEditor();
                onCloseRef.current();
              })();
            },
            onRequestRefreshFile: () => {
              requestReload("ONLYOFFICE requested a refreshed document session.");
            }
          })
        );
      } catch (error) {
        if (!cancelled) {
          const message = getErrorMessage(error);
          setState({
            kind: "unavailable",
            message
          });
          onStatusMessageRef.current(message);
          onSessionStateChangeRef.current(filePath, null);
        }
      }
    }

    void mountOnlyOfficeEditor();

    return () => {
      cancelled = true;
      destroyEditor();
    };
  }, [
    destroyEditor,
    editorElementId,
    filePath,
    forceSaveSession,
    onCloseRef,
    onSessionStateChangeRef,
    onStatusMessageRef,
    readOnly,
    requestReload,
    sessionKey,
    setDirty
  ]);

  useEffect(() => {
    return () => {
      destroyEditor();
      onSessionStateChangeRef.current(filePath, null);
      onDirtyStateChangeRef.current(filePath, false);
    };
  }, [destroyEditor, filePath, onDirtyStateChangeRef, onSessionStateChangeRef]);

  if (state.kind === "unavailable") {
    return (
      <div className="word-editor word-editor--setup" aria-label="Word document editor">
        <div className="word-editor__header">
          <div>
            <span className="eyebrow">ONLYOFFICE Word</span>
            <h3>{displayName}</h3>
          </div>
          <button className="secondary-button" type="button" onClick={onClose}>
            <X aria-hidden="true" size={14} />
            Close
          </button>
        </div>
        <div className="onlyoffice-setup-panel" role="status">
          <h3>ONLYOFFICE is unavailable</h3>
          <p>{state.message}</p>
          <div className="settings-action-row">
            <button
              className="text-button settings-action"
              type="button"
              onClick={() => requestReload("Retrying ONLYOFFICE editor session...")}
            >
              <RefreshCw aria-hidden="true" size={15} />
              Retry
            </button>
            <button
              className="text-button settings-action"
              type="button"
              onClick={onOpenSettings}
            >
              <Settings aria-hidden="true" size={15} />
              Open Word Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="word-editor word-editor--onlyoffice"
      aria-label="Word document editor"
    >
      <div className="onlyoffice-word-command-bar" aria-label="Word document actions">
        <button
          className="icon-button onlyoffice-compile-button"
          type="button"
          aria-label="Compile Word document to PDF"
          title="Compile Word document to PDF"
          disabled={state.kind !== "ready" || exportRunning}
          onClick={exportPdf}
        >
          <Play aria-hidden="true" size={15} />
        </button>
      </div>
      <div className="onlyoffice-editor-shell">
        {state.kind === "ready" ? (
          <div className="onlyoffice-editor-frame" id={editorElementId} />
        ) : (
          <div className="onlyoffice-loading-panel">{state.message}</div>
        )}
      </div>
    </div>
  );
}

const onlyOfficeApiPromises = new Map<string, Promise<void>>();

function useOnlyOfficeElementId(): string {
  return `onlyoffice-${useId().replace(/[^A-Za-z0-9_-]/gu, "")}`;
}

function useLatestRef<TValue>(value: TValue) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}

async function loadOnlyOfficeApi(documentServerUrl: string): Promise<void> {
  if (window.DocsAPI !== undefined) {
    return;
  }

  const normalizedUrl = documentServerUrl.replace(/\/+$/u, "");
  const scriptUrl = `${normalizedUrl}/web-apps/apps/api/documents/api.js`;
  const existingPromise = onlyOfficeApiPromises.get(scriptUrl);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      if (window.DocsAPI === undefined) {
        rejectPromise(new Error("ONLYOFFICE API script loaded without DocsAPI."));
        return;
      }
      resolvePromise();
    };
    script.onerror = () => {
      rejectPromise(new Error(`Unable to load ONLYOFFICE API from ${normalizedUrl}.`));
    };
    document.head.appendChild(script);
  });
  onlyOfficeApiPromises.set(scriptUrl, promise);

  return promise;
}

function formatOnlyOfficeErrorData(data: unknown): string {
  if (data === undefined || data === null) {
    return "";
  }

  if (typeof data === "string" || typeof data === "number") {
    return String(data);
  }

  if (typeof data !== "object") {
    return String(data);
  }

  const record = data as Readonly<Record<string, unknown>>;
  const code =
    typeof record["errorCode"] === "number" || typeof record["errorCode"] === "string"
      ? String(record["errorCode"])
      : undefined;
  const description =
    typeof record["errorDescription"] === "string"
      ? record["errorDescription"]
      : typeof record["message"] === "string"
        ? record["message"]
        : undefined;

  if (code !== undefined && description !== undefined) {
    return `${code}: ${description}`;
  }

  if (description !== undefined) {
    return description;
  }

  if (code !== undefined) {
    return code;
  }

  return JSON.stringify(data);
}

function withOnlyOfficeEvents(
  config: unknown,
  events: OnlyOfficeEditorEvents
): unknown {
  const configRecord =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>)
      : {};
  const existingEvents =
    typeof configRecord["events"] === "object" && configRecord["events"] !== null
      ? (configRecord["events"] as Record<string, unknown>)
      : {};

  return {
    ...configRecord,
    events: {
      ...existingEvents,
      ...events
    }
  };
}

function withOnlyOfficeReadOnly(config: unknown, readOnly: boolean): unknown {
  if (!readOnly) {
    return config;
  }

  const configRecord =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>)
      : {};
  const documentRecord =
    typeof configRecord["document"] === "object" && configRecord["document"] !== null
      ? (configRecord["document"] as Record<string, unknown>)
      : {};
  const permissionsRecord =
    typeof documentRecord["permissions"] === "object" &&
    documentRecord["permissions"] !== null
      ? (documentRecord["permissions"] as Record<string, unknown>)
      : {};
  const editorConfigRecord =
    typeof configRecord["editorConfig"] === "object" &&
    configRecord["editorConfig"] !== null
      ? (configRecord["editorConfig"] as Record<string, unknown>)
      : {};

  return {
    ...configRecord,
    document: {
      ...documentRecord,
      permissions: {
        ...permissionsRecord,
        edit: false,
        download: true,
        print: true
      }
    },
    editorConfig: {
      ...editorConfigRecord,
      mode: "view"
    }
  };
}

function focusOnlyOfficeFrame(editorElementId: string) {
  window.setTimeout(() => {
    const container = document.getElementById(editorElementId);
    const frame = container?.querySelector("iframe");
    frame?.focus();
  }, 0);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
