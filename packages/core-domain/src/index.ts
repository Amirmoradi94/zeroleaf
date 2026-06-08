export type PackageLayer =
  | "app"
  | "domain"
  | "ipc"
  | "service"
  | "agent"
  | "provider"
  | "security"
  | "ui";

export type PackageBoundary = {
  readonly name: string;
  readonly layer: PackageLayer;
};

export function describePackageBoundary(boundary: PackageBoundary): string {
  return `${boundary.name}:${boundary.layer}`;
}
