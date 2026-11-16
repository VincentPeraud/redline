import { describe, expect, it } from "vitest";
import { canvasCrop, canvasElementAt, canvasZoneFromDrag, MIN_ZONE_SIZE } from "../src/reviewCanvasRules.js";

describe("canvas crop", () => {
  it("surrounds the targeted elements with a margin and takes the 16:10 shape of the stage", () => {
    const crop = canvasCrop([{ x: 560, y: 124, width: 240, height: 100 }], undefined, 100);

    expect(crop.width / crop.height).toBeCloseTo(1.6, 5);
    expect(crop.x).toBeLessThanOrEqual(460);
    expect(crop.y).toBeLessThanOrEqual(24);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(900);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(324);
  });

  it("keeps several elements together, however far apart", () => {
    const crop = canvasCrop(
      [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 2000, y: 1000, width: 100, height: 100 },
      ],
      undefined,
      100,
    );

    expect(crop).toMatchObject({ x: expect.any(Number) });
    expect(crop.x).toBeLessThanOrEqual(-100);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(2200);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(1200);
  });

  it("falls back to the given box when no element is left", () => {
    const crop = canvasCrop([], { x: 0, y: 0, width: 1600, height: 1000 }, 100);

    expect(crop).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
  });
});

describe("canvas zone", () => {
  const crop = { x: 100, y: 100, width: 800, height: 500 };

  it("is clamped to the crop, whichever corner the drag starts from", () => {
    expect(canvasZoneFromDrag({ x: 950, y: 250 }, { x: 700, y: 50 }, crop, 1)).toEqual({ kind: "zone", space: "canvas", x: 700, y: 100, w: 200, h: 150 });
  });

  it("is a click, not a zone, when the drag is shorter than a few screen pixels", () => {
    expect(canvasZoneFromDrag({ x: 300, y: 300 }, { x: 300 + MIN_ZONE_SIZE - 1, y: 400 }, crop, 1)).toBeUndefined();
    expect(canvasZoneFromDrag({ x: 300, y: 300 }, { x: 302, y: 400 }, crop, 0.5)).toBeUndefined();
  });

  it("is nothing when the whole drag is outside the crop", () => {
    expect(canvasZoneFromDrag({ x: 10, y: 10 }, { x: 50, y: 50 }, crop, 1)).toBeUndefined();
  });
});

describe("pinning on the canvas", () => {
  const boxes = new Map([
    ["note", { x: 100, y: 100, width: 200, height: 100 }],
    ["frame", { x: 0, y: 0, width: 1000, height: 1000 }],
  ]);

  it("aims at the smallest targeted element under the point, and at nothing on empty canvas", () => {
    expect(canvasElementAt({ x: 150, y: 150 }, boxes)).toBe("note");
    expect(canvasElementAt({ x: 800, y: 800 }, boxes)).toBe("frame");
    expect(canvasElementAt({ x: 1500, y: 1500 }, boxes)).toBeUndefined();
  });
});
