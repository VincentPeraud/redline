import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChangeReviewState, ChangeReviewStepInput } from "@redline/shared";

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
  fetchedAt?: string;
}

export interface StoredStep extends ChangeReviewStepInput {
  id: string;
  reviewId: string;
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
  fetched_at: string | null;
}

/** Reviews of changes with their steps and answers, in their own tables. Not "diffusion review" (the design system one). */
export class ChangeReviewStore {
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
    // Tables created before remarks and fetching existed.
    const addColumn = (table: string, column: string, definition: string) => {
      if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn("change_review_answers", "kind", "TEXT NOT NULL DEFAULT 'ok'");
    addColumn("change_review_answers", "text", "TEXT");
    addColumn("change_review_answers", "thread_id", "TEXT");
    addColumn("change_reviews", "fetched_at", "TEXT");
  }

  /** `steps` are already in review order. */
  create(projectId: string, requester: { personId?: string; folder: string; label?: string }, steps: ChangeReviewStepInput[]): StoredReview {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO change_reviews (id, project_id, state, requester_person_id, folder, label, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?)")
        .run(id, projectId, requester.personId ?? null, requester.folder, requester.label ?? null, createdAt);
      const insert = this.db.prepare("INSERT INTO change_review_steps (id, review_id, position, page_id, artboard, changed, look_at, question) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      steps.forEach((step, position) => insert.run(randomUUID(), id, position, step.pageId, step.artboard, step.changed, step.lookAt, step.question));
    })();
    return this.get(id)!;
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
        ...(row.fetched_at ? { fetchedAt: row.fetched_at } : {}),
      }
    );
  }

  projectIdOf(reviewId: string): string | undefined {
    return (this.db.prepare("SELECT project_id FROM change_reviews WHERE id = ?").get(reviewId) as { project_id: string } | undefined)?.project_id;
  }

  steps(reviewId: string): StoredStep[] {
    const rows = this.db.prepare("SELECT * FROM change_review_steps WHERE review_id = ? ORDER BY position").all(reviewId) as { id: string; page_id: string; artboard: string; changed: string; look_at: string; question: string }[];
    return rows.map((row) => ({ id: row.id, reviewId, pageId: row.page_id, artboard: row.artboard, changed: row.changed, lookAt: row.look_at, question: row.question }));
  }

  answers(reviewId: string): StoredAnswer[] {
    const rows = this.db
      .prepare("SELECT a.id, a.step_id, a.person_id, a.kind, a.text, a.thread_id, a.at FROM change_review_answers a JOIN change_review_steps s ON s.id = a.step_id WHERE s.review_id = ? ORDER BY a.at, a.rowid")
      .all(reviewId) as { id: string; step_id: string; person_id: string; kind: "ok" | "remark"; text: string | null; thread_id: string | null; at: string }[];
    return rows.map((row) => ({
      id: row.id,
      stepId: row.step_id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      kind: row.kind,
      ...(row.text !== null ? { text: row.text } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
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

  /** One OK per person and step: answering again keeps the first. */
  addOk(stepId: string, personId: string | undefined): void {
    this.db.prepare("INSERT OR IGNORE INTO change_review_answers (id, step_id, person_id, at, kind) VALUES (?, ?, ?, ?, 'ok')").run(randomUUID(), stepId, personId ?? "", new Date().toISOString());
  }

  removeOk(stepId: string, personId: string | undefined): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE step_id = ? AND person_id = ? AND kind = 'ok'").run(stepId, personId ?? "");
  }

  /** Saves the person's remark on the step; it replaces their OK. */
  saveRemark(stepId: string, personId: string | undefined, text: string): void {
    this.db
      .prepare("INSERT INTO change_review_answers (id, step_id, person_id, at, kind, text) VALUES (?, ?, ?, ?, 'remark', ?) ON CONFLICT (step_id, person_id) DO UPDATE SET kind = 'remark', text = excluded.text, at = excluded.at")
      .run(randomUUID(), stepId, personId ?? "", new Date().toISOString(), text);
  }

  removeAnswer(answerId: string): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE id = ?").run(answerId);
  }

  setThread(answerId: string, threadId: string): void {
    this.db.prepare("UPDATE change_review_answers SET thread_id = ? WHERE id = ?").run(threadId, answerId);
  }

  markFetched(reviewId: string): void {
    this.db.prepare("UPDATE change_reviews SET fetched_at = ? WHERE id = ? AND fetched_at IS NULL").run(new Date().toISOString(), reviewId);
  }

  finish(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'finished', finished_by = ?, finished_at = ? WHERE id = ?").run(personId ?? null, new Date().toISOString(), reviewId);
  }
}
