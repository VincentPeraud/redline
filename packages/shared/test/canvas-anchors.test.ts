import { expect, it } from "vitest";
import { parseManifest, placeAnchoredElements, type CanvasBox, type ManifestElement } from "@redline/shared";

const elementsOf = (elements: object[]) => parseManifest(JSON.stringify({ artboards: [{ file: "a.html" }], elements })).elements;
const artboards = new Map<string, CanvasBox>([["a.html", { x: 100, y: 50, width: 1440, height: 900 }]]);
/** Every element 300 x its declared height (or 200). */
const sizeOf = (element: ManifestElement) => ({ width: 300, height: "height" in element ? element.height : 200 });
const positions = (elements: ManifestElement[]) => placeAnchoredElements(elements, artboards, sizeOf).map((e) => ("x" in e ? [e.id, e.x, e.y] : [e.id]));

it("puts an element below its target, left edges aligned, and right of it, top edges aligned, after the gap", () => {
  expect(
    positions(
      elementsOf([
        { kind: "text", text: "n", id: "note", rightOf: "a.html" },
        { kind: "sticky", text: "s", id: "ask", below: "note", gap: 20 },
      ]),
    ),
  ).toEqual([
    ["note", 1580, 50],
    ["ask", 1580, 270],
  ]);
});

it("follows a chain declared in any order, and a target's measured height", () => {
  const elements = elementsOf([
    { kind: "sticky", text: "s", id: "second", below: "first" },
    { kind: "shape", shape: "rect", width: 300, height: 500, id: "first", x: 10, y: 10 },
  ]);
  expect(positions(elements)).toEqual([
    ["second", 10, 550],
    ["first", 10, 10],
  ]);
});

it("leaves elements without an anchor where they are declared", () => {
  expect(positions(elementsOf([{ kind: "text", text: "n", id: "free", x: 7, y: 9 }]))).toEqual([["free", 7, 9]]);
});
