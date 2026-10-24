import { LINK_CARD_HEIGHT, LINK_CARD_WIDTH, type ManifestElement } from "@redline/shared";

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
    default:
      return { x: element.x, y: element.y, width: measured?.width ?? element.width, height: measured?.height ?? 0 };
  }
}
