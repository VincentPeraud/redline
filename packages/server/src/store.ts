import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { AgentInfo, AgentKind, Page, PageType, Project } from "@redline/shared";

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
  markAgentOnline(machine: string, folder: string, kind: AgentKind): string {
    this.db
      .prepare(
        `INSERT INTO agents (id, machine, folder, kind, status, last_seen_at) VALUES (?, ?, ?, ?, 'online', ?)
         ON CONFLICT(machine, folder) DO UPDATE SET kind = excluded.kind, status = 'online', last_seen_at = excluded.last_seen_at`,
      )
      .run(randomUUID(), machine, folder, kind, now());
    return (this.db.prepare("SELECT id FROM agents WHERE machine = ? AND folder = ?").get(machine, folder) as { id: string }).id;
  }

  markAgentOffline(id: string): void {
    this.db.prepare("UPDATE agents SET status = 'offline', last_seen_at = ? WHERE id = ?").run(now(), id);
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

function now(): string {
  return new Date().toISOString();
}
