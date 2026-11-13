import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  MANIFEST_PATH,
  defaultManifest,
  groupTitlesOf,
  mergeSteps,
  nextReviewState,
  orderSteps,
  parseManifest,
  bannerStateOf,
  FETCHED_BANNER_MS,
  readingOrder,
  renderingSlots,
  responsiveFrameLayout,
  reviewResult,
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
  type RequestChangeReviewRequest,
  type RequestChangeReviewResponse,
  type StepRemoval,
} from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import type { StoredReview, StoredStep } from "./change-review-store.js";
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
function removalOf(store: Store, review: StoredReview, step: StoredStep): StepRemoval | undefined {
  const page = store.getPage(step.pageId);
  if (!page || !store.hasArtboard(step.pageId, step.artboard)) return "deleted";
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
  const steps = store.changeReviews.steps(review.id).map((step) => {
    const page = store.getPage(step.pageId);
    const removed = removalOf(store, review, step);
    if (page && !recordsOfPage.has(step.pageId)) recordsOfPage.set(step.pageId, store.listVersionRecords(step.pageId));
    const current = page && currentArtboardVersion(recordsOfPage.get(step.pageId)!, step.artboard);
    const entry = page && removed !== "deleted" ? manifestOf(store, step.pageId).artboards.find((artboard) => artboard.file === step.artboard) : undefined;
    const stepAnswers = answers
      .filter((answer) => answer.stepId === step.id)
      .map((answer) => {
        const person = store.getPerson(answer.personId);
        const outdated = current !== undefined && answer.artboardVersion !== undefined && answer.artboardVersion !== current.id;
        return { id: answer.id, kind: answer.kind, ...(answer.text !== undefined ? { text: answer.text } : {}), ...(person ? { person } : {}), at: answer.at, mine: (answer.personId ?? "") === own, ...(outdated ? { outdated } : {}) };
      });
    return {
      pageId: step.pageId,
      artboard: step.artboard,
      changed: step.changed,
      lookAt: step.lookAt,
      question: step.question,
      id: step.id,
      pageTitle: page?.title ?? "",
      artboardTitle: entry?.title ?? (page && removed === "deleted" ? lastTitleOf(store, step.pageId, step.artboard) : undefined) ?? step.artboard,
      ...(entry ? { artboardEntry: entry } : {}),
      ...(removed ? { removed } : {}),
      answers: stepAnswers,
      ...(stepAnswers.some((answer) => answer.outdated) && current ? { ...(authorOf(current) ? { modifiedBy: authorOf(current) } : {}), modifiedAt: current.createdAt } : {}),
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
  const pageIds = [...new Set(store.changeReviews.steps(reviewId).map((step) => step.pageId))];
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
      pageTitles: [...new Set(kept.map((step) => step.pageTitle))],
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
export function declareChangeReview(store: Store, access: Access, viewer: Viewer, body: Partial<RequestChangeReviewRequest> | undefined): { error: string; status: number } | RequestChangeReviewResponse {
  const { folder, label, steps } = body ?? {};
  if (!requiredString(folder) || folder.length > MAX_TERMINAL_TEXT_LENGTH) return { status: 400, error: "folder is required" };
  if (label !== undefined && (!requiredString(label) || label.length > MAX_TERMINAL_TEXT_LENGTH)) return { status: 400, error: "label must be a non-empty string" };
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return { status: 400, error: `steps must be a list of 1 to ${MAX_STEPS} steps` };
  const valid = steps.every((step: Partial<ChangeReviewStepInput> | null) =>
    [step?.pageId, step?.artboard, step?.changed, step?.lookAt, step?.question].every((value) => requiredString(value) && value.length <= MAX_STEP_TEXT_LENGTH),
  );
  if (!valid) return { status: 400, error: "each step needs pageId, artboard, changed, lookAt and question" };
  const declared = steps as ChangeReviewStepInput[];

  const unknownPages = [...new Set(declared.map((step) => step.pageId).filter((pageId) => !store.getPage(pageId) || store.getPage(pageId)!.archivedAt))];
  if (unknownPages.length > 0) return { status: 400, error: `Unknown or archived pages: ${unknownPages.join(", ")}` };
  // The review's project is the first step's: the artboards of any other project are refused.
  const projectId = store.getPage(declared[0]!.pageId)!.projectId;
  if (access.levelOf(viewer, { projectId }) !== "write") return { status: 403, error: "your account does not have Écriture on this project" };
  const describe = (step: ChangeReviewStepInput) => `${store.getPage(step.pageId)!.title}: ${step.artboard}`;
  const otherProject = declared.filter((step) => store.getPage(step.pageId)!.projectId !== projectId).map(describe);
  const unknownArtboards = declared.filter((step) => store.getPage(step.pageId)!.projectId === projectId && !store.hasArtboard(step.pageId, step.artboard)).map(describe);
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

  const requester = { personId: viewerPersonId(viewer), folder };
  const pages = store.listPages(projectId, "active");
  const orderOf = (steps: readonly ChangeReviewStepInput[]) => {
    const readingOrderByPage: Record<string, string[]> = {};
    for (const page of pages) readingOrderByPage[page.id] = readingOrderOf(manifestOf(store, page.id));
    return orderSteps(steps, pages.map((page) => page.id), readingOrderByPage);
  };

  const open = store.changeReviews.latestOf(projectId, requester, "open");
  if (open) {
    const merged = orderOf(mergeSteps(store.changeReviews.steps(open.id), declared));
    store.changeReviews.merge(open.id, merged, label);
    announceReviewChange(store, open.id);
    return { id: open.id, merged: true, stepCount: merged.length };
  }
  const unfetched = store.changeReviews.latestOf(projectId, requester, "finished");
  const review = store.changeReviews.create(projectId, { ...requester, ...(label ? { label } : {}) }, orderOf(declared));
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
    return view.filedBy ? { status: "filed", filedBy: nameOf(view.filedBy), filedAt } : { status: "nothing-left", filedAt };
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
    steps: view.steps.map((step) => ({ id: step.id, label: `${step.pageTitle} · ${step.artboardTitle}`, artboard: step.artboard, answers: step.answers, ...(step.removed ? { removed: step.removed } : {}) })),
    threadIds,
  });
  return { status: "finished", ...(alreadyFetchedAt ? { alreadyFetchedAt } : {}), ...result };
}

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
      const thread = store.createThread(step.pageId, { target: { kind: "artboard", artboard: step.artboard }, body: answer.text ?? "" }, answer.person);
      const runId = randomUUID();
      pageLock.showTerminalRun(step.pageId, runId, thread.id);
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
  /** The artboard version an answer given now sees. */
  const versionSeenBy = (reviewId: string, stepId: string): string | undefined => {
    const step = store.changeReviews.steps(reviewId).find((candidate) => candidate.id === stepId);
    return step && currentArtboardVersion(store.listVersionRecords(step.pageId), step.artboard)?.id;
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
    store.changeReviews.addOk(req.params.stepId, viewerPersonId(req.viewer), versionSeenBy(review.id, req.params.stepId));
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

  app.put<{ Params: { reviewId: string; stepId: string }; Body: { text?: unknown } }>("/api/change-reviews/:reviewId/steps/:stepId/remark", async (req, reply) => {
    const review = open(req.params.reviewId);
    if (!review || !store.changeReviews.hasStep(review.id, req.params.stepId)) return reply.code(404).send({ error: "step not found" });
    if (review.state !== "open") return reply.code(409).send({ error: "this review is finished" });
    const text = req.body?.text;
    if (!requiredString(text) || text.length > MAX_STEP_TEXT_LENGTH) return reply.code(400).send({ error: `text must be a non-empty string of at most ${MAX_STEP_TEXT_LENGTH} characters` });
    // Always the viewer's own remark: nobody can write on another member's.
    store.changeReviews.saveRemark(req.params.stepId, viewerPersonId(req.viewer), text, versionSeenBy(review.id, req.params.stepId));
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
