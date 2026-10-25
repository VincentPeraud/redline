import type { DesignSystemUser, DiffusionDiff } from "@redline/shared";

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

export function pendingCountLabel(count: number): string {
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
