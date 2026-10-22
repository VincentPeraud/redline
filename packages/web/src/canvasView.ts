/** Screen position of the canvas origin plus the scale: screen = canvas * zoom + (x, y). */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom by `factor` keeping the canvas point under `cursor` (viewport coordinates) fixed. */
export function zoomAt(view: CanvasView, factor: number, cursor: { x: number; y: number }): CanvasView {
  const zoom = clampZoom(view.zoom * factor);
  const ratio = zoom / view.zoom;
  return { zoom, x: cursor.x - (cursor.x - view.x) * ratio, y: cursor.y - (cursor.y - view.y) * ratio };
}

export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function fitView(bounds: Bounds, viewport: { width: number; height: number }, margin = 48): CanvasView {
  const zoom = clampZoom(
    Math.min((viewport.width - 2 * margin) / bounds.width, (viewport.height - 2 * margin) / bounds.height),
  );
  return {
    zoom,
    x: (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (viewport.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}
