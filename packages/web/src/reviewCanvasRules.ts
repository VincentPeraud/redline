import type { ReviewZoneTarget } from "@redline/shared";
import type { Box } from "./canvasGeometry.js";
import { MIN_ZONE_SIZE } from "./reviewPinRules.js";

export { MIN_ZONE_SIZE };

/** Shape of the canvas crop: the same as the stage of the mock-up. */
const CROP_RATIO = 1.6;

/** The most a small crop is enlarged: a lone sticky would otherwise fill the stage. */
export const MAX_CANVAS_SCALE = 2;

/** The piece of the canvas a step shows: `targets` (their current boxes) with `margin` around them, widened or heightened to the stage's shape. With no box, `fallback` as it is. */
export function canvasCrop(targets: readonly Box[], fallback: Box | undefined, margin: number): Box {
  if (targets.length === 0) return fallback ?? { x: 0, y: 0, width: 1600, height: 1000 };
  const left = Math.min(...targets.map((box) => box.x)) - margin;
  const top = Math.min(...targets.map((box) => box.y)) - margin;
  const right = Math.max(...targets.map((box) => box.x + box.width)) + margin;
  const bottom = Math.max(...targets.map((box) => box.y + box.height)) + margin;
  const width = Math.max(right - left, (bottom - top) * CROP_RATIO);
  const height = width / CROP_RATIO >= bottom - top ? width / CROP_RATIO : bottom - top;
  return { x: (left + right) / 2 - width / 2, y: (top + bottom) / 2 - height / 2, width, height };
}

/**
 * The zone drawn by an Alt + drag between two canvas points, clamped to the crop (any corner first).
 * Undefined when the drag is shorter than a few screen pixels (at `scale`) in either direction, or lies outside the crop: it counts as a click.
 */
export function canvasZoneFromDrag(start: { x: number; y: number }, end: { x: number; y: number }, crop: Box, scale: number): ReviewZoneTarget | undefined {
  const clamp = (value: number, min: number, size: number) => Math.min(min + size, Math.max(min, value));
  const left = clamp(Math.min(start.x, end.x), crop.x, crop.width);
  const right = clamp(Math.max(start.x, end.x), crop.x, crop.width);
  const top = clamp(Math.min(start.y, end.y), crop.y, crop.height);
  const bottom = clamp(Math.max(start.y, end.y), crop.y, crop.height);
  const threshold = MIN_ZONE_SIZE / scale;
  if (Math.abs(end.x - start.x) < threshold || Math.abs(end.y - start.y) < threshold || right - left <= 0 || bottom - top <= 0) return undefined;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { kind: "zone", space: "canvas", x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

/** The targeted element a canvas point falls on (the smallest when several overlap); none on empty canvas. */
export function canvasElementAt(point: { x: number; y: number }, boxes: ReadonlyMap<string, Box>): string | undefined {
  const hit = [...boxes].filter(([, box]) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height);
  return hit.sort(([, a], [, b]) => a.width * a.height - b.width * b.height)[0]?.[0];
}
