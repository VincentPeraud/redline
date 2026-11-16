import { describe, expect, it } from "vitest";
import type { ReviewPin } from "@redline/shared";
import { feedbackReplacesOk, popoverPlacement, pinHiddenWhy, pinIsShown, pinOffsets } from "../src/reviewPinRules.js";

const pin = (extra: Partial<ReviewPin> = {}): ReviewPin => ({ id: "p1", number: 1, text: "Fix", target: { selector: "h1", xPct: 10, yPct: 10 }, at: "2026-11-16T10:00:00Z", mine: true, ...extra });
const example = { pageId: "p", artboard: "a.html" };
const view = { rendering: { format: "desktop" as const, width: 1440 }, values: { state: "full" }, showBefore: false };

describe("which pins an artboard view shows", () => {
  it("shows a pin on the artboard, rendering and state it was placed in, and nothing in Avant", () => {
    expect(pinIsShown(pin(), example, example, view)).toBe(true);
    expect(pinIsShown(pin(), example, example, { ...view, showBefore: true })).toBe(false);
  });

  it("hides a pin placed in another rendering or tweak state, and says why", () => {
    const mobile = pin({ rendering: { format: "mobile", width: 390 }, seenIn: "Mobile" });
    expect(pinIsShown(mobile, example, example, view)).toBe(false);
    expect(pinHiddenWhy(mobile, example, example, view)).toEqual({ kind: "state", seenIn: "Mobile" });
    const empty = pin({ tweaks: { state: "empty" }, seenIn: "empty" });
    expect(pinIsShown(empty, example, example, view)).toBe(false);
    expect(pinIsShown(pin({ tweaks: { state: "full" } }), example, example, view)).toBe(true);
  });

  it("keeps a pin of a group on the artboard where it was placed", () => {
    const other = { pageId: "p", artboard: "b.html" };
    const onOther = pin({ on: other });
    expect(pinIsShown(onOther, example, example, view)).toBe(false);
    expect(pinHiddenWhy(onOther, example, example, view)).toEqual({ kind: "artboard", on: other });
    expect(pinIsShown(onOther, example, other, view)).toBe(true);
  });

  it("explains that Avant hides every pin", () => {
    expect(pinHiddenWhy(pin(), example, example, { ...view, showBefore: true })).toEqual({ kind: "avant" });
  });
});

describe("pins on the same element", () => {
  it("offsets each one after the first so none covers another", () => {
    const positions = [
      { id: "a", xPct: 40, yPct: 10 },
      { id: "b", xPct: 40, yPct: 10 },
      { id: "c", xPct: 70, yPct: 50 },
      { id: "d", xPct: 40.05, yPct: 10 },
    ];
    expect(pinOffsets(positions)).toEqual({ a: 0, b: 1, c: 0, d: 2 });
  });
});

describe("the pin panel placement", () => {
  const box = { width: 1000, height: 600 };
  const panel = { width: 300, height: 200 };
  it("opens below and to the right of the pin", () => {
    expect(popoverPlacement({ xPct: 20, yPct: 10 }, box, panel)).toEqual({ horizontal: "right", vertical: "below" });
  });
  it("flips to the left or above when it would leave the stage", () => {
    expect(popoverPlacement({ xPct: 90, yPct: 90 }, box, panel)).toEqual({ horizontal: "left", vertical: "above" });
  });
});

describe("what the step says about feedback and the OK", () => {
  it("names the feedback that replaces the OK", () => {
    expect(feedbackReplacesOk(1, false)).toBe("Ton épingle remplace ton OK pour cette étape.");
    expect(feedbackReplacesOk(2, false)).toBe("Tes épingles remplacent ton OK pour cette étape.");
    expect(feedbackReplacesOk(0, true)).toBe("Ta remarque remplace ton OK pour cette étape.");
    expect(feedbackReplacesOk(2, true)).toBe("Tes épingles et ta remarque remplacent ton OK pour cette étape.");
  });
});
