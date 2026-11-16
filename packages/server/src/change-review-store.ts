import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { artboardKey, nextPinNumber, type ArtboardRef, type ChangeReviewResult, type ChangeReviewState, type ChangeReviewStepInput, type ReviewPinTarget, type StepTweaks, type ThreadRendering, type TweakValues } from "@redline/shared";

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
  /** What the first fetch gave (threads included), so a second fetch gives the same; absent until the review is fetched. */
  fetchedResult?: ChangeReviewResult;
  /** The terminal session that fetched it, and holds the threads of its remarks. */
  fetchedSessionId?: string;
}

/** The tables whose rows record the artboard versions their author saw (answers and pins share those columns). */
const FEEDBACK_TABLES = ["change_review_answers", "change_review_pins"] as const;

/** A screen of the review heartbeats every ~20 s: someone not heard from for this long is gone. */
export const REVIEW_PRESENCE_TIMEOUT_MS = 60_000;

/** An artboard of a group other than its example, with its own baseline (same meaning as a step's). */
export type StoredMember = ArtboardRef & { baseline?: string; /** Its page was archived when the review was finished: unarchiving it later does not bring it back. */ archivedAtFinish?: boolean };

export interface StoredStep extends ChangeReviewStepInput {
  id: string;
  reviewId: string;
  others?: StoredMember[];
  /** The example's page was archived when the review was finished: unarchiving it later does not bring the artboard back. */
  archivedAtFinish?: boolean;
  /** What "Avant" shows, fixed at declaration: a page version id, `""` for an artboard that is new in the series; absent when no baseline was known. */
  baseline?: string;
}

/** A step to store: its baseline is already worked out (see `baselineOf` in change-reviews.ts). */
export type StepToStore = Omit<ChangeReviewStepInput, "others"> & { others?: StoredMember[]; id?: string; baseline?: string };

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
  /** What the answer saw of the other artboards of a group, by `artboardKey`. */
  memberVersions?: Record<string, string>;
  /** A remark on a group: the artboard it is attached to (absent: the example). */
  on?: ArtboardRef;
  /** The step's question or texts changed after the answer was given: it counts as outdated until its author answers again. */
  stale?: boolean;
}

/** A reviewer's pin as stored: several per person and step, numbered per step. */
export interface StoredPin {
  id: string;
  stepId: string;
  personId?: string;
  number: number;
  text: string;
  target: ReviewPinTarget;
  /** The artboard of a group it sits on (absent: the example). */
  on?: ArtboardRef;
  rendering?: ThreadRendering;
  tweaks?: TweakValues;
  lost?: boolean;
  at: string;
  artboardVersion?: string;
  memberVersions?: Record<string, string>;
  stale?: boolean;
}

/** What a pin to store carries: where it sits and in which rendering and state. */
export interface PinToStore {
  text: string;
  target: ReviewPinTarget;
  on?: ArtboardRef;
  rendering?: ThreadRendering;
  tweaks?: TweakValues;
}

/** What an answer given now saw of a step's artboards. */
export interface SeenNow {
  artboardVersion?: string;
  memberVersions?: Record<string, string>;
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
  fetched_result: string | null;
  fetched_session: string | null;
}

/** The other artboards of a group as stored: JSON, or nothing for a single step. */
const othersColumn = (step: { others?: StoredMember[] }): string | null => (step.others && step.others.length > 0 ? JSON.stringify(step.others) : null);

/** What an answer saw of the other artboards of a group: JSON, or nothing for a single step. */
const memberVersionsColumn = (seen: SeenNow): string | null => (seen.memberVersions && Object.keys(seen.memberVersions).length > 0 ? JSON.stringify(seen.memberVersions) : null);

/** The elements a step frames as stored: JSON, or nothing when it frames none. */
const targetsColumn = (step: ChangeReviewStepInput): string | null => (step.targets && step.targets.length > 0 ? JSON.stringify(step.targets) : null);
/** The canvas elements a step points at as stored: JSON, or nothing when it points at none. */
const canvasElementsColumn = (step: ChangeReviewStepInput): string | null => (step.canvasElements && step.canvasElements.length > 0 ? JSON.stringify(step.canvasElements) : null);
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
      CREATE TABLE IF NOT EXISTS change_review_pins (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        person_id TEXT NOT NULL DEFAULT '',
        number INTEGER NOT NULL,
        text TEXT NOT NULL,
        target TEXT NOT NULL,
        on_page_id TEXT,
        on_artboard TEXT,
        rendering TEXT,
        tweaks TEXT,
        lost INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        artboard_version TEXT,
        member_versions TEXT,
        stale INTEGER NOT NULL DEFAULT 0
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
    if (!stepColumns.includes("baseline_version")) db.exec("ALTER TABLE change_review_steps ADD COLUMN baseline_version TEXT");
    for (const column of ["others", "title", "targets", "canvas_elements"]) if (!stepColumns.includes(column)) db.exec(`ALTER TABLE change_review_steps ADD COLUMN ${column} TEXT`);
    /** The highest pin number ever issued on the step: numbers are never reused. */
    if (!stepColumns.includes("pin_seq")) db.exec("ALTER TABLE change_review_steps ADD COLUMN pin_seq INTEGER NOT NULL DEFAULT 0");
    for (const column of ["member_versions", "on_page_id", "on_artboard"]) if (!answerColumns.includes(column)) db.exec(`ALTER TABLE change_review_answers ADD COLUMN ${column} TEXT`);
    if (!answerColumns.includes("stale")) db.exec("ALTER TABLE change_review_answers ADD COLUMN stale INTEGER NOT NULL DEFAULT 0");
    const columns = (db.prepare("PRAGMA table_info(change_reviews)").all() as { name: string }[]).map((column) => column.name);
    for (const column of ["fetched_by", "fetched_at", "filed_by", "filed_at", "fetched_result", "fetched_session"]) if (!columns.includes(column)) db.exec(`ALTER TABLE change_reviews ADD COLUMN ${column} TEXT`);
  }

  /** Open and finished reviews with a step on the page, plus those fetched since `fetchedSince` (ISO), oldest first. */
  coveringPage(pageId: string, fetchedSince: string): StoredReview[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM change_reviews WHERE id IN (SELECT review_id FROM change_review_steps s WHERE page_id = ? OR EXISTS (SELECT 1 FROM json_each(s.others) m WHERE json_extract(m.value, '$.pageId') = ?))
         AND (state IN ('open', 'finished') OR (state = 'fetched' AND fetched_at >= ?)) ORDER BY created_at, rowid`,
      )
      .all(pageId, pageId, fetchedSince) as { id: string }[];
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
  create(projectId: string, requester: { personId?: string; folder: string; label?: string }, steps: StepToStore[]): StoredReview {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO change_reviews (id, project_id, state, requester_person_id, folder, label, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?)")
        .run(id, projectId, requester.personId ?? null, requester.folder, requester.label ?? null, createdAt);
      const insert = this.db.prepare("INSERT INTO change_review_steps (id, review_id, position, page_id, artboard, changed, look_at, question, tweaks, mobile, baseline_version, others, title, targets, canvas_elements) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      steps.forEach((step, position) =>
        insert.run(randomUUID(), id, position, step.pageId, step.artboard, step.changed, step.lookAt, step.question, tweaksColumn(step), step.mobile ? 1 : 0, step.baseline ?? null, othersColumn(step), step.title ?? null, targetsColumn(step), canvasElementsColumn(step)),
      );
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
   * A given label renames the review. A step's baseline is replaced only when `baseline` is given (the oldest one is kept otherwise).
   */
  merge(reviewId: string, steps: StepToStore[], label?: string): void {
    this.db.transaction(() => {
      const before = new Map((this.db.prepare("SELECT id, changed, look_at, question FROM change_review_steps WHERE review_id = ?").all(reviewId) as { id: string; changed: string; look_at: string; question: string }[]).map((row) => [row.id, row]));
      const update = this.db.prepare("UPDATE change_review_steps SET position = ?, changed = ?, look_at = ?, question = ?, mobile = ?, baseline_version = COALESCE(?, baseline_version), others = ?, title = ?, targets = ? WHERE id = ? AND review_id = ?");
      const insert = this.db.prepare("INSERT INTO change_review_steps (id, review_id, position, page_id, artboard, changed, look_at, question, tweaks, mobile, baseline_version, others, title, targets, canvas_elements) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const outdateAnswers = this.db.prepare("UPDATE change_review_answers SET stale = 1 WHERE step_id = ?");
      const outdatePins = this.db.prepare("UPDATE change_review_pins SET stale = 1 WHERE step_id = ?");
      const outdate = { run: (stepId: string) => (outdateAnswers.run(stepId), outdatePins.run(stepId)) };
      steps.forEach((step, position) => {
        if (!step.id) {
          insert.run(randomUUID(), reviewId, position, step.pageId, step.artboard, step.changed, step.lookAt, step.question, tweaksColumn(step), step.mobile ? 1 : 0, step.baseline ?? null, othersColumn(step), step.title ?? null, targetsColumn(step), canvasElementsColumn(step));
          return;
        }
        update.run(position, step.changed, step.lookAt, step.question, step.mobile ? 1 : 0, step.baseline ?? null, othersColumn(step), step.title ?? null, targetsColumn(step), step.id, reviewId);
        const old = before.get(step.id);
        if (old && (old.changed !== step.changed || old.look_at !== step.lookAt || old.question !== step.question)) outdate.run(step.id);
      });
      if (label) this.db.prepare("UPDATE change_reviews SET label = ? WHERE id = ?").run(label, reviewId);
    })();
  }

  /** Deletes the reviews of a project, with their steps and answers (the project is gone). */
  deleteForProject(projectId: string): void {
    const reviews = "SELECT id FROM change_reviews WHERE project_id = ?";
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM change_review_answers WHERE step_id IN (SELECT id FROM change_review_steps WHERE review_id IN (${reviews}))`).run(projectId);
      this.db.prepare(`DELETE FROM change_review_pins WHERE step_id IN (SELECT id FROM change_review_steps WHERE review_id IN (${reviews}))`).run(projectId);
      this.db.prepare(`DELETE FROM change_review_steps WHERE review_id IN (${reviews})`).run(projectId);
      this.db.prepare("DELETE FROM change_reviews WHERE project_id = ?").run(projectId);
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
        ...(row.fetched_result ? { fetchedResult: JSON.parse(row.fetched_result) as ChangeReviewResult } : {}),
        ...(row.fetched_session ? { fetchedSessionId: row.fetched_session } : {}),
      }
    );
  }

  projectIdOf(reviewId: string): string | undefined {
    return (this.db.prepare("SELECT project_id FROM change_reviews WHERE id = ?").get(reviewId) as { project_id: string } | undefined)?.project_id;
  }

  steps(reviewId: string): StoredStep[] {
    const rows = this.db.prepare("SELECT * FROM change_review_steps WHERE review_id = ? ORDER BY position").all(reviewId) as {
      id: string; page_id: string; artboard: string; changed: string; look_at: string; question: string; tweaks: string | null; mobile: number; baseline_version: string | null; archived_at_finish: number; others: string | null; title: string | null; targets: string | null; canvas_elements: string | null;
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
      ...(row.baseline_version !== null ? { baseline: row.baseline_version } : {}),
      ...(row.others ? { others: JSON.parse(row.others) as StoredMember[] } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.targets ? { targets: JSON.parse(row.targets) as string[] } : {}),
      ...(row.canvas_elements ? { canvasElements: JSON.parse(row.canvas_elements) as string[] } : {}),
    }));
  }

  /** Open and finished reviews with a step on the page (a removal or an archive there changes them). */
  liveCovering(pageId: string): StoredReview[] {
    const rows = this.db
      .prepare("SELECT id FROM change_reviews WHERE state IN ('open', 'finished') AND id IN (SELECT review_id FROM change_review_steps s WHERE page_id = ? OR EXISTS (SELECT 1 FROM json_each(s.others) m WHERE json_extract(m.value, '$.pageId') = ?)) ORDER BY created_at, rowid")
      .all(pageId, pageId) as { id: string }[];
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
        // "Avant" named a version of the old page: it is not known on the new one.
        this.db.prepare("UPDATE change_review_steps SET page_id = ?, baseline_version = NULL WHERE id = ?").run(toPageId, id);
        if (seenOnSource !== undefined && seenOnTarget !== undefined) {
          for (const table of FEEDBACK_TABLES) this.db.prepare(`UPDATE ${table} SET artboard_version = ? WHERE step_id = ? AND artboard_version = ?`).run(seenOnTarget, id, seenOnSource);
        }
      }
      // The artboard as another artboard of a group: it keeps its place there, and the answers' versions and remarks follow it.
      const groups = this.db
        .prepare("SELECT s.id, s.review_id, s.others FROM change_review_steps s WHERE EXISTS (SELECT 1 FROM json_each(s.others) m WHERE json_extract(m.value, '$.pageId') = ? AND json_extract(m.value, '$.artboard') = ?)")
        .all(fromPageId, file) as { id: string; review_id: string; others: string }[];
      const fromKey = artboardKey({ pageId: fromPageId, artboard: file });
      const toKey = artboardKey({ pageId: toPageId, artboard: file });
      for (const group of groups) {
        const others = (JSON.parse(group.others) as StoredMember[]).map((member) => (member.pageId === fromPageId && member.artboard === file ? { pageId: toPageId, artboard: file } : member));
        this.db.prepare("UPDATE change_review_steps SET others = ? WHERE id = ?").run(JSON.stringify(others), group.id);
        for (const table of FEEDBACK_TABLES) {
          const answers = this.db.prepare(`SELECT id, member_versions FROM ${table} WHERE step_id = ?`).all(group.id) as { id: string; member_versions: string | null }[];
          for (const answer of answers) {
            const versions = answer.member_versions ? (JSON.parse(answer.member_versions) as Record<string, string>) : undefined;
            if (!versions || versions[fromKey] === undefined) continue;
            const seen = versions[fromKey];
            delete versions[fromKey];
            versions[toKey] = seenOnSource !== undefined && seenOnTarget !== undefined && seen === seenOnSource ? seenOnTarget : seen;
            this.db.prepare(`UPDATE ${table} SET member_versions = ? WHERE id = ?`).run(JSON.stringify(versions), answer.id);
          }
          this.db.prepare(`UPDATE ${table} SET on_page_id = ? WHERE step_id = ? AND on_page_id = ? AND on_artboard = ?`).run(toPageId, group.id, fromPageId, file);
        }
      }
      return [...new Set([...steps, ...groups].map((step) => step.review_id))];
    })();
  }

  /** Remembers which artboards of the review sat on an archived page when it was finished (a group keeps each of its artboards apart). */
  freezeArchived(reviewId: string, archived: readonly ArtboardRef[]): void {
    const frozen = (ref: ArtboardRef) => archived.some((other) => other.pageId === ref.pageId && other.artboard === ref.artboard);
    this.db.transaction(() => {
      for (const step of this.steps(reviewId)) {
        if (frozen(step)) this.db.prepare("UPDATE change_review_steps SET archived_at_finish = 1 WHERE id = ?").run(step.id);
        if (step.others?.some(frozen)) this.db.prepare("UPDATE change_review_steps SET others = ? WHERE id = ?").run(JSON.stringify(step.others.map((member) => (frozen(member) ? { ...member, archivedAtFinish: true } : member))), step.id);
      }
    })();
  }

  /** When the most recent fetched or filed review with a step on this artboard was fetched or filed (ISO). */
  lastLockedAt(pageId: string, artboard: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT COALESCE(fetched_at, filed_at) AS at FROM change_reviews WHERE state IN ('fetched', 'filed')
         AND id IN (
           SELECT review_id FROM change_review_steps s WHERE (page_id = ? AND artboard = ?)
           OR EXISTS (SELECT 1 FROM json_each(s.others) m WHERE json_extract(m.value, '$.pageId') = ? AND json_extract(m.value, '$.artboard') = ?)
         ) ORDER BY COALESCE(fetched_at, filed_at) DESC LIMIT 1`,
      )
      .get(pageId, artboard, pageId, artboard) as { at: string } | undefined;
    return row?.at;
  }

  answers(reviewId: string): StoredAnswer[] {
    const rows = this.db
      .prepare("SELECT a.id, a.step_id, a.person_id, a.kind, a.text, a.thread_id, a.artboard_version, a.member_versions, a.on_page_id, a.on_artboard, a.stale, a.at FROM change_review_answers a JOIN change_review_steps s ON s.id = a.step_id WHERE s.review_id = ? ORDER BY a.at, a.rowid")
      .all(reviewId) as { id: string; step_id: string; person_id: string; kind: "ok" | "remark"; text: string | null; thread_id: string | null; artboard_version: string | null; member_versions: string | null; on_page_id: string | null; on_artboard: string | null; stale: number; at: string }[];
    return rows.map((row) => ({
      id: row.id,
      stepId: row.step_id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      kind: row.kind,
      ...(row.text !== null ? { text: row.text } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.artboard_version ? { artboardVersion: row.artboard_version } : {}),
      ...(row.member_versions ? { memberVersions: JSON.parse(row.member_versions) as Record<string, string> } : {}),
      ...(row.on_page_id && row.on_artboard ? { on: { pageId: row.on_page_id, artboard: row.on_artboard } } : {}),
      ...(row.stale ? { stale: true } : {}),
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
  addOk(stepId: string, personId: string | undefined, seen: SeenNow): void {
    this.db
      .prepare(
        `INSERT INTO change_review_answers (id, step_id, person_id, at, kind, artboard_version, member_versions) VALUES (?, ?, ?, ?, 'ok', ?, ?)
         ON CONFLICT (step_id, person_id) DO UPDATE SET at = excluded.at, artboard_version = excluded.artboard_version, member_versions = excluded.member_versions, stale = 0
         WHERE kind = 'ok' AND (stale = 1 OR artboard_version IS NOT excluded.artboard_version OR member_versions IS NOT excluded.member_versions)`,
      )
      .run(randomUUID(), stepId, personId ?? "", new Date().toISOString(), seen.artboardVersion ?? null, memberVersionsColumn(seen));
  }

  removeOk(stepId: string, personId: string | undefined): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE step_id = ? AND person_id = ? AND kind = 'ok'").run(stepId, personId ?? "");
  }

  /** Saves the person's remark on the step; it replaces their OK. On a group `on` names the artboard it is attached to: set once, an edit keeps the place. */
  saveRemark(stepId: string, personId: string | undefined, text: string, seen: SeenNow, on?: ArtboardRef): void {
    this.db
      .prepare(
        `INSERT INTO change_review_answers (id, step_id, person_id, at, kind, text, artboard_version, member_versions, on_page_id, on_artboard) VALUES (?, ?, ?, ?, 'remark', ?, ?, ?, ?, ?)
         ON CONFLICT (step_id, person_id) DO UPDATE SET text = excluded.text, at = excluded.at, artboard_version = excluded.artboard_version, member_versions = excluded.member_versions, stale = 0,
         on_page_id = CASE WHEN kind = 'remark' THEN on_page_id ELSE excluded.on_page_id END, on_artboard = CASE WHEN kind = 'remark' THEN on_artboard ELSE excluded.on_artboard END, kind = 'remark'`,
      )
      .run(randomUUID(), stepId, personId ?? "", new Date().toISOString(), text, seen.artboardVersion ?? null, memberVersionsColumn(seen), on?.pageId ?? null, on?.artboard ?? null);
  }

  removeAnswer(answerId: string): void {
    this.db.prepare("DELETE FROM change_review_answers WHERE id = ?").run(answerId);
  }

  /** Every pin of the review, in number order within each step. */
  pins(reviewId: string): StoredPin[] {
    const rows = this.db
      .prepare("SELECT p.* FROM change_review_pins p JOIN change_review_steps s ON s.id = p.step_id WHERE s.review_id = ? ORDER BY s.position, p.number")
      .all(reviewId) as { id: string; step_id: string; person_id: string; number: number; text: string; target: string; on_page_id: string | null; on_artboard: string | null; rendering: string | null; tweaks: string | null; lost: number; at: string; artboard_version: string | null; member_versions: string | null; stale: number }[];
    return rows.map((row) => ({
      id: row.id,
      stepId: row.step_id,
      ...(row.person_id ? { personId: row.person_id } : {}),
      number: row.number,
      text: row.text,
      target: JSON.parse(row.target) as ReviewPinTarget,
      ...(row.on_page_id && row.on_artboard ? { on: { pageId: row.on_page_id, artboard: row.on_artboard } } : {}),
      ...(row.rendering ? { rendering: JSON.parse(row.rendering) as ThreadRendering } : {}),
      ...(row.tweaks ? { tweaks: JSON.parse(row.tweaks) as TweakValues } : {}),
      ...(row.lost ? { lost: true } : {}),
      ...(row.artboard_version ? { artboardVersion: row.artboard_version } : {}),
      ...(row.member_versions ? { memberVersions: JSON.parse(row.member_versions) as Record<string, string> } : {}),
      ...(row.stale ? { stale: true } : {}),
      at: row.at,
    }));
  }

  /** The review a pin belongs to. */
  reviewIdOfPin(pinId: string): string | undefined {
    return (this.db.prepare("SELECT s.review_id FROM change_review_pins p JOIN change_review_steps s ON s.id = p.step_id WHERE p.id = ?").get(pinId) as { review_id: string } | undefined)?.review_id;
  }

  /** Adds a pin to the step with the next number (never one already issued). A pin counts as a remark: it replaces its author's OK. */
  addPin(stepId: string, personId: string | undefined, pin: PinToStore, seen: SeenNow): void {
    this.db.transaction(() => {
      const issued = (this.db.prepare("SELECT pin_seq FROM change_review_steps WHERE id = ?").get(stepId) as { pin_seq: number }).pin_seq;
      const inUse = (this.db.prepare("SELECT number FROM change_review_pins WHERE step_id = ?").all(stepId) as { number: number }[]).map((row) => row.number);
      const number = nextPinNumber(inUse, issued);
      this.db.prepare("UPDATE change_review_steps SET pin_seq = ? WHERE id = ?").run(number, stepId);
      this.db
        .prepare("INSERT INTO change_review_pins (id, step_id, person_id, number, text, target, on_page_id, on_artboard, rendering, tweaks, at, artboard_version, member_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), stepId, personId ?? "", number, pin.text, JSON.stringify(pin.target), pin.on?.pageId ?? null, pin.on?.artboard ?? null, pin.rendering ? JSON.stringify(pin.rendering) : null, pin.tweaks && Object.keys(pin.tweaks).length > 0 ? JSON.stringify(pin.tweaks) : null, new Date().toISOString(), seen.artboardVersion ?? null, memberVersionsColumn(seen));
      this.removeOk(stepId, personId);
    })();
  }

  editPin(pinId: string, text: string, seen: SeenNow): void {
    this.db.prepare("UPDATE change_review_pins SET text = ?, at = ?, artboard_version = ?, member_versions = ?, stale = 0 WHERE id = ?").run(text, new Date().toISOString(), seen.artboardVersion ?? null, memberVersionsColumn(seen), pinId);
  }

  removePin(pinId: string): void {
    this.db.prepare("DELETE FROM change_review_pins WHERE id = ?").run(pinId);
  }

  /** The screen found (or no longer finds) the pin's element in the current artboard. */
  setPinLost(pinId: string, lost: boolean): void {
    this.db.prepare("UPDATE change_review_pins SET lost = ? WHERE id = ?").run(lost ? 1 : 0, pinId);
  }

  /** Deletes the person's pins and general remark on the step (not their OK, which there is none next to feedback). */
  clearFeedback(stepId: string, personId: string | undefined): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM change_review_pins WHERE step_id = ? AND person_id = ?").run(stepId, personId ?? "");
      this.db.prepare("DELETE FROM change_review_answers WHERE step_id = ? AND person_id = ? AND kind = 'remark'").run(stepId, personId ?? "");
    })();
  }

  setThread(answerId: string, threadId: string): void {
    this.db.prepare("UPDATE change_review_answers SET thread_id = ? WHERE id = ?").run(threadId, answerId);
  }

  /** The first fetch of a finished review: it is now `fetched`, by this person's terminal session, with the result it gave (a second fetch gives it again). */
  markFetched(reviewId: string, personId: string | undefined, sessionId: string, result: ChangeReviewResult): void {
    this.db
      .prepare("UPDATE change_reviews SET state = 'fetched', fetched_by = ?, fetched_at = ?, fetched_session = ?, fetched_result = ? WHERE id = ? AND state = 'finished'")
      .run(personId ?? null, new Date().toISOString(), sessionId, JSON.stringify(result), reviewId);
  }

  /** The terminal session now holding the threads of a fetched review's remarks. */
  setFetchedSession(reviewId: string, sessionId: string): void {
    this.db.prepare("UPDATE change_reviews SET fetched_session = ? WHERE id = ?").run(sessionId, reviewId);
  }

  finish(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'finished', finished_by = ?, finished_at = ? WHERE id = ?").run(personId ?? null, new Date().toISOString(), reviewId);
  }

  /** Back to `open`: the finish is forgotten (the caller checked it was finished, not fetched or filed). */
  reopen(reviewId: string): void {
    this.db.prepare("UPDATE change_reviews SET state = 'open', finished_by = NULL, finished_at = NULL WHERE id = ?").run(reviewId);
    this.db.prepare("UPDATE change_review_steps SET archived_at_finish = 0 WHERE review_id = ?").run(reviewId);
    for (const step of this.steps(reviewId)) {
      if (step.others?.some((member) => member.archivedAtFinish)) this.db.prepare("UPDATE change_review_steps SET others = ? WHERE id = ?").run(JSON.stringify(step.others.map(({ archivedAtFinish: _frozen, ...member }) => member)), step.id);
    }
  }

  /** Puts a finished review aside for good, signed by this person. */
  file(reviewId: string, personId: string | undefined): void {
    this.db.prepare("UPDATE change_reviews SET state = 'filed', filed_by = ?, filed_at = ? WHERE id = ?").run(personId ?? null, new Date().toISOString(), reviewId);
  }

  /** This person is on a screen of the review now; `step` is 1-based, absent on the recap. */
  markPresent(reviewId: string, personId: string | undefined, step: number | undefined): void {
    this.forgetQuiet();
    const people = this.presence.get(reviewId) ?? new Map();
    people.set(personId ?? "", { ...(step !== undefined ? { step } : {}), at: Date.now() });
    this.presence.set(reviewId, people);
  }

  markGone(reviewId: string, personId: string | undefined): void {
    this.presence.get(reviewId)?.delete(personId ?? "");
  }

  /** Drops the people not heard from within the timeout, and the reviews nobody is on, so the map stays as small as the people actually there. */
  private forgetQuiet(): void {
    const limit = Date.now() - REVIEW_PRESENCE_TIMEOUT_MS;
    for (const [reviewId, people] of this.presence) {
      for (const [personId, { at }] of people) if (at < limit) people.delete(personId);
      if (people.size === 0) this.presence.delete(reviewId);
    }
  }

  /** The people other than `exceptPersonId` heard from within the timeout, as person ids ("" without accounts) with their step. */
  presentIn(reviewId: string, exceptPersonId: string | undefined): { personId: string; step?: number }[] {
    const limit = Date.now() - REVIEW_PRESENCE_TIMEOUT_MS;
    return [...(this.presence.get(reviewId) ?? [])]
      .filter(([personId, { at }]) => personId !== (exceptPersonId ?? "") && at >= limit)
      .map(([personId, { step }]) => ({ personId, ...(step !== undefined ? { step } : {}) }));
  }
}
