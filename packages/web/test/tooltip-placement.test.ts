import { describe, expect, it } from "vitest";
import { placeTooltip } from "../src/ui/tooltipPlacement.js";

const viewport = { width: 1000, height: 800 };
const bubble = { width: 100, height: 24 };
const trigger = (left: number, top: number) => ({ left, top, width: 30, height: 30 });

describe("placeTooltip", () => {
  it("centres the bubble above the trigger with the arrow in the middle of it", () => {
    const placed = placeTooltip(trigger(400, 400), bubble, viewport);
    expect(placed).toEqual({ side: "top", left: 365, top: 370, arrowLeft: 50 });
  });

  it("flips under the trigger when there is no room above", () => {
    const placed = placeTooltip(trigger(400, 10), bubble, viewport);
    expect(placed.side).toBe("bottom");
    expect(placed.top).toBe(46);
  });

  it("stays inside the viewport at the left edge and keeps the arrow on the trigger", () => {
    const placed = placeTooltip(trigger(0, 400), bubble, viewport);
    expect(placed.left).toBe(8);
    expect(placed.arrowLeft).toBe(7);
  });

  it("stays inside the viewport at the right edge", () => {
    const placed = placeTooltip(trigger(980, 400), bubble, viewport);
    expect(placed.left).toBe(892);
    expect(placed.arrowLeft).toBe(93);
  });
});
