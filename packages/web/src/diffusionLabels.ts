import type { DiffusionDiff } from "@redline/shared";

export function projectCountLabel(count: number): string {
  return `${count} projet${count > 1 ? "s" : ""}`;
}

export function diffusionToastMessage(number: number, projects: number): string {
  return `Diffusion ${number} envoyée à ${projectCountLabel(projects)}`;
}

/** "1 token, 2 composants": what the draft changes, for the preview banner (empty when nothing is pending). */
export function pendingScopeLabel(pending: DiffusionDiff): string {
  const tokens = pending.tokens.changed.length + pending.tokens.added.length + pending.tokens.removed.length;
  const components = pending.components.added.length + pending.components.changed.length + pending.components.removed.length;
  return [
    tokens > 0 ? `${tokens} token${tokens > 1 ? "s" : ""}` : "",
    components > 0 ? `${components} composant${components > 1 ? "s" : ""}` : "",
    pending.designMdChanged ? "DESIGN.md" : "",
  ]
    .filter(Boolean)
    .join(", ");
}
