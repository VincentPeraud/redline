import type { ProjectDesignSystem } from "@redline/shared";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rrggbb` for the native colour picker, or null when the value is not a plain hex colour. */
export function pickerHex(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  return (v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v).toLowerCase();
}

const isWhite = (value: string) => pickerHex(value) === "#ffffff";

/** "1 variable surchargée", "3 variables surchargées". */
export const overrideCountLabel = (count: number) => `${count} variable${count > 1 ? "s" : ""} surchargée${count > 1 ? "s" : ""}`;

/** "0 composant du projet", "2 composants du projet". */
export const componentCountLabel = (count: number) => `${count} composant${count > 1 ? "s" : ""} du projet`;

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
