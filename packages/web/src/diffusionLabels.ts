import type { DesignSystemUser, DiffusionDiff } from "@redline/shared";

export function projectCountLabel(count: number): string {
  return `${count} projet${count > 1 ? "s" : ""}`;
}

export function diffusionToastMessage(number: number, projects: number): string {
  return `Diffusion ${number} envoyée à ${projectCountLabel(projects)}`;
}

export function componentCountLabel(count: number): string {
  return `${count} composant${count > 1 ? "s" : ""}`;
}

export function usedByHeading(count: number): string {
  return count === 0 ? "Utilisé par aucun projet" : `Utilisé par ${projectCountLabel(count)}`;
}

export function userSummary(user: DesignSystemUser): string {
  const overrides = user.overrideCount === 0 ? "Aucune surcharge" : `${user.overrideCount} variable${user.overrideCount > 1 ? "s" : ""} surchargée${user.overrideCount > 1 ? "s" : ""}`;
  return user.componentCount === 0 ? overrides : `${overrides} · ${user.componentCount} composant${user.componentCount > 1 ? "s" : ""} du projet`;
}

export function pendingChangesLabel(count: number): string {
  return `${count} modification${count > 1 ? "s" : ""} pas encore diffusée${count > 1 ? "s" : ""}`;
}

const MAX_LISTED_NAMES = 2;
const MAX_PENDING_NAMES = 4;

export interface ChangePart {
  label: string;
  names: string[];
  /** The board writes components as "label : names" and tokens as "label · names". */
  separator: ":" | "·";
  /** More names than listed: shown with an ellipsis. */
  more: boolean;
}

const VERBS = { changed: "modifié", added: "ajouté", removed: "supprimé" } as const;

/** What a diffusion changed, in French, from the structured diff (the stored summary is English). */
export function diffusionChangeParts(diff: DiffusionDiff): ChangePart[] {
  const parts: ChangePart[] = [];
  const add = (noun: string, kind: keyof typeof VERBS, names: string[], separator: ChangePart["separator"]) => {
    if (names.length === 0) return;
    const plural = names.length > 1 ? "s" : "";
    parts.push({ label: `${names.length} ${noun}${plural} ${VERBS[kind]}${plural}`, names: names.slice(0, MAX_LISTED_NAMES), separator, more: names.length > MAX_LISTED_NAMES });
  };
  for (const kind of ["changed", "added", "removed"] as const) add("composant", kind, diff.components[kind], ":");
  for (const kind of ["changed", "added", "removed"] as const) add("token", kind, diff.tokens[kind].map((token) => token.name), "·");
  if (diff.designMdChanged) parts.push({ label: "DESIGN.md modifié", names: [], separator: ":", more: false });
  return parts;
}

/** Names of the pending changes for the banner: tokens, then components, then DESIGN.md. */
export function pendingNames(diff: DiffusionDiff): { names: string[]; more: boolean } {
  const all = [
    ...diff.tokens.changed.map((t) => t.name),
    ...diff.tokens.added.map((t) => t.name),
    ...diff.tokens.removed.map((t) => t.name),
    ...diff.components.changed,
    ...diff.components.added,
    ...diff.components.removed,
    ...(diff.designMdChanged ? ["DESIGN.md"] : []),
  ];
  return { names: all.slice(0, MAX_PENDING_NAMES), more: all.length > MAX_PENDING_NAMES };
}
