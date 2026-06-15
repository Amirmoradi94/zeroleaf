import {
  defaultWorkbenchLayout,
  type WorkbenchLayout
} from "@latex-agent/ipc-contracts";

export type ResizeTarget = "sidebar" | "pdf" | "agent" | "bottom";

export type ResizeDelta = {
  readonly x: number;
  readonly y: number;
};

export const paneConstraints = {
  sidebarWidth: { min: 220, max: 420 },
  pdfWidth: { min: 320, max: 1400 },
  agentWidth: { min: 340, max: 560 },
  bottomPanelHeight: { min: 140, max: 360 }
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampPaneSizes(layout: WorkbenchLayout): WorkbenchLayout {
  return {
    sidebarWidth: clamp(
      layout.sidebarWidth,
      paneConstraints.sidebarWidth.min,
      paneConstraints.sidebarWidth.max
    ),
    pdfWidth: clamp(
      layout.pdfWidth,
      paneConstraints.pdfWidth.min,
      paneConstraints.pdfWidth.max
    ),
    agentWidth: clamp(
      layout.agentWidth,
      paneConstraints.agentWidth.min,
      paneConstraints.agentWidth.max
    ),
    bottomPanelHeight: clamp(
      layout.bottomPanelHeight,
      paneConstraints.bottomPanelHeight.min,
      paneConstraints.bottomPanelHeight.max
    )
  };
}

export function resizeWorkbenchPane(
  target: ResizeTarget,
  startLayout: WorkbenchLayout,
  delta: ResizeDelta
): WorkbenchLayout {
  switch (target) {
    case "sidebar":
      return clampPaneSizes({
        ...startLayout,
        sidebarWidth: startLayout.sidebarWidth + delta.x
      });
    case "pdf":
      return clampPaneSizes({
        ...startLayout,
        pdfWidth: startLayout.pdfWidth - delta.x
      });
    case "agent":
      return clampPaneSizes({
        ...startLayout,
        agentWidth: startLayout.agentWidth - delta.x
      });
    case "bottom":
      return clampPaneSizes({
        ...startLayout,
        bottomPanelHeight: startLayout.bottomPanelHeight - delta.y
      });
  }
}

export const initialWorkbenchLayout = defaultWorkbenchLayout;
