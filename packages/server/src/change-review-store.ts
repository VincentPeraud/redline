import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChangeReviewState, ChangeReviewStepInput, StepTweaks } from "@redline/shared";

export interface StoredReview {
  id: string;
  projectId: string;
  state: ChangeReviewState;
  requesterPersonId?: string;
  folder: string;
  label?: string;
  createdAt: string;
  finishedBy?: string;
  finishedAt?: string;
  fetchedBy?: string;
  fetchedAt?: string;
  filedBy?: string;
  filedAt?: string;
}

/** A screen of the review heartbeats every ~20 s: someone not heard from for this long is gone. */
export const REVIEW_PRESENCE_TIMEOUT_MS = 60_000;

export interface StoredStep extends ChangeReviewStepInput {
  id: string;
  reviewId: string;
  /** Its page was archived when the review was finished: unarchiving it later does not bring the step back. */
  archivedAtFinish?: boolean;
}

export interface StoredAnswer {
  id: string;
  stepId: string;
  personId?: string;
  kind: "ok" | "remark";
  text?: string;
  /** The thread a remark became at fetch. */
  threadId?: string;
  at: string;
  /** The artboard version (the version where its content last changed) the answer saw; absent on answers from before versions were recorded. */
  artboardVersion?: string;
}

interface ReviewRow {
  id: string;
  project_id: string;
  state: ChangeReviewState;
  requester_person_id: string | null;
  folder: string;
  label: string | null;
  created_at: string;
  finished_by: string | null;
  finished_at: string | null;
  fetched_by: string | null;
  fetched_at: string | null;
  filed_by: string | null;
  filed_at: string | null;
}

/** The tweak values of a step as stored: JSON, or nothing when it sets none. */
const tweaksColumn = (step: ChangeReviewStepInput): string | null => (step.tweaks && Object.keys(step.tweaks).length > 0 ? JSON.stringify(step.tweaks) : null);

/** Reviews of changes with their steps and answers, in their own tables. Not "diffusion review" (the design system one). */
export class ChangeReviewStore {
  /** Who is on a screen of which review, in memory only: review id, then person id ("" without accounts). */
  private readonly presence = new Map<string, Map<string, { step?: number; at: number }>>();

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        requester_person_id TEXT,
        folder TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        finished_by TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS change_review_steps (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        page_id TEXT NOT NULL,
        artboard TEXT NOT NULL,
        changed TEXT NOT NULL,
        look_at TEXT NOT NULL,
        question TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS change_review_answers (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        person_id TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ok',
        text TEXT,
        thread_id TEXT,
        UNIQUE (step_id, person_id)
      );
    `);
    // Answers created before remarks existed.
    const answerColumns = (db.prepare("PRAGMA table_info(change_review_answers)").all() as { name: string }[]).map((column) => column.name);
    if (!answerColumns.includes("kind")) db.exec("ALTER TABLE change_review_answers ADD COLUMN kind TEXT NOT NULL DEFAULT 'ok'");
    if (!answerColumns.includes("text")) db.exec("ALTER TABLE change_review_answers ADD COLUMN text TEXT");
    if (!answerColumns.includes("artboard_version")) db.exec("ALTER TABLE change_review_answers ADD COLUMN artboard_version TEXT");
    if (!answerColumns.includes("thread_id")) db.exec("ALTER TABLE change_review_answers ADD COLUMN thread_id TEXT");
    const stepColumns = (db.prepare("PRAGMA table_info(change_review_steps)").all() as { name: string }[]).map((column) => column.name);
    if (!stepColumns.includes("archived_at_finish")) db.exec("ALTER TABLE change_review_steps ADD COLUMN archived_at_finish INTEGER NOT NULL DEFAULT 0");
    if (!stepColumns.includes("tweaks")) db.exec("ALTER TABLE change_review_steps ADD COLUMN tweaks TEXT");
    if (!stepColumns.includes("mobile")) db.exec("ALTER TABLE change_review_steps ADD COLUMN mobile INTEGER NOT NULL DEFAULT 0");
    const columns = (db.prepare("PRAGMA table_info(change_reviews)").all() as { name: string }[]).map((column) => column.name);
    for (const column of ["fetched_by", "fetched_at", "filed_by", "filed_at"]) if (!columns.includes(column)) db.exec(`ALTER TABLE change_reviews ADD COLUMN ${column} TEXT`);
  }

  /** Open and finished reviews with a step on the page, plus those fetched since `fetchedSince` (ISO), oldest first. */
  coveringPage(pageId: string, fetchedSince: string): StoredReview[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM change_reviews WHERE id IN (SELECT review_id FROM change_review_steps WHERE page_id = ?)
         AND (state IN ('open', 'finished') OR (state = 'fetched' AND fetched_at >= ?)) ORDER BY created_at, rowid`,
      )
      .all(pageId, fetchedSince) as { id: string }[];
    return rows.map((row) => this.get(row.id)!);
  }

  /** The reviews of these projects in one of these states, oldest first. */
  inProjects(projectIds: readonly string[], states: readonly ChangeReviewState[]): StoredReview[] {
    if (projectIds.length === 0 || states.length === 0) return [];
    const marks = (list: readonly unknown[]) => list.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT id FROM change_reviews WHERE project_id IN (${marks(projectIds)}) AND state IN (${marks(states)}) ORDER BY created_at, rowid`)
      .all(...projectIds, ...states) as { id: string }[];
    return rows.map((row) => this.get(row.id)!);
  }

  /** `steps` are already in review order. */
  create(projectId: string, requester: { personId?: string; folder: string; label?: string }, steps: ChangeReviewStepInput[]): StoredReview {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO change_reviews (id, project_id, state, requester_person_id, folder, label, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?)")
        .run(id, projectId, requester.personId ?? null, requester.folder, requester.label ?? null, createdAt);
      const insert = this.db.prepare("INSERT INTO change_review_steps (id, review_id, position, page_id, artboard, changed, look_at, question, tweaks, mobile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      steps.forEach((step, position) => insert.run(randomUUID(), id, position, step.pageId, step.artboard, step.changed, step.lookAt, step.question, tweaksColumn(step), step.mobile ? 1 : 0));
    })();
    return this.get(id)!;
  }

  /** The latest review of this requester (person and folder) on the project in `state`. */
  latestOf(projectId: string, requester: { personId?: string; folder: string }, state: ChangeReviewState): StoredReview | undefined {
    const row = this.db
      .prepare("SELECT id FROM change_reviews WHERE project_id = ? AND state = ? AND folder = ? AND COALESCE(requester_person_id, '') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(projectId, state, requester.folder, requester.personId ?? "") as { id: string } | undefined;
    return row && this.get(row.id);
  }

  /**
   * Replaces the steps of an open review by `steps`, already in review order: a step with an id keeps its row (and its answers) and takes the new texts, the others are added.
   * A given label renames the review.
   */
  merge(reviewId: string, steps: (ChangeReviewStepInput & { id?: string })[], label?: string): void {
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE change_review_steps SET position = ?, changed = ?, look_at = ?, question = ?, mobile = ? WHERE id = ? AND review_id = ?");
      const insert = this.db.prepare("INSERT INTO change_review_steps (id, review_id, position, page_id, artboard, changed, look_at, question, tweaks, mobile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      steps.forEach((step, position) => {
        if (step.id) update.run(position, step.changed, step.lookAt, step.question, step.mobile ? 1 : 0, step.id, reviewId);
        else insert.run(randomUUID(), reviewId, position, step.pageId, step.artboard, step.changed, step.lookAt, step.question, tweaksColumn(step), step.mobile ? 1 : 0);
      });
      if (label) this.db.prepare("UPDATE change_reviews SET label = ? WHERE id = ?").run(label, reviewId);
    })();
  }

  get(id: string): StoredReview | undefined {
    const row = this.db.prepare("SELECT * FROM change_reviews WHERE id = ?").get(id) as ReviewRow | undefined;
    return (
      row && {
        id: row.id,
        projectId: row.project_id,
        state: row.state,
        ...(row.requester_person_id ? { requesterPersonId: row.requester_person_id } : {}),
        folder: row.folder,
        ...(row.label ? { label: row.label } : {}),
        createdAt: row.created_at,
        ...(row.finished_by ? { finishedBy: row.finished_by } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
        ...(row.fetched_by ? { fetchedBy: row.fetched_by } : {}),
        ...(row.fetched_at ? { fetchedAt: row.fetched_at } : {}),
        ...(row.filed_by ? { filedBy: row.filed_by } : {}),
        ...(row.filed_at ? { filedAt: row.filed_at } : {}),
      }
    );
  }

  projectIdOf(reviewId: string): string | undefined {
    return (this.db.prepare("SELECT project_id FROM change_reviews WHERE id = ?").get(reviewId) as { project_id: string } | undefined)?.project_id;
  }

  steps(reviewId: string): StoredStep[] {
    const rows = this.db.prepare("SELECT * FROM change_review_steps WHERE review_id = ? ORDER BY position").all(reviewId) as {
      id: string; page_id: string; artboard: string; changed: string; look_at: string; question: string; tweaks: string | null; mobile: number; archived_at_finish: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      reviewId,
      pageId: row.page_id,
      artboard: row.artboard,
      changed: row.changed,
      lookAt: row.look_at,
      question: row.question,
      ...(row.archived_at_finish ? { archivedAtFinish: true } : {}),
      ...(row.tweaks ? { tweaks: JSON.parse(row.tweaks) as StepTweaks } : {}),
      ...(row.mobile ? { mobile: true } : {}),
    }));
  }

  /** Open and finished reviews with a step on the page (a removal or an archive there changes them). */
  liveCovering(pageId: string): StoredReview[] {
    const rows = this.db
      .prepare("SELECT id FROM change_reviews WHERE state IN ('open', 'finished') AND id IN (SELECT review_id FROM change_review_steps WHERE page_id = ?) ORDER BY created_at, rowid")
      .all(pageId) as { id: string }[];
    return rows.map((row) => this.get(row.id)!);
  }

  /**
   * An artboard moved to another page of the project: its steps follow it. Answers that saw the artboard's current version on the old page
   * (`seenOnSource`) now saw its version on the new one (`seenOnTarget`), so moving it does not count as modifying it.
   * Returns the reviews concerned.
   */
  follow(file: string, fromPageId: string, toPageId: string, seenOnSource: string | undefined, seenOnTarget: string | undefined): string[] {
    return this.db.transaction(() => {
      const steps = this.db.prepare("SELECT id, review_id FROM change_review_steps WHERE page_id = ? AND artboard = ?").all(fromPageId, file) as { id: string; review_id: string }[];
      for (const { id } of steps) {
        this.db.prepare("UPDATE change_review_steps SET page_id = ? WHERE id = ?").run(toPageId, id);
        if (seenOnSource !== undefined && seenOnTarget !== undefined) this.db.prepare("UPDATE change_review_answers SET artboard_version = ? WHERE step_id = ? AND artboard_version = ?").run(seenOnTarget, id, seenOnSource);
      }
      return [...new Set(steps.map((step) => step.review_id))];
    })();
  }

  /** Remembers which steps sat on an archived page when the review was finished. */
  freezeArchived(stepIds: readonly string[]): void {
    const update = this.db.prepare("UPDATE change_review_steps SET archived_at_finish = 1 WHERE id = ?");
    for (const id of stepIds) update.run(id);
  }

  answers(reviewId: string): StoredAnswer[] {
    const rows = this.db
      .prepare("SELECT a.id, a.step_id, a.person_id, a.kind, a.text, a.thread_id, a.artboard_version, a.at FROM change_review_answers a JOIN change_review_steps s ON s.id = a.step_id WHERE s.review_id = ? ORDER BY a.at, a.rowid")
      .all(reviewId) as { id: string; step_id: string; person_id: string; kind: "ok" | "remark"; text: string | null; thread_id: string | null; artboard_version: string | null; at: string }[];
    return rows.map((row) => ({
      id: row.id,
      stepId: row.step_id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      kind: row.kind,
      ...(row.text !== null ? { text: row.text } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.artboard_version ? { artboardVersion: row.artboard_version } : {}),
      at: row.at,
    }));
  }

  /** The answer of one person on a step (an OK or a remark: one per person). */
  answerOf(stepId: string, personId: string | undefined): StoredAnswer | undefined {
    const row = this.db.prepare("SELECT review_id FROM change_review_steps WHERE id = ?").get(stepId) as { review_id: string } | undefined;
    return row && this.answers(row.review_id).find((answer) => answer.stepId === stepId && (answer.personId ?? "") === (personId ?? ""));
  }

  /** The review an answer belongs to. */
  reviewIdOfAnswer(answerId: string): string | undefined {
    return (this.db.prepare("SELECT s.review_id FROM change_review_answers a JOIN change_review_steps s ON s.id = a.step_id WHERE a.id = ?").get(answerId) as { review_id: string } | undefined)?.review_id;
  }

  hasStep(reviewId: string, stepId: string): boolean {
    return this.db.prepare("SELECT 1 FROM change_review_steps WHERE id = ? AND review_id = ?").get(stepId, reviewId) !== undefined;
  }

  /** One OK per person and step: answering again keeps the first, unless it saw an older version of the artboard (then it is replaced). */
  addOk(stepId: string, personId: string | undefined, artboardVersion: string | undefined): void {
    this.db
      .prepare(
        `INSERT INTO change_review_answers (id, step_id, person_id, at, kind, artboard_version) VALUES (?, ?, ?, ?, 'ok', ?)
         ON CONFLICT (step_id, person_id) DO UPDATE SET at = excluded.at, artboard_version = excluded.artboard_version WHERE kind = 'ok' AND artboard_version IS NOT excluded.artboard_version`,
      )
      .run(randomUUID(), stepId, personId ?? "", new Date().toISOString(), artboardVersion ?? null);
  }

  removeOk(stepId: string, personId: string | undefined): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE step_id = ? AND person_id = ? AND kind = 'ok'").run(stepId, personId ?? "");
  }

  /** Saves the person's remark on the step; it replaces their OK. */
  saveRemark(stepId: string, personId: string | undefined, text: string, artboardVersion: string | undefined): void {
    this.db
      .prepare(
        "INSERT INTO change_review_answers (id, step_id, person_id, at, kind, text, artboard_version) VALUES (?, ?, ?, ?, 'remark', ?, ?) ON CONFLICT (step_id, person_id) DO UPDATE SET kind = 'remark', text = excluded.text, at = excluded.at, artboard_version = excluded.artboard_version",
      )
      .run(randomUUID(), stepId, personId ?? "", new Date().toISOString(), text, artboardVersion ?? null);
  }

  removeAnswer(answerId: string): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE id = ?").run(answerId);
  }

  setThread(answerId: string, threadId: string): void {
    this.db.prepare("UPDATE change_review_answers SET thread_id = ? WHERE id = ?").run(threadId, answerId);
  }

  /** The first fetch of a finished review: it is now `fetched`, by this person. */
  markFetched(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'fetched', fetched_by = ?, fetched_at = ? WHERE id = ? AND state = 'finished'").run(personId ?? null, new Date().toISOString(), reviewId);
  }

  finish(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'finished', finished_by = ?, finished_at = ? WHERE id = ?").run(personId ?? null, new Date().toISOString(), reviewId);
  }

  /** Back to `open`: the finish is forgotten (the caller checked it was finished, not fetched or filed). */
  reopen(reviewId: string): void {
    this.db.prepare("UPDATE change_reviews SET state = 'open', finished_by = NULL, finished_at = NULL WHERE id = ?").run(reviewId);
    this.db.prepare("UPDATE change_review_steps SET archived_at_finish = 0 WHERE review_id = ?").run(reviewId);
  }

  /** Puts a finished review aside for good, signed by this person. */
  file(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'filed', filed_by = ?, filed_at = ? WHERE id = ?").run(personId ?? null, new Date().toISOString(), reviewId);
  }

  /** This person is on a screen of the review now; `step` is 1-based, absent on the recap. */
  markPresent(reviewId: string, personId: string | undefined, step: number | undefined): void {
    const people = this.presence.get(reviewId) ?? new Map();
    people.set(personId ?? "", { ...(step !== undefined ? { step } : {}), at: Date.now() });
    this.presence.set(reviewId, people);
  }

  markGone(reviewId: string, personId: string | undefined): void {
    this.presence.get(reviewId)?.delete(personId ?? "");
  }

  /** The people other than `exceptPersonId` heard from within the timeout, as person ids ("" without accounts) with their step. */
  presentIn(reviewId: string, exceptPersonId: string | undefined): { personId: string; step?: number }[] {
    const limit = Date.now() - REVIEW_PRESENCE_TIMEOUT_MS;
    return [...(this.presence.get(reviewId) ?? [])]
      .filter(([personId, { at }]) => personId !== (exceptPersonId ?? "") && at >= limit)
      .map(([personId, { step }]) => ({ personId, ...(step !== undefined ? { step } : {}) }));
  }
}
