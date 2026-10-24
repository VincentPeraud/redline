import { LINK_CARD_HEIGHT, LINK_CARD_WIDTH, RESPONSIVE_SPACING, renderingKey, type ArtboardRendering, type ManifestElement } from "@redline/shared";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Point, Size {}

export interface ArrowGeometry {
  start: Point;
  end: Point;
  /** Where the label is anchored: the middle of the arrow. */
  label: Point;
}

const isBox = (target: Box | Point): target is Box => "width" in target;

/** Middles of the four edges of a box. */
function edgeMiddles(box: Box): Point[] {
  return [
    { x: box.x + box.width / 2, y: box.y },
    { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height },
    { x: box.x, y: box.y + box.height / 2 },
  ];
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** An arrow runs between the middles of the two closest edges; a free point stands for itself. */
export function arrowGeometry(from: Box | Point, to: Box | Point): ArrowGeometry {
  const starts = isBox(from) ? edgeMiddles(from) : [from];
  const ends = isBox(to) ? edgeMiddles(to) : [to];
  let best = { start: starts[0]!, end: ends[0]! };
  for (const start of starts) {
    for (const end of ends) {
      if (distance(start, end) < distance(best.start, best.end)) best = { start, end };
    }
  }
  const { start, end } = best;
  return { start, end, label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

/** Box of an element on the canvas, or null for an arrow. Link cards have a fixed size; the others use the size measured in the DOM. */
export function elementBox(element: ManifestElement, measured: Size | undefined): Box | null {
  switch (element.kind) {
    case "arrow":
      return null;
    case "link":
      return { x: element.x, y: element.y, width: LINK_CARD_WIDTH, height: LINK_CARD_HEIGHT };
    case "shape":
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    default:
      return { x: element.x, y: element.y, width: measured?.width ?? element.width, height: measured?.height ?? 0 };
  }
}

export interface RenderingSlot {
  /** `renderingKey` of the rendering: the identity that measured heights and hidden sets refer to. */
  key: string;
  width: number;
  /** Declared viewport height, used until the page height is measured. */
  height: number;
}

export interface ResponsiveFrameLayout {
  frame: Box;
  renderings: (Box & { key: string })[];
}

export interface ResponsiveFrameOptions {
  /** Real document height of each rendering, by key, as reported by the artboard bridge. */
  measuredHeights?: Readonly<Record<string, number>>;
  /** Renderings left out of the frame; it closes up around the others. */
  hidden?: ReadonlySet<string>;
}

/** Renderings side by side from the frame's top-left corner; one spacing step is both the frame's padding and the gap between renderings. */
export function responsiveFrameLayout(origin: Point, slots: readonly RenderingSlot[], { measuredHeights = {}, hidden }: ResponsiveFrameOptions = {}): ResponsiveFrameLayout {
  let x = origin.x + RESPONSIVE_SPACING;
  const renderings = slots
    .filter((slot) => !hidden?.has(slot.key))
    .map((slot) => {
      const box = { key: slot.key, x, y: origin.y + RESPONSIVE_SPACING, width: slot.width, height: measuredHeights[slot.key] ?? slot.height };
      x += slot.width + RESPONSIVE_SPACING;
      return box;
    });
  const tallest = Math.max(0, ...renderings.map((r) => r.height));
  return { frame: { x: origin.x, y: origin.y, width: x - origin.x, height: tallest + 2 * RESPONSIVE_SPACING }, renderings };
}

export const renderingSlots = (renderings: readonly ArtboardRendering[]): RenderingSlot[] =>
  renderings.map((rendering) => ({ key: renderingKey(rendering), width: rendering.width, height: rendering.height }));

/** Box an arrow targets for a responsive artboard: the whole frame. */
export function responsiveFrameBox(artboard: { x: number; y: number; responsive: readonly ArtboardRendering[] }, options?: ResponsiveFrameOptions): Box {
  return responsiveFrameLayout(artboard, renderingSlots(artboard.responsive), options).frame;
}
