import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BrowserWindow } from "electron";
import type {
  PdfPreviewBounds,
  PdfPreviewCaptureResult,
  PdfPreviewCaptureState
} from "@latex-agent/ipc-contracts";

type ReportedPdfPreviewState = PdfPreviewCaptureState & {
  readonly webContentsId: number;
};

export class PdfPreviewCaptureStore {
  private activeState: ReportedPdfPreviewState | undefined;

  report(webContentsId: number, request: PdfPreviewCaptureState) {
    if (request.bounds === null) {
      if (
        this.activeState?.webContentsId === webContentsId &&
        this.activeState.projectRoot === request.projectRoot
      ) {
        this.activeState = undefined;
      }

      return;
    }

    this.activeState = {
      ...request,
      webContentsId
    };
  }

  async capture(projectRoot: string): Promise<PdfPreviewCaptureResult> {
    const state = this.activeState;

    if (state === undefined || state.projectRoot !== projectRoot) {
      throw new Error("No live PDF preview is available for this project.");
    }

    if (state.bounds === null) {
      throw new Error("The PDF preview bounds are not available yet.");
    }

    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === state.webContentsId
    );

    if (window === undefined || window.isDestroyed()) {
      throw new Error("The PDF preview window is no longer available.");
    }

    const rect = normalizePdfPreviewCaptureBounds(state.bounds);
    const image = await window.capturePage(rect);
    const png = image.toPNG();
    const capturedAt = new Date().toISOString();
    const captureDir = join(projectRoot, ".latex-agent", "visual-captures");
    await mkdir(captureDir, { recursive: true });
    const imagePath = join(
      captureDir,
      `pdf-preview-${capturedAt.replace(/[:.]/gu, "-")}.png`
    );
    await writeFile(imagePath, png);
    const size = image.getSize();

    return {
      projectRoot,
      imagePath,
      mimeType: "image/png",
      byteLength: png.byteLength,
      width: size.width,
      height: size.height,
      pageNumber: state.pageNumber,
      pageCount: state.pageCount,
      stale: state.stale,
      ...(state.pdfPath === undefined ? {} : { pdfPath: state.pdfPath }),
      capturedAt
    };
  }
}

function normalizePdfPreviewCaptureBounds(bounds: PdfPreviewBounds) {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));

  if (width < 80 || height < 80) {
    throw new Error("The PDF preview is too small to capture.");
  }

  return { x, y, width, height };
}
