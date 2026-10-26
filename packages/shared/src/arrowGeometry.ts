// Arrows between canvas boxes (lot A ticket 04): pure geometry shared by the canvas, which draws them, and the layout check
// of a page, which looks for arrows crossing other boxes.

import type { CanvasBox } from "./canvasAnchors.js";

export interface CanvasPoint {
  x: number;
  y: number;
}

type Point = CanvasPoint;
type Box = CanvasBox;

export interface ArrowGeometry {
  start: Point;
  end: Point;
  /** SVG path from `start` to `end`: a straight line when the ends are aligned, else a soft curve. */
  path: string;
  /** Where the label is anchored: the middle of the arrow. */
  label: Point;
  /** Smallest box holding the whole line. */
  box: Box;
  /** Points along the line, ends included, to test what it crosses. */
  samples: Point[];
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
      samples: Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => ({ x: start.x + ((end.x - start.x) * i) / CURVE_SAMPLES, y: start.y + ((end.y - start.y) * i) / CURVE_SAMPLES })),
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
  const samples = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => along(i / CURVE_SAMPLES));
  return {
    start,
    end,
    box: boundsOf(samples),
    samples,
    path: `M${fmt(start.x)} ${fmt(start.y)} C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(end.x)} ${fmt(end.y)}`,
    label: { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 },
  };
}

