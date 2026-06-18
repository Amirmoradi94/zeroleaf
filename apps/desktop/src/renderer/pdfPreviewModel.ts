export type PdfStaleReason = "unsaved" | "saved" | "external";

export function formatPdfStaleReason(reason: PdfStaleReason | null): string {
  switch (reason) {
    case "unsaved":
      return "Stale: unsaved source changes";
    case "saved":
      return "Stale: saved source newer than PDF";
    case "external":
      return "Stale: project changed outside editor";
    case null:
      return "Stale";
  }
}
