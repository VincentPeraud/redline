import { describe, expect, it } from "vitest";
import { mergeSteps, orderSteps, stepArtboards, stepIsCanvasOnly, stepKey } from "@redline/shared";

const canvasStep = (canvasElements: string[], pageId = "p1") => ({ pageId, artboard: "", canvasElements });

describe("canvas steps", () => {
  it("has no artboard when it only targets canvas elements", () => {
    expect(stepIsCanvasOnly(canvasStep(["note"]))).toBe(true);
    expect(stepIsCanvasOnly({ pageId: "p1", artboard: "home.html", canvasElements: ["note"] })).toBe(false);
    expect(stepArtboards(canvasStep(["note"]))).toEqual([]);
    expect(stepArtboards({ pageId: "p1", artboard: "home.html", canvasElements: ["note"] })).toEqual([{ pageId: "p1", artboard: "home.html" }]);
  });

  it("is identified by its canvas elements too, whatever their order", () => {
    const base = { pageId: "p1", artboard: "home.html" };
    expect(stepKey({ ...base, canvasElements: ["a", "b"] })).toBe(stepKey({ ...base, canvasElements: ["b", "a"] }));
    expect(stepKey({ ...base, canvasElements: ["a"] })).not.toBe(stepKey(base));
    expect(stepKey(canvasStep(["a"]))).not.toBe(stepKey(canvasStep(["b"])));
  });

  it("merges a redeclared canvas step into the known one, and keeps a step that differs only by its elements apart", () => {
    const known = [
      { id: "s1", ...canvasStep(["note"]), question: "old" },
      { id: "s2", pageId: "p1", artboard: "home.html", question: "kept" },
    ];
    const merged = mergeSteps(known, [
      { ...canvasStep(["note"]), question: "new" },
      { pageId: "p1", artboard: "home.html", canvasElements: ["note"], question: "mixed" },
    ]);
    expect(merged).toMatchObject([{ id: "s1", question: "new" }, { id: "s2", question: "kept" }, { question: "mixed" }]);
    expect(merged[2]!.id).toBeUndefined();
  });

  it("is ordered by the reading order of its first element", () => {
    const reading = { p1: ["a.html", "canvas:early", "b.html", "canvas:late"] };
    const steps = [canvasStep(["late"]), { pageId: "p1", artboard: "b.html" }, canvasStep(["early", "late"]), { pageId: "p1", artboard: "a.html" }, canvasStep(["gone"])];
    const names = orderSteps(steps, ["p1"], reading).map((step) => ("canvasElements" in step && stepIsCanvasOnly(step) ? `canvas:${step.canvasElements[0]}` : step.artboard));
    expect(names).toEqual(["a.html", "canvas:early", "b.html", "canvas:late", "canvas:gone"]);
  });
});
