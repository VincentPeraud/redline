import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Page, PageType, PageVersionSummary, Project, VersionOrigin } from "@redline/shared";

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

  /** Reads a file of the page's current version, or undefined if the page or path is unknown. */
  readPageFile(pageId: string, path: string): Buffer | undefined {
    const hash = this.getPage(pageId)?.version.files[path];
    return hash === undefined ? undefined : readFileSync(join(this.blobDir, hash));
  }

  /** Records a new version of the page from file contents. */
  addVersion(pageId: string, files: Record<string, string>, message: string, origin: VersionOrigin): PageVersionSummary {
    return this.createVersion(pageId, files, message, origin);
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
