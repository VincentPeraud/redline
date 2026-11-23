import { canvasElementLabel, isCanvasTarget, renderingKey, stepIsCanvasOnly, type ArtboardRef, type ArtboardRendering, type ReviewElementTarget, type ReviewPin, type ReviewPinTarget, type ReviewZoneTarget, type ThreadRendering, type TweakValues } from "@redline/shared";

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

/** A pin on the page canvas (an element or a zone drawn on it), as opposed to one on an artboard. */
export const isCanvasPin = (pin: Pick<ReviewPin, "target">): boolean => isCanvasTarget(pin.target);

/** `shown` with no artboard is the canvas view (the whole of a canvas step, or the "Canevas" thumbnail of a mixed step). */
const onCanvasView = (shown: ArtboardRef) => stepIsCanvasOnly(shown);

/** A pin shows only on the view it was placed in (canvas or artboard), on the artboard, in the rendering and with the tweak values it was placed in, and never on the "Avant" version. */
export function pinIsShown(pin: ReviewPin, example: ArtboardRef, shown: ArtboardRef, view: PinView): boolean {
  if (view.showBefore) return false;
  if (isCanvasPin(pin) !== onCanvasView(shown)) return false;
  if (onCanvasView(shown)) return true;
  if (!sameArtboard(pin.on ?? example, shown)) return false;
  if (pin.rendering && (!view.rendering || renderingKey(pin.rendering) !== renderingKey(view.rendering))) return false;
  return Object.entries(pin.tweaks ?? {}).every(([id, value]) => view.values[id] === value);
}

/** Why a pin is not on the stage: Avant, the other view of a mixed step, another artboard of its group, or another rendering or state. */
export type PinHidden = { kind: "avant" } | { kind: "view"; of: "canvas" | "artboard" } | { kind: "artboard"; on: ArtboardRef } | { kind: "state"; seenIn: string };

export function pinHiddenWhy(pin: ReviewPin, example: ArtboardRef, shown: ArtboardRef, view: PinView): PinHidden | undefined {
  if (pinIsShown(pin, example, shown, view)) return undefined;
  if (view.showBefore) return { kind: "avant" };
  if (isCanvasPin(pin) !== onCanvasView(shown)) return { kind: "view", of: isCanvasPin(pin) ? "canvas" : "artboard" };
  if (!sameArtboard(pin.on ?? example, shown)) return { kind: "artboard", on: pin.on ?? example };
  return { kind: "state", seenIn: pin.seenIn ?? "un autre état" };
}

/** A pin on an element of an artboard (not a zone, not a canvas element). */
export const isArtboardElementTarget = (target: ReviewPinTarget): target is ReviewElementTarget => target.kind !== "zone" && target.kind !== "canvas-element";

/**
 * The element's name as the bridge gives it (role and visible text, such as `titre « Budget »`), or the selector of an element that has no name; "Zone" for a zone.
 * `textOnly` keeps just the visible text ("« Budget »"), as the recap names it.
 */
export const pinTargetLabel = (pin: Pick<ReviewPin, "target">, textOnly = false): string => {
  if (pin.target.kind === "zone") return "Zone";
  if (pin.target.kind === "canvas-element") return canvasElementLabel(pin.target.elementKind);
  const text = textOnly && pin.target.elementName && /^.+? « (.*) »$/.exec(pin.target.elementName)?.[1];
  return text ? `« ${text} »` : (pin.target.elementName ?? pin.target.selector);
};

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

/** Where an artboard's window stands over its document, as the bridge reports it (`redline:view`), in pixels. */
export interface DocView {
  x: number;
  y: number;
  docW: number;
  docH: number;
  viewW: number;
  viewH: number;
}

/**
 * A point kept in percent of the artboard's document, in percent of its window: the pin layer covers the window, and a
 * document taller than it scrolls inside. Without a view yet, the document is taken to fit its window.
 */
export function docToView(point: { xPct: number; yPct: number }, view: DocView | undefined): { xPct: number; yPct: number } {
  if (!view) return { xPct: point.xPct, yPct: point.yPct };
  return { xPct: ((point.xPct / 100) * view.docW - view.x) / view.viewW * 100, yPct: ((point.yPct / 100) * view.docH - view.y) / view.viewH * 100 };
}

/** An artboard zone (in percent of the document) in percent of the window, moved by its scroll. */
export function zoneToView<Z extends { xPct: number; yPct: number; wPct: number; hPct: number }>(zone: Z, view: DocView | undefined): Z {
  if (!view) return zone;
  const at = docToView(zone, view);
  return { ...zone, ...at, wPct: (zone.wPct / 100) * view.docW / view.viewW * 100, hPct: (zone.hPct / 100) * view.docH / view.viewH * 100 };
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

/** Space kept between a panel squeezed inside a narrow stage and the stage's edges. */
const STAGE_MARGIN = 8;

export type PopoverPlacement = { vertical: "above" | "below" } & ({ horizontal: "left" | "right" } | { horizontal: "inside"; left: number });

/** The panel opens below and to the right of the pin, and flips to the left or above when it would leave the stage. When neither side has room (a phone-wide artboard), it stays inside the stage, `left` px from its left edge, under or over the pin. */
export function popoverPlacement(at: { xPct: number; yPct: number }, box: { width: number; height: number }, panel: { width: number; height: number }): PopoverPlacement {
  const x = (at.xPct / 100) * box.width;
  const y = (at.yPct / 100) * box.height;
  const vertical = y + panel.height > box.height ? "above" : "below";
  if (x + panel.width <= box.width) return { horizontal: "right", vertical };
  if (x - panel.width >= 0) return { horizontal: "left", vertical };
  const left = Math.max(STAGE_MARGIN, Math.min(x - panel.width / 2, box.width - panel.width - STAGE_MARGIN));
  return { horizontal: "inside", left: Math.round(left), vertical };
}

/** "Tes épingles, ta zone et ta remarque remplacent ton OK pour cette étape." */
export function feedbackReplacesOk(pinCount: number, hasRemark: boolean, zoneCount = 0): string {
  const subjects = [pinCount === 1 ? "ton épingle" : pinCount > 1 ? "tes épingles" : undefined, zoneCount === 1 ? "ta zone" : zoneCount > 1 ? "tes zones" : undefined, hasRemark ? "ta remarque" : undefined].filter((subject) => subject !== undefined);
  const subject = subjects.length > 1 ? `${subjects.slice(0, -1).join(", ")} et ${subjects.at(-1)}` : (subjects[0] ?? "");
  const plural = pinCount > 1 || zoneCount > 1 || subjects.length > 1;
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${plural ? "remplacent" : "remplace"} ton OK pour cette étape.`;
}
