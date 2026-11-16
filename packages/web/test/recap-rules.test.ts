import { describe, expect, it } from "vitest";
import type { ChangeReview, ChangeReviewAnswer, ChangeReviewStep, ReviewPin } from "@redline/shared";
import { recapOf } from "../src/recapRules.js";

const victor = { id: "v", name: "Victor", email: "v@x.test", initials: "VI" };
const pin = (extra: Partial<ReviewPin> = {}): ReviewPin => ({ id: "p1", number: 1, text: "Bold", target: { selector: "h1", elementName: "heading « Budget »", xPct: 1, yPct: 1 }, at: "2026-11-16T10:00:00Z", mine: true, ...extra });
const answer = (extra: Partial<ChangeReviewAnswer> = {}): ChangeReviewAnswer => ({ id: "a1", kind: "remark", text: "Too long", at: "2026-11-16T10:00:00Z", mine: false, person: victor, ...extra });
const step = (id: string, extra: Partial<ChangeReviewStep> = {}): ChangeReviewStep =>
  ({ id, pageId: "p", artboard: `${id}.html`, pageTitle: "Page", artboardTitle: id, answers: [], pins: [], ...extra }) as ChangeReviewStep;
const review = (steps: ChangeReviewStep[]): ChangeReview => ({ id: "r", state: "open", steps }) as ChangeReview;

describe("recap grouped by step", () => {
  it("counts a step with three pins once and lists its pins first, then the general remark", () => {
    const recap = recapOf(
      review([
        step("a", { pins: [pin({ id: "1", number: 1 }), pin({ id: "2", number: 2, mine: false }), pin({ id: "3", number: 3 })], answers: [answer({ id: "r" })] }),
        step("b", { answers: [answer({ kind: "ok", text: undefined })] }),
        step("c"),
      ]),
    );
    expect(recap.feedback).toBe(4);
    expect(recap.groups).toHaveLength(1);
    expect(recap.groups[0]!.items.map((item) => (item.kind === "pin" ? item.pin.number : "remark"))).toEqual([1, 2, 3, "remark"]);
    expect(recap.withFeedback).toBe(1);
    expect(recap.ok).toBe(1);
    expect(recap.notSeen.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("counts a step that only has pins as a step with feedback, not as OK or not seen", () => {
    const recap = recapOf(review([step("a", { pins: [pin()] })]));
    expect(recap).toMatchObject({ withFeedback: 1, ok: 0, feedback: 1 });
    expect(recap.notSeen).toEqual([]);
  });

  it("names who validated the step, never the author of the feedback", () => {
    const ok = answer({ id: "ok", kind: "ok", text: undefined });
    const wendy = { id: "w", name: "Wendy", email: "w@x.test", initials: "WE" };
    const recap = recapOf(review([step("a", { answers: [ok], pins: [pin({ mine: false, person: wendy })] })]));
    expect(recap.groups[0]!.validators.map((entry) => entry.person?.name)).toEqual(["Victor"]);
    const own = recapOf(review([step("a", { answers: [{ ...ok, person: wendy }], pins: [pin({ mine: false, person: wendy })] })]));
    expect(own.groups[0]!.validators).toEqual([]);
  });
});
