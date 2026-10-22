import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  CreateThreadRequest,
  AgentInfo,
  AgentKind,
  AgentStatus,
  Page,
  PageType,
  PageVersionSummary,
  Project,
  Thread,
  ThreadStatus,
  VersionOrigin,
} from "@redline/shared";

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
        created_at TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'terminal'
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (machine, folder)
      );
      UPDATE agents SET status = 'offline';
    `);
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentColumns.some((c) => c.name === "project_id")) this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT");
  }

  close(): void {
    this.db.close();
  }

  /** The agents' token, generated on first read. */
  getAgentToken(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'agent_token'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? this.regenerateAgentToken();
  }

  regenerateAgentToken(): string {
    const token = `abt_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('agent_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(token);
    return token;
  }

  /** Records an agent as online; one entry per machine and folder. */
  markAgentOnline(machine: string, folder: string, kind: AgentKind, projectId?: string): string {
    if (projectId) this.db.prepare("UPDATE agents SET project_id = NULL WHERE project_id = ?").run(projectId);
    this.db
      .prepare(
        `INSERT INTO agents (id, machine, folder, kind, status, last_seen_at, project_id) VALUES (?, ?, ?, ?, 'online', ?, ?)
         ON CONFLICT(machine, folder) DO UPDATE SET kind = excluded.kind, status = 'online', last_seen_at = excluded.last_seen_at, project_id = excluded.project_id`,
      )
      .run(randomUUID(), machine, folder, kind, now(), projectId ?? null);
    return (this.db.prepare("SELECT id FROM agents WHERE machine = ? AND folder = ?").get(machine, folder) as { id: string }).id;
  }

  markAgentOffline(id: string): void {
    this.db.prepare("UPDATE agents SET status = 'offline', last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  /** The online project agent serving a project, other than the given machine and folder. */
  findOtherOnlineProjectAgent(projectId: string, machine: string, folder: string): { machine: string; folder: string } | undefined {
    return this.db
      .prepare(
        "SELECT machine, folder FROM agents WHERE project_id = ? AND status = 'online' AND NOT (machine = ? AND folder = ?)",
      )
      .get(projectId, machine, folder) as { machine: string; folder: string } | undefined;
  }

  listAgents(): AgentInfo[] {
    return this.db
      .prepare("SELECT id, machine, folder, kind, status, last_seen_at AS lastSeenAt FROM agents ORDER BY machine, folder")
      .all() as AgentInfo[];
  }

  createProject(title: string): Project {
    const project = { id: randomUUID(), title };
    this.db
      .prepare("INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)")
      .run(project.id, title, now());
    return project;
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, a.id AS agentId, a.machine, a.folder, a.status
         FROM projects p LEFT JOIN agents a ON a.project_id = p.id
         ORDER BY p.created_at, p.rowid`,
      )
      .all() as { id: string; title: string; agentId: string | null; machine: string; folder: string; status: AgentStatus }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.agentId ? { agent: { id: r.agentId, machine: r.machine, folder: r.folder, status: r.status } } : {}),
    }));
  }

  projectExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined;
  }

  createPage(projectId: string, title: string, type: PageType, files: Record<string, string>): Page {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, project_id, title, type, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, projectId, title, type, now());
    this.createVersion(id, files, "Page created", "terminal");
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

  /** Records a new version of the page from file contents. */
  addVersion(pageId: string, files: Record<string, string>, message: string, origin: VersionOrigin): PageVersionSummary {
    return this.createVersion(pageId, files, message, origin);
  }

  /** Records a new version identical to the current one except for one file. */
  setPageFile(pageId: string, path: string, content: string, message: string, origin: VersionOrigin): PageVersionSummary {
    const hashes = { ...this.getPage(pageId)!.version.files, [path]: this.putBlob(Buffer.from(content, "utf8")) };
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin);
  }

  /** Versions of a page, newest first. */
  listVersions(pageId: string): PageVersionSummary[] {
    const rows = this.db
      .prepare(
        "SELECT id, message, origin, created_at FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(pageId) as VersionRow[];
    return rows.map(toSummary);
  }

  /** Repoints the page's paths to the hashes of an old version and records that as a new version. */
  restoreVersion(pageId: string, versionId: string): PageVersionSummary | undefined {
    const old = this.db
      .prepare("SELECT files, created_at FROM versions WHERE id = ? AND page_id = ?")
      .get(versionId, pageId) as { files: string; created_at: string } | undefined;
    if (!old) return undefined;
    return this.insertVersion(pageId, old.files, `Restored version of ${old.created_at}`, "restore");
  }

  private createVersion(
    pageId: string,
    files: Record<string, string>,
    message: string,
    origin: VersionOrigin,
  ): PageVersionSummary {
    const hashes: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      hashes[path] = this.putBlob(Buffer.from(content, "utf8"));
    }
    return this.insertVersion(pageId, JSON.stringify(hashes), message, origin);
  }

  private insertVersion(pageId: string, filesJson: string, message: string, origin: VersionOrigin): PageVersionSummary {
    const row: VersionRow = { id: randomUUID(), message, origin, created_at: now() };
    this.db
      .prepare("INSERT INTO versions (id, page_id, files, created_at, message, origin) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, pageId, filesJson, row.created_at, message, origin);
    return toSummary(row);
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

interface VersionRow {
  id: string;
  message: string;
  origin: VersionOrigin;
  created_at: string;
}

function toSummary(row: VersionRow): PageVersionSummary {
  return { id: row.id, message: row.message, origin: row.origin, createdAt: row.created_at };
}

function now(): string {
  return new Date().toISOString();
}
