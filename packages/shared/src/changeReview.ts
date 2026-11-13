import type { ManifestArtboard, ManifestTweak, TweakValues } from "./index.js";
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

/** Tweak values a step shows (name to value). */
export type StepTweaks = Readonly<Record<string, string | number | boolean>>;

/** An artboard of a page. */
export interface ArtboardRef {
  pageId: string;
  artboard: string;
}

/** One step as declared by Claude's `request_review`: one artboard, or a group (`pageId` / `artboard` is then the example, `others` the rest). */
export interface ChangeReviewStepInput {
  pageId: string;
  artboard: string;
  /** The other artboards sharing the change: the step is then a group, whose first artboard is the example. */
  others?: ArtboardRef[];
  /** The name of a group ("Badge cmux"); the example's title when absent. */
  title?: string;
  changed: string;
  lookAt: string;
  question: string;
  /** Tweak values the step opens with (tweak id to value); they are never saved to the page. */
  tweaks?: StepTweaks;
  /** The step opens in the mobile rendering of a responsive artboard. */
  mobile?: boolean;
  /** The page version "Avant" shows: always wins over the baseline Redline works out. */
  baselineVersion?: string;
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
  /** The artboard was republished after this answer: it saw an older version (on a group: any of its artboards). */
  outdated?: boolean;
  /** A remark on a group: the artboard it is attached to (the one shown when it was started); absent on the example. */
  on?: ArtboardRef;
}

/** An artboard of a group other than its example, as the step shows it (the fields mirror the step's own, which describe the example). */
export interface ChangeReviewMember extends ArtboardRef {
  pageTitle: string;
  artboardTitle: string;
  artboardEntry?: ManifestArtboard;
  artboardTweaks?: ManifestTweak[];
  savedTweaks?: TweakValues;
  baselineVersionId?: string;
  baselineAt?: string;
  isNew?: boolean;
  /** Republished after one of the answers: marked in the thumbnails. */
  modified?: boolean;
  modifiedBy?: string;
  modifiedAt?: string;
}

/** Why a step no longer counts: its artboard was deleted, or its page is archived (steps come back if the page is unarchived before the review is finished). */
export type StepRemoval = "deleted" | "archived";

export interface ChangeReviewStep extends ChangeReviewStepInput {
  id: string;
  /** The other artboards of a group, with what the step knows of each. */
  others?: ChangeReviewMember[];
  /** Set when the step is out of the review: it shows "Cet artboard n'existe plus" and is not counted. */
  removed?: StepRemoval;
  pageTitle: string;
  artboardTitle: string;
  /** The artboard's manifest entry (size, frame, address text); absent when the artboard no longer exists. */
  artboardEntry?: ManifestArtboard;
  /** The tweaks the artboard shows (its own and the page's), for the Tweaks panel. */
  artboardTweaks?: ManifestTweak[];
  /** The values saved on the page (the tweaks file): what the step shows under Claude's values. */
  savedTweaks?: TweakValues;
  answers: ChangeReviewAnswer[];
  /** Who published the version that outdated the answers (present when at least one answer is outdated); absent when unknown. */
  modifiedBy?: string;
  /** When that version was published. */
  modifiedAt?: string;
  /** The page version "Avant" shows (preview it with `versionPreviewPath`); absent when the artboard is new or no baseline is known. */
  baselineVersionId?: string;
  baselineAt?: string;
  /** The artboard did not exist before the series: "Avant" is disabled and "Après" says "(nouveau)". */
  isNew?: boolean;
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

type Answered = { answers: readonly ChangeReviewAnswer[]; removed?: StepRemoval };

/** The steps still in the review: removed ones are not counted, not shown in the menu and not asked about. */
export const activeSteps = <T extends { removed?: StepRemoval }>(steps: readonly T[]): T[] => steps.filter((step) => step.removed === undefined);

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

/** Seen / total, and one segment per step still in the review (`currentIndex` counts all steps); a modified step is red, the current step shows as current until it is answered. */
export function progressOf<T extends Answered>(steps: readonly T[], currentIndex: number): ChangeReviewProgress {
  const segmentOf = (step: Answered, index: number): ProgressSegment =>
    stepIsModified(step) ? "modified" : stepIsSeen(step) ? (stepStatus(step.answers) === "remark" ? "remark" : "ok") : index === currentIndex ? "current" : "unseen";
  const kept = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.removed === undefined);
  return { seen: kept.filter(({ step }) => stepIsSeen(step)).length, total: kept.length, segments: kept.map(({ step, index }) => segmentOf(step, index)) };
}

/** The artboards a step covers, the example first. */
export const stepArtboards = ({ pageId, artboard, others = [] }: { pageId: string; artboard: string; others?: readonly ArtboardRef[] }): ArtboardRef[] => [{ pageId, artboard }, ...others];

/** A group of artboards: its example and at least one other. */
export const stepIsGroup = ({ others }: { others?: readonly unknown[] }): boolean => (others?.length ?? 0) > 0;

/** A group spanning several pages. */
export const stepIsMultiPage = (step: { pageId: string; artboard: string; others?: readonly ArtboardRef[] }): boolean => new Set(stepArtboards(step).map((ref) => ref.pageId)).size > 1;

/** "Badge cmux (17 artboards)" for a group (its title, else its example's), "Page · artboard" for a single step. */
export const stepLabel = (step: { title?: string; pageTitle: string; artboardTitle: string; others?: readonly unknown[] }): string => {
  const name = step.title ?? `${step.pageTitle} · ${step.artboardTitle}`;
  return stepIsGroup(step) ? `${name} (${step.others!.length + 1} artboards)` : name;
};

/**
 * Steps in page order, then in the reading order of their page. An artboard missing from the reading order goes last of its page.
 * A group on one page sits at its first artboard in that order; a group spanning several pages goes after all the others, placed the same way by its first artboard.
 */
export function orderSteps<T extends { pageId: string; artboard: string; others?: readonly ArtboardRef[] }>(steps: readonly T[], pageOrder: readonly string[], readingOrderOf: Readonly<Record<string, readonly string[]>>): T[] {
  const rank = (list: readonly string[] | undefined, item: string) => {
    const index = list?.indexOf(item) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const position = (step: T) =>
    stepArtboards(step)
      .map((ref) => [rank(pageOrder, ref.pageId), rank(readingOrderOf[ref.pageId], ref.artboard)] as const)
      .reduce((first, next) => (next[0] < first[0] || (next[0] === first[0] && next[1] < first[1]) ? next : first));
  return [...steps].sort((a, b) => Number(stepIsMultiPage(a)) - Number(stepIsMultiPage(b)) || position(a)[0] - position(b)[0] || position(a)[1] - position(b)[1]);
}

/** What identifies an artboard among the versions an answer records. */
export const artboardKey = ({ pageId, artboard }: ArtboardRef): string => JSON.stringify([pageId, artboard]);

/**
 * What identifies a step: its artboards and its tweak values (two states of one artboard are two steps; an artboard of a group redeclared alone is another step).
 * A group is identified by its set of artboards, whichever is the example.
 */
export const stepKey = ({ pageId, artboard, others, tweaks = {} }: { pageId: string; artboard: string; others?: readonly ArtboardRef[]; tweaks?: StepTweaks }): string => {
  const sortedTweaks = Object.entries(tweaks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!stepIsGroup({ others })) return JSON.stringify([pageId, artboard, sortedTweaks]);
  return JSON.stringify([stepArtboards({ pageId, artboard, others }).map(artboardKey).sort(), sortedTweaks]);
};

/** The artboard versions an answer saw: the example's, and each other artboard's by `artboardKey`. */
export interface SeenVersions {
  artboardVersion?: string;
  memberVersions?: Readonly<Record<string, string>>;
}

/** The current version of each artboard of a step (absent when it has none, for example when it no longer exists). */
export interface CurrentVersions {
  example?: string;
  others: Readonly<Record<string, string | undefined>>;
}

/** Which artboards of a step were republished since an answer saw them (only versions known on both sides count): the example, and the keys of the others. */
export function republishedSince(seen: SeenVersions, current: CurrentVersions): { example: boolean; others: string[] } {
  const changed = (before: string | undefined, now: string | undefined) => before !== undefined && now !== undefined && before !== now;
  return {
    example: changed(seen.artboardVersion, current.example),
    others: Object.entries(current.others)
      .filter(([key, now]) => changed(seen.memberVersions?.[key], now))
      .map(([key]) => key),
  };
}

/**
 * A new declaration merged into the steps of an open review: a redeclared step keeps its id (so its answers stay) and takes the new texts,
 * the other known steps stay, new steps have no id. Not ordered: see `orderSteps`.
 */
export function mergeSteps<T extends { pageId: string; artboard: string; others?: readonly ArtboardRef[]; tweaks?: StepTweaks }>(existing: readonly (T & { id: string })[], declared: readonly T[]): (T & { id?: string })[] {
  const latest = new Map(declared.map((step) => [stepKey(step), step]));
  const known = new Set(existing.map(stepKey));
  return [...existing.map((step) => ({ ...(latest.get(stepKey(step)) ?? step), id: step.id })), ...[...latest].filter(([key]) => !known.has(key)).map(([, step]) => step)];
}

export interface ChangeReviewResultInput {
  requester: string;
  finishedBy: string;
  /** In review order. */
  steps: {
    id: string;
    label: string;
    artboard: string;
    /** A group's artboards, the example first, with their "Page · artboard" names. */
    members?: { pageId: string; artboard: string; label: string }[];
    answers: readonly ChangeReviewAnswer[];
    removed?: StepRemoval;
  }[];
  /** The thread opened for each remark, by remark id. */
  threadIds?: Readonly<Record<string, string>>;
}

export interface ChangeReviewRemarkResult {
  stepId: string;
  label: string;
  /** Absent on a remark of a removed step, which has no place in the count. */
  number?: number;
  artboard: string;
  /** On a group: the artboard the remark is attached to ("Page · artboard") and the other artboards of the group it cites. */
  onLabel?: string;
  alsoOn?: string[];
  author: string;
  text: string;
  /** Others who validated the same step ("Victor avait validé cette étape"). */
  alsoValidatedBy: string[];
  /** The artboard was republished after this remark ("artboard modifié depuis la remarque"). */
  artboardModified?: boolean;
  /** The step's artboard was deleted ("artboard supprimé") or its page is archived ("page archivée"): the remark comes as text, without a thread. */
  removed?: StepRemoval;
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
  const numbered = activeSteps(steps).map((step, index) => ({ ...step, number: index + 1 }));
  const numberOf = new Map(numbered.map((step) => [step.id, step.number]));
  return {
    requester,
    finishedBy,
    validated: numbered.filter((step) => stepStatus(step.answers) === "ok").map((step) => ({ stepId: step.id, label: step.label, number: step.number, by: step.answers.filter((answer) => !answer.outdated).map(nameOfAnswer) })),
    remarks: steps.flatMap((step) =>
      step.answers
        .filter((answer) => answer.kind === "remark")
        .map((answer) => {
          const where = step.members && (step.members.find((member) => member.pageId === answer.on?.pageId && member.artboard === answer.on?.artboard) ?? step.members[0]);
          return {
            stepId: step.id,
            label: step.label,
            ...(numberOf.has(step.id) ? { number: numberOf.get(step.id)! } : {}),
            artboard: where?.artboard ?? step.artboard,
            ...(where ? { onLabel: where.label, alsoOn: step.members!.filter((member) => member !== where).map((member) => member.label) } : {}),
            author: nameOfAnswer(answer),
            text: answer.text ?? "",
            alsoValidatedBy: step.answers.filter((other) => other.kind === "ok" && !other.outdated).map(nameOfAnswer),
            ...(answer.outdated ? { artboardModified: true } : {}),
            ...(step.removed ? { removed: step.removed } : {}),
            ...(threadIds[answer.id] ? { threadId: threadIds[answer.id] } : {}),
          };
        }),
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
  | { status: "filed"; filedBy: string; filedAt: string }
  /** Every step was removed and no remark is left: Redline filed the review by itself ("plus rien à revoir"). */
  | { status: "nothing-left"; filedAt: string };

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

/** A page version as the baseline rules see it, oldest first and without tweak versions: `hash` is the artboard's file in it (absent: the artboard is not on the page then). */
export interface BaselineVersion {
  id: string;
  createdAt: string;
  origin: string;
  originLabel?: string;
  hash?: string;
}

/** Where "Avant" points: a page version, or `"new"` when the artboard did not exist before the series. */
export type Baseline = { versionId: string } | "new";

export interface BaselineInput {
  versions: readonly BaselineVersion[];
  /** Last segment of the requesting terminal session's folder: what its publishes are labelled with (terminal publishes are unsigned). */
  requesterFolder: string;
  /** When the last fetched or filed review covering the artboard was fetched or filed (ISO). */
  afterReviewAt?: string;
}

/**
 * The automatic baseline of an artboard ("Avant", when Claude gave no version):
 * the version current right after the last fetched or filed review covering it; else the version before the requester's first publish of the artboard
 * (the version before their latest publish when they did not change it); none when the requester never published.
 */
export function automaticBaseline({ versions, requesterFolder, afterReviewAt }: BaselineInput): Baseline | undefined {
  const before = (index: number): Baseline => (index >= 0 && versions[index]!.hash !== undefined ? { versionId: versions[index]!.id } : "new");
  if (afterReviewAt !== undefined) return before(versions.map((version) => version.createdAt <= afterReviewAt).lastIndexOf(true));
  const publishedByRequester = (version: BaselineVersion) => version.origin === "terminal" && version.originLabel === requesterFolder;
  const firstPublish = versions.findIndex((version, index) => publishedByRequester(version) && version.hash !== undefined && version.hash !== versions[index - 1]?.hash);
  if (firstPublish >= 0) return before(firstPublish - 1);
  const latestPublish = versions.map(publishedByRequester).lastIndexOf(true);
  return latestPublish >= 0 ? before(latestPublish - 1) : undefined;
}
