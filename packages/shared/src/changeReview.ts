import type { ManifestArtboard } from "./index.js";
import type { Person } from "./people.js";

/** Where a review is: `open` (people answer) then `finished` (locked, waiting for the conversation to fetch it). */
export type ChangeReviewState = "open" | "finished";

/** One step as declared by Claude's `request_review` (one artboard for now). */
export interface ChangeReviewStepInput {
  pageId: string;
  artboard: string;
  changed: string;
  lookAt: string;
  question: string;
}

export interface RequestChangeReviewRequest {
  /** The terminal session's folder: shown (last segment) in the review title. */
  folder: string;
  label?: string;
  steps: ChangeReviewStepInput[];
}

export interface RequestChangeReviewResponse {
  id: string;
}

/** One member's answer on a step: `mine` tells the viewer whether they wrote it. */
export interface ChangeReviewAnswer {
  id: string;
  kind: "ok";
  /** Absent when the instance has no accounts. */
  person?: Person;
  at: string;
  mine: boolean;
}

export interface ChangeReviewStep extends ChangeReviewStepInput {
  id: string;
  pageTitle: string;
  artboardTitle: string;
  /** The artboard's manifest entry (size, frame, address text); absent when the artboard no longer exists. */
  artboardEntry?: ManifestArtboard;
  answers: ChangeReviewAnswer[];
}

/** A review as the web shows it, steps in review order. */
export interface ChangeReview {
  id: string;
  projectId: string;
  projectTitle: string;
  state: ChangeReviewState;
  requester: { person?: Person; folder: string; label?: string };
  createdAt: string;
  finishedBy?: Person;
  finishedAt?: string;
  steps: ChangeReviewStep[];
}

export type ChangeReviewStatus = "unseen" | "ok";

export type ProgressSegment = "ok" | "current" | "unseen";

export interface ChangeReviewProgress {
  seen: number;
  total: number;
  segments: ProgressSegment[];
}

/** "OK" when at least one member validated the step, else "Non vu". */
export const stepStatus = (answers: readonly ChangeReviewAnswer[]): ChangeReviewStatus => (answers.length > 0 ? "ok" : "unseen");

/** "Vu": the step has at least one answer (opening a step without answering does not count). */
export const stepIsSeen = (step: { answers: readonly ChangeReviewAnswer[] }): boolean => step.answers.length > 0;

/** Seen / total, and one segment per step; the current step shows as current until it is answered. */
export function progressOf(steps: readonly { answers: readonly ChangeReviewAnswer[] }[], currentIndex: number): ChangeReviewProgress {
  return {
    seen: steps.filter(stepIsSeen).length,
    total: steps.length,
    segments: steps.map((step, index) => (stepIsSeen(step) ? "ok" : index === currentIndex ? "current" : "unseen")),
  };
}

/** Steps in page order, then in the reading order of their page. An artboard missing from the reading order goes last of its page. */
export function orderSteps<T extends { pageId: string; artboard: string }>(steps: readonly T[], pageOrder: readonly string[], readingOrderOf: Readonly<Record<string, readonly string[]>>): T[] {
  const rank = (list: readonly string[] | undefined, item: string) => {
    const index = list?.indexOf(item) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...steps].sort((a, b) => rank(pageOrder, a.pageId) - rank(pageOrder, b.pageId) || rank(readingOrderOf[a.pageId], a.artboard) - rank(readingOrderOf[b.pageId], b.artboard));
}

export interface ChangeReviewResultInput {
  requester: string;
  finishedBy: string;
  /** In review order. */
  steps: { id: string; label: string; answers: readonly ChangeReviewAnswer[] }[];
}

export interface ChangeReviewResult {
  requester: string;
  finishedBy: string;
  validated: { stepId: string; label: string; number: number; by: string[] }[];
  notSeen: { stepId: string; label: string; number: number }[];
}

/** What Claude gets from a finished review: the validated steps with who validated them, and the steps not seen. */
export function reviewResult({ requester, finishedBy, steps }: ChangeReviewResultInput): ChangeReviewResult {
  const numbered = steps.map((step, index) => ({ ...step, number: index + 1 }));
  return {
    requester,
    finishedBy,
    validated: numbered.filter((step) => stepIsSeen(step)).map((step) => ({ stepId: step.id, label: step.label, number: step.number, by: step.answers.map((answer) => answer.person?.name || answer.person?.email || "someone") })),
    notSeen: numbered.filter((step) => !stepIsSeen(step)).map((step) => ({ stepId: step.id, label: step.label, number: step.number })),
  };
}

/** What `review_feedback` answers: the result of a finished review, or its progress while it is still open. */
export type ChangeReviewFeedback = ({ status: "finished" } & ChangeReviewResult) | { status: "open"; seen: number; total: number };

/** Web route (hash part) of a review, and of one of its steps (1-based). */
export const reviewHash = (reviewId: string, step?: number): string => `#/reviews/${encodeURIComponent(reviewId)}${step === undefined ? "" : `/steps/${step}`}`;

export interface ChangeReviewFeedbackRequest {
  reviewId: string;
}
