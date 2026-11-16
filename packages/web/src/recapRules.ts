import { stepIsSeen, stepStatus, type ChangeReview, type ChangeReviewAnswer, type ChangeReviewStep, type ReviewPin } from "@redline/shared";

/** One line of the recap: a pin or a zone (with its number), or the general remark of the step. */
export type RecapItem = { kind: "pin"; pin: ReviewPin } | { kind: "remark"; answer: ChangeReviewAnswer };

export interface RecapGroup {
  step: ChangeReviewStep;
  /** Index in `review.steps`. */
  index: number;
  /** Pins by number, then the general remarks. */
  items: RecapItem[];
  /** Members who validated the step and did not write any of its feedback ("Victor avait validé cette étape"). */
  validators: ChangeReviewAnswer[];
}

export interface Recap {
  /** Pins, zones and general remarks, all steps. */
  feedback: number;
  groups: RecapGroup[];
  /** Steps with feedback (a step with three pins counts once). */
  withFeedback: number;
  ok: number;
  notSeen: ChangeReviewStep[];
}

/** What a pin sits on, as the recap names it: "« Budget validé »" for an element, "Zone" for a zone. The one place canvas targets add their label. */
export function recapTargetLabel(pin: ReviewPin): string {
  if (pin.target.kind === "zone") return "Zone";
  const text = pin.target.elementName && /^.+? « (.*) »$/.exec(pin.target.elementName)?.[1];
  return text ? `« ${text} »` : (pin.target.elementName ?? pin.target.selector);
}

const sameAuthor = (a: { mine: boolean; person?: { id: string } }, b: { mine: boolean; person?: { id: string } }) => a.mine === b.mine && a.person?.id === b.person?.id;

export function recapOf(review: ChangeReview): Recap {
  const groups: RecapGroup[] = [];
  review.steps.forEach((step, index) => {
    const items: RecapItem[] = [
      ...[...step.pins].sort((a, b) => a.number - b.number).map((pin): RecapItem => ({ kind: "pin", pin })),
      ...step.answers.filter((answer) => answer.kind === "remark").map((answer): RecapItem => ({ kind: "remark", answer })),
    ];
    if (items.length === 0) return;
    const authors = items.map((item) => (item.kind === "pin" ? item.pin : item.answer));
    const validators = step.answers.filter((answer) => answer.kind === "ok" && !answer.outdated && !authors.some((author) => sameAuthor(author, answer)));
    groups.push({ step, index, items, validators });
  });
  const kept = review.steps.filter((step) => step.removed === undefined);
  return {
    feedback: groups.reduce((count, group) => count + group.items.length, 0),
    groups,
    withFeedback: kept.filter((step) => stepStatus(step.answers, step.pins) === "remark").length,
    ok: kept.filter((step) => stepStatus(step.answers, step.pins) === "ok").length,
    notSeen: kept.filter((step) => !stepIsSeen(step)),
  };
}
