import { activeSteps, stepIsModified, stepIsSeen, stepStatus, type ArtboardRef, type ChangeReview, type ChangeReviewStep } from "@redline/shared";
import { type Route } from "./router.js";
import { counted } from "./plural.js";
import { personName } from "./ReviewRemark.js";
import styles from "./ReviewScreen.module.css";

export type Load = { status: "loading" } | { status: "missing" } | { status: "refused" } | { status: "error" } | { status: "ready"; review: ChangeReview };

export type View = number | "recap";

/** A remark deleted from the recap: "Annuler" puts it back while the review is open; when it was locked meanwhile (`lost`) the text stays here to copy. */
export interface RemovedRemark {
  stepId: string;
  text: string;
  /** The artboard of the group it was attached to (absent: the example). */
  on?: ArtboardRef;
  title: string;
  lost?: boolean;
}

export const reviewPath = (reviewId: string) => `/api/change-reviews/${encodeURIComponent(reviewId)}`;

/** First step without an answer after `from`, else any earlier one, else the recap. A removed step is never asked about. */
export function nextUnanswered(review: ChangeReview, from: number): View {
  const unanswered = (step: ChangeReviewStep) => !step.removed && !stepIsSeen(step);
  const after = review.steps.findIndex((step, index) => index > from && unanswered(step));
  const anywhere = after !== -1 ? after : review.steps.findIndex(unanswered);
  return anywhere === -1 ? "recap" : anywhere;
}

/** The nearest step still in the review after (`1`) or before (`-1`) `from`, none when there is no more. */
export function neighbour(review: ChangeReview, from: number, direction: 1 | -1): number | undefined {
  for (let index = from + direction; index >= 0 && index < review.steps.length; index += direction) if (!review.steps[index]!.removed) return index;
  return undefined;
}

/** "Étape n" of a step: removed steps are not counted, and a removed one takes the number of the step that follows it. */
export function stepNumber(review: ChangeReview, index: number): number {
  const kept = review.steps.slice(0, index + 1).filter((step) => !step.removed).length;
  return Math.min(review.steps[index]!.removed ? kept + 1 : kept, Math.max(activeSteps(review.steps).length, 1));
}

export const stepRoute = (reviewId: string, view: View): Route => ({ name: "review", reviewId, step: view === "recap" ? "recap" : view + 1 });

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

/** What each state of a step shows in the menu: its label and the colour of its dot. */
export const STEP_STATE = {
  unseen: { label: "Non vu", dot: undefined },
  ok: { label: "OK", dot: styles.dotOk },
  remark: { label: "Remarque", dot: styles.dotRemark },
  modified: { label: "Modifié", dot: styles.dotChanged },
} as const;

export const stepStateOf = (step: ChangeReviewStep): keyof typeof STEP_STATE => (stepIsModified(step) ? "modified" : stepStatus(step.answers, step.pins));

/** The step as the top bar and the stage show it: the example, or the artboard of the group whose thumbnail was opened (its own fields; the example's tweak values and group do not apply to it). */
export function shownStep(step: ChangeReviewStep, member: number | undefined): ChangeReviewStep {
  const other = member === undefined ? undefined : step.others?.[member];
  if (!other) return step;
  return {
    ...step,
    id: `${step.id}#${member}`,
    others: undefined,
    tweaks: undefined,
    pageId: other.pageId,
    artboard: other.artboard,
    pageTitle: other.pageTitle,
    artboardTitle: other.artboardTitle,
    artboardEntry: other.artboardEntry,
    artboardTweaks: other.artboardTweaks,
    savedTweaks: other.savedTweaks,
    baselineVersionId: other.baselineVersionId,
    baselineAt: other.baselineAt,
    isNew: other.isNew,
    modifiedBy: other.modifiedBy,
    modifiedAt: other.modifiedAt,
  };
}

/** "Page · artboard" of an artboard of the step. */
export function titleOfArtboard(step: ChangeReviewStep, ref: ArtboardRef): string {
  const member = step.others?.find((other) => other.pageId === ref.pageId && other.artboard === ref.artboard);
  return member ? `${member.pageTitle} · ${member.artboardTitle}` : `${step.pageTitle} · ${step.artboardTitle}`;
}

/** "Terminée par X", "Récupérée par la conversation de X", "Classée sans envoi par X": who locked the review. */
export function lockTitle(review: ChangeReview): string {
  if (review.state === "fetched") return `Récupérée par la conversation de ${personName(review.fetchedBy)}`;
  if (review.state === "filed") return `Classée sans envoi par ${personName(review.filedBy)}`;
  return `Terminée par ${personName(review.finishedBy)}`;
}

export const lockWhen = (review: ChangeReview): string => {
  const at = review.state === "fetched" ? review.fetchedAt : review.state === "filed" ? review.filedAt : review.finishedAt;
  return at ? ` le ${formatWhen(at)}` : "";
};
