import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CreateThreadRequest, Page, PageType, Project, Thread, ThreadStatus } from "@redline/shared";

export class Store {
  private readonly db: Database.Database;
  private readonly blobDir: string;

  constructor(dataDir: string) {
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "redline.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        files TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        number INTEGER NOT NULL,
        artboard TEXT NOT NULL,
        selector TEXT NOT NULL,
        x_pct REAL NOT NULL,
        y_pct REAL NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (page_id, number)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createProject(title: string): Project {
    const project = { id: randomUUID(), title };
    this.db
      .prepare("INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)")
      .run(project.id, title, now());
    return project;
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT id, title FROM projects ORDER BY created_at, rowid").all() as Project[];
  }

  projectExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined;
  }

  createPage(projectId: string, title: string, type: PageType, files: Record<string, string>): Page {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, project_id, title, type, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, title, type, now());
    this.createVersion(id, files);
    return this.getPage(id)!;
  }

  listPages(projectId: string): Page[] {
    const ids = this.db
      .prepare("SELECT id FROM pages WHERE project_id = ? ORDER BY created_at, rowid")
      .all(projectId) as { id: string }[];
    return ids.map(({ id }) => this.getPage(id)!);
  }

  getPage(id: string): Page | undefined {
    const row = this.db
      .prepare("SELECT id, project_id, title, type FROM pages WHERE id = ?")
      .get(id) as { id: string; project_id: string; title: string; type: PageType } | undefined;
    if (!row) return undefined;
    const version = this.db
      .prepare("SELECT id, files FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(id) as { id: string; files: string };
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      type: row.type,
      version: { id: version.id, files: JSON.parse(version.files) },
    };
  }

  createThread(pageId: string, pin: CreateThreadRequest): Thread {
    const id = randomUUID();
    const { next } = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM threads WHERE page_id = ?")
      .get(pageId) as { next: number };
    const title = pin.body.trim().split("\n")[0].slice(0, 80);
    this.db
      .prepare(
        `INSERT INTO threads (id, page_id, number, artboard, selector, x_pct, y_pct, title, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, pageId, next, pin.artboard, pin.selector, pin.xPct, pin.yPct, title, pin.body, now());
    return this.getThread(id)!;
  }

  listThreads(pageId: string): Thread[] {
    const rows = this.db
      .prepare(`${THREAD_SELECT} WHERE page_id = ? ORDER BY number`)
      .all(pageId) as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && toThread(row);
  }

  resolveThread(id: string): Thread | undefined {
    this.db.prepare("UPDATE threads SET status = 'resolved' WHERE id = ?").run(id);
    return this.getThread(id);
  }

  /** Reads a file of the page's current version, or undefined if the page or path is unknown. */
  readPageFile(pageId: string, path: string): Buffer | undefined {
    const hash = this.getPage(pageId)?.version.files[path];
    return hash === undefined ? undefined : readFileSync(join(this.blobDir, hash));
  }

  private createVersion(pageId: string, files: Record<string, string>): void {
    const hashes: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      hashes[path] = this.putBlob(Buffer.from(content, "utf8"));
    }
    this.db
      .prepare("INSERT INTO versions (id, page_id, files, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), pageId, JSON.stringify(hashes), now());
  }

  private putBlob(content: Buffer): string {
    const hash = createHash("sha256").update(content).digest("hex");
    const blobPath = join(this.blobDir, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, content);
    return hash;
  }
}

const THREAD_SELECT =
  "SELECT id, page_id, number, artboard, selector, x_pct, y_pct, title, body, status FROM threads";

interface ThreadRow {
  id: string;
  page_id: string;
  number: number;
  artboard: string;
  selector: string;
  x_pct: number;
  y_pct: number;
  title: string;
  body: string;
  status: ThreadStatus;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    pageId: row.page_id,
    number: row.number,
    artboard: row.artboard,
    selector: row.selector,
    xPct: row.x_pct,
    yPct: row.y_pct,
    title: row.title,
    body: row.body,
    status: row.status,
  };
}

function now(): string {
  return new Date().toISOString();
}
