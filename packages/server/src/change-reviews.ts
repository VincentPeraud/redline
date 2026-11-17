import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MANIFEST_PATH,
  defaultManifest,
  groupTitlesOf,
  mergeSteps,
  artboardKey,
  republishedSince,
  stepArtboards,
  isCanvasTarget,
  memberOn,
  stepIsCanvasOnly,
  stepLabel,
  stepPageIds,
  canvasElementKey,
  type ArtboardRef,
  type ChangeReviewCanvas,
  type ChangeReviewStepDeclaration,
  type ManifestElement,
  nextReviewState,
  orderSteps,
  parseManifest,
  bannerStateOf,
  FETCHED_BANNER_MS,
  readingOrder,
  renderingSlots,
  tweakValueError,
  parseTweaks,
  TWEAKS_PATH,
  responsiveFrameLayout,
  reviewResult,
  automaticBaseline,
  type BaselineVersion,
  progressOf,
  canvasElementSummary,
  activeSteps,
  folderName,
  type ChangeReview,
  type ChangeReviewFeedback,
  type ChangeReviewFeedbackRequest,
  type ChangeReviewPresenceRequest,
  type ChangeReviewStepInput,
  type CreateThreadRequest,
  type PageChangeReview,
  type Manifest,
  type Person,
  type TweakValues,
  type RequestChangeReviewRequest,
  type RequestChangeReviewResponse,
  reviewPlace,
  RESPONSIVE_FORMATS,
  renderingKey,
  resolveDeclaredTweakValues,
  type InstanceState,
  type ReviewPin,
  type StepRemoval,
} from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import type { PinToStore, SeenNow, StoredMember, StoredPin, StoredReview, StoredStep } from "./change-review-store.js";
import { contentChanges } from "./artboard-history.js";
import type { PageLock } from "./page-lock.js";
import type { Store, VersionRecord } from "./store.js";
import type { SessionLabel, TerminalSessions } from "./terminal-sessions.js";
import { MAX_TERMINAL_TEXT_LENGTH, artboardZoneError, canvasZoneError, createThreadRequestError, requiredString } from "./validation.js";

const MAX_STEPS = 200;
/** Elements a step frames at most: past that, nothing stands out any more. */
const MAX_TARGETS = 10;
/** Canvas elements a step points at at most, for the same reason. */
const MAX_CANVAS_ELEMENTS = 10;
/** Artboards in one review (its steps and the others of its groups together): a declaration is checked artboard by artboard. */
const MAX_ARTBOARDS = 500;
const MAX_STEP_TEXT_LENGTH = 4_000;
/** Pins one member leaves on one step, and the sizes of what a pin carries from the artboard (they end up in the feedback given to Claude). */
const MAX_PINS_PER_MEMBER_AND_STEP = 50;
const MAX_SELECTOR_LENGTH = 500;
const MAX_STATE_VALUE_LENGTH = 200;
const MAX_SEEN_IN_VALUE_LENGTH = 60;
const MAX_SEEN_IN_LENGTH = 200;
const SEVERAL_LINES = /[\r\n]/;

/** What the review code works with: the store, the rights, and what the terminal sessions hold. */
export interface ReviewContext {
  store: Store;
  access: Access;
  pageLock: PageLock;
  terminalSessions: TerminalSessions;
}

/** The terminal session a review is declared or fetched from. */
export interface ReviewSession {
  id: string;
  /** Where it works (shortened of the home folder), when it is present. */
  folder?: string;
}

/** The manifest of a page's current version (the default one when it has none). */
function manifestOf(store: Store, pageId: string): Manifest {
  const files = store.getPage(pageId)?.version.files ?? {};
  return files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(store.blobText(files[MANIFEST_PATH]));
}

/** The tweak values saved on the page (its tweaks file, validated at publish). */
function savedTweaksOf(store: Store, pageId: string): TweakValues {
  const hash = store.getPage(pageId)?.version.files[TWEAKS_PATH];
  return hash === undefined ? {} : parseTweaks(store.blobText(hash));
}

/** Where an element starts on the canvas: its own corner, the one of what it is anchored to, or the start of an arrow. Undefined when it cannot be told. */
function elementOrigin(manifest: Manifest, element: ManifestElement, depth = 0): { x: number; y: number } | undefined {
  const place = (id: string) => {
    const artboard = manifest.artboards.find((candidate) => candidate.file === id);
    if (artboard) return { x: artboard.x, y: artboard.y };
    const other = depth > 3 ? undefined : manifest.elements.find((candidate) => candidate.id === id);
    return other && elementOrigin(manifest, other, depth + 1);
  };
  if (element.kind === "arrow") return typeof element.from === "string" ? place(element.from) : element.from;
  return "anchor" in element && element.anchor ? place(element.anchor.target) : { x: element.x, y: element.y };
}

/**
 * Files of a page in reading order, from the declared sizes (as the agent's page addresses do), with its canvas elements (by `canvasElementKey`) read
 * where they start, like one-pixel boxes: an element beside an artboard row reads in that row.
 */
function readingOrderOf(manifest: Manifest): string[] {
  const boxes = manifest.artboards.map((artboard) => ({
    file: artboard.file,
    title: artboard.title,
    ...(artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive)).frame : artboard),
  }));
  const points = manifest.elements.flatMap((element) => {
    const origin = element.id === undefined ? undefined : elementOrigin(manifest, element);
    return origin ? [{ file: canvasElementKey(element.id!), ...origin, width: 1, height: 1 }] : [];
  });
  return readingOrder([...boxes, ...points], groupTitlesOf(manifest)).map((artboard) => artboard.file);
}

/** The page canvas a step with canvas elements shows: the page's elements and artboard boxes as they are now, and which of the step's elements are gone. */
function canvasOf(manifest: Manifest, elementIds: readonly string[]): ChangeReviewCanvas {
  const present = new Set(manifest.elements.flatMap((element) => (element.id === undefined ? [] : [element.id])));
  return { elements: manifest.elements, artboards: manifest.artboards, missing: elementIds.filter((id) => !present.has(id)) };
}

/** The version in which the artboard's content last changed (tweak versions do not count); none when the artboard has no content. */
function currentArtboardVersion(records: VersionRecord[], file: string): VersionRecord | undefined {
  return contentChanges(records, file).pop();
}

/** The versions of a page, read once per call (a declaration or a view asks for the same page many times). */
type RecordsOf = (pageId: string) => VersionRecord[];
function recordsReader(store: Store): RecordsOf {
  const pages = new Map<string, VersionRecord[]>();
  return (pageId) => {
    if (!pages.has(pageId)) pages.set(pageId, store.listVersionRecords(pageId));
    return pages.get(pageId)!;
  };
}

/** What "Avant" shows for a step, as stored: a page version id, or `""` for an artboard that is new in the series. A given version always wins. */
function baselineOf(
  store: Store,
  recordsOf: RecordsOf,
  step: Pick<ChangeReviewStepInput, "pageId" | "artboard" | "baselineVersion">,
  requester: { folder: string; sessionId: string },
  sameArtboard: { baseline?: string } | undefined,
): string | undefined {
  const records = recordsOf(step.pageId);
  if (step.baselineVersion !== undefined) return records.find((record) => record.id === step.baselineVersion)?.files[step.artboard] === undefined ? "" : step.baselineVersion;
  if (sameArtboard?.baseline !== undefined) return sameArtboard.baseline;
  const versions: BaselineVersion[] = records
    .filter((record) => record.origin !== "tweak")
    .map((record) => ({ id: record.id, createdAt: record.createdAt, origin: record.origin, ...(record.originLabel ? { originLabel: record.originLabel } : {}), ...(record.terminalSessionId ? { terminalSessionId: record.terminalSessionId } : {}), ...(record.files[step.artboard] !== undefined ? { hash: record.files[step.artboard] } : {}) }));
  const baseline = automaticBaseline({ versions, requesterFolder: requester.folder, requesterSessionId: requester.sessionId, afterReviewAt: store.changeReviews.lastLockedAt(step.pageId, step.artboard) });
  return baseline === undefined ? undefined : baseline === "new" ? "" : baseline.versionId;
}

/** "Claude (folder)" for a terminal publish, "Claude de Ana" for a thread or conversation, or the person or link visitor who made the version by hand. */
function authorOf(record: VersionRecord): string | undefined {
  const person = record.person?.name || record.person?.email;
  if (record.origin === "terminal" || record.origin === "thread" || record.origin === "conversation") {
    const folder = record.origin === "terminal" && record.originLabel ? ` (${record.originLabel})` : "";
    return `Claude${person ? ` de ${person}` : ""}${folder}`;
  }
  return person ?? record.linkAuthor?.name;
}

/** An artboard of a stored step, with whether its page was archived when the review was finished. */
type StoredArtboard = ArtboardRef & { archivedAtFinish?: boolean };

/** The artboards of a stored step, the example first. */
const storedArtboards = (step: StoredStep): StoredArtboard[] => [{ pageId: step.pageId, artboard: step.artboard, ...(step.archivedAtFinish ? { archivedAtFinish: true } : {}) }, ...(step.others ?? [])];

/**
 * Why an artboard of a step is out of the review, if it is: it was deleted (or its page), or its page is archived.
 * An archived page brings its artboards back while the review is open; a finished review keeps them out even if the page is unarchived later.
 */
function removalOf(store: Store, review: StoredReview, ref: StoredArtboard): StepRemoval | undefined {
  const page = store.getPage(ref.pageId);
  // A canvas-only step has no artboard: only its page can take it out of the review.
  if (!page || (!stepIsCanvasOnly(ref) && !store.hasArtboard(ref.pageId, ref.artboard))) return "deleted";
  if (page.archivedAt || (review.state !== "open" && ref.archivedAtFinish)) return "archived";
  return undefined;
}

/** What `removalOf` says of each artboard of a step (the example first), and why the step as a whole is out of the review: only when none of its artboards is left (the example's reason is given). */
function removalsOf(store: Store, review: StoredReview, step: StoredStep): { each: (StepRemoval | undefined)[]; step: StepRemoval | undefined } {
  const each = storedArtboards(step).map((ref) => removalOf(store, review, ref));
  // A mixed step keeps its canvas view as one more part: it is gone with its page or when none of its elements is left.
  if (step.canvasElements && !stepIsCanvasOnly(step)) {
    const onPage = removalOf(store, review, { pageId: step.pageId, artboard: "", ...(step.archivedAtFinish ? { archivedAtFinish: true } : {}) });
    each.push(onPage ?? (step.canvasElements.some((id) => store.canvasElement(step.pageId, id)) ? undefined : "deleted"));
  }
  return { each, step: each.every((reason) => reason !== undefined) ? each[0] : undefined };
}

/** The title an artboard had in the latest version that still had it (a deleted artboard is gone from the current manifest). */
function lastTitleOf(store: Store, pageId: string, file: string): string | undefined {
  for (const record of store.listVersionRecords(pageId).reverse()) {
    const hash = record.files[MANIFEST_PATH];
    if (hash === undefined || record.files[file] === undefined) continue;
    const title = parseManifest(store.blobText(hash)).artboards.find((artboard) => artboard.file === file)?.title;
    if (title) return title;
  }
  return undefined;
}

/**
 * "Mobile · Brouillon": the rendering and the tweak values a pin was placed in when they are not what the step opens with (so a pin on the default view says nothing).
 * A true switch is named by its label, a false one by "sans <label>".
 */
function seenInOf(pin: StoredPin, step: StoredStep, manifest: Manifest, saved: TweakValues): string | undefined {
  const ref = pin.on ?? step;
  const entry = manifest.artboards.find((artboard) => artboard.file === ref.artboard);
  const parts: string[] = [];
  if (pin.rendering) {
    const renderings = entry?.responsive ?? [];
    const opening = (step.mobile && !pin.on ? renderings.find((rendering) => rendering.format === "mobile") : undefined) ?? renderings[0];
    if (!opening || renderingKey(opening) !== renderingKey(pin.rendering)) parts.push(RESPONSIVE_FORMATS[pin.rendering.format].label);
  }
  const tweaks = manifest.tweaks.filter((tweak) => tweak.artboard === undefined || tweak.artboard === ref.artboard);
  const opening = resolveDeclaredTweakValues(tweaks, { ...saved, ...(pin.on ? {} : step.tweaks) });
  for (const [id, value] of Object.entries(pin.tweaks ?? {})) {
    const declared = tweaks.find((tweak) => tweak.id === id);
    if (!declared || opening[id] === value) continue;
    parts.push(typeof value === "boolean" ? (value ? declared.label : `sans ${declared.label}`) : String(value).slice(0, MAX_SEEN_IN_VALUE_LENGTH));
  }
  return parts.length > 0 ? parts.join(" · ").slice(0, MAX_SEEN_IN_LENGTH) : undefined;
}

const viewerPersonId = (viewer: Viewer): string | undefined => (viewer.kind === "account" || viewer.kind === "agent" ? viewer.person?.id : undefined);

/** The review as `viewer` sees it, steps in review order. */
function viewOf(store: Store, review: StoredReview, viewer: Viewer): ChangeReview {
  const answers = store.changeReviews.answers(review.id);
  const storedPins = store.changeReviews.pins(review.id);
  const own = viewerPersonId(viewer) ?? "";
  const recordsOf = recordsReader(store);
  const manifests = new Map<string, Manifest>();
  const manifestOfPage = (pageId: string): Manifest => {
    if (!manifests.has(pageId)) manifests.set(pageId, manifestOf(store, pageId));
    return manifests.get(pageId)!;
  };
  /** What the step knows of one of its artboards: titles, size, tweaks, and the "Avant" version. */
  const describe = (ref: ArtboardRef, baseline: string | undefined, removal: StepRemoval | undefined) => {
    const page = store.getPage(ref.pageId);
    const entry = page && removal !== "deleted" ? manifestOfPage(ref.pageId).artboards.find((artboard) => artboard.file === ref.artboard) : undefined;
    const baselineRecord = baseline ? recordsOf(ref.pageId).find((record) => record.id === baseline) : undefined;
    return {
      pageTitle: page?.title ?? "",
      artboardTitle: entry?.title ?? (page && removal === "deleted" ? lastTitleOf(store, ref.pageId, ref.artboard) : undefined) ?? ref.artboard,
      ...(entry ? { artboardEntry: entry } : {}),
      ...(page ? { artboardTweaks: manifestOfPage(ref.pageId).tweaks.filter((tweak) => tweak.artboard === undefined || tweak.artboard === ref.artboard), savedTweaks: savedTweaksOf(store, ref.pageId) } : {}),
      ...(baselineRecord ? { baselineVersionId: baselineRecord.id, baselineAt: baselineRecord.createdAt } : {}),
      ...(baseline === "" ? { isNew: true } : {}),
    };
  };
  const steps = store.changeReviews.steps(review.id).map((step) => {
    const current = currentArtboardVersion(recordsOf(step.pageId), step.artboard);
    const currentOthers = (step.others ?? []).map((member) => ({ member, current: currentArtboardVersion(recordsOf(member.pageId), member.artboard) }));
    const now = { example: current?.id, others: Object.fromEntries(currentOthers.map(({ member, current: version }) => [artboardKey(member), version?.id])) };
    const republished = { example: false, others: new Set<string>() };
    const { each: removals, step: removed } = removalsOf(store, review, step);
    const canvas = step.canvasElements && store.getPage(step.pageId) ? canvasOf(manifestOfPage(step.pageId), step.canvasElements) : undefined;
    const stepAnswers = answers
      .filter((answer) => answer.stepId === step.id)
      .map((answer) => {
        const person = store.getPerson(answer.personId);
        const changed = republishedSince(answer, now);
        const outdated = changed.example || changed.others.length > 0 || answer.stale === true;
        republished.example ||= changed.example;
        for (const key of changed.others) republished.others.add(key);
        return { id: answer.id, kind: answer.kind, ...(answer.text !== undefined ? { text: answer.text } : {}), ...(person ? { person } : {}), at: answer.at, mine: (answer.personId ?? "") === own, ...(outdated ? { outdated } : {}), ...(answer.on ? { on: answer.on } : {}) };
      });
    const stepPins = storedPins
      .filter((pin) => pin.stepId === step.id)
      .map((pin): ReviewPin => {
        const person = store.getPerson(pin.personId);
        const changed = republishedSince(pin, now);
        const outdated = changed.example || changed.others.length > 0 || pin.stale === true;
        republished.example ||= changed.example;
        for (const key of changed.others) republished.others.add(key);
        const seenIn = seenInOf(pin, step, manifestOfPage((pin.on ?? step).pageId), savedTweaksOf(store, (pin.on ?? step).pageId));
        return {
          id: pin.id,
          number: pin.number,
          text: pin.text,
          target: pin.target,
          ...(pin.on ? { on: pin.on } : {}),
          ...(pin.rendering ? { rendering: pin.rendering } : {}),
          ...(pin.tweaks ? { tweaks: pin.tweaks } : {}),
          ...(seenIn ? { seenIn } : {}),
          ...(pin.lost || (pin.target.kind === "canvas-element" && canvas?.missing.includes(pin.target.elementId)) ? { lost: true } : {}),
          ...(person ? { person } : {}),
          at: pin.at,
          mine: (pin.personId ?? "") === own,
          ...(outdated ? { outdated } : {}),
        };
      });
    const modifiedFields = (version: VersionRecord | undefined) => (version ? { ...(authorOf(version) ? { modifiedBy: authorOf(version) } : {}), modifiedAt: version.createdAt } : {});
    return {
      pageId: step.pageId,
      artboard: step.artboard,
      changed: step.changed,
      lookAt: step.lookAt,
      question: step.question,
      id: step.id,
      ...(step.title ? { title: step.title } : {}),
      ...(stepIsCanvasOnly(step) ? { pageTitle: store.getPage(step.pageId)?.title ?? "", artboardTitle: "Canevas" } : describe(step, step.baseline, removals[0])),
      ...(step.canvasElements ? { canvasElements: step.canvasElements } : {}),
      ...(canvas ? { canvas } : {}),
      ...(removed ? { removed } : {}),
      ...(step.others
        ? { others: currentOthers.map(({ member, current: version }, index) => ({ pageId: member.pageId, artboard: member.artboard, ...describe(member, member.baseline, removals[index + 1]), ...(republished.others.has(artboardKey(member)) ? { modified: true, ...modifiedFields(version) } : {}) })) }
        : {}),
      ...(step.tweaks ? { tweaks: step.tweaks } : {}),
      ...(step.mobile ? { mobile: true } : {}),
      ...(step.targets ? { targets: step.targets } : {}),
      answers: stepAnswers,
      pins: stepPins,
      ...(republished.example ? modifiedFields(current) : {}),
    };
  });
  const requester = store.getPerson(review.requesterPersonId);
  const finishedBy = store.getPerson(review.finishedBy);
  const fetchedBy = store.getPerson(review.fetchedBy);
  const filedBy = store.getPerson(review.filedBy);
  const present = store.changeReviews.presentIn(review.id, viewerPersonId(viewer)).map(({ personId, step }) => {
    const person = store.getPerson(personId);
    return { ...(person ? { person } : {}), ...(step !== undefined ? { step } : {}) };
  });
  return {
    id: review.id,
    projectId: review.projectId,
    projectTitle: store.getProject(review.projectId)?.title ?? "",
    state: review.state,
    requester: { ...(requester ? { person: requester } : {}), folder: folderName(review.folder), ...(review.label ? { label: review.label } : {}) },
    createdAt: review.createdAt,
    ...(finishedBy ? { finishedBy } : {}),
    ...(review.finishedAt ? { finishedAt: review.finishedAt } : {}),
    ...(fetchedBy ? { fetchedBy } : {}),
    ...(review.fetchedAt ? { fetchedAt: review.fetchedAt } : {}),
    ...(filedBy ? { filedBy } : {}),
    ...(review.filedAt ? { filedAt: review.filedAt } : {}),
    viewerIsRequester: (review.requesterPersonId ?? "") === (viewerPersonId(viewer) ?? ""),
    present,
    steps,
  };
}

/** Tells the members with Écriture that a review changed: banners and an open review screen reload. Call after every change of a review. */
export function announceReviewChange(store: Store, reviewId: string): void {
  const projectId = store.changeReviews.projectIdOf(reviewId);
  if (!projectId) return;
  const pageIds = [...new Set(store.changeReviews.steps(reviewId).flatMap(stepPageIds))];
  store.emit({ type: "review-updated", reviewId, projectId, pageIds });
}

/** The reviews that cover a page as its banner shows them: open, finished, and fetched within the hour. */
function bannersOf(store: Store, pageId: string, viewer: Viewer): PageChangeReview[] {
  const fetchedSince = new Date(Date.now() - FETCHED_BANNER_MS).toISOString();
  return store.changeReviews.coveringPage(pageId, fetchedSince).map((review) => {
    const view = viewOf(store, review, viewer);
    const kept = activeSteps(view.steps);
    const answers = kept.flatMap((step) => step.answers);
    const contributors = answers.flatMap((answer) => (answer.person ? [answer.person] : [])).filter((person, index, all) => all.findIndex((other) => other.id === person.id) === index);
    const { seen } = progressOf(view.steps, -1);
    const fetchedBy = store.getPerson(review.fetchedBy);
    return {
      id: review.id,
      state: bannerStateOf(review.state as Exclude<typeof review.state, "filed">, seen),
      stepCount: kept.length,
      pageTitles: [...new Set(kept.flatMap((step) => [step.pageTitle, ...(step.others ?? []).map((member) => member.pageTitle)]))],
      seen,
      okCount: answers.filter((answer) => answer.kind === "ok").length,
      feedbackStepCount: kept.filter((step) => step.pins.length > 0 || step.answers.some((answer) => answer.kind === "remark")).length,
      contributors,
      requester: view.requester,
      viewerIsRequester: view.viewerIsRequester,
      createdAt: review.createdAt,
      ...(view.finishedBy ? { finishedBy: view.finishedBy } : {}),
      ...(fetchedBy ? { fetchedBy } : {}),
      ...(review.fetchedAt ? { fetchedAt: review.fetchedAt } : {}),
    };
  });
}

const nameOf = (person: Person | undefined): string => person?.name || person?.email || "someone";

/** A terminal session declares a review: a 4xx message, or the new review's id. Rights are checked here: the route names no project. */
export function declareChangeReview({ store, access }: Pick<ReviewContext, "store" | "access">, viewer: Viewer, session: ReviewSession, body: Partial<RequestChangeReviewRequest> | undefined): { error: string; status: number } | RequestChangeReviewResponse {
  const { folder, label, steps } = body ?? {};
  if (!requiredString(folder) || folder.length > MAX_TERMINAL_TEXT_LENGTH) return { status: 400, error: "folder is required" };
  if (label !== undefined && (!requiredString(label) || label.length > MAX_TERMINAL_TEXT_LENGTH)) return { status: 400, error: "label must be a non-empty string" };
  // The folder and the label are printed back to conversations: one line each, so they cannot read as instructions.
  if (SEVERAL_LINES.test(folder) || (label !== undefined && SEVERAL_LINES.test(label))) return { status: 400, error: "folder and label must be a single line" };
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return { status: 400, error: `steps must be a list of 1 to ${MAX_STEPS} steps` };
  // A step with no artboard points at canvas elements alone.
  const valid = steps.every((step: Partial<ChangeReviewStepDeclaration> | null) =>
    [step?.pageId, step?.changed, step?.lookAt, step?.question, ...(step?.artboard === undefined && step?.canvasElements !== undefined ? [] : [step?.artboard])].every((value) => requiredString(value) && value.length <= MAX_STEP_TEXT_LENGTH),
  );
  if (!valid) return { status: 400, error: "each step needs pageId, changed, lookAt, question and an artboard (or canvasElements when it points at the canvas only)" };
  const canvasShape = steps.every(
    (step: Partial<ChangeReviewStepDeclaration>) =>
      step.canvasElements === undefined ||
      (Array.isArray(step.canvasElements) &&
        step.canvasElements.length > 0 &&
        step.canvasElements.length <= MAX_CANVAS_ELEMENTS &&
        new Set(step.canvasElements).size === step.canvasElements.length &&
        step.canvasElements.every((id) => requiredString(id) && id.trim() !== "" && id.length <= MAX_STEP_TEXT_LENGTH && !SEVERAL_LINES.test(id))),
  );
  if (!canvasShape) return { status: 400, error: `a step's canvasElements must be a list of 1 to ${MAX_CANVAS_ELEMENTS} different element ids of the page's canvas` };
  const groups = steps.every((step: Partial<ChangeReviewStepInput>) => (step.title === undefined || (requiredString(step.title) && step.title.length <= MAX_STEP_TEXT_LENGTH)) && (step.others === undefined || (Array.isArray(step.others) && step.others.length > 0 && step.others.length <= MAX_STEPS && step.others.every((other) => requiredString(other?.pageId) && requiredString(other?.artboard)))));
  if (!groups) return { status: 400, error: "a step's others must be a non-empty list of { pageId, artboard } (the other artboards sharing the change) and its title a non-empty string" };
  const shape = steps.every((step: Partial<ChangeReviewStepInput>) => (step.mobile === undefined || typeof step.mobile === "boolean") && (step.baselineVersion === undefined || requiredString(step.baselineVersion)) && (step.tweaks === undefined || (typeof step.tweaks === "object" && step.tweaks !== null && !Array.isArray(step.tweaks))));
  if (!shape) return { status: 400, error: "a step's mobile must be a boolean, its baselineVersion a version id and its tweaks an object of tweak id to value" };
  const targets = steps.every((step: Partial<ChangeReviewStepInput>) => step.targets === undefined || (Array.isArray(step.targets) && step.targets.length > 0 && step.targets.length <= MAX_TARGETS && step.targets.every((target) => requiredString(target) && target.trim() !== "" && target.length <= MAX_STEP_TEXT_LENGTH && !SEVERAL_LINES.test(target))));
  if (!targets) return { status: 400, error: `a step's targets must be a list of 1 to ${MAX_TARGETS} CSS selectors (the elements to frame), each on one line` };
  const declared = steps.map((step): ChangeReviewStepInput => {
    const whole = { ...step, artboard: step.artboard ?? "" };
    return step.others ? { ...whole, others: step.others.map(({ pageId, artboard }) => ({ pageId, artboard })) } : whole;
  });
  const artboardCount = declared.flatMap(stepArtboards).length;
  if (artboardCount > MAX_ARTBOARDS) return { status: 400, error: `A review covers at most ${MAX_ARTBOARDS} artboards (this declaration lists ${artboardCount}): split it into several reviews.` };
  const repeated = declared.filter((step) => new Set(stepArtboards(step).map(artboardKey)).size < stepArtboards(step).length).map((step) => `${step.pageId}: ${step.artboard}`);
  if (repeated.length > 0) return { status: 400, error: `A group lists each artboard once, the example included, fix the declaration: ${repeated.join(", ")}.` };

  const unknownPages = [...new Set(declared.flatMap(stepPageIds).filter((pageId) => !store.getPage(pageId) || store.getPage(pageId)!.archivedAt))];
  if (unknownPages.length > 0) return { status: 400, error: `Unknown or archived pages: ${unknownPages.join(", ")}` };
  // The review's project is the first step's: the artboards of any other project are refused.
  const projectId = store.getPage(declared[0]!.pageId)!.projectId;
  if (access.levelOf(viewer, { projectId }) !== "write") return { status: 403, error: "your account does not have Écriture on this project" };
  const describe = (step: ArtboardRef) => `${store.getPage(step.pageId)!.title}: ${step.artboard}`;
  const recordsOf = recordsReader(store);
  const artboards = declared.flatMap(stepArtboards);
  // The pages of another project are named by id only: their titles are not for this account to read.
  const otherProject = [
    ...artboards.filter((ref) => store.getPage(ref.pageId)!.projectId !== projectId).map((ref) => `${ref.pageId}: ${ref.artboard}`),
    ...declared.filter((step) => stepIsCanvasOnly(step) && store.getPage(step.pageId)!.projectId !== projectId).map((step) => `${step.pageId}: canvas elements`),
  ];
  const unknownArtboards = artboards.filter((ref) => store.getPage(ref.pageId)!.projectId === projectId && !store.hasArtboard(ref.pageId, ref.artboard)).map(describe);
  if (otherProject.length > 0 || unknownArtboards.length > 0) {
    return {
      status: 400,
      error: [
        otherProject.length > 0 ? `A review covers one project only: these artboards are not in project "${store.getProject(projectId)?.title ?? projectId}": ${[...new Set(otherProject)].join(", ")}.` : "",
        unknownArtboards.length > 0 ? `Unknown artboards, fix the declaration: ${[...new Set(unknownArtboards)].join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  const unknownElements = declared.flatMap((step) => {
    const known = manifestOf(store, step.pageId).elements.flatMap((element) => (element.id === undefined ? [] : [element.id]));
    const unknown = (step.canvasElements ?? []).filter((id) => !known.includes(id));
    if (unknown.length === 0) return [];
    const name = step.title ?? `${store.getPage(step.pageId)!.title} · ${stepIsCanvasOnly(step) ? "canvas" : step.artboard}`;
    return [`Step "${name}": ${unknown.map((id) => `"${id}"`).join(", ")} ${unknown.length > 1 ? "do" : "does"} not exist on page ${store.getPage(step.pageId)!.title}. Elements of the page: ${known.join(", ") || "none"}.`];
  });
  if (unknownElements.length > 0) return { status: 400, error: `Unknown canvas elements, fix the declaration (canvasElements are the ids of elements of the page's manifest.json). ${unknownElements.join(" ")} No review was created.` };

  const unknownVersions = declared.filter((step) => !stepIsCanvasOnly(step) && step.baselineVersion !== undefined && !recordsOf(step.pageId).some((record) => record.id === step.baselineVersion)).map((step) => `${describe(step)}: version ${step.baselineVersion}`);
  if (unknownVersions.length > 0) return { status: 400, error: `Unknown baseline versions (use a version id of the page, as given by publish_page), fix the declaration: ${unknownVersions.join("; ")}.` };

  const tweakErrors = declared.flatMap((step) => {
    const available = manifestOf(store, step.pageId).tweaks.filter((tweak) => tweak.artboard === undefined || tweak.artboard === step.artboard);
    return Object.entries(step.tweaks ?? {}).flatMap(([id, value]) => {
      const tweak = available.find((candidate) => candidate.id === id);
      if (!tweak) return [`${describe(step)}: no tweak "${id}" (available: ${available.map((candidate) => candidate.id).join(", ") || "none"})`];
      const error = tweakValueError(tweak, value);
      return error ? [`${describe(step)}: tweak "${id}": ${error}`] : [];
    });
  });
  if (tweakErrors.length > 0) return { status: 400, error: `Invalid tweak values, fix the declaration: ${tweakErrors.join("; ")}.` };

  const requester = { personId: viewerPersonId(viewer), folder };
  const pages = store.listPages(projectId, "active");
  const orderOf = <T extends ChangeReviewStepInput>(steps: readonly T[]) => {
    const readingOrderByPage: Record<string, string[]> = {};
    for (const page of pages) readingOrderByPage[page.id] = readingOrderOf(manifestOf(store, page.id));
    return orderSteps(steps, pages.map((page) => page.id), readingOrderByPage);
  };

  const open = store.changeReviews.latestOf(projectId, requester, "open");
  // A step of this artboard already in the open review keeps its baseline: the oldest automatic one is the start of the series.
  const known = open ? store.changeReviews.steps(open.id) : [];
  const baselineRequester = { folder: folderName(session.folder ?? folder), sessionId: session.id };
  const knownBaselines = known.flatMap((other): StoredMember[] => [other, ...(other.others ?? [])]).filter((other) => other.baseline !== undefined);
  const sameArtboard = (ref: ArtboardRef) => knownBaselines.find((other) => other.pageId === ref.pageId && other.artboard === ref.artboard);
  const withBaselines = declared.map((step) => {
    // The canvas has no "Avant": a step with no artboard has no baseline.
    const baseline = stepIsCanvasOnly(step) ? undefined : baselineOf(store, recordsOf, step, baselineRequester, sameArtboard(step));
    const others = step.others?.map((member): StoredMember => {
      const memberBaseline = baselineOf(store, recordsOf, member, baselineRequester, sameArtboard(member));
      return memberBaseline === undefined ? member : { ...member, baseline: memberBaseline };
    });
    return { ...step, ...(others ? { others } : {}), ...(baseline === undefined ? {} : { baseline }) };
  });
  if (open) {
    const merged = orderOf(mergeSteps(known, withBaselines));
    store.changeReviews.merge(open.id, merged, label);
    announceReviewChange(store, open.id);
    return { id: open.id, merged: true, stepCount: merged.length };
  }
  const unfetched = store.changeReviews.latestOf(projectId, requester, "finished");
  const review = store.changeReviews.create(projectId, { ...requester, ...(label ? { label } : {}) }, orderOf(withBaselines));
  announceReviewChange(store, review.id);
  return { id: review.id, merged: false, stepCount: declared.length, ...(unfetched ? { warning: "your previous review is finished but was not fetched" } : {}) };
}

const folderNameOf = (review: StoredReview): string => reviewPlace({ folder: review.folder, label: review.label });

/**
 * What `review_feedback` gives: the result of a review (its progress while it is open).
 * With an id any member with Écriture on the project may take it. Without one, the finished, not yet fetched reviews of `projectIds`
 * (the folder's linked projects): one is taken, several are listed and nothing is taken, none gives the open ones with their progress.
 * Taking a review turns each remark into a thread on its artboard, taken by the fetching account, and keeps the result: asking again returns that same result and creates nothing.
 */
export function changeReviewFeedback(ctx: ReviewContext, viewer: Viewer, sessionId: string, request: ChangeReviewFeedbackRequest): { error: string; status: number } | ChangeReviewFeedback {
  const { store, access } = ctx;
  // A project that is gone gives nobody Écriture (its reviews went with it).
  const mayFetch = (projectId: string) => store.projectOwnership(projectId) !== undefined && access.levelOf(viewer, { projectId }) === "write";
  if (request.reviewId !== undefined) {
    const review = store.changeReviews.get(request.reviewId);
    if (!review) return { status: 404, error: "review not found" };
    if (!mayFetch(review.projectId)) return { status: 403, error: "your account does not have Écriture on this project" };
    return fetchReview(ctx, viewer, sessionId, review);
  }
  const projectIds = (request.projectIds ?? []).filter(mayFetch);
  if (projectIds.length === 0) return { status: 403, error: "pass reviewId, or link this folder to a project where your account has Écriture" };
  const finished = store.changeReviews.inProjects(projectIds, ["finished"]);
  if (finished.length === 1) return fetchReview(ctx, viewer, sessionId, finished[0]!);
  if (finished.length > 1) {
    return {
      status: "several",
      reviews: finished.map((review) => ({ id: review.id, requester: nameOf(store.getPerson(review.requesterPersonId)), folder: folderNameOf(review), finishedAt: review.finishedAt ?? review.createdAt })),
    };
  }
  const reviews = store.changeReviews.inProjects(projectIds, ["open"]).map((review) => {
    const view = viewOf(store, review, viewer);
    const { seen, total } = progressOf(view.steps, -1);
    return {
      id: review.id,
      requester: nameOf(view.requester.person),
      folder: folderNameOf(review),
      seen,
      total,
      remarks: view.steps.flatMap((step) => step.answers).filter((answer) => answer.kind === "remark").length + view.steps.reduce((count, step) => count + step.pins.length, 0),
    };
  });
  return { status: "none-finished", reviews };
}

function fetchReview(ctx: ReviewContext, viewer: Viewer, sessionId: string, review: StoredReview): ChangeReviewFeedback {
  const { store, pageLock } = ctx;
  const view = viewOf(store, review, viewer);
  if (view.state === "filed") {
    const filedAt = review.filedAt ?? review.createdAt;
    const nothingLeft = activeSteps(view.steps).length === 0 && !view.steps.some((step) => step.pins.length > 0 || step.answers.some((answer) => answer.kind === "remark"));
    return nothingLeft ? { status: "nothing-left", filedAt } : { status: "filed", filedBy: nameOf(view.filedBy), filedAt };
  }
  if (view.state === "open") {
    const { seen, total } = progressOf(view.steps, -1);
    return { status: "open", seen, total };
  }
  if (review.state === "fetched") return { status: "finished", alreadyFetchedAt: review.fetchedAt, ...review.fetchedResult! };
  const result = reviewResult({
    requester: nameOf(view.requester.person),
    finishedBy: nameOf(view.finishedBy),
    steps: view.steps.map((step) => ({
      id: step.id,
      label: stepLabel(step),
      artboard: step.artboard,
      ...(step.others ? { members: membersOf(step) } : {}),
      answers: step.answers,
      pins: step.pins,
      ...(step.removed ? { removed: step.removed } : {}),
      ...(stepIsCanvasOnly(step) && step.canvasElements!.every((id) => step.canvas?.missing.includes(id)) ? { elementGone: true } : {}),
    })),
    threadIds: openRemarkThreads(store, view, ctx.terminalSessions.labelOf(sessionId)),
  });
  store.changeReviews.markFetched(review.id, viewerPersonId(viewer), sessionId, result);
  announceReviewChange(store, review.id);
  return { status: "finished", ...result };
}

/** The artboards of a group with their "Page · artboard" names, the example first. */
const membersOf = (step: ChangeReview["steps"][number]) => [
  { pageId: step.pageId, artboard: step.artboard, label: `${step.pageTitle} · ${step.artboardTitle}` },
  ...(step.others ?? []).map((member) => ({ pageId: member.pageId, artboard: member.artboard, label: `${member.pageTitle} · ${member.artboardTitle}` })),
];

/**
 * One thread per remark on its artboard and one element thread per pin, signed by their author and taken by `sessionId` (so `reply_in_thread` works on them).
 * Thread ids by remark id and pin id. A pin whose element is lost keeps its last position.
 */
function openRemarkThreads(store: Store, view: ChangeReview, label: SessionLabel | undefined): Record<string, string> {
  const threadIds: Record<string, string> = {};
  const take = (_pageId: string, threadId: string) => {
    if (label) store.takeThread(threadId, label.accountId, label.folder, label.machine);
    store.markThreadFromReview(threadId, view.finishedAt ?? new Date().toISOString());
  };
  for (const step of activeSteps(view.steps)) {
    const members = membersOf(step);
    for (const pin of step.pins) {
      // A pin on a canvas element, or a zone on the canvas, is a thread of the step's page; an element deleted since keeps what the pin recorded of it (the thread opens as removed).
      const target = pin.target;
      if (isCanvasTarget(target)) {
        const thread = store.createThread(step.pageId, { target, body: pin.text } as CreateThreadRequest, pin.person);
        take(step.pageId, thread.id);
        threadIds[pin.id] = thread.id;
        continue;
      }
      // A pin sits on the artboard it was placed on; when that one is gone the thread opens on the first artboard of the step that is left.
      const written = memberOn(members, pin.on)!;
      const where = [written, ...members].find((member) => store.hasArtboard(member.pageId, member.artboard) && !store.getPage(member.pageId)?.archivedAt);
      if (!where) continue;
      const request: CreateThreadRequest =
        target.kind === "zone"
          ? { target: { ...target, artboard: where.artboard, ...(pin.rendering ? { rendering: pin.rendering } : {}), ...(pin.tweaks ? { cell: pin.tweaks } : {}) }, body: pin.text }
          : { artboard: where.artboard, selector: target.selector, xPct: target.xPct, yPct: target.yPct, body: pin.text, ...(target.elementName ? { elementName: target.elementName } : {}), ...(pin.rendering ? { rendering: pin.rendering } : {}), ...(pin.tweaks ? { cell: pin.tweaks } : {}), ...(target.instanceState ? { instanceState: target.instanceState } : {}) };
      const thread = store.createThread(where.pageId, request, pin.person);
      take(where.pageId, thread.id);
      threadIds[pin.id] = thread.id;
    }
  }
  // A remark on a removed step (deleted artboard, archived page) has nowhere to be a thread: it comes as text.
  for (const step of activeSteps(view.steps)) {
    for (const answer of step.answers.filter((a) => a.kind === "remark")) {
      // A group remark goes on the artboard it was written on and cites the others of the group.
      const members = step.others ? membersOf(step) : undefined;
      // When the artboard it was written on is gone (or its page archived), the thread opens on the first artboard of the group that is left.
      const written = members && memberOn(members, answer.on);
      const where = members
        ? [written!, ...members].find((member) => store.hasArtboard(member.pageId, member.artboard) && !store.getPage(member.pageId)?.archivedAt)
        : stepIsCanvasOnly(step) || (store.hasArtboard(step.pageId, step.artboard) && !store.getPage(step.pageId)?.archivedAt)
          ? { pageId: step.pageId, artboard: step.artboard }
          : undefined;
      // A remark on a canvas step, or on a mixed step whose artboards are all gone, is a thread on its first targeted element; with none left it comes as text.
      if (stepIsCanvasOnly(step) || (step.canvasElements && !where)) {
        const first = step.canvasElements!.find((id) => !step.canvas?.missing.includes(id));
        const element = first === undefined ? undefined : store.canvasElement(step.pageId, first);
        if (!element) continue;
        const thread = store.createThread(step.pageId, { target: { kind: "canvas-element", elementId: first! }, body: answer.text ?? "" }, answer.person);
        take(step.pageId, thread.id);
        store.changeReviews.setThread(answer.id, thread.id);
        threadIds[answer.id] = thread.id;
        continue;
      }
      const pageId = where?.pageId ?? step.pageId;
      const cited = members && where ? `\n\nRemarque sur le groupe « ${stepLabel(step)} » : le même changement concerne aussi ${members.filter((member) => member !== where).map((member) => member.label).join(", ")}.` : "";
      const thread = store.createThread(pageId, { target: { kind: "artboard", artboard: where?.artboard ?? step.artboard }, body: `${answer.text ?? ""}${cited}` }, answer.person);
      take(pageId, thread.id);
      store.changeReviews.setThread(answer.id, thread.id);
      threadIds[answer.id] = thread.id;
    }
  }
  return threadIds;
}

/** Files a review by itself when no step is left to review and no remark is left to hand over ("plus rien à revoir"): final, so steps that may come back (archived page of an open review) keep it alive. */
function fileIfNothingLeft(store: Store, reviewId: string): boolean {
  const review = store.changeReviews.get(reviewId);
  if (!review || (review.state !== "open" && review.state !== "finished")) return false;
  const steps = store.changeReviews.steps(reviewId);
  const removals = steps.flatMap((step) => removalsOf(store, review, step).each);
  const nothingToReview = removals.every((removal) => removal === "deleted" || (review.state === "finished" && removal === "archived"));
  if (!nothingToReview || store.changeReviews.pins(reviewId).length > 0 || store.changeReviews.answers(reviewId).some((answer) => answer.kind === "remark")) return false;
  store.changeReviews.file(reviewId, undefined);
  return true;
}

/**
 * Keeps reviews in line with their pages: a publish or an archive on a page may remove steps (deleted artboard, archived page), so the reviews covering it are
 * announced (screens and banners reload) and filed when nothing is left. Runs after the current change is complete: a move publishes to two pages one after the other.
 */
function watchRemovals(store: Store): () => void {
  return store.onChange((event) => {
    if (event.type !== "page-updated" && event.type !== "page-archive-changed") return;
    const { pageId } = event;
    queueMicrotask(() => {
      for (const review of store.changeReviews.liveCovering(pageId)) {
        fileIfNothingLeft(store, review.id);
        announceReviewChange(store, review.id);
      }
    });
  });
}

/**
 * An artboard moved to another page of its project: the steps on it follow, and answers do not become "modified" for it (the receiving page's version of the artboard
 * is the one the answers saw). Announces both pages.
 */
export function followMovedArtboard(store: Store, sourcePageId: string, file: string, targetPageId: string, seenOnSource: string | undefined): void {
  const seenOnTarget = currentArtboardVersion(store.listVersionRecords(targetPageId), file)?.id;
  for (const reviewId of store.changeReviews.follow(file, sourcePageId, targetPageId, seenOnSource, seenOnTarget)) {
    const projectId = store.changeReviews.projectIdOf(reviewId)!;
    const pageIds = [...new Set([sourcePageId, ...store.changeReviews.steps(reviewId).map((step) => step.pageId)])];
    store.emit({ type: "review-updated", reviewId, projectId, pageIds });
  }
}

/** The version of `file` a review answer on `pageId` would see now (see `followMovedArtboard`). */
export const artboardVersionOf = (store: Store, pageId: string, file: string): string | undefined => currentArtboardVersion(store.listVersionRecords(pageId), file)?.id;

/** The review screen's routes: reading a review, answering OK or with a remark, cancelling, finishing. Access is by the review's project (see `access.ts`). */
export function registerChangeReviewRoutes(app: FastifyInstance, store: Store): void {
  const stopWatching = watchRemovals(store);
  app.addHook("onClose", async () => stopWatching());
  const open = (reviewId: string) => store.changeReviews.get(reviewId);
  const stepOf = (reviewId: string, stepId: string): StoredStep | undefined => store.changeReviews.steps(reviewId).find((candidate) => candidate.id === stepId);
  /** The artboard versions an answer given now sees: the example's, and each other artboard's of a group. */
  const seenNow = (step: StoredStep | undefined): SeenNow => {
    if (!step) return {};
    const recordsOf = recordsReader(store);
    const versionOf = (ref: ArtboardRef) => currentArtboardVersion(recordsOf(ref.pageId), ref.artboard)?.id;
    const memberVersions = Object.fromEntries((step.others ?? []).flatMap((member) => (versionOf(member) ? [[artboardKey(member), versionOf(member)!]] : [])));
    return { ...(versionOf(step) ? { artboardVersion: versionOf(step)! } : {}), memberVersions };
  };

  app.get<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId", async (req, reply) => {
    const review = open(req.params.reviewId);
    return review ? viewOf(store, review, req.viewer) : reply.code(404).send({ error: "review not found" });
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/change-reviews", async (req) => bannersOf(store, req.params.pageId, req.viewer));

  /** The open review whose step (or, with `answerId`, remark) a route changes; else the 404 or 409 is already sent. */
  const openReviewFor = (reply: FastifyReply, reviewId: string, target: { stepId: string } | { remarkId: string }): StoredReview | undefined => {
    const review = open(reviewId);
    const found = review && ("stepId" in target ? store.changeReviews.hasStep(review.id, target.stepId) : store.changeReviews.answers(review.id).some((answer) => answer.id === target.remarkId && answer.kind === "remark"));
    if (!review || !found) void reply.code(404).send({ error: "stepId" in target ? "step not found" : "remark not found" });
    else if (review.state !== "open") void reply.code(409).send({ error: "this review is finished" });
    else return review;
    return undefined;
  };

  app.put<{ Params: { reviewId: string; stepId: string } }>("/api/change-reviews/:reviewId/steps/:stepId/ok", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { stepId: req.params.stepId });
    if (!review) return reply;
    if (store.changeReviews.answerOf(req.params.stepId, viewerPersonId(req.viewer))?.kind === "remark") return reply.code(409).send({ error: "you left a remark on this step: delete it before answering OK" });
    if (store.changeReviews.pins(review.id).some((pin) => pin.stepId === req.params.stepId && (pin.personId ?? "") === (viewerPersonId(req.viewer) ?? ""))) return reply.code(409).send({ error: "you left pins on this step: delete them before answering OK" });
    store.changeReviews.addOk(req.params.stepId, viewerPersonId(req.viewer), seenNow(stepOf(review.id, req.params.stepId)));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.delete<{ Params: { reviewId: string; stepId: string } }>("/api/change-reviews/:reviewId/steps/:stepId/ok", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { stepId: req.params.stepId });
    if (!review) return reply;
    store.changeReviews.removeOk(req.params.stepId, viewerPersonId(req.viewer));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.put<{ Params: { reviewId: string; stepId: string }; Body: { text?: unknown; pageId?: unknown; artboard?: unknown } }>("/api/change-reviews/:reviewId/steps/:stepId/remark", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { stepId: req.params.stepId });
    if (!review) return reply;
    const text = req.body?.text;
    if (!requiredString(text) || text.length > MAX_STEP_TEXT_LENGTH) return reply.code(400).send({ error: `text must be a non-empty string of at most ${MAX_STEP_TEXT_LENGTH} characters` });
    // On a group the remark is attached to the artboard shown when it was started: one of the step's artboards (the example is the default).
    const step = stepOf(review.id, req.params.stepId)!;
    const { pageId, artboard } = req.body;
    if ((pageId !== undefined || artboard !== undefined) && !stepArtboards(step).some((ref) => ref.pageId === pageId && ref.artboard === artboard)) return reply.code(400).send({ error: "on must name an artboard of the step (pageId and artboard)" });
    const on = pageId !== undefined && !(pageId === step.pageId && artboard === step.artboard) ? { pageId: pageId as string, artboard: artboard as string } : undefined;
    // Always the viewer's own remark: nobody can write on another member's.
    store.changeReviews.saveRemark(req.params.stepId, viewerPersonId(req.viewer), text, seenNow(step), on);
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.delete<{ Params: { reviewId: string; answerId: string } }>("/api/change-reviews/:reviewId/remarks/:answerId", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { remarkId: req.params.answerId });
    if (!review) return reply;
    const answer = store.changeReviews.answers(review.id).find((candidate) => candidate.id === req.params.answerId)!;
    if ((answer.personId ?? "") !== (viewerPersonId(req.viewer) ?? "")) return reply.code(403).send({ error: "only the author can delete a remark" });
    store.changeReviews.removeAnswer(answer.id);
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  /** The open review a pin route changes (the pin is one of its own); else the 404 or 409 is already sent. */
  const openReviewForPin = (reply: FastifyReply, reviewId: string, pinId: string): StoredReview | undefined => {
    const review = open(reviewId);
    if (!review || store.changeReviews.reviewIdOfPin(pinId) !== review.id) void reply.code(404).send({ error: "pin not found" });
    else if (review.state !== "open") void reply.code(409).send({ error: "this review is finished" });
    else return review;
    return undefined;
  };
  const ownPin = (reviewId: string, pinId: string, viewer: Viewer) => store.changeReviews.pins(reviewId).find((pin) => pin.id === pinId && (pin.personId ?? "") === (viewerPersonId(viewer) ?? ""));
  const stepSeenBy = (reviewId: string, pinId: string) => seenNow(stepOf(reviewId, store.changeReviews.pins(reviewId).find((pin) => pin.id === pinId)!.stepId));

  type PinBody = { text?: unknown; target?: { kind?: unknown; space?: unknown; elementId?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; wPct?: unknown; hPct?: unknown; selector?: unknown; elementName?: unknown; xPct?: unknown; yPct?: unknown; instanceState?: unknown }; on?: { pageId?: unknown; artboard?: unknown }; rendering?: unknown; tweaks?: unknown };

  app.post<{ Params: { reviewId: string; stepId: string }; Body: PinBody }>("/api/change-reviews/:reviewId/steps/:stepId/pins", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { stepId: req.params.stepId });
    if (!review) return reply;
    const { text, target, on, rendering, tweaks } = req.body ?? {};
    if (!requiredString(text) || text.length > MAX_STEP_TEXT_LENGTH) return reply.code(400).send({ error: `text must be a non-empty string of at most ${MAX_STEP_TEXT_LENGTH} characters` });
    const step = stepOf(review.id, req.params.stepId)!;
    if (on !== undefined && !stepArtboards(step).some((ref) => ref.pageId === on.pageId && ref.artboard === on.artboard)) return reply.code(400).send({ error: "on must name an artboard of the step (pageId and artboard)" });
    const own = viewerPersonId(req.viewer) ?? "";
    if (store.changeReviews.pins(review.id).filter((pin) => pin.stepId === step.id && (pin.personId ?? "") === own).length >= MAX_PINS_PER_MEMBER_AND_STEP) return reply.code(409).send({ error: `a member can leave at most ${MAX_PINS_PER_MEMBER_AND_STEP} pins on a step` });
    const canvasTarget = target !== undefined && isCanvasTarget(target);
    // A canvas step has no artboard to pin on, and an artboard step no canvas: the target must belong to the step.
    if (canvasTarget && !step.canvasElements) return reply.code(400).send({ error: "this step points at no canvas element: pin on its artboard" });
    if (!canvasTarget && stepIsCanvasOnly(step)) return reply.code(400).send({ error: "this step has no artboard: pin on a canvas element or draw a zone on the canvas" });
    if (target?.kind === "canvas-element") {
      if (typeof target.elementId !== "string" || !step.canvasElements!.includes(target.elementId)) return reply.code(400).send({ error: "elementId must be one of the step's canvas elements" });
      const element = store.canvasElement(step.pageId, target.elementId);
      if (!element) return reply.code(400).send({ error: "this canvas element no longer exists" });
      const elementSummary = canvasElementSummary(element);
      const pin: PinToStore = { text, target: { kind: "canvas-element", elementId: target.elementId, elementKind: element.kind, ...(elementSummary ? { elementSummary } : {}) } };
      store.changeReviews.addPin(step.id, viewerPersonId(req.viewer), pin, seenNow(step));
      announceReviewChange(store, review.id);
      return viewOf(store, review, req.viewer);
    }
    if (target?.kind === "zone" && target.space === "canvas") {
      const zoneError = canvasZoneError(target);
      if (zoneError) return reply.code(400).send({ error: zoneError });
      const { x, y, w, h } = target as { x: number; y: number; w: number; h: number };
      store.changeReviews.addPin(step.id, viewerPersonId(req.viewer), { text, target: { kind: "zone", space: "canvas", x, y, w, h } }, seenNow(step));
      announceReviewChange(store, review.id);
      return viewOf(store, review, req.viewer);
    }
    if (target?.kind === "zone") {
      const zoneError = artboardZoneError(target, rendering, tweaks);
      if (zoneError) return reply.code(400).send({ error: zoneError });
      const { xPct, yPct, wPct, hPct } = target as { xPct: number; yPct: number; wPct: number; hPct: number };
      const zone: PinToStore = {
        text,
        target: { kind: "zone", space: "artboard", xPct, yPct, wPct, hPct },
        ...(on && !(on.pageId === step.pageId && on.artboard === step.artboard) ? { on: on as { pageId: string; artboard: string } } : {}),
        ...(rendering ? { rendering: rendering as PinToStore["rendering"] } : {}),
        ...(tweaks ? { tweaks: tweaks as PinToStore["tweaks"] } : {}),
      };
      store.changeReviews.addPin(step.id, viewerPersonId(req.viewer), zone, seenNow(step));
      announceReviewChange(store, review.id);
      return viewOf(store, review, req.viewer);
    }
    // The same shape as a comment pinned on an element: validated as one.
    if (typeof target?.selector === "string" && target.selector.length > MAX_SELECTOR_LENGTH) return reply.code(400).send({ error: `selector must be at most ${MAX_SELECTOR_LENGTH} characters` });
    const shape = createThreadRequestError({ body: text, artboard: (on?.artboard as string | undefined) ?? step.artboard, selector: target?.selector, xPct: target?.xPct, yPct: target?.yPct, elementName: target?.elementName, rendering, cell: tweaks, instanceState: target?.instanceState });
    if (shape) return reply.code(400).send({ error: shape });
    const stateTooLong = Array.isArray(target?.instanceState) && (target.instanceState as InstanceState[]).some((entry) => entry.selector.length > MAX_SELECTOR_LENGTH || Object.entries(entry.attributes).some(([name, value]) => name.length > MAX_STATE_VALUE_LENGTH || value.length > MAX_STATE_VALUE_LENGTH));
    if (stateTooLong) return reply.code(400).send({ error: `instanceState entries must keep selectors under ${MAX_SELECTOR_LENGTH} and attributes under ${MAX_STATE_VALUE_LENGTH} characters` });
    const placed = target!;
    const pin: PinToStore = {
      text,
      target: { selector: placed.selector as string, xPct: placed.xPct as number, yPct: placed.yPct as number, ...(placed.elementName ? { elementName: placed.elementName as string } : {}), ...(placed.instanceState ? { instanceState: placed.instanceState as InstanceState[] } : {}) },
      ...(on && !(on.pageId === step.pageId && on.artboard === step.artboard) ? { on: on as { pageId: string; artboard: string } } : {}),
      ...(rendering ? { rendering: rendering as PinToStore["rendering"] } : {}),
      ...(tweaks ? { tweaks: tweaks as PinToStore["tweaks"] } : {}),
    };
    store.changeReviews.addPin(step.id, viewerPersonId(req.viewer), pin, seenNow(step));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.put<{ Params: { reviewId: string; pinId: string }; Body: { text?: unknown } }>("/api/change-reviews/:reviewId/pins/:pinId", async (req, reply) => {
    const review = openReviewForPin(reply, req.params.reviewId, req.params.pinId);
    if (!review) return reply;
    if (!ownPin(review.id, req.params.pinId, req.viewer)) return reply.code(403).send({ error: "only the author can change a pin" });
    const text = req.body?.text;
    if (!requiredString(text) || text.length > MAX_STEP_TEXT_LENGTH) return reply.code(400).send({ error: `text must be a non-empty string of at most ${MAX_STEP_TEXT_LENGTH} characters` });
    store.changeReviews.editPin(req.params.pinId, text, stepSeenBy(review.id, req.params.pinId));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.delete<{ Params: { reviewId: string; pinId: string } }>("/api/change-reviews/:reviewId/pins/:pinId", async (req, reply) => {
    const review = openReviewForPin(reply, req.params.reviewId, req.params.pinId);
    if (!review) return reply;
    if (!ownPin(review.id, req.params.pinId, req.viewer)) return reply.code(403).send({ error: "only the author can delete a pin" });
    store.changeReviews.removePin(req.params.pinId);
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  // Any member's screen reports whether it finds the pin's element in the current artboard: it is a fact about the artboard, not an edit.
  app.put<{ Params: { reviewId: string; pinId: string }; Body: { lost?: unknown } }>("/api/change-reviews/:reviewId/pins/:pinId/lost", async (req, reply) => {
    const review = openReviewForPin(reply, req.params.reviewId, req.params.pinId);
    if (!review) return reply;
    if (typeof req.body?.lost !== "boolean") return reply.code(400).send({ error: "lost must be a boolean" });
    store.changeReviews.setPinLost(req.params.pinId, req.body.lost);
    announceReviewChange(store, review.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { reviewId: string; stepId: string } }>("/api/change-reviews/:reviewId/steps/:stepId/clear-and-validate", async (req, reply) => {
    const review = openReviewFor(reply, req.params.reviewId, { stepId: req.params.stepId });
    if (!review) return reply;
    const personId = viewerPersonId(req.viewer);
    store.changeReviews.clearFeedback(req.params.stepId, personId);
    store.changeReviews.addOk(req.params.stepId, personId, seenNow(stepOf(review.id, req.params.stepId)));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.post<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId/finish", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review) return reply.code(404).send({ error: "review not found" });
    if (!nextReviewState(review.state, "finish")) return reply.code(409).send({ error: "this review is already finished" });
    store.changeReviews.finish(review.id, viewerPersonId(req.viewer));
    // Artboards on an archived page stay out even if the page is unarchived later.
    store.changeReviews.freezeArchived(review.id, store.changeReviews.steps(review.id).flatMap(storedArtboards).filter((ref) => store.getPage(ref.pageId)?.archivedAt));
    fileIfNothingLeft(store, review.id);
    announceReviewChange(store, review.id);
    return viewOf(store, open(review.id)!, req.viewer);
  });

  app.post<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId/reopen", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review) return reply.code(404).send({ error: "review not found" });
    if (!nextReviewState(review.state, "reopen")) return reply.code(409).send({ error: "only a finished review can be reopened, and not once it was fetched or filed" });
    store.changeReviews.reopen(review.id);
    announceReviewChange(store, review.id);
    return viewOf(store, open(review.id)!, req.viewer);
  });

  app.post<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId/file", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review) return reply.code(404).send({ error: "review not found" });
    if (!nextReviewState(review.state, "file")) return reply.code(409).send({ error: "only a finished review can be filed, and not once it was fetched" });
    store.changeReviews.file(review.id, viewerPersonId(req.viewer));
    announceReviewChange(store, review.id);
    return viewOf(store, open(review.id)!, req.viewer);
  });

  app.post<{ Params: { reviewId: string }; Body: Partial<ChangeReviewPresenceRequest> }>("/api/change-reviews/:reviewId/presence", async (req, reply) => {
    if (!open(req.params.reviewId)) return reply.code(404).send({ error: "review not found" });
    const step = req.body?.step;
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) return reply.code(400).send({ error: "step must be a positive integer" });
    store.changeReviews.markPresent(req.params.reviewId, viewerPersonId(req.viewer), step);
    return reply.code(204).send();
  });

  app.delete<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId/presence", async (req, reply) => {
    store.changeReviews.markGone(req.params.reviewId, viewerPersonId(req.viewer));
    return reply.code(204).send();
  });
}
