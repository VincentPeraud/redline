import { describe, expect, it } from "vitest";
import { describeZone, feedbackByStep, nextPinNumber, progressOf, reviewResult, stepIsModified, stepIsSeen, stepStatus, type ChangeReviewAnswer, type ChangeReviewResultInput, type ReviewPin } from "@redline/shared";

const person = (name: string) => ({ id: name, name, email: "", initials: name.slice(0, 2) });
const ok = (name: string): ChangeReviewAnswer => ({ id: `a-${name}`, kind: "ok", at: "2026-11-13T10:00:00Z", mine: false, person: person(name) });
const remark = (name: string, text: string): ChangeReviewAnswer => ({ ...ok(name), id: `r-${name}`, kind: "remark", text });
const pin = (name: string, number: number, extra: Partial<ReviewPin> = {}): ReviewPin => ({
  id: `p-${name}-${number}`,
  number,
  text: `Fix ${number}`,
  target: { selector: `.item-${number}`, elementName: `Item ${number}`, xPct: 10, yPct: 20 },
  at: "2026-11-13T10:00:00Z",
  mine: false,
  person: person(name),
  ...extra,
});

describe("pins and step status", () => {
  it("makes a step Remarque and seen as soon as anyone pinned something, even next to an OK", () => {
    expect(stepStatus([], [pin("Ana", 1)])).toBe("remark");
    expect(stepStatus([ok("Victor")], [pin("Ana", 1)])).toBe("remark");
    expect(stepIsSeen({ answers: [], pins: [pin("Ana", 1)] })).toBe(true);
    expect(progressOf([{ id: "a", answers: [], pins: [pin("Ana", 1)] }], 0)).toEqual({ seen: 1, total: 1, segments: ["remark"] });
  });

  it("is modified only when every answer and pin saw an older version", () => {
    expect(stepIsModified({ answers: [], pins: [pin("Ana", 1, { outdated: true })] })).toBe(true);
    expect(stepIsModified({ answers: [{ ...ok("Victor"), outdated: true }], pins: [pin("Ana", 1)] })).toBe(false);
  });
});

describe("pin numbers", () => {
  it("count up from the highest number in use, and never reuse a number that was issued", () => {
    expect(nextPinNumber([], 0)).toBe(1);
    expect(nextPinNumber([1, 3], 3)).toBe(4);
    expect(nextPinNumber([1], 3)).toBe(4);
  });
});

describe("pins in the review result", () => {
  const input = (steps: ChangeReviewResultInput["steps"], threadIds: Record<string, string> = {}): ChangeReviewResultInput => ({ requester: "Ana", finishedBy: "Victor", steps, threadIds });

  it("lists each pin with its element, author and thread, and keeps the step as not validated", () => {
    const result = reviewResult(input([{ id: "s1", label: "Home · list", artboard: "list.html", answers: [ok("Victor")], pins: [pin("Ana", 1, { seenIn: "Mobile · 390", lost: true })] }], { "p-Ana-1": "t-1" }));

    expect(result.validated).toEqual([]);
    expect(result.pins).toEqual([
      {
        stepId: "s1",
        label: "Home · list",
        number: 1,
        pinNumber: 1,
        artboard: "list.html",
        target: { selector: ".item-1", elementName: "Item 1", xPct: 10, yPct: 20 },
        author: "Ana",
        text: "Fix 1",
        alsoValidatedBy: ["Victor"],
        seenIn: "Mobile · 390",
        elementLost: true,
        threadId: "t-1",
      },
    ]);
  });

  it("groups pins and general remarks under their step, in step order", () => {
    const result = reviewResult(
      input([
        { id: "s1", label: "Home · list", artboard: "list.html", answers: [remark("Victor", "Too long")], pins: [pin("Ana", 2), pin("Ana", 1)] },
        { id: "s2", label: "Home · empty", artboard: "empty.html", answers: [] },
        { id: "s3", label: "Home · form", artboard: "form.html", answers: [], pins: [pin("Victor", 1)] },
      ]),
    );

    expect(feedbackByStep(result).map((group) => [group.stepId, group.pins.map((entry) => entry.pinNumber), group.remarks.length])).toEqual([
      ["s1", [1, 2], 1],
      ["s3", [1], 0],
    ]);
  });
});

describe("describing a zone", () => {
  it("gives an artboard zone in percent with at most one decimal, and a canvas zone in pixels", () => {
    expect(describeZone({ kind: "zone", space: "artboard", xPct: 64, yPct: 18.25, wPct: 28.04, hPct: 26 })).toBe("zone x 64 % · y 18.3 % · 28 % × 26 % de l'artboard");
    expect(describeZone({ kind: "zone", space: "canvas", x: 120, y: 40, w: 300, h: 200 })).toBe("zone x 120 px · y 40 px · 300 px × 200 px du canevas");
  });
});
