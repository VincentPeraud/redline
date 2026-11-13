import type { ManifestArtboard } from "./index.js";
import type { Person } from "./people.js";

/** Where a review is: `open` (people answer), `finished` (locked, waiting for a conversation to fetch it), then `fetched` (its feedback was fetched) or `filed` (put aside without ever being sent). */
export type ChangeReviewState = "open" | "finished" | "fetched" | "filed";

export type ChangeReviewAction = "finish" | "reopen" | "file" | "fetch";

const TRANSITIONS: Readonly<Record<ChangeReviewAction, { from: ChangeReviewState; to: ChangeReviewState }>> = {
  finish: { from: "open", to: "finished" },
  /** Only while nobody fetched or filed it. */
  reopen: { from: "finished", to: "open" },
  /** Final: only a finished review can be filed, and a filed one stays so. */
  file: { from: "finished", to: "filed" },
  fetch: { from: "finished", to: "fetched" },
};

/** The state `action` leads to from `state`, or undefined when the action is not allowed there. */
export const nextReviewState = (state: ChangeReviewState, action: ChangeReviewAction): ChangeReviewState | undefined => (TRANSITIONS[action].from === state ? TRANSITIONS[action].to : undefined);

/** A member of the review who is on a screen of it right now (in memory only, never stored). `step` is 1-based; absent on the recap. */
export interface ChangeReviewPresence {
  person?: Person;
  step?: number;
}

/** What a screen of the review sends every few seconds while it is open: the step it shows (1-based), none on the recap. */
export interface ChangeReviewPresenceRequest {
  step?: number;
}

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
  /** The steps went into the requester's open review of the project instead of a new one. */
  merged: boolean;
  /** Steps of the review after the declaration. */
  stepCount: number;
  /** Something the requester should know, for example that the previous review was not fetched. */
  warning?: string;
}

/** One member's answer on a step (an OK or a remark, one per person): `mine` tells the viewer whether they wrote it. */
export interface ChangeReviewAnswer {
  id: string;
  kind: "ok" | "remark";
  /** The remark's text; absent on an OK. */
  text?: string;
  /** Absent when the instance has no accounts. */
  person?: Person;
  at: string;
  mine: boolean;
  /** The artboard was republished after this answer: it saw an older version. */
  outdated?: boolean;
}

export interface ChangeReviewStep extends ChangeReviewStepInput {
  id: string;
  pageTitle: string;
  artboardTitle: string;
  /** The artboard's manifest entry (size, frame, address text); absent when the artboard no longer exists. */
  artboardEntry?: ManifestArtboard;
  answers: ChangeReviewAnswer[];
  /** Who published the version that outdated the answers (present when at least one answer is outdated); absent when unknown. */
  modifiedBy?: string;
  /** When that version was published. */
  modifiedAt?: string;
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
  fetchedBy?: Person;
  fetchedAt?: string;
  filedBy?: Person;
  filedAt?: string;
  /** The viewer is the requester (always true when the instance has no accounts). */
  viewerIsRequester: boolean;
  /** The other members on a screen of the review right now. */
  present: ChangeReviewPresence[];
  steps: ChangeReviewStep[];
}

export type ChangeReviewStatus = "unseen" | "ok" | "remark";

export type ProgressSegment = "ok" | "remark" | "current" | "unseen" | "modified";

export interface ChangeReviewProgress {
  seen: number;
  total: number;
  segments: ProgressSegment[];
}

type Answered = { answers: readonly ChangeReviewAnswer[] };

/**
 * "Remarque" as soon as anyone left a remark (kept even when its artboard changed), "OK" when someone validated the current version and nobody left a remark, else "Non vu".
 * An OK on an older version of the artboard does not count.
 */
export const stepStatus = (answers: readonly ChangeReviewAnswer[]): ChangeReviewStatus =>
  answers.some((answer) => answer.kind === "remark") ? "remark" : answers.some((answer) => !answer.outdated) ? "ok" : "unseen";

/** "Modifié depuis ta revue": the artboard was republished after answers and nobody answered its current version. */
export const stepIsModified = ({ answers }: Answered): boolean => answers.length > 0 && answers.every((answer) => answer.outdated);

/** "Vu": the step has a remark or an OK on the current version (opening a step without answering does not count). */
export const stepIsSeen = ({ answers }: Answered): boolean => stepStatus(answers) !== "unseen";

/** Seen / total, and one segment per step; a modified step is red, the current step shows as current until it is answered. */
export function progressOf(steps: readonly Answered[], currentIndex: number): ChangeReviewProgress {
  const segmentOf = (step: Answered, index: number): ProgressSegment =>
    stepIsModified(step) ? "modified" : stepIsSeen(step) ? (stepStatus(step.answers) === "remark" ? "remark" : "ok") : index === currentIndex ? "current" : "unseen";
  return { seen: steps.filter(stepIsSeen).length, total: steps.length, segments: steps.map(segmentOf) };
}

/** Steps in page order, then in the reading order of their page. An artboard missing from the reading order goes last of its page. */
export function orderSteps<T extends { pageId: string; artboard: string }>(steps: readonly T[], pageOrder: readonly string[], readingOrderOf: Readonly<Record<string, readonly string[]>>): T[] {
  const rank = (list: readonly string[] | undefined, item: string) => {
    const index = list?.indexOf(item) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...steps].sort((a, b) => rank(pageOrder, a.pageId) - rank(pageOrder, b.pageId) || rank(readingOrderOf[a.pageId], a.artboard) - rank(readingOrderOf[b.pageId], b.artboard));
}

/** Tweak values a step shows (name to value). */
export type StepTweaks = Readonly<Record<string, string | number | boolean>>;

/** What identifies a step: its artboard and its tweak values (two states of one artboard are two steps). */
export const stepKey = ({ pageId, artboard, tweaks = {} }: { pageId: string; artboard: string; tweaks?: StepTweaks }): string =>
  JSON.stringify([pageId, artboard, Object.entries(tweaks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);

/**
 * A new declaration merged into the steps of an open review: a redeclared step keeps its id (so its answers stay) and takes the new texts,
 * the other known steps stay, new steps have no id. Not ordered: see `orderSteps`.
 */
export function mergeSteps<T extends { pageId: string; artboard: string; tweaks?: StepTweaks }>(existing: readonly (T & { id: string })[], declared: readonly T[]): (T & { id?: string })[] {
  const latest = new Map(declared.map((step) => [stepKey(step), step]));
  const known = new Set(existing.map(stepKey));
  return [...existing.map((step) => ({ ...(latest.get(stepKey(step)) ?? step), id: step.id })), ...[...latest].filter(([key]) => !known.has(key)).map(([, step]) => step)];
}

export interface ChangeReviewResultInput {
  requester: string;
  finishedBy: string;
  /** In review order. */
  steps: { id: string; label: string; artboard: string; answers: readonly ChangeReviewAnswer[] }[];
  /** The thread opened for each remark, by remark id. */
  threadIds?: Readonly<Record<string, string>>;
}

export interface ChangeReviewRemarkResult {
  stepId: string;
  label: string;
  number: number;
  artboard: string;
  author: string;
  text: string;
  /** Others who validated the same step ("Victor avait validé cette étape"). */
  alsoValidatedBy: string[];
  /** The artboard was republished after this remark ("artboard modifié depuis la remarque"). */
  artboardModified?: boolean;
  threadId?: string;
}

export interface ChangeReviewResult {
  requester: string;
  finishedBy: string;
  validated: { stepId: string; label: string; number: number; by: string[] }[];
  remarks: ChangeReviewRemarkResult[];
  notSeen: { stepId: string; label: string; number: number; /** Validated, then republished and not validated again ("modifié après le OK"). */ modifiedAfterOk?: boolean }[];
}

const nameOfAnswer = (answer: ChangeReviewAnswer): string => answer.person?.name || answer.person?.email || "someone";

/** What Claude gets from a finished review: the validated steps with who validated them, the remarks, and the steps not seen. */
export function reviewResult({ requester, finishedBy, steps, threadIds = {} }: ChangeReviewResultInput): ChangeReviewResult {
  const numbered = steps.map((step, index) => ({ ...step, number: index + 1 }));
  return {
    requester,
    finishedBy,
    validated: numbered.filter((step) => stepStatus(step.answers) === "ok").map((step) => ({ stepId: step.id, label: step.label, number: step.number, by: step.answers.filter((answer) => !answer.outdated).map(nameOfAnswer) })),
    remarks: numbered.flatMap((step) =>
      step.answers
        .filter((answer) => answer.kind === "remark")
        .map((answer) => ({
          stepId: step.id,
          label: step.label,
          number: step.number,
          artboard: step.artboard,
          author: nameOfAnswer(answer),
          text: answer.text ?? "",
          alsoValidatedBy: step.answers.filter((other) => other.kind === "ok" && !other.outdated).map(nameOfAnswer),
          ...(answer.outdated ? { artboardModified: true } : {}),
          ...(threadIds[answer.id] ? { threadId: threadIds[answer.id] } : {}),
        })),
    ),
    notSeen: numbered
      .filter((step) => !stepIsSeen(step))
      .map((step) => ({ stepId: step.id, label: step.label, number: step.number, ...(step.answers.length > 0 ? { modifiedAfterOk: true } : {}) })),
  };
}

/** What `review_feedback` answers: the result of a finished review, or its progress while it is still open. */
export type ChangeReviewFeedback =
  /** `alreadyFetchedAt` is set when the review had been fetched before: the same result, nothing created again. */
  | ({ status: "finished"; alreadyFetchedAt?: string } & ChangeReviewResult)
  | { status: "open"; seen: number; total: number }
  /** Without an id, several finished reviews wait: nothing was fetched. */
  | { status: "several"; reviews: WaitingChangeReview[] }
  /** Without an id, no finished review waits: the open ones, with their progress (none at all gives an empty list). */
  | { status: "none-finished"; reviews: OpenChangeReview[] }
  /** The review was put aside without being sent: nothing to handle, and nothing was created. */
  | { status: "filed"; filedBy: string; filedAt: string };

/** A finished review waiting to be fetched, as listed to Claude. */
export interface WaitingChangeReview {
  id: string;
  requester: string;
  folder: string;
  finishedAt: string;
}

/** An open review with its progress, as listed to Claude. */
export interface OpenChangeReview {
  id: string;
  requester: string;
  folder: string;
  seen: number;
  total: number;
  remarks: number;
}

/** Web route (hash part) of a review, and of one of its steps (1-based). */
export const reviewHash = (reviewId: string, step?: number): string => `#/reviews/${encodeURIComponent(reviewId)}${step === undefined ? "" : `/steps/${step}`}`;

/** `review_feedback`: a review id, or none and the projects linked to the folder (the finished, not yet fetched reviews of those are looked at). */
export interface ChangeReviewFeedbackRequest {
  reviewId?: string;
  projectIds?: string[];
}

/** Path of the reviews that cover a page, for the banner under the canvas header. */
export const pageChangeReviewsPath = (pageId: string): string => `/api/pages/${encodeURIComponent(pageId)}/change-reviews`;

/** How long a fetched review stays in the banner list, so the green "fetched" state shows on load. */
export const FETCHED_BANNER_MS = 60 * 60 * 1000;

/** The banner's four states: `requested` (nobody answered yet), `in-progress`, `finished` (waiting for fetch), `fetched`. */
export type ChangeReviewBannerState = "requested" | "in-progress" | "finished" | "fetched";

/** One review as the banner of a page shows it. */
export interface PageChangeReview {
  id: string;
  state: ChangeReviewBannerState;
  stepCount: number;
  /** Titles of the pages of the review, in review order. */
  pageTitles: string[];
  seen: number;
  /** Validations given on all steps. */
  okCount: number;
  /** Remarks left on all steps. */
  remarkCount: number;
  /** People who answered, in order of first answer. */
  contributors: Person[];
  requester: { person?: Person; folder: string; label?: string };
  /** The viewer is the requester (always true when the instance has no accounts). */
  viewerIsRequester: boolean;
  createdAt: string;
  finishedBy?: Person;
  fetchedBy?: Person;
  fetchedAt?: string;
}

/** Which banner state a review is in: an open review splits on whether anybody answered. */
export function bannerStateOf(state: Exclude<ChangeReviewState, "filed">, seen: number): ChangeReviewBannerState {
  if (state === "open") return seen === 0 ? "requested" : "in-progress";
  return state;
}
