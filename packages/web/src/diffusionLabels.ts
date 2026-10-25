import type { DiffusionDiff } from "@redline/shared";

export function projectCountLabel(count: number): string {
  return `${count} projet${count > 1 ? "s" : ""}`;
}

export function diffusionToastMessage(number: number, projects: number): string {
  return `Diffusion ${number} envoyée à ${projectCountLabel(projects)}`;
}

const countOf = (group: Record<string, unknown[]>) => Object.values(group).reduce((sum, items) => sum + items.length, 0);

/** "1 token et 2 composants modifiés": what the draft changes compared with the current diffusion. */
export function pendingChangesLabel(diff: DiffusionDiff): string {
  const tokens = countOf(diff.tokens);
  const components = countOf(diff.components);
  const parts = [
    ...(tokens > 0 ? [`${tokens} token${tokens > 1 ? "s" : ""}`] : []),
    ...(components > 0 ? [`${components} composant${components > 1 ? "s" : ""}`] : []),
    ...(diff.designMdChanged ? ["DESIGN.md"] : []),
  ];
  const plural = parts.length > 1 || tokens > 1 || components > 1;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}` : parts[0];
  return `${list} modifié${plural ? "s" : ""}`;
}

/** The line of the "Pas encore diffusé" card: the changes and how many projects follow the design system. */
export function pendingCardLabel(diff: DiffusionDiff, projects: number): string {
  return `${pendingChangesLabel(diff)} · ${projects === 0 ? "aucun projet" : projectCountLabel(projects)} concerné${projects > 1 ? "s" : ""}`;
}

/** "1 token, 2 composants": what the draft changes, for the preview banner (empty when nothing is pending). */
export function pendingScopeLabel(pending: DiffusionDiff): string {
  const tokens = countOf(pending.tokens);
  const components = countOf(pending.components);
  return [
    tokens > 0 ? `${tokens} token${tokens > 1 ? "s" : ""}` : "",
    components > 0 ? `${components} composant${components > 1 ? "s" : ""}` : "",
    pending.designMdChanged ? "DESIGN.md" : "",
  ]
    .filter(Boolean)
    .join(", ");
}
