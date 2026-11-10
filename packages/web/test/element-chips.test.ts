import { describe, expect, it } from "vitest";
import type { ThreadTarget } from "@redline/shared";
import { addChip, chipParts, marksFor, removeChip } from "../src/elementChips.js";

const button: ThreadTarget = { kind: "element", artboard: "home.html", selector: "#go", elementName: "bouton « Réserver ma place »", xPct: 10, yPct: 20 };
const whole: ThreadTarget = { kind: "artboard", artboard: "home.html" };
const note: ThreadTarget = { kind: "canvas-element", elementId: "note-parcours", elementKind: "sticky" };

describe("element chips of a message", () => {
  it("adds targets in order and does not duplicate one already selected", () => {
    let chips = addChip([], button);
    chips = addChip(chips, whole);
    chips = addChip(chips, { ...button, xPct: 55, yPct: 70 });
    chips = addChip(chips, note);
    chips = addChip(chips, { ...note });
    expect(chips).toEqual([button, whole, note]);
  });

  it("tells the same selector apart in two renderings of a responsive artboard", () => {
    const mobile = { ...button, rendering: { format: "mobile" as const, width: 390 } };
    expect(addChip([button], mobile)).toHaveLength(2);
    expect(addChip([mobile], { ...mobile })).toHaveLength(1);
  });

  it("removes a chip by position and numbers the rest again", () => {
    expect(removeChip([button, whole, note], 1)).toEqual([button, note]);
  });

  it("splits a chip into a grey kind and a bold name", () => {
    expect(chipParts(button)).toEqual({ kind: "Bouton", name: "Réserver ma place" });
    expect(chipParts({ ...button, elementName: "image" })).toEqual({ kind: "Image" });
    expect(chipParts({ ...button, elementName: null })).toEqual({ kind: "Élément", name: "#go" });
    expect(chipParts(whole)).toEqual({ kind: "Artboard", name: "home" });
    expect(chipParts(note)).toEqual({ kind: "Post-it", name: "note-parcours" });
  });

  it("gives an artboard the numbered marks of its element chips", () => {
    const other: ThreadTarget = { ...button, artboard: "pay.html", selector: "h1" };
    const chips = [other, whole, button];
    expect(marksFor(chips, "home.html")).toEqual([{ number: 3, selector: "#go" }]);
    expect(marksFor(chips, "pay.html")).toEqual([{ number: 1, selector: "h1" }]);
  });

  it("keeps the marks of one rendering of a responsive artboard apart", () => {
    const mobile = { ...button, selector: "#m", rendering: { format: "mobile" as const, width: 390 } };
    const tablet = { ...button, selector: "#t", rendering: { format: "tablet" as const, width: 768 } };
    expect(marksFor([mobile, tablet], "home.html", "mobile-390")).toEqual([{ number: 1, selector: "#m" }]);
    expect(marksFor([mobile, tablet], "home.html")).toEqual([]);
  });
});
