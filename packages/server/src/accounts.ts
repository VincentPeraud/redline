import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { initialsOf, type AccountRole, type Person } from "@redline/shared";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keyLength: number) => Promise<Buffer>;
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

export type AccountErrorCode = "invalid-link" | "password-too-short" | "invalid-email";

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SignedInAccount extends Person {
  role: AccountRole;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  password_hash: string | null;
}

/** Accounts, sessions and single-use setup links, kept in the people table and its neighbours. */
export class AccountStore {
  /** A hash to check against when the e-mail is unknown, so that a miss takes as long as a wrong password. */
  private readonly decoyHash: Promise<string> = hashPassword(randomUUID());

  constructor(private readonly db: Database.Database) {
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const addColumn = (table: string, column: string, definition: string) => {
      if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    // A person with a role is an account; the SSO people seen before accounts keep a NULL role and stay authors only.
    addColumn("people", "role", "TEXT");
    addColumn("people", "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumn("people", "password_hash", "TEXT");
    addColumn("people", "origin", "TEXT NOT NULL DEFAULT 'sso'");
    addColumn("people", "last_sign_in_at", "TEXT");
    addColumn("projects", "created_by", "TEXT");
    addColumn("projects", "visibility", "TEXT NOT NULL DEFAULT 'team'");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS people_account_email ON people (lower(email)) WHERE role IS NOT NULL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS single_use_links (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** Every active account with its role, oldest first. */
  activeAccounts(): SignedInAccount[] {
    const rows = this.db
      .prepare("SELECT id, name, email, role FROM people WHERE role IS NOT NULL AND status = 'active' ORDER BY created_at, rowid")
      .all() as AccountRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, email: row.email, initials: initialsOf(row.name, row.id), role: row.role }));
  }

  hasAccount(): boolean {
    return this.db.prepare("SELECT 1 FROM people WHERE role IS NOT NULL").get() !== undefined;
  }

  /** A new setup link token while no account exists (the one of a previous start stops working), else undefined. */
  issueSetupToken(): string | undefined {
    if (this.hasAccount()) return undefined;
    const token = randomBytes(24).toString("base64url");
    this.db.prepare("DELETE FROM single_use_links WHERE kind = 'setup'").run();
    this.db.prepare("INSERT INTO single_use_links (token_hash, kind, created_at) VALUES (?, 'setup', ?)").run(sha256(token), new Date().toISOString());
    return token;
  }

  isSetupTokenValid(token: string): boolean {
    return !this.hasAccount() && this.db.prepare("SELECT 1 FROM single_use_links WHERE token_hash = ? AND kind = 'setup'").get(sha256(token)) !== undefined;
  }

  /** Creates the first admin, consumes the link and hands them every project without an owner (all Équipe), in one transaction. */
  async createFirstAdmin(token: string, input: { name: string; email: string; password: string }): Promise<Person> {
    const email = input.email.trim();
    const name = input.name.trim();
    const invalidLink = () => new AccountError("invalid-link", "This setup link is used or unknown.");
    if (!this.isSetupTokenValid(token)) throw invalidLink();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AccountError("invalid-email", "Enter a valid e-mail.");
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new AccountError("password-too-short", `The password needs ${MIN_PASSWORD_LENGTH} characters at least.`);
    const hash = await hashPassword(input.password);
    const id = randomUUID();
    this.db.transaction(() => {
      if (!this.isSetupTokenValid(token)) throw invalidLink();
      this.db
        .prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'admin', 'active', ?, 'local')")
        .run(id, name, email, new Date().toISOString(), hash);
      this.db.prepare("DELETE FROM single_use_links WHERE kind = 'setup'").run();
      this.db.prepare("UPDATE projects SET created_by = ?, visibility = 'team' WHERE created_by IS NULL").run(id);
    })();
    return { id, name, email, initials: initialsOf(name, id) };
  }

  /** The active account with this e-mail and password, or undefined (the same work is done when the e-mail is unknown). */
  async authenticate(email: string, password: string): Promise<Person | undefined> {
    const row = this.db
      .prepare("SELECT id, name, email, role, password_hash FROM people WHERE role IS NOT NULL AND status = 'active' AND lower(email) = lower(?)")
      .get(email.trim()) as AccountRow | undefined;
    const matches = await passwordMatches(password, row?.password_hash ?? (await this.decoyHash));
    if (!row || !row.password_hash || !matches) return undefined;
    this.db.prepare("UPDATE people SET last_sign_in_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return { id: row.id, name: row.name, email: row.email, initials: initialsOf(row.name, row.id) };
  }

  createSession(personId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
    this.db
      .prepare("INSERT INTO sessions (token_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), personId, new Date().toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  /** The signed-in account behind a session cookie value; an expired session is dropped, a deactivated account has none. */
  accountOfSession(token: string): SignedInAccount | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.email, p.role, s.expires_at FROM sessions s JOIN people p ON p.id = s.person_id
         WHERE s.token_hash = ? AND p.role IS NOT NULL AND p.status = 'active'`,
      )
      .get(sha256(token)) as (AccountRow & { expires_at: string }) | undefined;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteSession(token);
      return undefined;
    }
    return { id: row.id, name: row.name, email: row.email, initials: initialsOf(row.name, row.id), role: row.role };
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
}
