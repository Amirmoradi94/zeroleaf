export type ToolRiskLevel = "read" | "build" | "write" | "external" | "dangerous";

export function requiresApproval(riskLevel: ToolRiskLevel): boolean {
  return riskLevel !== "read";
}
