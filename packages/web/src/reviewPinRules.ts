import { renderingKey, type ArtboardRef, type ArtboardRendering, type ReviewPin, type ReviewPinTarget, type ThreadRendering, type TweakValues } from "@redline/shared";

/** A pin being placed: it has no number and no id until its first text is saved. */
export interface DraftPin {
  /** Keeps the panel mounted when the draft becomes a saved pin. */
  key: number;
  target: ReviewPinTarget;
  /** The artboard of a group it sits on (absent: the example). */
  on?: ArtboardRef;
  rendering?: ThreadRendering;
  tweaks?: TweakValues;
}

/** What the stage shows: the artboard, rendering and tweak values on screen, and whether it is the "Avant" version. */
export interface PinView {
  rendering: ArtboardRendering | undefined;
  values: TweakValues;
  showBefore: boolean;
}

const sameArtboard = (a: ArtboardRef, b: ArtboardRef) => a.pageId === b.pageId && a.artboard === b.artboard;

/** A pin shows only on the artboard, in the rendering and with the tweak values it was placed in, and never on the "Avant" version. */
export function pinIsShown(pin: ReviewPin, example: ArtboardRef, shown: ArtboardRef, view: PinView): boolean {
  if (view.showBefore) return false;
  if (!sameArtboard(pin.on ?? example, shown)) return false;
  if (pin.rendering && (!view.rendering || renderingKey(pin.rendering) !== renderingKey(view.rendering))) return false;
  return Object.entries(pin.tweaks ?? {}).every(([id, value]) => view.values[id] === value);
}

/** Why a pin is not on the stage: Avant, another artboard of its group, or another rendering or state. */
export type PinHidden = { kind: "avant" } | { kind: "artboard"; on: ArtboardRef } | { kind: "state"; seenIn: string };

export function pinHiddenWhy(pin: ReviewPin, example: ArtboardRef, shown: ArtboardRef, view: PinView): PinHidden | undefined {
  if (pinIsShown(pin, example, shown, view)) return undefined;
  if (view.showBefore) return { kind: "avant" };
  if (!sameArtboard(pin.on ?? example, shown)) return { kind: "artboard", on: pin.on ?? example };
  return { kind: "state", seenIn: pin.seenIn ?? "un autre état" };
}

/** "« Budget validé à [MONTANT] »", or the selector of an element that has no name. */
export const pinTargetLabel = (pin: Pick<ReviewPin, "target">): string => (pin.target.elementName ? `« ${pin.target.elementName} »` : pin.target.selector);

/** How many pins sit before each one on the same spot (two pins of one element): the stage shifts each by that many steps. */
export function pinOffsets(positions: readonly { id: string; xPct: number; yPct: number }[]): Record<string, number> {
  const offsets: Record<string, number> = {};
  positions.forEach((position, index) => {
    offsets[position.id] = positions.slice(0, index).filter((other) => Math.abs(other.xPct - position.xPct) < 0.5 && Math.abs(other.yPct - position.yPct) < 0.5).length;
  });
  return offsets;
}

/** The panel opens below and to the right of the pin, and flips to the left or above when it would leave the stage. */
export function popoverPlacement(at: { xPct: number; yPct: number }, box: { width: number; height: number }, panel: { width: number; height: number }): { horizontal: "left" | "right"; vertical: "above" | "below" } {
  const x = (at.xPct / 100) * box.width;
  const y = (at.yPct / 100) * box.height;
  return { horizontal: x + panel.width > box.width ? "left" : "right", vertical: y + panel.height > box.height ? "above" : "below" };
}

/** "Tes épingles et ta remarque remplacent ton OK pour cette étape." */
export function feedbackReplacesOk(pinCount: number, hasRemark: boolean): string {
  const pins = pinCount === 1 ? "ton épingle" : pinCount > 1 ? "tes épingles" : undefined;
  const remark = hasRemark ? "ta remarque" : undefined;
  const subject = [pins, remark].filter(Boolean).join(" et ");
  const plural = pinCount > 1 || (pins !== undefined && remark !== undefined);
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${plural ? "remplacent" : "remplace"} ton OK pour cette étape.`;
}
