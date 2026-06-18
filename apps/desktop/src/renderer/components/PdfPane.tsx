import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PdfArtifactData } from "@latex-agent/ipc-contracts";
import { ChevronRight, PanelRight, Save, Search } from "lucide-react";

import { desktopApi } from "../desktopApi.js";
import { formatPdfStaleReason, type PdfStaleReason } from "../pdfPreviewModel.js";
import { IconButton } from "./IconButton.js";

export function PdfPane({
  artifact,
  buildRunning,
  canvasRefs,
  onCanvasClick,
  onDownload,
  onFitWidth,
  onNextPage,
  onPreviousPage,
  onRunSearch,
  onSearchQueryChange,
  onSearchNext,
  onSearchPrevious,
  onSourceToPdf,
  onZoomIn,
  onZoomOut,
  pageCount,
  pageNumber,
  projectRoot,
  searchActiveIndex,
  searchMatchCount,
  searchQuery,
  scale,
  stale,
  staleReason,
  syncTexTarget
}: {
  readonly artifact: PdfArtifactData | null;
  readonly buildRunning: boolean;
  readonly canvasRefs: RefObject<Map<number, HTMLCanvasElement>>;
  readonly onCanvasClick: (page: number, x: number, y: number) => void;
  readonly onDownload: () => void;
  readonly onFitWidth: () => void;
  readonly onNextPage: () => void;
  readonly onPreviousPage: () => void;
  readonly onRunSearch: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSearchNext: () => void;
  readonly onSearchPrevious: () => void;
  readonly onSourceToPdf: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly pageCount: number;
  readonly pageNumber: number;
  readonly projectRoot: string | undefined;
  readonly searchActiveIndex: number;
  readonly searchMatchCount: number;
  readonly searchQuery: string;
  readonly scale: number;
  readonly stale: boolean;
  readonly staleReason: PdfStaleReason | null;
  readonly syncTexTarget: {
    readonly page: number;
    readonly x?: number;
    readonly y?: number;
  } | null;
}) {
  const paneRef = useRef<HTMLElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pageNumbers = useMemo(
    () =>
      Array.from({ length: pageCount }, (_value, index) => {
        return index + 1;
      }),
    [pageCount]
  );

  useEffect(() => {
    pageRefs.current.get(pageNumber)?.scrollIntoView({
      block: "start",
      behavior: "smooth"
    });
  }, [pageNumber]);

  useEffect(() => {
    const pane = paneRef.current;

    if (pane === null || projectRoot === undefined) {
      return;
    }

    let animationFrame: number | null = null;

    const reportBounds = () => {
      const bounds = pane.getBoundingClientRect();

      void desktopApi.pdf.reportPreviewBounds({
        projectRoot,
        bounds:
          artifact === null
            ? null
            : {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
              },
        ...(artifact?.pdfPath === undefined ? {} : { pdfPath: artifact.pdfPath }),
        pageNumber,
        pageCount,
        stale,
        ...(staleReason === null ? {} : { reason: formatPdfStaleReason(staleReason) })
      });
    };

    const scheduleReport = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        reportBounds();
      });
    };

    scheduleReport();
    const resizeObserver = new ResizeObserver(scheduleReport);
    resizeObserver.observe(pane);
    window.addEventListener("resize", scheduleReport);
    window.addEventListener("scroll", scheduleReport, true);

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleReport);
      window.removeEventListener("scroll", scheduleReport, true);
      void desktopApi.pdf.reportPreviewBounds({
        projectRoot,
        bounds: null,
        pageNumber,
        pageCount,
        stale
      });
    };
  }, [artifact, pageCount, pageNumber, projectRoot, stale, staleReason]);

  const registerPageRef = useCallback(
    (page: number) => (node: HTMLDivElement | null) => {
      if (node === null) {
        pageRefs.current.delete(page);
        return;
      }

      pageRefs.current.set(page, node);
    },
    []
  );
  const registerCanvasRef = useCallback(
    (page: number) => (node: HTMLCanvasElement | null) => {
      if (node === null) {
        canvasRefs.current?.delete(page);
        return;
      }

      canvasRefs.current?.set(page, node);
    },
    [canvasRefs]
  );

  return (
    <section className="pdf-pane" aria-label="PDF preview" ref={paneRef}>
      <div className="pane-title">
        <PanelRight aria-hidden="true" size={16} />
        <span>PDF Preview</span>
        {stale && (
          <span className="pdf-state">{formatPdfStaleReason(staleReason)}</span>
        )}
      </div>
      <div className="pdf-toolbar" aria-label="PDF toolbar">
        <button
          className="icon-button"
          type="button"
          aria-label="Previous page"
          title="Previous page"
          disabled={pageNumber <= 1}
          onClick={onPreviousPage}
        >
          <ChevronRight className="flip-icon" size={15} />
        </button>
        <span className="pdf-page-indicator">
          {pageCount === 0 ? "0 / 0" : `${pageNumber} / ${pageCount}`}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label="Next page"
          title="Next page"
          disabled={pageNumber >= pageCount}
          onClick={onNextPage}
        >
          <ChevronRight size={15} />
        </button>
        <IconButton label="Zoom out" onClick={onZoomOut}>
          <span className="toolbar-icon-text" aria-hidden="true">
            -
          </span>
        </IconButton>
        <span className="zoom-label">{Math.round(scale * 100)}%</span>
        <IconButton label="Zoom in" onClick={onZoomIn}>
          <span className="toolbar-icon-text" aria-hidden="true">
            +
          </span>
        </IconButton>
        <IconButton label="Fit PDF width" onClick={onFitWidth}>
          <span className="toolbar-icon-text compact" aria-hidden="true">
            Fit
          </span>
        </IconButton>
        <input
          className="pdf-search-input"
          aria-label="Search PDF"
          value={searchQuery}
          placeholder="Search PDF"
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRunSearch();
            }
          }}
        />
        <IconButton
          label="Search PDF"
          disabled={artifact === null}
          onClick={onRunSearch}
        >
          <Search aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Previous PDF match"
          disabled={artifact === null || searchMatchCount === 0}
          onClick={onSearchPrevious}
        >
          <ChevronRight className="flip-icon" aria-hidden="true" size={15} />
        </IconButton>
        <span className="pdf-search-count" aria-label="PDF search result count">
          {searchMatchCount === 0
            ? "0 / 0"
            : `${searchActiveIndex + 1} / ${searchMatchCount}`}
        </span>
        <IconButton
          label="Next PDF match"
          disabled={artifact === null || searchMatchCount === 0}
          onClick={onSearchNext}
        >
          <ChevronRight aria-hidden="true" size={15} />
        </IconButton>
        <IconButton
          label="Source to PDF"
          disabled={artifact === null}
          onClick={onSourceToPdf}
        >
          <ChevronRight aria-hidden="true" size={15} />
        </IconButton>
        <IconButton label="Save PDF" disabled={artifact === null} onClick={onDownload}>
          <Save aria-hidden="true" size={15} />
        </IconButton>
      </div>
      <div className="pdf-canvas">
        {artifact === null ? (
          <div className="pdf-empty">
            <PanelRight aria-hidden="true" size={24} />
            <p>{buildRunning ? "Compiling..." : "Compile to preview the PDF."}</p>
          </div>
        ) : (
          <div className="pdf-document">
            {pageNumbers.map((page) => (
              <div
                className="pdf-page-wrap"
                key={page}
                ref={registerPageRef(page)}
                aria-label={`PDF page ${page}`}
              >
                <canvas
                  ref={registerCanvasRef(page)}
                  className="pdf-page-canvas"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onCanvasClick(
                      page,
                      (event.clientX - rect.left) / scale,
                      (event.clientY - rect.top) / scale
                    );
                  }}
                />
                {syncTexTarget?.page === page &&
                  syncTexTarget.x !== undefined &&
                  syncTexTarget.y !== undefined && (
                    <span
                      className="synctex-marker"
                      style={{
                        left: `${syncTexTarget.x * scale}px`,
                        top: `${syncTexTarget.y * scale}px`
                      }}
                      aria-hidden="true"
                    />
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
