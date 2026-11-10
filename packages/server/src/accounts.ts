import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { tokensEqual } from "./request-hardening.js";
import type Database from "better-sqlite3";
import { INVITATION_DAYS, PASSWORD_LINK_HOURS, initialsOf, type AccountEntry, type AccountRole, type AccountsResponse, type InvitationEntry, type InvitationPreview, type PasswordLinkEntry, type PasswordLinkPreview, type Person } from "@redline/shared";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keyLength: number) => Promise<Buffer>;
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The `expires_at` of an entry that never expires (added in proxy mode). */
const NEVER = "9999-12-31T23:59:59.999Z";
const SSO_REFRESH_MS = 60_000;

export type AccountErrorCode = "invalid-link" | "password-too-short" | "invalid-email" | "invalid-role" | "email-taken" | "invitation-pending" | "unknown-account" | "last-admin" | "self-deactivation" | "wrong-password" | "invalid-name";

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

/** Who an agent token stands for: an account, or nobody in particular (the old shared token while no admin exists), which acts as an admin. */
export interface AgentActor {
  account?: SignedInAccount;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

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

interface InvitationRow {
  id: string;
  token: string;
  email: string;
  role: AccountRole;
  created_at: string;
  expires_at: string;
  invited_by: string | null;
}

const invitationEntry = (row: InvitationRow): InvitationEntry => ({
  id: row.id,
  email: row.email,
  role: row.role,
  invitedBy: row.invited_by ?? "",
  createdAt: row.created_at,
  expiresAt: row.expires_at === NEVER ? null : row.expires_at,
  token: row.expires_at === NEVER ? "" : row.token,
});

/** Accounts, sessions and single-use setup links, kept in the people table and its neighbours. */
export class AccountStore {
  /** A hash to check against when the e-mail is unknown, so that a miss takes as long as a wrong password. */
  private readonly decoyHash: Promise<string> = hashPassword(randomUUID());

  /** Where notable migrations are reported; the server points it at its log. */
  log: (line: string) => void = () => {};

  constructor(private readonly db: Database.Database) {
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const addColumn = (table: string, column: string, definition: string) => {
      if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    // A person with a role is an account; the SSO people seen before accounts keep a NULL role and stay authors only.
    addColumn("people", "role", "TEXT");
    addColumn("agents", "person_id", "TEXT");
    addColumn("people", "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumn("people", "password_hash", "TEXT");
    addColumn("people", "origin", "TEXT NOT NULL DEFAULT 'sso'");
    addColumn("people", "last_sign_in_at", "TEXT");
    addColumn("people", "sso_id", "TEXT");
    addColumn("projects", "created_by", "TEXT");
    addColumn("projects", "visibility", "TEXT NOT NULL DEFAULT 'team'");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS people_account_email ON people (lower(email)) WHERE role IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS people_sso_id ON people (sso_id) WHERE sso_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tokens (
        person_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS single_use_links (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    addColumn("single_use_links", "person_id", "TEXT");
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
    if (!EMAIL_PATTERN.test(email)) throw new AccountError("invalid-email", "Enter a valid e-mail.");
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new AccountError("password-too-short", `The password needs ${MIN_PASSWORD_LENGTH} characters at least.`);
    const hash = await hashPassword(input.password);
    const id = randomUUID();
    this.db.transaction(() => {
      if (!this.isSetupTokenValid(token)) throw invalidLink();
      this.db
        .prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin, last_sign_in_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?, 'local', ?)")
        .run(id, name, email, new Date().toISOString(), hash, new Date().toISOString());
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

  private accountEntries(onlyId?: string): AccountEntry[] {
    const owned = new Map<string, string[]>();
    for (const { created_by, title } of this.db.prepare("SELECT created_by, title FROM projects WHERE created_by IS NOT NULL ORDER BY created_at, rowid").all() as { created_by: string; title: string }[]) {
      owned.set(created_by, [...(owned.get(created_by) ?? []), title]);
    }
    const links = new Map<string, number>();
    const now = new Date().toISOString();
    for (const { created_by, n } of this.db.prepare("SELECT created_by, COUNT(*) AS n FROM share_links WHERE status = 'active' AND created_by IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY created_by").all(now) as { created_by: string; n: number }[]) {
      links.set(created_by, n);
    }
    return (
      this.db.prepare("SELECT id, name, email, role, status, last_sign_in_at FROM people WHERE role IS NOT NULL ORDER BY created_at, rowid").all() as (AccountRow & { status: AccountEntry["status"]; last_sign_in_at: string | null })[]
    )
      .filter((row) => onlyId === undefined || row.id === onlyId)
      .map((row) => ({ id: row.id, name: row.name, email: row.email, initials: initialsOf(row.name, row.id), role: row.role, status: row.status, lastSignInAt: row.last_sign_in_at, ownedProjects: owned.get(row.id) ?? [], linkCount: links.get(row.id) ?? 0 }));
  }

  /** Every account (people with a role) and the invitations still open, oldest first. */
  list(): AccountsResponse {
    const accounts = this.accountEntries();
    const invitations = (
      this.db
        .prepare("SELECT i.id, i.token, i.email, i.role, i.created_at, i.expires_at, p.name AS invited_by FROM invitations i LEFT JOIN people p ON p.id = i.invited_by WHERE i.expires_at > ? ORDER BY i.created_at, i.rowid")
        .all(new Date().toISOString()) as InvitationRow[]
    ).map(invitationEntry);
    return { sso: false, accounts, invitations };
  }

  /** A link to copy, valid 7 days and single use, for someone with this e-mail; `expiry: "never"` is the entry waiting for a first SSO sign-in (proxy mode, no link). */
  invite(adminId: string, input: { email: string; role: string }, expiry: "7-days" | "never" = "7-days"): InvitationEntry {
    const email = input.email.trim();
    if (!EMAIL_PATTERN.test(email)) throw new AccountError("invalid-email", "Enter a valid e-mail.");
    if (input.role !== "admin" && input.role !== "member") throw new AccountError("invalid-role", "The role is admin or member.");
    if (this.db.prepare("SELECT 1 FROM people WHERE role IS NOT NULL AND lower(email) = lower(?)").get(email)) throw new AccountError("email-taken", "This e-mail already has an account.");
    const now = new Date();
    if (this.db.prepare("SELECT 1 FROM invitations WHERE lower(email) = lower(?) AND expires_at > ?").get(email, now.toISOString())) {
      throw new AccountError("invitation-pending", "This e-mail already has a pending invitation: copy it from the list.");
    }
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const expiresAt = expiry === "never" ? NEVER : new Date(now.getTime() + INVITATION_DAYS * DAY_MS).toISOString();
    this.db
      .prepare("INSERT INTO invitations (id, token, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, token, email, input.role, adminId, now.toISOString(), expiresAt);
    return this.list().invitations.find((invitation) => invitation.id === id)!;
  }

  /** Cancels a pending invitation; false when it is unknown or already used. */
  cancelInvitation(id: string): boolean {
    return this.db.prepare("DELETE FROM invitations WHERE id = ?").run(id).changes > 0;
  }

  private openInvitation(token: string): InvitationRow | undefined {
    return this.db
      .prepare("SELECT i.id, i.token, i.email, i.role, i.created_at, i.expires_at, p.name AS invited_by FROM invitations i LEFT JOIN people p ON p.id = i.invited_by WHERE i.token = ? AND i.expires_at > ?")
      .get(token, new Date().toISOString()) as InvitationRow | undefined;
  }

  /** What the invitee sees, or undefined when the link is expired, used or cancelled. */
  previewInvitation(token: string): InvitationPreview | undefined {
    const row = this.openInvitation(token);
    return row && { email: row.email, role: row.role, invitedBy: row.invited_by ?? "", expiresAt: row.expires_at };
  }

  /** Creates the invited account with the invited role and consumes the link, in one transaction. */
  async acceptInvitation(token: string, input: { name: string; password: string }): Promise<Person> {
    const invalidLink = () => new AccountError("invalid-link", "This invitation link is expired, used or cancelled.");
    const invitation = this.openInvitation(token);
    if (!invitation) throw invalidLink();
    const name = input.name.trim();
    if (name === "") throw new AccountError("invalid-name", "Enter a name.");
    if (input.password.length < MIN_PASSWORD_LENGTH) throw new AccountError("password-too-short", `The password needs ${MIN_PASSWORD_LENGTH} characters at least.`);
    const hash = await hashPassword(input.password);
    const id = randomUUID();
    this.db.transaction(() => {
      if (!this.openInvitation(token)) throw invalidLink();
      if (this.db.prepare("SELECT 1 FROM people WHERE role IS NOT NULL AND lower(email) = lower(?)").get(invitation.email)) throw new AccountError("email-taken", "This e-mail already has an account.");
      this.db
        .prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin, last_sign_in_at) VALUES (?, ?, ?, ?, ?, 'active', ?, 'local', ?)")
        .run(id, name, invitation.email, new Date().toISOString(), invitation.role, hash, new Date().toISOString());
      this.db.prepare("DELETE FROM invitations WHERE id = ?").run(invitation.id);
    })();
    return { id, name, email: invitation.email, initials: initialsOf(name, id) };
  }

  /** The oldest active admin: the account `reset-admin` writes a password link for. */
  firstActiveAdmin(): AccountEntry | undefined {
    return this.accountEntries().find((account) => account.role === "admin" && account.status === "active");
  }

  private requireAccount(id: string): AccountEntry {
    const entry = this.accountEntries(id)[0];
    if (!entry) throw new AccountError("unknown-account", "This account is unknown.");
    return entry;
  }

  private activeAdminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM people WHERE role = 'admin' AND status = 'active'").get() as { n: number }).n;
  }

  private assertNotLastAdmin(account: AccountEntry): void {
    if (account.role === "admin" && account.status === "active" && this.activeAdminCount() <= 1) throw new AccountError("last-admin", "Il faut au moins un admin.");
  }

  /** Makes an account admin or member; the last active admin cannot be lowered. */
  setRole(id: string, role: string): AccountEntry {
    if (role !== "admin" && role !== "member") throw new AccountError("invalid-role", "The role is admin or member.");
    const account = this.requireAccount(id);
    if (role === "member") this.assertNotLastAdmin(account);
    this.db.prepare("UPDATE people SET role = ? WHERE id = ?").run(role, id);
    return this.requireAccount(id);
  }

  /** Signs the account out everywhere, hands its projects to the admin who deactivates; its name stays on what it signed. */
  deactivate(adminId: string, id: string): AccountEntry {
    const account = this.requireAccount(id);
    this.assertNotLastAdmin(account);
    if (id === adminId) throw new AccountError("self-deactivation", "You cannot deactivate your own account.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE people SET status = 'deactivated' WHERE id = ?").run(id);
      this.db.prepare("UPDATE projects SET created_by = ? WHERE created_by = ?").run(adminId, id);
      this.deleteSessionsOf(id);
      this.db.prepare("DELETE FROM single_use_links WHERE person_id = ?").run(id);
      this.db.prepare("DELETE FROM agent_tokens WHERE person_id = ?").run(id);
    })();
    return this.requireAccount(id);
  }

  reactivate(id: string): AccountEntry {
    this.requireAccount(id);
    this.db.prepare("UPDATE people SET status = 'active' WHERE id = ?").run(id);
    return this.requireAccount(id);
  }

  /** A link to copy, valid 24 hours and single use, to choose a new password; it replaces the previous one of that account. */
  issuePasswordLink(id: string): PasswordLinkEntry {
    const account = this.requireAccount(id);
    if (account.status !== "active") throw new AccountError("unknown-account", "This account is deactivated.");
    const token = randomBytes(24).toString("base64url");
    const now = new Date();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM single_use_links WHERE kind = 'password' AND person_id = ?").run(id);
      this.db.prepare("INSERT INTO single_use_links (token_hash, kind, created_at, person_id) VALUES (?, 'password', ?, ?)").run(sha256(token), now.toISOString(), id);
    })();
    return { token, expiresAt: new Date(now.getTime() + PASSWORD_LINK_HOURS * HOUR_MS).toISOString() };
  }

  private openPasswordLink(token: string): (PasswordLinkPreview & { personId: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.email, l.created_at FROM single_use_links l JOIN people p ON p.id = l.person_id
         WHERE l.token_hash = ? AND l.kind = 'password' AND p.role IS NOT NULL AND p.status = 'active'`,
      )
      .get(sha256(token)) as { id: string; email: string; created_at: string } | undefined;
    const expiresAt = row && new Date(new Date(row.created_at).getTime() + PASSWORD_LINK_HOURS * HOUR_MS);
    return row && expiresAt && expiresAt.getTime() > Date.now() ? { personId: row.id, email: row.email, expiresAt: expiresAt.toISOString() } : undefined;
  }

  previewPasswordLink(token: string): PasswordLinkPreview | undefined {
    const link = this.openPasswordLink(token);
    return link && { email: link.email, expiresAt: link.expiresAt };
  }

  /** Sets the new password, consumes the link and signs every device of the account out, in one transaction. */
  async choosePassword(token: string, password: string): Promise<Person> {
    const invalidLink = () => new AccountError("invalid-link", "This password link is expired or used.");
    const link = this.openPasswordLink(token);
    if (!link) throw invalidLink();
    if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError("password-too-short", `The password needs ${MIN_PASSWORD_LENGTH} characters at least.`);
    const hash = await hashPassword(password);
    this.db.transaction(() => {
      if (!this.openPasswordLink(token)) throw invalidLink();
      this.db.prepare("UPDATE people SET password_hash = ?, last_sign_in_at = ? WHERE id = ?").run(hash, new Date().toISOString(), link.personId);
      this.db.prepare("DELETE FROM single_use_links WHERE kind = 'password' AND person_id = ?").run(link.personId);
      this.deleteSessionsOf(link.personId);
    })();
    const { name } = this.requireAccount(link.personId);
    return { id: link.personId, name, email: link.email, initials: initialsOf(name, link.personId) };
  }

  rename(id: string, name: string): Person {
    const trimmed = name.trim();
    if (trimmed === "") throw new AccountError("invalid-name", "Enter a name.");
    this.db.prepare("UPDATE people SET name = ? WHERE id = ?").run(trimmed, id);
    const { email } = this.requireAccount(id);
    return { id, name: trimmed, email, initials: initialsOf(trimmed, id) };
  }

  /** Changes the password of the signed-in account when the current one is right; every other device is signed out. */
  async changePassword(id: string, sessionToken: string | undefined, currentPassword: string, newPassword: string): Promise<void> {
    const row = this.db.prepare("SELECT password_hash FROM people WHERE id = ? AND role IS NOT NULL AND status = 'active'").get(id) as { password_hash: string | null } | undefined;
    if (!row?.password_hash || !(await passwordMatches(currentPassword, row.password_hash))) throw new AccountError("wrong-password", "Le mot de passe actuel n'est pas le bon.");
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw new AccountError("password-too-short", `The password needs ${MIN_PASSWORD_LENGTH} characters at least.`);
    const hash = await hashPassword(newPassword);
    this.db.transaction(() => {
      this.db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hash, id);
      this.deleteSessionsOf(id, sessionToken);
    })();
  }

  private firstAdmin(): SignedInAccount | undefined {
    return this.activeAccounts().find((account) => account.role === "admin");
  }

  private storeAgentToken(personId: string, token: string): void {
    this.db
      .prepare("INSERT INTO agent_tokens (person_id, token, token_hash) VALUES (?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET token = excluded.token, token_hash = excluded.token_hash")
      .run(personId, token, sha256(token));
  }

  /** The shared token of before the accounts becomes the first admin's own, at the first use after an admin exists. */
  private adoptSharedAgentToken(): SignedInAccount | undefined {
    const shared = this.db.prepare("SELECT value FROM settings WHERE key = 'agent_token'").get() as { value: string } | undefined;
    const admin = shared && this.firstAdmin();
    if (!shared || !admin) return undefined;
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM agent_tokens WHERE person_id = ?").get(admin.id)) this.storeAgentToken(admin.id, shared.value);
      this.db.prepare("DELETE FROM settings WHERE key = 'agent_token'").run();
    })();
    this.log(`The shared agent token of before the accounts is now the agent token of ${admin.email}. If other machines used it, regenerate it from the Agents page.`);
    return admin;
  }

  /** The account's agent token, generated on first read. */
  agentTokenOf(personId: string): string {
    const owned = this.db.prepare("SELECT token FROM agent_tokens WHERE person_id = ?").get(personId) as { token: string } | undefined;
    if (owned) return owned.token;
    if (this.firstAdmin()?.id === personId && this.adoptSharedAgentToken()) return this.agentTokenOf(personId);
    return this.regenerateAgentToken(personId);
  }

  /** A new token for the account; the previous one stops working. */
  regenerateAgentToken(personId: string): string {
    const token = `abt_${randomBytes(24).toString("hex")}`;
    this.db.transaction(() => {
      this.storeAgentToken(personId, token);
      // The shared token was the first admin's: regenerating replaces it, it must not come back.
      if (this.firstAdmin()?.id === personId) this.db.prepare("DELETE FROM settings WHERE key = 'agent_token'").run();
    })();
    return token;
  }

  /** The actor behind an agent token, or undefined when the token is unknown, revoked or its account deactivated. */
  agentActorOf(token: string | undefined): AgentActor | undefined {
    if (token === undefined) return undefined;
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.email, p.role FROM agent_tokens t JOIN people p ON p.id = t.person_id
         WHERE t.token_hash = ? AND p.role IS NOT NULL AND p.status = 'active'`,
      )
      .get(sha256(token)) as AccountRow | undefined;
    if (row) return { account: { id: row.id, name: row.name, email: row.email, initials: initialsOf(row.name, row.id), role: row.role } };
    const shared = this.db.prepare("SELECT value FROM settings WHERE key = 'agent_token'").get() as { value: string } | undefined;
    if (!shared || !tokensEqual(token, shared.value)) return undefined;
    const admin = this.adoptSharedAgentToken();
    return admin ? { account: admin } : {};
  }

  /** Every session of the account, except the one of `keepToken`. */
  deleteSessionsOf(personId: string, keepToken?: string): void {
    this.db.prepare("DELETE FROM sessions WHERE person_id = ? AND token_hash IS NOT ?").run(personId, keepToken === undefined ? null : sha256(keepToken));
  }

  /** The active admins' names and e-mails: who a person without access is told to ask. */
  activeAdmins(): { name: string; email: string }[] {
    return this.db.prepare("SELECT name, email FROM people WHERE role = 'admin' AND status = 'active' ORDER BY created_at, rowid").all() as { name: string; email: string }[];
  }

  /**
   * The account of a person the SSO let in, or undefined when Redline does not know them (or has deactivated them).
   * Found by SSO user id; else bound at their first sign-in to the account of a former local mode or to the entry
   * an admin added, both matched by e-mail; else, while no account exists at all, the person with `firstAdminEmail` becomes admin.
   * All of it runs in one transaction, so two first visitors cannot both become admin.
   */
  signInThroughSso(sso: { id: string; name: string; email: string }, firstAdminEmail?: string): SignedInAccount | undefined {
    return this.db.transaction((): SignedInAccount | undefined => {
      const now = new Date();
      const columns = "id, name, email, role, status, last_sign_in_at";
      type Found = AccountRow & { status: string; last_sign_in_at: string | null };
      const touch = (found: Found, name: string, email: string): SignedInAccount | undefined => {
        if (found.status !== "active") return undefined;
        const emailTaken = email !== "" && email.toLowerCase() !== found.email.toLowerCase() && this.db.prepare("SELECT 1 FROM people WHERE role IS NOT NULL AND id <> ? AND lower(email) = lower(?)").get(found.id, email);
        const nextName = name || found.name;
        const nextEmail = email === "" || emailTaken ? found.email : email;
        const stale = !found.last_sign_in_at || now.getTime() - Date.parse(found.last_sign_in_at) > SSO_REFRESH_MS;
        if (nextName !== found.name || nextEmail !== found.email || stale) {
          this.db.prepare("UPDATE people SET name = ?, email = ?, last_sign_in_at = ? WHERE id = ?").run(nextName, nextEmail, now.toISOString(), found.id);
        }
        return { id: found.id, name: nextName, email: nextEmail, initials: initialsOf(nextName, found.id), role: found.role };
      };

      const bound = this.db.prepare(`SELECT ${columns} FROM people WHERE role IS NOT NULL AND sso_id = ?`).get(sso.id) as Found | undefined;
      if (bound) return touch(bound, sso.name, sso.email);

      if (sso.email !== "") {
        const local = this.db.prepare(`SELECT ${columns} FROM people WHERE role IS NOT NULL AND sso_id IS NULL AND lower(email) = lower(?)`).get(sso.email) as Found | undefined;
        if (local) {
          this.db.prepare("UPDATE people SET sso_id = ? WHERE id = ?").run(sso.id, local.id);
          return touch(local, sso.name, sso.email);
        }
      }

      const pending = sso.email === "" ? undefined : (this.db.prepare("SELECT id, role FROM invitations WHERE lower(email) = lower(?) AND expires_at > ?").get(sso.email, now.toISOString()) as { id: string; role: AccountRole } | undefined);
      const mayBeFirstAdmin = !this.hasAccount() && sso.email !== "" && sso.email.toLowerCase() === firstAdminEmail?.trim().toLowerCase();
      const role: AccountRole | undefined = pending?.role ?? (mayBeFirstAdmin ? "admin" : undefined);
      if (!role) return undefined;
      // A person seen before the accounts already has a row under their SSO user id: it becomes the account, so their history follows.
      const seen = this.db.prepare("SELECT 1 FROM people WHERE id = ?").get(sso.id);
      if (seen) {
        this.db
          .prepare("UPDATE people SET name = ?, email = ?, role = ?, status = 'active', origin = 'sso', sso_id = ?, last_sign_in_at = ? WHERE id = ?")
          .run(sso.name, sso.email, role, sso.id, now.toISOString(), sso.id);
      } else {
        this.db
          .prepare("INSERT INTO people (id, name, email, created_at, role, status, origin, sso_id, last_sign_in_at) VALUES (?, ?, ?, ?, ?, 'active', 'sso', ?, ?)")
          .run(sso.id, sso.name, sso.email, now.toISOString(), role, sso.id, now.toISOString());
      }
      if (pending) this.db.prepare("DELETE FROM invitations WHERE id = ?").run(pending.id);
      else this.db.prepare("UPDATE projects SET created_by = ?, visibility = 'team' WHERE created_by IS NULL").run(sso.id);
      return { id: sso.id, name: sso.name, email: sso.email, initials: initialsOf(sso.name, sso.id), role };
    })();
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
