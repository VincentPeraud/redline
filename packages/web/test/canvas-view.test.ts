import { describe, expect, it } from "vitest";
import { fitView, panBy, zoomAt, MAX_ZOOM, MIN_ZOOM } from "../src/canvasView.js";

describe("canvas view", () => {
  it("zooms around the cursor so the canvas point under it does not move", () => {
    const view = { x: 100, y: 50, zoom: 1 };
    const cursor = { x: 300, y: 250 };
    const zoomed = zoomAt(view, 2, cursor);
    expect(zoomed.zoom).toBe(2);
    // canvas point under the cursor before: (200, 200); after: ((300 - x) / zoom, (250 - y) / zoom)
    expect((cursor.x - zoomed.x) / zoomed.zoom).toBe(200);
    expect((cursor.y - zoomed.y) / zoomed.zoom).toBe(200);
  });

  it("keeps the zoom within bounds", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 1000, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 0.0001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
  });

  it("pans by a screen delta", () => {
    expect(panBy({ x: 10, y: 10, zoom: 2 }, 5, -5)).toEqual({ x: 15, y: 5, zoom: 2 });
  });

  it("fits a set of boxes in the viewport with a margin and centers them", () => {
    const view = fitView({ x: 0, y: 0, width: 1000, height: 500 }, { width: 500, height: 500 }, 0);
    expect(view.zoom).toBe(0.5);
    expect(view.x).toBe(0);
    expect(view.y).toBe(125);
  });
});
