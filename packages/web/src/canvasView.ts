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

/** Share of the viewport an artboard takes when the canvas centres on it, so its surroundings stay visible. */
const CENTRED_SHARE = 0.7;

/** Centres `box` in the viewport, zoomed so it takes `CENTRED_SHARE` of it, never past 100 %. */
export function centerOn(box: Bounds, viewport: { width: number; height: number }): CanvasView {
  const zoom = clampZoom(Math.min(1, (CENTRED_SHARE * viewport.width) / box.width, (CENTRED_SHARE * viewport.height) / box.height));
  return {
    zoom,
    x: (viewport.width - box.width * zoom) / 2 - box.x * zoom,
    y: (viewport.height - box.height * zoom) / 2 - box.y * zoom,
  };
}

/**
 * The view a share `t` (0 to 1) of the way from `from` to `to`: the zoom changes geometrically, so zooming in and out feel
 * the same speed, and the canvas point at the centre of the viewport moves in a straight line.
 */
export function interpolateView(from: CanvasView, to: CanvasView, t: number, viewport: { width: number; height: number }): CanvasView {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const centreOf = (view: CanvasView) => ({ x: (viewport.width / 2 - view.x) / view.zoom, y: (viewport.height / 2 - view.y) / view.zoom });
  const a = centreOf(from);
  const b = centreOf(to);
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t);
  const centre = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  return { zoom, x: viewport.width / 2 - centre.x * zoom, y: viewport.height / 2 - centre.y * zoom };
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
