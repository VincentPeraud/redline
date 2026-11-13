import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  MANIFEST_PATH,
  defaultManifest,
  groupTitlesOf,
  mergeSteps,
  orderSteps,
  parseManifest,
  bannerStateOf,
  FETCHED_BANNER_MS,
  readingOrder,
  renderingSlots,
  responsiveFrameLayout,
  reviewResult,
  progressOf,
  type ChangeReview,
  type ChangeReviewFeedback,
  type ChangeReviewStepInput,
  type PageChangeReview,
  type Manifest,
  type Person,
  type RequestChangeReviewRequest,
  type RequestChangeReviewResponse,
} from "@redline/shared";
import type { Access, Viewer } from "./access.js";
import type { StoredReview } from "./change-review-store.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
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

const viewerPersonId = (viewer: Viewer): string | undefined => (viewer.kind === "account" || viewer.kind === "agent" ? viewer.person?.id : undefined);

/** The review as `viewer` sees it, steps in review order. */
function viewOf(store: Store, review: StoredReview, viewer: Viewer): ChangeReview {
  const answers = store.changeReviews.answers(review.id);
  const own = viewerPersonId(viewer) ?? "";
  const steps = store.changeReviews.steps(review.id).map((step) => {
    const page = store.getPage(step.pageId);
    const entry = page ? manifestOf(store, step.pageId).artboards.find((artboard) => artboard.file === step.artboard) : undefined;
    return {
      pageId: step.pageId,
      artboard: step.artboard,
      changed: step.changed,
      lookAt: step.lookAt,
      question: step.question,
      id: step.id,
      pageTitle: page?.title ?? "",
      artboardTitle: entry?.title ?? step.artboard,
      ...(entry ? { artboardEntry: entry } : {}),
      answers: answers
        .filter((answer) => answer.stepId === step.id)
        .map((answer) => {
          const person = store.getPerson(answer.personId);
          return { id: answer.id, kind: answer.kind, ...(answer.text !== undefined ? { text: answer.text } : {}), ...(person ? { person } : {}), at: answer.at, mine: (answer.personId ?? "") === own };
        }),
    };
  });
  const requester = store.getPerson(review.requesterPersonId);
  const finishedBy = store.getPerson(review.finishedBy);
  return {
    id: review.id,
    projectId: review.projectId,
    projectTitle: store.getProject(review.projectId)?.title ?? "",
    state: review.state,
    requester: { ...(requester ? { person: requester } : {}), folder: review.folder, ...(review.label ? { label: review.label } : {}) },
    createdAt: review.createdAt,
    ...(finishedBy ? { finishedBy } : {}),
    ...(review.finishedAt ? { finishedAt: review.finishedAt } : {}),
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
    const answers = view.steps.flatMap((step) => step.answers);
    const contributors = answers.flatMap((answer) => (answer.person ? [answer.person] : [])).filter((person, index, all) => all.findIndex((other) => other.id === person.id) === index);
    const { seen } = progressOf(view.steps, -1);
    const fetchedBy = store.getPerson(review.fetchedBy);
    return {
      id: review.id,
      state: bannerStateOf(review.state, seen),
      stepCount: view.steps.length,
      pageTitles: [...new Set(view.steps.map((step) => step.pageTitle))],
      seen,
      okCount: answers.filter((answer) => answer.kind === "ok").length,
      remarkCount: answers.filter((answer) => answer.kind === "remark").length,
      contributors,
      requester: view.requester,
      viewerIsRequester: (review.requesterPersonId ?? "") === (viewerPersonId(viewer) ?? ""),
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

/**
 * What `review_feedback` gives for a review: its result once finished, its progress before.
 * Fetching a finished review turns each remark into a thread on its artboard, taken by the fetching terminal session.
 */
export function changeReviewFeedback(
  store: Store,
  access: Access,
  pageLock: PageLock,
  viewer: Viewer,
  sessionId: string,
  reviewId: string,
): { error: string; status: number } | ChangeReviewFeedback {
  const review = store.changeReviews.get(reviewId);
  if (!review) return { status: 404, error: "review not found" };
  if (access.levelOf(viewer, { projectId: review.projectId }) !== "write") return { status: 403, error: "your account does not have Écriture on this project" };
  const view = viewOf(store, review, viewer);
  if (view.state === "open") {
    const { seen, total } = progressOf(view.steps, -1);
    return { status: "open", seen, total };
  }
  const threadIds = openRemarkThreads(store, pageLock, view, sessionId);
  store.changeReviews.markFetched(review.id, viewerPersonId(viewer));
  announceReviewChange(store, review.id);
  const result = reviewResult({
    requester: nameOf(view.requester.person),
    finishedBy: nameOf(view.finishedBy),
    steps: view.steps.map((step) => ({ id: step.id, label: `${step.pageTitle} · ${step.artboardTitle}`, artboard: step.artboard, answers: step.answers })),
    threadIds,
  });
  return { status: "finished", ...result };
}

/** One thread per remark on its artboard, signed by the remark's author and taken by `sessionId` (so `reply_in_thread` works on it). Thread ids by remark id. */
function openRemarkThreads(store: Store, pageLock: PageLock, view: ChangeReview, sessionId: string): Record<string, string> {
  const stored = new Map(store.changeReviews.answers(view.id).map((answer) => [answer.id, answer]));
  const threadIds: Record<string, string> = {};
  for (const step of view.steps) {
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

/** The review screen's routes: reading a review, answering OK or with a remark, cancelling, finishing. Access is by the review's project (see `access.ts`). */
export function registerChangeReviewRoutes(app: FastifyInstance, store: Store): void {
  const open = (reviewId: string) => store.changeReviews.get(reviewId);

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
    store.changeReviews.addOk(req.params.stepId, viewerPersonId(req.viewer));
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
    store.changeReviews.saveRemark(req.params.stepId, viewerPersonId(req.viewer), text);
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
    if (review.state !== "open") return reply.code(409).send({ error: "this review is already finished" });
    store.changeReviews.finish(review.id, viewerPersonId(req.viewer));
    announceReviewChange(store, review.id);
    return viewOf(store, open(review.id)!, req.viewer);
  });
}
