import type { Bounds, CanvasView } from "./canvasView.js";

interface Size {
  width: number;
  height: number;
}

/** Where the canvas sits in a photo: photo = canvas * scale + (x, y). */
export interface PhotoFit {
  scale: number;
  x: number;
  y: number;
}

/** Smallest box holding every box; a unit box when there is none. */
export function boundsOf(boxes: readonly Bounds[]): Bounds {
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) };
}

/**
 * Fits the canvas `bounds` in `area` inside `padding`, centred and never past 100 %. With `crop`, a canvas so tall that, whole,
 * it would take less than half the width is scaled to the width instead and shows its top, cut below.
 */
export function photoFit(bounds: Bounds, area: Size, padding: number, { crop = false }: { crop?: boolean } = {}): PhotoFit {
  const inner = { width: Math.max(area.width - 2 * padding, 1), height: Math.max(area.height - 2 * padding, 1) };
  const whole = Math.min(1, inner.width / bounds.width, inner.height / bounds.height);
  if (crop && bounds.width * whole < inner.width / 2) {
    const scale = Math.min(1, inner.width / bounds.width);
    return { scale, x: padding + (inner.width - bounds.width * scale) / 2 - bounds.x * scale, y: padding - bounds.y * scale };
  }
  return {
    scale: whole,
    x: padding + (inner.width - bounds.width * whole) / 2 - bounds.x * whole,
    y: padding + (inner.height - bounds.height * whole) / 2 - bounds.y * whole,
  };
}

/** The canvas area the viewport shows. */
export function visibleArea(view: CanvasView, viewport: Size): Bounds {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: viewport.width / view.zoom, height: viewport.height / view.zoom };
}

export function photoPointToCanvas(point: { x: number; y: number }, fit: PhotoFit): { x: number; y: number } {
  return { x: (point.x - fit.x) / fit.scale, y: (point.y - fit.y) / fit.scale };
}

/** The view at `zoom` with the canvas `point` at the centre of the viewport. */
export function viewCentredOn(point: { x: number; y: number }, zoom: number, viewport: Size): CanvasView {
  return { zoom, x: viewport.width / 2 - point.x * zoom, y: viewport.height / 2 - point.y * zoom };
}
