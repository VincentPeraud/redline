import type { ProjectDesignSystem, SwitchComponent } from "@redline/shared";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rrggbb` for the native colour picker, or null when the value is not a plain hex colour. */
export function pickerHex(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  return (v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v).toLowerCase();
}

const isWhite = (value: string) => pickerHex(value) === "#ffffff";

export interface PreviewSwatch {
  value: string;
  overridden: boolean;
  /** A white swatch needs a border to stand on the light preview. */
  bordered: boolean;
}

const SWATCH_TOKENS = ["--color-primary", "--color-background", "--color-surface"];

/** The project's primary, background and surface colours as the project sees them. */
export function previewSwatches(detail: ProjectDesignSystem): PreviewSwatch[] {
  return SWATCH_TOKENS.flatMap((name) => {
    const token = detail.tokens.find((t) => t.name === name);
    return token?.isColor ? [{ value: token.value, overridden: token.status === "overridden", bordered: isWhite(token.value) }] : [];
  });
}

/** The match pill of the switch dialog: same settings, what differs, or absent from the target design system. */
export function switchMatchLabel(component: SwitchComponent, targetTitle: string): string {
  if (component.match === "same") return "même nom, mêmes réglages";
  if (component.match === "absent") return `absent de ${targetTitle}`;
  const { difference } = component;
  if (difference?.kind === "value") return `même nom, variante ${difference.value} absente`;
  if (difference?.kind === "setting") return `même nom, réglage ${difference.name} absent`;
  return "même nom, réglages différents";
}

export type Follows = "diffusion" | "draft";

export const followsLabel = (follows: Follows) => (follows === "draft" ? "le brouillon" : "la dernière diffusion");

/** The line after the "Ce projet suit" choice: what the pages see, and for the draft how far it is from the diffusion (`lead` is the bold start). */
export function followStatus(follows: Follows, designSystemTitle: string, diffusion: number, pendingChanges: number): { lead?: string; text: string } {
  if (follows === "diffusion") return { text: `Les pages voient ${designSystemTitle} tel qu'il a été diffusé. Les modifications en cours n'arrivent qu'à la prochaine diffusion.` };
  if (pendingChanges === 0) return { text: `Le brouillon est identique à la diffusion ${diffusion} : rien de plus pour l'instant.` };
  const one = pendingChanges === 1;
  return {
    lead: `${pendingChanges} ${one ? "modification pas encore diffusée" : "modifications pas encore diffusées"}`,
    text: ` ${one ? "est déjà visible" : "sont déjà visibles"} dans ce projet, et ses pages se publient avec ${one ? "elle" : "elles"}.`,
  };
}
