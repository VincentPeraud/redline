import type { DesignSystemSummary } from "@redline/shared";

export function usedByLabel(designSystem: DesignSystemSummary): string {
  return designSystem.usedBy.length === 0
    ? "Utilisé par aucun projet"
    : `Utilisé par ${designSystem.usedBy.map((project) => (project.archived ? `${project.title} (archivé)` : project.title)).join(", ")}`;
}
