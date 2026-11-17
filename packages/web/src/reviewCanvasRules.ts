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

/** The person's zoom on the crop: `zoom` relative to the crop (1 = the step's framing), `x`, `y` the shift of the shown top-left from the crop's, in canvas pixels. */
export interface CanvasZoomView {
  zoom: number;
  x: number;
  y: number;
}

/** The piece of the canvas shown: the crop at the start (no view), otherwise the crop zoomed and shifted by the person. */
export function canvasViewBox(crop: Box, view: CanvasZoomView | undefined): Box {
  if (!view) return crop;
  return { x: crop.x + view.x, y: crop.y + view.y, width: crop.width / view.zoom, height: crop.height / view.zoom };
}

/** Zooms by `factor` keeping the canvas point under `cursor` (screen pixels from the crop's top-left, the crop drawn at `scale`) in place, within `limits`. */
export function zoomCanvasView(view: CanvasZoomView | undefined, factor: number, cursor: { x: number; y: number }, scale: number, limits: { min: number; max: number }): CanvasZoomView {
  const current = view ?? { zoom: 1, x: 0, y: 0 };
  const zoom = Math.min(limits.max, Math.max(limits.min, current.zoom * factor));
  const shiftX = cursor.x / (scale * current.zoom) - cursor.x / (scale * zoom);
  const shiftY = cursor.y / (scale * current.zoom) - cursor.y / (scale * zoom);
  return { zoom, x: current.x + shiftX, y: current.y + shiftY };
}

/** Moves the shown piece by a drag or a wheel of (`dx`, `dy`) screen pixels, the crop drawn at `scale`. */
export function panCanvasView(view: CanvasZoomView | undefined, dx: number, dy: number, scale: number): CanvasZoomView {
  const current = view ?? { zoom: 1, x: 0, y: 0 };
  return { zoom: current.zoom, x: current.x - dx / (scale * current.zoom), y: current.y - dy / (scale * current.zoom) };
}

/** The canvas is never shown past this scale (as on the page canvas). */
const MAX_SHOWN_SCALE = 4;

/** How far the person zooms: out until the whole page fits the crop (never below the step's framing when it already shows it all), in up to 400 % of the canvas. */
export function zoomLimits(crop: Box, page: Box | undefined, scale: number): { min: number; max: number } {
  const min = page ? Math.min(1, crop.width / page.width, crop.height / page.height) : 1;
  return { min, max: Math.max(1, MAX_SHOWN_SCALE / scale) };
}
