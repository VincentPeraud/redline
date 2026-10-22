import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  DESIGN_SYSTEM_TOKENS_PATH,
  NEUTRAL_DESIGN_SYSTEM_ID,
  NEUTRAL_TOKENS_CSS,
  NEUTRAL_TOKENS_PAGE_HTML,
  type DesignSystem,
  type ProjectAsset,
} from "@redline/shared";
import type {
  CreateThreadRequest,
  AgentInfo,
  AgentKind,
  AgentStatus,
  Page,
  PageType,
  PageVersionSummary,
  Project,
  ServerEvent,
  Thread,
  ThreadReply,
  ThreadStatus,
  VersionOrigin,
} from "@redline/shared";

export class Store {
  private readonly db: Database.Database;
  private readonly blobDir: string;
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  constructor(dataDir: string) {
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "redline.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        design_system TEXT,
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
      CREATE TABLE IF NOT EXISTS thread_replies (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS design_systems (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        page_id TEXT NOT NULL REFERENCES pages(id)
      );
      CREATE TABLE IF NOT EXISTS project_files (
        project_id TEXT NOT NULL REFERENCES projects(id),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      UPDATE agents SET status = 'offline';
    `);
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    if (!agentColumns.some((c) => c.name === "project_id")) this.db.exec("ALTER TABLE agents ADD COLUMN project_id TEXT");
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    if (!threadColumns.some((c) => c.name === "session_id")) this.db.exec("ALTER TABLE threads ADD COLUMN session_id TEXT");
    if (!threadColumns.some((c) => c.name === "agent_id")) this.db.exec("ALTER TABLE threads ADD COLUMN agent_id TEXT");
    if (!this.getDesignSystem(NEUTRAL_DESIGN_SYSTEM_ID)) {
      this.createDesignSystem("Neutral", { [DESIGN_SYSTEM_TOKENS_PATH]: NEUTRAL_TOKENS_CSS, "index.html": NEUTRAL_TOKENS_PAGE_HTML }, NEUTRAL_DESIGN_SYSTEM_ID);
    }
  }

  /** A design system is a project (same id) with one page holding its tokens and components. */
  createDesignSystem(title: string, files: Record<string, string>, id: string = randomUUID()): DesignSystem {
    this.createProject(title, id);
    const page = this.createPage(id, title, "prototype", files);
    this.db.prepare("INSERT INTO design_systems (project_id, page_id) VALUES (?, ?)").run(id, page.id);
    return { id, title, pageId: page.id };
  }

  getDesignSystem(id: string): DesignSystem | undefined {
    return this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId FROM design_systems d JOIN projects p ON p.id = d.project_id WHERE p.id = ?",
      )
      .get(id) as DesignSystem | undefined;
  }

  listDesignSystems(): DesignSystem[] {
    return this.db
      .prepare(
        "SELECT p.id, p.title, d.page_id AS pageId FROM design_systems d JOIN projects p ON p.id = d.project_id ORDER BY p.created_at, p.rowid",
      )
      .all() as DesignSystem[];
  }

  isDesignSystemPage(pageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM design_systems WHERE page_id = ?").get(pageId) !== undefined;
  }

  close(): void {
    this.db.close();
  }

  /** Calls `listener` after every change the web UI shows (new thread or reply, new version). Returns the unsubscribe function. */
  onChange(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Id of the online project agent serving the project. */
  findOnlineProjectAgentId(projectId: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM agents WHERE project_id = ? AND status = 'online'").get(projectId) as
      | { id: string }
      | undefined;
    return row?.id;
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

  createProject(title: string, id: string = randomUUID(), instructions = "", designSystem: string | null = null): Project {
    this.db
      .prepare("INSERT INTO projects (id, title, instructions, design_system, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, title, instructions, designSystem, now());
    return { id, title, instructions, designSystem };
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.instructions, p.design_system AS designSystem, a.id AS agentId, a.machine, a.folder, a.status
         FROM projects p LEFT JOIN agents a ON a.project_id = p.id
         WHERE p.id NOT IN (SELECT project_id FROM design_systems)
         ORDER BY p.created_at, p.rowid`,
      )
      .all() as {
      id: string;
      title: string;
      instructions: string;
      designSystem: string | null;
      agentId: string | null;
      machine: string;
      folder: string;
      status: AgentStatus;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      instructions: r.instructions,
      designSystem: r.designSystem,
      ...(r.agentId ? { agent: { id: r.agentId, machine: r.machine, folder: r.folder, status: r.status } } : {}),
    }));
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  projectExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined;
  }

  /** Stores a project-level file (DESIGN.md or `assets/<name>`) under its content hash. */
  setProjectFile(projectId: string, path: string, content: Buffer): string {
    const hash = this.putBlob(content);
    this.db
      .prepare("INSERT INTO project_files (project_id, path, hash) VALUES (?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET hash = excluded.hash")
      .run(projectId, path, hash);
    return hash;
  }

  readProjectFile(projectId: string, path: string): Buffer | undefined {
    const row = this.db.prepare("SELECT hash FROM project_files WHERE project_id = ? AND path = ?").get(projectId, path) as
      | { hash: string }
      | undefined;
    return row && readFileSync(join(this.blobDir, row.hash));
  }

  /** Project-level files under `prefix`, as `{name (prefix removed), hash, size}`. */
  listProjectFiles(projectId: string, prefix: string): ProjectAsset[] {
    const rows = this.db
      .prepare("SELECT path, hash FROM project_files WHERE project_id = ? AND substr(path, 1, ?) = ? ORDER BY path")
      .all(projectId, prefix.length, prefix) as { path: string; hash: string }[];
    return rows.map((r) => ({ name: r.path.slice(prefix.length), hash: r.hash, size: statSync(join(this.blobDir, r.hash)).size }));
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
    this.emit({ type: "thread-updated", pageId, threadId: id });
    return this.getThread(id)!;
  }

  listThreads(pageId: string): Thread[] {
    const rows = this.db
      .prepare(`${THREAD_SELECT} WHERE page_id = ? ORDER BY number`)
      .all(pageId) as ThreadRow[];
    return rows.map((row) => toThread(row, this.repliesOf(row.id)));
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row && toThread(row, this.repliesOf(id));
  }

  resolveThread(id: string): Thread | undefined {
    this.db.prepare("UPDATE threads SET status = 'resolved' WHERE id = ?").run(id);
    const thread = this.getThread(id);
    if (thread) this.emit({ type: "thread-updated", pageId: thread.pageId, threadId: id });
    return thread;
  }

  /** The engine session that opened the thread and the agent that owns it; undefined until a work item was sent. */
  getThreadSession(threadId: string): { sessionId: string; agentId: string } | undefined {
    const row = this.db.prepare("SELECT session_id, agent_id FROM threads WHERE id = ?").get(threadId) as
      | { session_id: string | null; agent_id: string | null }
      | undefined;
    return row?.session_id && row.agent_id ? { sessionId: row.session_id, agentId: row.agent_id } : undefined;
  }

  setThreadSession(threadId: string, sessionId: string, agentId: string): void {
    this.db.prepare("UPDATE threads SET session_id = ?, agent_id = ? WHERE id = ?").run(sessionId, agentId, threadId);
  }

  /** Records an answer of Claude or a message of the user in a thread; undefined if the thread does not exist. */
  addReply(threadId: string, body: string, author: ThreadReply["author"] = "claude"): ThreadReply | undefined {
    const thread = this.getThread(threadId);
    if (!thread) return undefined;
    const reply: ThreadReply = { id: randomUUID(), author, body, createdAt: now() };
    this.db
      .prepare("INSERT INTO thread_replies (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(reply.id, threadId, reply.author, body, reply.createdAt);
    this.emit({ type: "thread-updated", pageId: thread.pageId, threadId });
    return reply;
  }

  private repliesOf(threadId: string): ThreadReply[] {
    return this.db
      .prepare("SELECT id, author, body, created_at AS createdAt FROM thread_replies WHERE thread_id = ? ORDER BY created_at, rowid")
      .all(threadId) as ThreadReply[];
  }

  /** Every file of the page's current version as UTF-8 text, or undefined if the page is unknown. */
  readPageFiles(pageId: string): { versionId: string; files: Record<string, string> } | undefined {
    const version = this.getPage(pageId)?.version;
    if (!version) return undefined;
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(version.files)) {
      files[path] = readFileSync(join(this.blobDir, hash), "utf8");
    }
    return { versionId: version.id, files };
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
    this.emit({ type: "page-updated", pageId, versionId: row.id });
    return toSummary(row);
  }

  private putBlob(content: Buffer): string {
    const hash = createHash("sha256").update(content).digest("hex");
    const blobPath = join(this.blobDir, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, content);
    return hash;
  }
}

const PROJECT_SELECT = "SELECT id, title, instructions, design_system AS designSystem FROM projects";

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

function toThread(row: ThreadRow, replies: ThreadReply[]): Thread {
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
    replies,
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
