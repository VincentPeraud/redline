import { describe, expect, it } from "vitest";
import type { ChangeReviewStep, ReviewPin } from "@redline/shared";
import { canvasViewOf, firstCanvasFrame, hasCanvasView, opensOnCanvas } from "../src/reviewMixed.js";
import { pinHiddenWhy, pinIsShown } from "../src/reviewPinRules.js";

const entry = { file: "a.html", title: "A", x: 0, y: 0, width: 800, height: 600 };
const step = (extra: Partial<ChangeReviewStep> = {}): ChangeReviewStep => ({
  id: "s1",
  pageId: "p",
  artboard: "a.html",
  canvasElements: ["note"],
  canvas: { elements: [], artboards: [], missing: [] },
  pageTitle: "Réglages",
  artboardTitle: "Instance",
  artboardEntry: entry,
  targets: [".lien", ".titre"],
  tweaks: { state: "full" },
  changed: "c",
  lookAt: "l",
  question: "q",
  answers: [],
  pins: [],
  ...extra,
});

describe("the canvas view of a mixed step", () => {
  it("exists when the step has an artboard and at least one canvas element left, and only then", () => {
    expect(hasCanvasView(step())).toBe(true);
    expect(hasCanvasView(step({ canvasElements: undefined, canvas: undefined }))).toBe(false);
    expect(hasCanvasView(step({ canvas: { elements: [], artboards: [], missing: ["note"] } }))).toBe(false);
    expect(hasCanvasView(step({ artboard: "" }))).toBe(false);
  });

  it("opens first when the step's artboards are all deleted", () => {
    expect(opensOnCanvas(step())).toBe(false);
    expect(opensOnCanvas(step({ artboardEntry: undefined }))).toBe(true);
    expect(opensOnCanvas(step({ artboardEntry: undefined, others: [{ pageId: "p", artboard: "b.html", pageTitle: "R", artboardTitle: "B", artboardEntry: { ...entry, file: "b.html" } }] }))).toBe(false);
  });

  it("is the step seen as a canvas step: no artboard, no Tweaks, no Avant, its own id", () => {
    const view = canvasViewOf(step({ baselineVersionId: "v1", baselineAt: "2026-11-16T10:00:00Z" }));

    expect(view).toMatchObject({ id: "s1#canvas", artboard: "", pageId: "p", canvasElements: ["note"], pageTitle: "Réglages" });
    expect(view.artboardEntry).toBeUndefined();
    expect(view.baselineVersionId).toBeUndefined();
    expect(view.tweaks).toBeUndefined();
    expect(view.targets).toBeUndefined();
  });

  it("numbers its frames after the artboard targets", () => {
    expect(firstCanvasFrame(step())).toBe(3);
    expect(firstCanvasFrame(step({ targets: undefined }))).toBe(1);
    expect(firstCanvasFrame(step({ artboard: "" }))).toBe(1);
  });
});

describe("which pins each view of a mixed step shows", () => {
  const pin = (target: ReviewPin["target"]): ReviewPin => ({ id: "p1", number: 1, text: "Fix", target, at: "2026-11-16T10:00:00Z", mine: true });
  const onArtboard = pin({ selector: ".lien", xPct: 10, yPct: 10 });
  const onNote = pin({ kind: "canvas-element", elementId: "note", elementKind: "sticky" });
  const canvasZone = pin({ kind: "zone", space: "canvas", x: 1, y: 2, w: 3, h: 4 });
  const artboardZone = pin({ kind: "zone", space: "artboard", xPct: 1, yPct: 2, wPct: 3, hPct: 4 });
  const example = { pageId: "p", artboard: "a.html" };
  const canvas = { pageId: "p", artboard: "" };
  const view = { rendering: undefined, values: {}, showBefore: false };

  it("keeps artboard pins and zones off the canvas, and canvas pins and zones off the artboard", () => {
    expect([onArtboard, artboardZone].map((entryPin) => [pinIsShown(entryPin, example, example, view), pinIsShown(entryPin, example, canvas, view)])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect([onNote, canvasZone].map((entryPin) => [pinIsShown(entryPin, example, example, view), pinIsShown(entryPin, example, canvas, view)])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it("says a pin of the other view is on that view, so the list can offer l'afficher", () => {
    expect(pinHiddenWhy(onNote, example, example, view)).toEqual({ kind: "view", of: "canvas" });
    expect(pinHiddenWhy(onArtboard, example, canvas, view)).toEqual({ kind: "view", of: "artboard" });
  });

  it("still lets a canvas-only step show its canvas pins", () => {
    expect(pinIsShown(onNote, canvas, canvas, view)).toBe(true);
  });
});
