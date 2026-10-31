import { describe, expect, it } from "vitest";
import { boundsOf, photoFit, photoPointToCanvas, viewCentredOn, visibleArea } from "../src/canvasPhotoFit.js";

describe("canvas photo", () => {
  it("bounds every box, and gives a unit box when there is none", () => {
    expect(boundsOf([{ x: 10, y: 20, width: 100, height: 50 }, { x: -40, y: 60, width: 20, height: 40 }])).toEqual({ x: -40, y: 20, width: 150, height: 80 });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("fits a wide canvas whole, centred in the area inside the padding", () => {
    // 2000 × 500 in 300 × 150 with 16 of padding: limited by the width, 268 / 2000.
    const fit = photoFit({ x: 100, y: 0, width: 2000, height: 500 }, { width: 300, height: 150 }, 16);
    expect(fit.scale).toBeCloseTo(0.134);
    expect(fit.x + 100 * fit.scale).toBeCloseTo(16);
    expect(fit.y + (500 * fit.scale) / 2).toBeCloseTo(75);
  });

  it("never enlarges a small canvas past 100 %", () => {
    const fit = photoFit({ x: 0, y: 0, width: 100, height: 50 }, { width: 300, height: 150 }, 16);
    expect(fit.scale).toBe(1);
    expect(fit).toMatchObject({ x: 100, y: 50 });
  });

  it("crops a very tall canvas: scaled to the area width and showing its top", () => {
    // Fitted whole, 1000 × 6000 would be 19.7 px wide in 268: narrower than half, so it takes the width and is cut below.
    const fit = photoFit({ x: 0, y: -200, width: 1000, height: 6000 }, { width: 300, height: 150 }, 16, { crop: true });
    expect(fit.scale).toBeCloseTo(0.268);
    expect(fit.x).toBeCloseTo(16);
    expect(fit.y - 200 * fit.scale).toBeCloseTo(16);
  });

  it("keeps a tall canvas whole when it is not asked to crop, as the mini-map does", () => {
    const fit = photoFit({ x: 0, y: 0, width: 1000, height: 6000 }, { width: 300, height: 150 }, 16);
    expect(fit.scale).toBeCloseTo(118 / 6000);
  });

  it("does not crop a canvas that, fitted whole, takes at least half the width", () => {
    const fit = photoFit({ x: 0, y: 0, width: 1000, height: 800 }, { width: 300, height: 150 }, 16, { crop: true });
    expect(fit.scale).toBeCloseTo(118 / 800);
  });

  it("gives the canvas area the viewport shows", () => {
    expect(visibleArea({ x: -200, y: 100, zoom: 0.5 }, { width: 800, height: 600 })).toEqual({ x: 400, y: -200, width: 1600, height: 1200 });
  });

  it("turns a point of the photo back into a canvas point", () => {
    expect(photoPointToCanvas({ x: 30, y: 40 }, { scale: 0.1, x: 10, y: 20 })).toEqual({ x: 200, y: 200 });
  });

  it("centres the view on a canvas point, keeping the zoom", () => {
    const view = viewCentredOn({ x: 200, y: 300 }, 0.5, { width: 800, height: 600 });
    expect(view).toEqual({ x: 300, y: 150, zoom: 0.5 });
  });
});
