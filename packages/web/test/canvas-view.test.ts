import { describe, expect, it } from "vitest";
import { centerOn, fitView, interpolateView, panBy, zoomAt, zoomWithin, MAX_ZOOM, MIN_ZOOM } from "../src/canvasView.js";

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

  it("travels between two views, the zoom geometrically and the centred canvas point in a straight line", () => {
    const viewport = { width: 400, height: 200 };
    const from = { x: 0, y: 0, zoom: 1 }; // centres canvas (200, 100)
    const to = { x: -1800, y: -100, zoom: 4 }; // centres canvas (500, 50)
    expect(interpolateView(from, to, 0, viewport)).toEqual(from);
    expect(interpolateView(from, to, 1, viewport)).toEqual(to);
    const half = interpolateView(from, to, 0.5, viewport);
    expect(half.zoom).toBe(2);
    expect((200 - half.x) / half.zoom).toBe(350);
    expect((100 - half.y) / half.zoom).toBe(75);
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

  it("fits a canvas too wide for the minimum zoom, below it", () => {
    const view = fitView({ x: 0, y: 0, width: 40000, height: 1000 }, { width: 1000, height: 800 }, 0);
    expect(view.zoom).toBe(0.025);
  });

  it("zooms out past the minimum zoom down to a lower floor, never further", () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 0.1 }, 0.5, { x: 0, y: 0 }, 0.025).zoom).toBe(0.05);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.1 }, 0.0001, { x: 0, y: 0 }, 0.025).zoom).toBe(0.025);
  });

  it("lands on the whole-canvas view when zooming all the way out of a canvas wider than the minimum zoom shows", () => {
    const fit = { x: 500, y: 300, zoom: 0.025 };
    expect(zoomWithin({ x: 0, y: 0, zoom: 0.1 }, 0.5, { x: 0, y: 0 }, fit)).toEqual({ x: 0, y: 0, zoom: 0.05 });
    expect(zoomWithin({ x: 0, y: 0, zoom: 0.05 }, 0.1, { x: 0, y: 0 }, fit)).toBe(fit);
  });

  it("zooms a canvas the minimum zoom shows whole as usual, down to the minimum zoom", () => {
    const fit = { x: 300, y: 300, zoom: 1 };
    expect(zoomWithin({ x: 0, y: 0, zoom: 1 }, 0.5, { x: 0, y: 0 }, fit)).toEqual({ x: 0, y: 0, zoom: 0.5 });
    expect(zoomWithin({ x: 0, y: 0, zoom: 1 }, 0.0001, { x: 0, y: 0 }, null).zoom).toBe(MIN_ZOOM);
  });

  it("never enlarges a small canvas past 100 % when fitting it", () => {
    const view = fitView({ x: 100, y: 50, width: 200, height: 100 }, { width: 1000, height: 800 });
    expect(view).toEqual({ zoom: 1, x: 300, y: 300 });
  });

  it("centres an artboard so that it fills 70 % of the viewport, leaving its surroundings visible, never past 100 %", () => {
    const viewport = { width: 1000, height: 800 };
    const large = centerOn({ x: 200, y: 100, width: 1400, height: 800 }, viewport);
    expect(large.zoom).toBeCloseTo(0.5);
    expect(large.x + (200 + 700) * large.zoom).toBeCloseTo(500);
    expect(large.y + (100 + 400) * large.zoom).toBeCloseTo(400);
    expect(centerOn({ x: 0, y: 0, width: 200, height: 100 }, viewport).zoom).toBe(1);
  });
});
