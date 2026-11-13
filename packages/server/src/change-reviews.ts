import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  MANIFEST_PATH,
  defaultManifest,
  groupTitlesOf,
  mergeSteps,
  artboardKey,
  republishedSince,
  stepArtboards,
  stepLabel,
  type ArtboardRef,
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
  activeSteps,
  type ChangeReview,
  type ChangeReviewFeedback,
  type ChangeReviewFeedbackRequest,
  type ChangeReviewPresenceRequest,
  type ChangeReviewStepInput,
  type PageChangeReview,
  type Manifest,
  type Person,
  type TweakValues,
  type RequestChangeReviewRequest,
  type RequestChangeReviewResponse,
  type StepRemoval,
} from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import type { SeenNow, StoredMember, StoredReview, StoredStep } from "./change-review-store.js";
import { contentChanges } from "./artboard-history.js";
import type { PageLock } from "./page-lock.js";
import type { Store, VersionRecord } from "./store.js";
import { MAX_TERMINAL_TEXT_LENGTH, requiredString } from "./validation.js";

const MAX_STEPS = 200;
const MAX_STEP_TEXT_LENGTH = 4_000;

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

/** Files of a page in reading order, from the declared sizes (as the agent's page addresses do). */
function readingOrderOf(manifest: Manifest): string[] {
  const boxes = manifest.artboards.map((artboard) => ({
    file: artboard.file,
    title: artboard.title,
    ...(artboard.responsive ? responsiveFrameLayout(artboard, renderingSlots(artboard.responsive)).frame : artboard),
  }));
  return readingOrder(boxes, groupTitlesOf(manifest)).map((artboard) => artboard.file);
}

/** The version in which the artboard's content last changed (tweak versions do not count); none when the artboard has no content. */
function currentArtboardVersion(records: VersionRecord[], file: string): VersionRecord | undefined {
  return contentChanges(records, file).pop();
}

/** What "Avant" shows for a step, as stored: a page version id, or `""` for an artboard that is new in the series. A given version always wins. */
function baselineOf(store: Store, step: Pick<ChangeReviewStepInput, "pageId" | "artboard" | "baselineVersion">, requesterFolder: string, sameArtboard: { baseline?: string } | undefined): string | undefined {
  const records = store.listVersionRecords(step.pageId);
  if (step.baselineVersion !== undefined) return records.find((record) => record.id === step.baselineVersion)?.files[step.artboard] === undefined ? "" : step.baselineVersion;
  if (sameArtboard?.baseline !== undefined) return sameArtboard.baseline;
  const versions: BaselineVersion[] = records
    .filter((record) => record.origin !== "tweak")
    .map((record) => ({ id: record.id, createdAt: record.createdAt, origin: record.origin, ...(record.originLabel ? { originLabel: record.originLabel } : {}), ...(record.files[step.artboard] !== undefined ? { hash: record.files[step.artboard] } : {}) }));
  const baseline = automaticBaseline({ versions, requesterFolder, afterReviewAt: store.changeReviews.lastLockedAt(step.pageId, step.artboard) });
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

/**
 * Why a step is out of the review, if it is: its artboard was deleted (or its page), or its page is archived.
 * An archived page brings its steps back while the review is open; a finished review keeps them out even if the page is unarchived later.
 */
function removalOf(store: Store, review: StoredReview, step: StoredStep, ref: ArtboardRef = step): StepRemoval | undefined {
  const page = store.getPage(ref.pageId);
  if (!page || !store.hasArtboard(ref.pageId, ref.artboard)) return "deleted";
  if (page.archivedAt || (review.state !== "open" && step.archivedAtFinish)) return "archived";
  return undefined;
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

const viewerPersonId = (viewer: Viewer): string | undefined => (viewer.kind === "account" || viewer.kind === "agent" ? viewer.person?.id : undefined);

/** The review as `viewer` sees it, steps in review order. */
function viewOf(store: Store, review: StoredReview, viewer: Viewer): ChangeReview {
  const answers = store.changeReviews.answers(review.id);
  const own = viewerPersonId(viewer) ?? "";
  const recordsOfPage = new Map<string, VersionRecord[]>();
  const recordsOf = (pageId: string): VersionRecord[] => {
    if (!recordsOfPage.has(pageId)) recordsOfPage.set(pageId, store.getPage(pageId) ? store.listVersionRecords(pageId) : []);
    return recordsOfPage.get(pageId)!;
  };
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
    // A group is out of the review only when none of its artboards is left (the example's reason is given).
    const removals = stepArtboards(step).map((ref) => removalOf(store, review, step, ref));
    const removed = removals.every((reason) => reason !== undefined) ? removals[0] : undefined;
    const stepAnswers = answers
      .filter((answer) => answer.stepId === step.id)
      .map((answer) => {
        const person = store.getPerson(answer.personId);
        const changed = republishedSince(answer, now);
        const outdated = changed.example || changed.others.length > 0;
        republished.example ||= changed.example;
        for (const key of changed.others) republished.others.add(key);
        return { id: answer.id, kind: answer.kind, ...(answer.text !== undefined ? { text: answer.text } : {}), ...(person ? { person } : {}), at: answer.at, mine: (answer.personId ?? "") === own, ...(outdated ? { outdated } : {}), ...(answer.on ? { on: answer.on } : {}) };
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
      ...describe(step, step.baseline, removals[0]),
      ...(removed ? { removed } : {}),
      ...(step.others
        ? { others: currentOthers.map(({ member, current: version }, index) => ({ pageId: member.pageId, artboard: member.artboard, ...describe(member, member.baseline, removals[index + 1]), ...(republished.others.has(artboardKey(member)) ? { modified: true, ...modifiedFields(version) } : {}) })) }
        : {}),
      ...(step.tweaks ? { tweaks: step.tweaks } : {}),
      ...(step.mobile ? { mobile: true } : {}),
      answers: stepAnswers,
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
    requester: { ...(requester ? { person: requester } : {}), folder: review.folder, ...(review.label ? { label: review.label } : {}) },
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
  const pageIds = [...new Set(store.changeReviews.steps(reviewId).flatMap((step) => stepArtboards(step).map((ref) => ref.pageId)))];
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
      remarkCount: answers.filter((answer) => answer.kind === "remark").length,
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
export function declareChangeReview(store: Store, access: Access, viewer: Viewer, sessionFolder: string | undefined, body: Partial<RequestChangeReviewRequest> | undefined): { error: string; status: number } | RequestChangeReviewResponse {
  const { folder, label, steps } = body ?? {};
  if (!requiredString(folder) || folder.length > MAX_TERMINAL_TEXT_LENGTH) return { status: 400, error: "folder is required" };
  if (label !== undefined && (!requiredString(label) || label.length > MAX_TERMINAL_TEXT_LENGTH)) return { status: 400, error: "label must be a non-empty string" };
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return { status: 400, error: `steps must be a list of 1 to ${MAX_STEPS} steps` };
  const valid = steps.every((step: Partial<ChangeReviewStepInput> | null) =>
    [step?.pageId, step?.artboard, step?.changed, step?.lookAt, step?.question].every((value) => requiredString(value) && value.length <= MAX_STEP_TEXT_LENGTH),
  );
  if (!valid) return { status: 400, error: "each step needs pageId, artboard, changed, lookAt and question" };
  const groups = steps.every((step: Partial<ChangeReviewStepInput>) => (step.title === undefined || (requiredString(step.title) && step.title.length <= MAX_STEP_TEXT_LENGTH)) && (step.others === undefined || (Array.isArray(step.others) && step.others.length > 0 && step.others.length <= MAX_STEPS && step.others.every((other) => requiredString(other?.pageId) && requiredString(other?.artboard)))));
  if (!groups) return { status: 400, error: "a step's others must be a non-empty list of { pageId, artboard } (the other artboards sharing the change) and its title a non-empty string" };
  const shape = steps.every((step: Partial<ChangeReviewStepInput>) => (step.mobile === undefined || typeof step.mobile === "boolean") && (step.baselineVersion === undefined || requiredString(step.baselineVersion)) && (step.tweaks === undefined || (typeof step.tweaks === "object" && step.tweaks !== null && !Array.isArray(step.tweaks))));
  if (!shape) return { status: 400, error: "a step's mobile must be a boolean, its baselineVersion a version id and its tweaks an object of tweak id to value" };
  const declared = (steps as ChangeReviewStepInput[]).map((step) => (step.others ? { ...step, others: step.others.map(({ pageId, artboard }) => ({ pageId, artboard })) } : step));
  const repeated = declared.filter((step) => new Set(stepArtboards(step).map(artboardKey)).size < stepArtboards(step).length).map((step) => `${step.pageId}: ${step.artboard}`);
  if (repeated.length > 0) return { status: 400, error: `A group lists each artboard once, the example included, fix the declaration: ${repeated.join(", ")}.` };

  const unknownPages = [...new Set(declared.flatMap(stepArtboards).map((ref) => ref.pageId).filter((pageId) => !store.getPage(pageId) || store.getPage(pageId)!.archivedAt))];
  if (unknownPages.length > 0) return { status: 400, error: `Unknown or archived pages: ${unknownPages.join(", ")}` };
  // The review's project is the first step's: the artboards of any other project are refused.
  const projectId = store.getPage(declared[0]!.pageId)!.projectId;
  if (access.levelOf(viewer, { projectId }) !== "write") return { status: 403, error: "your account does not have Écriture on this project" };
  const describe = (step: ArtboardRef) => `${store.getPage(step.pageId)!.title}: ${step.artboard}`;
  const artboards = declared.flatMap(stepArtboards);
  const otherProject = artboards.filter((ref) => store.getPage(ref.pageId)!.projectId !== projectId).map(describe);
  const unknownArtboards = artboards.filter((ref) => store.getPage(ref.pageId)!.projectId === projectId && !store.hasArtboard(ref.pageId, ref.artboard)).map(describe);
  if (otherProject.length > 0 || unknownArtboards.length > 0) {
    return {
      status: 400,
      error: [
        otherProject.length > 0 ? `A review covers one project only ("une revue ne couvre qu'un projet"): these artboards are not in project "${store.getProject(projectId)?.title ?? projectId}": ${[...new Set(otherProject)].join(", ")}.` : "",
        unknownArtboards.length > 0 ? `Unknown artboards, fix the declaration: ${[...new Set(unknownArtboards)].join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  const unknownVersions = declared.filter((step) => step.baselineVersion !== undefined && !store.listVersionRecords(step.pageId).some((record) => record.id === step.baselineVersion)).map((step) => `${describe(step)}: version ${step.baselineVersion}`);
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
  const requesterFolder = (sessionFolder ?? folder).split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const knownBaselines = known.flatMap((other): StoredMember[] => [other, ...(other.others ?? [])]).filter((other) => other.baseline !== undefined);
  const sameArtboard = (ref: ArtboardRef) => knownBaselines.find((other) => other.pageId === ref.pageId && other.artboard === ref.artboard);
  const withBaselines = declared.map((step) => {
    const baseline = baselineOf(store, step, requesterFolder, sameArtboard(step));
    const others = step.others?.map((member): StoredMember => {
      const memberBaseline = baselineOf(store, member, requesterFolder, sameArtboard(member));
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
  return { id: review.id, merged: false, stepCount: declared.length, ...(unfetched ? { warning: "ta revue précédente est terminée mais pas récupérée" } : {}) };
}

const folderNameOf = (review: StoredReview): string => review.label ?? (review.folder.split("/").filter(Boolean).pop() ?? review.folder);

/**
 * What `review_feedback` gives: the result of a review (its progress while it is open).
 * With an id any member with Écriture on the project may take it. Without one, the finished, not yet fetched reviews of `projectIds`
 * (the folder's linked projects): one is taken, several are listed and nothing is taken, none gives the open ones with their progress.
 * Taking a review turns each remark into a thread on its artboard, owned by the terminal session; asking again returns the same result and creates nothing.
 */
export function changeReviewFeedback(
  store: Store,
  access: Access,
  pageLock: PageLock,
  viewer: Viewer,
  sessionId: string,
  request: ChangeReviewFeedbackRequest,
): { error: string; status: number } | ChangeReviewFeedback {
  const mayFetch = (projectId: string) => access.levelOf(viewer, { projectId }) === "write";
  if (request.reviewId !== undefined) {
    const review = store.changeReviews.get(request.reviewId);
    if (!review) return { status: 404, error: "review not found" };
    if (!mayFetch(review.projectId)) return { status: 403, error: "your account does not have Écriture on this project" };
    return fetchReview(store, pageLock, viewer, sessionId, review);
  }
  const projectIds = (request.projectIds ?? []).filter(mayFetch);
  if (projectIds.length === 0) return { status: 403, error: "pass reviewId, or link this folder to a project where your account has Écriture" };
  const finished = store.changeReviews.inProjects(projectIds, ["finished"]);
  if (finished.length === 1) return fetchReview(store, pageLock, viewer, sessionId, finished[0]!);
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
      remarks: view.steps.flatMap((step) => step.answers).filter((answer) => answer.kind === "remark").length,
    };
  });
  return { status: "none-finished", reviews };
}

function fetchReview(store: Store, pageLock: PageLock, viewer: Viewer, sessionId: string, review: StoredReview): ChangeReviewFeedback {
  const view = viewOf(store, review, viewer);
  if (view.state === "filed") {
    const filedAt = review.filedAt ?? review.createdAt;
    const nothingLeft = activeSteps(view.steps).length === 0 && !view.steps.some((step) => step.answers.some((answer) => answer.kind === "remark"));
    return nothingLeft ? { status: "nothing-left", filedAt } : { status: "filed", filedBy: nameOf(view.filedBy), filedAt };
  }
  if (view.state === "open") {
    const { seen, total } = progressOf(view.steps, -1);
    return { status: "open", seen, total };
  }
  const alreadyFetchedAt = review.state === "fetched" ? review.fetchedAt : undefined;
  const threadIds = openRemarkThreads(store, pageLock, view, sessionId);
  store.changeReviews.markFetched(review.id, viewerPersonId(viewer));
  announceReviewChange(store, review.id);
  const result = reviewResult({
    requester: nameOf(view.requester.person),
    finishedBy: nameOf(view.finishedBy),
    steps: view.steps.map((step) => ({
      id: step.id,
      label: stepLabel(step),
      artboard: step.artboard,
      ...(step.others ? { members: membersOf(step) } : {}),
      answers: step.answers,
      ...(step.removed ? { removed: step.removed } : {}),
    })),
    threadIds,
  });
  return { status: "finished", ...(alreadyFetchedAt ? { alreadyFetchedAt } : {}), ...result };
}

/** The artboards of a group with their "Page · artboard" names, the example first. */
const membersOf = (step: ChangeReview["steps"][number]) => [
  { pageId: step.pageId, artboard: step.artboard, label: `${step.pageTitle} · ${step.artboardTitle}` },
  ...(step.others ?? []).map((member) => ({ pageId: member.pageId, artboard: member.artboard, label: `${member.pageTitle} · ${member.artboardTitle}` })),
];

/** One thread per remark on its artboard, signed by the remark's author and taken by `sessionId` (so `reply_in_thread` works on it). Thread ids by remark id. */
function openRemarkThreads(store: Store, pageLock: PageLock, view: ChangeReview, sessionId: string): Record<string, string> {
  const stored = new Map(store.changeReviews.answers(view.id).map((answer) => [answer.id, answer]));
  const threadIds: Record<string, string> = {};
  // A remark on a removed step (deleted artboard, archived page) has nowhere to be a thread: it comes as text.
  for (const step of activeSteps(view.steps)) {
    for (const answer of step.answers.filter((a) => a.kind === "remark")) {
      const known = stored.get(answer.id)?.threadId;
      if (known) {
        threadIds[answer.id] = known;
        continue;
      }
      // A group remark goes on the artboard it was written on and cites the others of the group.
      const members = step.others ? membersOf(step) : undefined;
      // When the artboard it was written on is gone (or its page archived), the thread opens on the first artboard of the group that is left.
      const written = members?.find((member) => member.pageId === answer.on?.pageId && member.artboard === answer.on?.artboard) ?? members?.[0];
      const where = members && [written!, ...members].find((member) => store.hasArtboard(member.pageId, member.artboard) && !store.getPage(member.pageId)?.archivedAt);
      const pageId = where?.pageId ?? step.pageId;
      const cited = members && where ? `\n\nRemarque sur le groupe « ${stepLabel(step)} » : le même changement concerne aussi ${members.filter((member) => member !== where).map((member) => member.label).join(", ")}.` : "";
      const thread = store.createThread(pageId, { target: { kind: "artboard", artboard: where?.artboard ?? step.artboard }, body: `${answer.text ?? ""}${cited}` }, answer.person);
      const runId = randomUUID();
      pageLock.showTerminalRun(pageId, runId, thread.id);
      store.pickThreadForTerminalSession(thread.id, sessionId, runId);
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
  const removals = steps.map((step) => removalOf(store, review, step));
  const nothingToReview = removals.every((removal) => removal === "deleted" || (review.state === "finished" && removal === "archived"));
  if (!nothingToReview || store.changeReviews.answers(reviewId).some((answer) => answer.kind === "remark")) return false;
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
    const versionOf = (ref: ArtboardRef) => currentArtboardVersion(store.listVersionRecords(ref.pageId), ref.artboard)?.id;
    const memberVersions = Object.fromEntries((step.others ?? []).flatMap((member) => (versionOf(member) ? [[artboardKey(member), versionOf(member)!]] : [])));
    return { ...(versionOf(step) ? { artboardVersion: versionOf(step)! } : {}), memberVersions };
  };

  app.get<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId", async (req, reply) => {
    const review = open(req.params.reviewId);
    return review ? viewOf(store, review, req.viewer) : reply.code(404).send({ error: "review not found" });
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/change-reviews", async (req) => bannersOf(store, req.params.pageId, req.viewer));

  app.put<{ Params: { reviewId: string; stepId: string } }>("/api/change-reviews/:reviewId/steps/:stepId/ok", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review || !store.changeReviews.hasStep(review.id, req.params.stepId)) return reply.code(404).send({ error: "step not found" });
    if (review.state !== "open") return reply.code(409).send({ error: "this review is finished" });
    if (store.changeReviews.answerOf(req.params.stepId, viewerPersonId(req.viewer))?.kind === "remark") return reply.code(409).send({ error: "you left a remark on this step: delete it before answering OK" });
    store.changeReviews.addOk(req.params.stepId, viewerPersonId(req.viewer), seenNow(stepOf(review.id, req.params.stepId)));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.delete<{ Params: { reviewId: string; stepId: string } }>("/api/change-reviews/:reviewId/steps/:stepId/ok", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review || !store.changeReviews.hasStep(review.id, req.params.stepId)) return reply.code(404).send({ error: "step not found" });
    if (review.state !== "open") return reply.code(409).send({ error: "this review is finished" });
    store.changeReviews.removeOk(req.params.stepId, viewerPersonId(req.viewer));
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.put<{ Params: { reviewId: string; stepId: string }; Body: { text?: unknown; pageId?: unknown; artboard?: unknown } }>("/api/change-reviews/:reviewId/steps/:stepId/remark", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review || !store.changeReviews.hasStep(review.id, req.params.stepId)) return reply.code(404).send({ error: "step not found" });
    if (review.state !== "open") return reply.code(409).send({ error: "this review is finished" });
    const text = req.body?.text;
    if (!requiredString(text) || text.length > MAX_STEP_TEXT_LENGTH) return reply.code(400).send({ error: `text must be a non-empty string of at most ${MAX_STEP_TEXT_LENGTH} characters` });
    // On a group the remark is attached to the artboard shown when it was started: one of the step's artboards (the example is the default).
    const step = stepOf(review.id, req.params.stepId)!;
    const { pageId, artboard } = req.body;
    if ((pageId !== undefined || artboard !== undefined) && !stepArtboards(step).some((ref) => ref.pageId === pageId && ref.artboard === artboard)) return reply.code(400).send({ error: "pageId and artboard must name an artboard of the step" });
    const on = pageId !== undefined && !(pageId === step.pageId && artboard === step.artboard) ? { pageId: pageId as string, artboard: artboard as string } : undefined;
    // Always the viewer's own remark: nobody can write on another member's.
    store.changeReviews.saveRemark(req.params.stepId, viewerPersonId(req.viewer), text, seenNow(step), on);
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.delete<{ Params: { reviewId: string; answerId: string } }>("/api/change-reviews/:reviewId/remarks/:answerId", async (req, reply) => {
    const review = open(req.params.reviewId);
    const answer = review && store.changeReviews.answers(review.id).find((candidate) => candidate.id === req.params.answerId && candidate.kind === "remark");
    if (!review || !answer) return reply.code(404).send({ error: "remark not found" });
    if (review.state !== "open") return reply.code(409).send({ error: "this review is finished" });
    if ((answer.personId ?? "") !== (viewerPersonId(req.viewer) ?? "")) return reply.code(403).send({ error: "only the author can delete a remark" });
    store.changeReviews.removeAnswer(answer.id);
    announceReviewChange(store, review.id);
    return viewOf(store, review, req.viewer);
  });

  app.post<{ Params: { reviewId: string } }>("/api/change-reviews/:reviewId/finish", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review) return reply.code(404).send({ error: "review not found" });
    if (!nextReviewState(review.state, "finish")) return reply.code(409).send({ error: "this review is already finished" });
    store.changeReviews.finish(review.id, viewerPersonId(req.viewer));
    // Steps on an archived page stay out even if the page is unarchived later.
    store.changeReviews.freezeArchived(store.changeReviews.steps(review.id).filter((step) => store.getPage(step.pageId)?.archivedAt).map((step) => step.id));
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
