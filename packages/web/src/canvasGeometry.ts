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
  /** SVG path from `start` to `end`: a straight line when the ends are aligned, else a soft curve. */
  path: string;
  /** Where the label is anchored: the middle of the arrow. */
  label: Point;
  /** Smallest box holding the whole line. */
  box: Box;
}

const isBox = (target: Box | Point): target is Box => "width" in target;

interface Anchor {
  point: Point;
  /** Unit vector pointing out of the box through this edge; absent on a free point. */
  outward?: Point;
}

/** Middles of the four edges of a box, with the way each one faces. */
function edgeAnchors(box: Box): Anchor[] {
  return [
    { point: { x: box.x + box.width / 2, y: box.y }, outward: { x: 0, y: -1 } },
    { point: { x: box.x + box.width, y: box.y + box.height / 2 }, outward: { x: 1, y: 0 } },
    { point: { x: box.x + box.width / 2, y: box.y + box.height }, outward: { x: 0, y: 1 } },
    { point: { x: box.x, y: box.y + box.height / 2 }, outward: { x: -1, y: 0 } },
  ];
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** How far a curve's control points stand from its ends, as a share of the distance between them. */
const CURVE_TENSION = 0.4;

function boundsOf(points: Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const CURVE_SAMPLES = 24;

const fmt = (value: number) => String(Math.round(value * 100) / 100);

/** An arrow runs between the middles of the two closest edges; a free point stands for itself. */
export function arrowGeometry(from: Box | Point, to: Box | Point): ArrowGeometry {
  const starts: Anchor[] = isBox(from) ? edgeAnchors(from) : [{ point: from }];
  const ends: Anchor[] = isBox(to) ? edgeAnchors(to) : [{ point: to }];
  let best = { start: starts[0]!, end: ends[0]! };
  for (const start of starts) {
    for (const end of ends) {
      if (distance(start.point, end.point) < distance(best.start.point, best.end.point)) best = { start, end };
    }
  }
  const start = best.start.point;
  const end = best.end.point;
  if (start.x === end.x || start.y === end.y) {
    return {
      start,
      end,
      path: `M${fmt(start.x)} ${fmt(start.y)} L${fmt(end.x)} ${fmt(end.y)}`,
      label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      box: boundsOf([start, end]),
    };
  }
  const length = distance(start, end);
  const chord = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const reach = length * CURVE_TENSION;
  const startDirection = best.start.outward ?? chord;
  const endDirection = best.end.outward ?? { x: -chord.x, y: -chord.y };
  const c1 = { x: start.x + startDirection.x * reach, y: start.y + startDirection.y * reach };
  const c2 = { x: end.x + endDirection.x * reach, y: end.y + endDirection.y * reach };
  const along = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y,
    };
  };
  return {
    start,
    end,
    box: boundsOf(Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => along(i / CURVE_SAMPLES))),
    path: `M${fmt(start.x)} ${fmt(start.y)} C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(end.x)} ${fmt(end.y)}`,
    label: { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 },
  };
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
