import { describe, expect, it } from "vitest";
import { arrowGeometry, elementBox } from "../src/canvasGeometry.js";

describe("arrow geometry", () => {
  it("links the facing edges of two boxes side by side, at their middles", () => {
    const left = { x: 0, y: 0, width: 100, height: 200 };
    const right = { x: 300, y: 0, width: 100, height: 200 };
    const { start, end } = arrowGeometry(left, right);
    expect(start).toEqual({ x: 100, y: 100 });
    expect(end).toEqual({ x: 300, y: 100 });
  });

  it("links bottom to top for boxes stacked vertically, and follows when a box moves", () => {
    const top = { x: 0, y: 0, width: 200, height: 100 };
    expect(arrowGeometry(top, { x: 0, y: 400, width: 200, height: 100 })).toMatchObject({ start: { x: 100, y: 100 }, end: { x: 100, y: 400 } });
    expect(arrowGeometry(top, { x: 1000, y: 40, width: 200, height: 100 })).toMatchObject({ start: { x: 200, y: 50 }, end: { x: 1000, y: 90 } });
  });

  it("ends on a free point as given, starting from the nearest edge of the box", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    const { start, end } = arrowGeometry(box, { x: 500, y: 60 });
    expect(end).toEqual({ x: 500, y: 60 });
    expect(start).toEqual({ x: 100, y: 50 });
    expect(arrowGeometry({ x: 50, y: 500 }, box).end).toEqual({ x: 50, y: 100 });
  });

  it("keeps two free points as they are", () => {
    const { start, end } = arrowGeometry({ x: 1, y: 2 }, { x: 3, y: 4 });
    expect(start).toEqual({ x: 1, y: 2 });
    expect(end).toEqual({ x: 3, y: 4 });
  });

  it("puts the label at the middle of the arrow", () => {
    const a = { x: 0, y: 0, width: 100, height: 200 };
    const b = { x: 300, y: 0, width: 100, height: 200 };
    expect(arrowGeometry(a, b).label).toEqual({ x: 200, y: 100 });
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 10, y: 30 }).label).toEqual({ x: 5, y: 15 });
  });
});

describe("element box", () => {
  it("uses the fixed size of a link card", () => {
    expect(elementBox({ kind: "link", page: "p", x: 10, y: 20 }, undefined)).toEqual({ x: 10, y: 20, width: 640, height: 112 });
  });

  it("takes the measured size of the other elements, at their position", () => {
    const measured = { width: 240, height: 130 };
    expect(elementBox({ kind: "sticky", text: "a", width: 240, size: "m", color: "pink", x: 5, y: 6 }, measured)).toEqual({ x: 5, y: 6, width: 240, height: 130 });
  });

  it("falls back to the declared width and no height until measured", () => {
    expect(elementBox({ kind: "text", text: "a", width: 360, size: "m", x: 5, y: 6 }, undefined)).toEqual({ x: 5, y: 6, width: 360, height: 0 });
  });

  it("has no box for an arrow", () => {
    expect(elementBox({ kind: "arrow", from: "a", to: "b", color: "gray", line: "solid" }, undefined)).toBeNull();
  });
});
