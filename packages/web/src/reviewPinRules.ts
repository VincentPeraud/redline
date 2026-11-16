import { renderingKey, type ArtboardRef, type ArtboardRendering, type ReviewPin, type ReviewPinTarget, type ReviewZoneTarget, type ThreadRendering, type TweakValues } from "@redline/shared";

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

/** The element's name as the bridge gives it (role and visible text, such as `titre « Budget »`), or the selector of an element that has no name; "Zone" for a zone. */
export const pinTargetLabel = (pin: Pick<ReviewPin, "target">): string => (pin.target.kind === "zone" ? "Zone" : (pin.target.elementName ?? pin.target.selector));

/** A drag shorter than this (in artboard pixels) in either direction is an Alt + click, not a zone. */
export const MIN_ZONE_SIZE = 6;

/**
 * The zone drawn by an Alt + drag from `start` to `end` (artboard pixels, any corner first), in percent of `box` and clamped to it.
 * Undefined when the drag is too short to be a zone: it counts as a click.
 */
export function zoneFromDrag(start: { x: number; y: number }, end: { x: number; y: number }, box: { width: number; height: number }): ReviewZoneTarget | undefined {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const left = clamp(Math.min(start.x, end.x), box.width);
  const right = clamp(Math.max(start.x, end.x), box.width);
  const top = clamp(Math.min(start.y, end.y), box.height);
  const bottom = clamp(Math.max(start.y, end.y), box.height);
  if (Math.abs(end.x - start.x) < MIN_ZONE_SIZE || Math.abs(end.y - start.y) < MIN_ZONE_SIZE || right - left <= 0 || bottom - top <= 0) return undefined;
  const pct = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;
  return { kind: "zone", space: "artboard", xPct: pct(left, box.width), yPct: pct(top, box.height), wPct: pct(right - left, box.width), hPct: pct(bottom - top, box.height) };
}

/** What the phone sheet shows of a pin. A zone is drawn on a computer, so a phone only names it. */
export function phonePinText(pin: Pick<ReviewPin, "target" | "text">): string {
  const target: object = pin.target;
  return "kind" in target && target.kind === "zone" ? `Zone (tracée sur ordinateur) : ${pin.text}` : pin.text;
}

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

/** "Tes épingles, ta zone et ta remarque remplacent ton OK pour cette étape." */
export function feedbackReplacesOk(pinCount: number, hasRemark: boolean, zoneCount = 0): string {
  const subjects = [pinCount === 1 ? "ton épingle" : pinCount > 1 ? "tes épingles" : undefined, zoneCount === 1 ? "ta zone" : zoneCount > 1 ? "tes zones" : undefined, hasRemark ? "ta remarque" : undefined].filter((subject) => subject !== undefined);
  const subject = subjects.length > 1 ? `${subjects.slice(0, -1).join(", ")} et ${subjects.at(-1)}` : (subjects[0] ?? "");
  const plural = pinCount > 1 || zoneCount > 1 || subjects.length > 1;
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${plural ? "remplacent" : "remplace"} ton OK pour cette étape.`;
}
