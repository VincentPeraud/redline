import { describe, expect, it } from "vitest";
import type { ReviewPin } from "@redline/shared";
import { docToView, zoneToView, zoneFromDrag, feedbackReplacesOk, phonePinText, popoverPlacement, pinHiddenWhy, pinIsShown, pinOffsets } from "../src/reviewPinRules.js";

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
  it("stays inside a narrow stage when neither side has room, under the pin", () => {
    const phone = { width: 390, height: 760 };
    expect(popoverPlacement({ xPct: 70, yPct: 10 }, phone, panel)).toEqual({ horizontal: "inside", left: 82, vertical: "below" });
    expect(popoverPlacement({ xPct: 10, yPct: 10 }, phone, panel).horizontal).toBe("right");
  });
});

describe("what the step says about feedback and the OK", () => {
  it("names the feedback that replaces the OK", () => {
    expect(feedbackReplacesOk(1, false)).toBe("Ton épingle remplace ton OK pour cette étape.");
    expect(feedbackReplacesOk(2, false)).toBe("Tes épingles remplacent ton OK pour cette étape.");
    expect(feedbackReplacesOk(0, true)).toBe("Ta remarque remplace ton OK pour cette étape.");
    expect(feedbackReplacesOk(2, true)).toBe("Tes épingles et ta remarque remplacent ton OK pour cette étape.");
    expect(feedbackReplacesOk(1, false, 1)).toBe("Ton épingle et ta zone remplacent ton OK pour cette étape.");
    expect(feedbackReplacesOk(0, false, 1)).toBe("Ta zone remplace ton OK pour cette étape.");
    expect(feedbackReplacesOk(2, true, 1)).toBe("Tes épingles, ta zone et ta remarque remplacent ton OK pour cette étape.");
  });
});

describe("drawing a zone with Alt + drag", () => {
  const box = { width: 1000, height: 800 };

  it("gives the rectangle in percent of the artboard, whichever corner the drag starts from", () => {
    expect(zoneFromDrag({ x: 640, y: 160 }, { x: 920, y: 400 }, box)).toEqual({ kind: "zone", space: "artboard", xPct: 64, yPct: 20, wPct: 28, hPct: 30 });
    expect(zoneFromDrag({ x: 920, y: 400 }, { x: 640, y: 160 }, box)).toEqual({ kind: "zone", space: "artboard", xPct: 64, yPct: 20, wPct: 28, hPct: 30 });
  });

  it("keeps the zone inside the artboard", () => {
    expect(zoneFromDrag({ x: -50, y: 700 }, { x: 400, y: 900 }, box)).toEqual({ kind: "zone", space: "artboard", xPct: 0, yPct: 87.5, wPct: 40, hPct: 12.5 });
  });

  it("counts a very short drag as a click", () => {
    expect(zoneFromDrag({ x: 100, y: 100 }, { x: 104, y: 103 }, box)).toBeUndefined();
    expect(zoneFromDrag({ x: 100, y: 100 }, { x: 300, y: 103 }, box)).toBeUndefined();
  });
});

describe("pins in the phone sheet", () => {
  it("shows the text of an element pin as it is", () => {
    expect(phonePinText(pin({ text: "Le montant en gras" }))).toBe("Le montant en gras");
  });

  it("names a zone drawn on a computer, since a phone cannot draw or show it", () => {
    const zone = pin({ text: "Les participants sous les décisions", target: { kind: "zone", xPct: 10, yPct: 10 } as unknown as ReviewPin["target"] });
    expect(phonePinText(zone)).toBe("Zone (tracée sur ordinateur) : Les participants sous les décisions");
  });
});

describe("pins over an artboard taller than its window", () => {
  // A 1000 × 2000 document in a 1000 × 800 window, scrolled down by 400.
  const scrolled = { x: 0, y: 400, docW: 1000, docH: 2000, viewW: 1000, viewH: 800 };

  it("places a point of the document where the window shows it", () => {
    expect(docToView({ xPct: 50, yPct: 50 }, scrolled)).toEqual({ xPct: 50, yPct: 75 });
    expect(docToView({ xPct: 50, yPct: 10 }, scrolled)).toEqual({ xPct: 50, yPct: -25 });
  });

  it("keeps percents as they are while the document fits its window", () => {
    expect(docToView({ xPct: 30, yPct: 60 }, undefined)).toEqual({ xPct: 30, yPct: 60 });
  });

  it("moves and scales a zone with the scroll", () => {
    const zone = { kind: "zone" as const, space: "artboard" as const, xPct: 10, yPct: 25, wPct: 20, hPct: 10 };
    expect(zoneToView(zone, scrolled)).toEqual({ ...zone, xPct: 10, yPct: 12.5, wPct: 20, hPct: 25 });
  });
});
