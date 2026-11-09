import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initialsOf, type AccessLevel, type LinkKind, type LinkScope, type Person, type ShareLink } from "@redline/shared";

interface LinkRow {
  id: string;
  token: string;
  scope: LinkScope;
  scope_id: string;
  kind: LinkKind;
  name: string;
  level: AccessLevel;
  direct: number;
  expires_at: string | null;
  status: "active" | "disabled";
  created_at: string;
  created_by: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
  last_opened_at: string | null;
}

/** Active and not expired: a visitor can still use it. */
export const isWorking = (link: StoredLink): boolean => link.status === "active" && !link.expired;

/** A link as stored: `ShareLink` without what depends on who asks. */
export type StoredLink = Omit<ShareLink, "canManage">;

export interface NewLink {
  scope: LinkScope;
  scopeId: string;
  kind: LinkKind;
  name: string;
  level: AccessLevel;
  direct: boolean;
  expiresAt: string | null;
  createdBy?: Person;
}

/** Share links and the devices that opened them, kept in their own tables. */
export class LinkStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        level TEXT NOT NULL,
        direct INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        disabled_at TEXT,
        disabled_by TEXT,
        last_opened_at TEXT
      );
      CREATE TABLE IF NOT EXISTS share_link_devices (
        link_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        PRIMARY KEY (link_id, device_id)
      );
    `);
  }

  private person(id: string | null): Person | undefined {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT id, name, email FROM people WHERE id = ?").get(id) as { id: string; name: string; email: string } | undefined;
    return row && { ...row, initials: initialsOf(row.name, row.id) };
  }

  private entry(row: LinkRow): StoredLink {
    const devices = (this.db.prepare("SELECT COUNT(*) AS n FROM share_link_devices WHERE link_id = ?").get(row.id) as { n: number }).n;
    const expired = row.expires_at !== null && row.expires_at <= new Date().toISOString();
    const createdBy = this.person(row.created_by);
    const disabledBy = this.person(row.disabled_by);
    return {
      id: row.id,
      token: row.token,
      scope: row.scope,
      scopeId: row.scope_id,
      kind: row.kind,
      name: row.name,
      level: row.level,
      direct: row.direct === 1,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      status: row.status,
      createdAt: row.created_at,
      ...(createdBy ? { createdBy } : {}),
      ...(row.disabled_at ? { disabledAt: row.disabled_at } : {}),
      ...(disabledBy ? { disabledBy } : {}),
      ...(row.last_opened_at ? { lastOpenedAt: row.last_opened_at } : {}),
      deviceCount: devices,
      expired,
    };
  }

  create(input: NewLink): StoredLink {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO share_links (id, token, scope, scope_id, kind, name, level, direct, expires_at, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
      .run(id, randomBytes(24).toString("base64url"), input.scope, input.scopeId, input.kind, input.name, input.level, input.direct ? 1 : 0, input.expiresAt, new Date().toISOString(), input.createdBy?.id ?? null);
    return this.get(id)!;
  }

  get(id: string): StoredLink | undefined {
    const row = this.db.prepare("SELECT * FROM share_links WHERE id = ?").get(id) as LinkRow | undefined;
    return row && this.entry(row);
  }

  /** The links of a scope, oldest first. */
  list(scope: LinkScope, scopeId: string): StoredLink[] {
    return (this.db.prepare("SELECT * FROM share_links WHERE scope = ? AND scope_id = ? ORDER BY created_at, rowid").all(scope, scopeId) as LinkRow[]).map((row) => this.entry(row));
  }

  /** The links of a project and of its pages, oldest first. */
  ofProject(projectId: string): StoredLink[] {
    const rows = this.db
      .prepare("SELECT * FROM share_links WHERE (scope = 'project' AND scope_id = ?) OR (scope = 'page' AND scope_id IN (SELECT id FROM pages WHERE project_id = ?)) ORDER BY created_at, rowid")
      .all(projectId, projectId) as LinkRow[];
    return rows.map((row) => this.entry(row));
  }

  /** The links an account created, oldest first. */
  createdBy(personId: string): StoredLink[] {
    return (this.db.prepare("SELECT * FROM share_links WHERE created_by = ? ORDER BY created_at, rowid").all(personId) as LinkRow[]).map((row) => this.entry(row));
  }

  /** Disables the links an account created that still work. */
  disableCreatedBy(personId: string, by: Person): void {
    for (const link of this.createdBy(personId)) if (isWorking(link)) this.setActive(link.id, false, by);
  }

  /**
   * The link behind a token when it works: active, not expired, its scope still there and neither it nor its project archived.
   * Every other case is undefined, so callers cannot tell the failures apart.
   */
  live(token: string): StoredLink | undefined {
    const row = this.db.prepare("SELECT * FROM share_links WHERE token = ?").get(token) as LinkRow | undefined;
    if (!row || row.status !== "active" || (row.expires_at !== null && row.expires_at <= new Date().toISOString())) return undefined;
    const scope =
      row.scope === "page"
        ? (this.db.prepare("SELECT p.archived_at AS own, pr.archived_at AS project FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?").get(row.scope_id) as { own: string | null; project: string | null } | undefined)
        : (this.db.prepare("SELECT NULL AS own, archived_at AS project FROM projects WHERE id = ?").get(row.scope_id) as { own: string | null; project: string | null } | undefined);
    return scope && scope.own === null && scope.project === null ? this.entry(row) : undefined;
  }

  update(id: string, changes: { name?: string; level?: AccessLevel; direct?: boolean; expiresAt?: string | null }): StoredLink | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const level = changes.level ?? current.level;
    const direct = level === "comment" && (changes.direct ?? current.direct);
    const expiresAt = changes.expiresAt === undefined ? (current.expiresAt ?? null) : changes.expiresAt;
    this.db.prepare("UPDATE share_links SET name = ?, level = ?, direct = ?, expires_at = ? WHERE id = ?").run(changes.name ?? current.name, level, direct ? 1 : 0, expiresAt, id);
    return this.get(id);
  }

  setActive(id: string, active: boolean, by?: Person): StoredLink | undefined {
    if (active) this.db.prepare("UPDATE share_links SET status = 'active', disabled_at = NULL, disabled_by = NULL WHERE id = ?").run(id);
    else this.db.prepare("UPDATE share_links SET status = 'disabled', disabled_at = ?, disabled_by = ? WHERE id = ?").run(new Date().toISOString(), by?.id ?? null, id);
    return this.get(id);
  }

  /** Notes an opening: the time, and the device when it is new. */
  recordOpening(id: string, deviceId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE share_links SET last_opened_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.prepare("INSERT OR IGNORE INTO share_link_devices (link_id, device_id) VALUES (?, ?)").run(id, deviceId);
    })();
  }

  /** Removes the links of a deleted page or project (and, for a project, of its pages). */
  deleteFor(scope: LinkScope, scopeId: string): void {
    const ids = `SELECT id FROM share_links WHERE scope = '${scope}' AND scope_id = ?`;
    this.db.prepare(`DELETE FROM share_link_devices WHERE link_id IN (${ids})`).run(scopeId);
    this.db.prepare("DELETE FROM share_links WHERE scope = ? AND scope_id = ?").run(scope, scopeId);
  }
}
