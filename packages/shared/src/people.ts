/** Someone signed in through the SSO, identified by the user-id header value. */
export interface Person {
  id: string;
  /** The display name the SSO gave; empty when it gave none. */
  name: string;
  email: string;
  initials: string;
}

export type AccountRole = "admin" | "member";

/**
 * `GET /api/me`: the viewing person and where "Se déconnecter" leads (null when none is set); the body is `null` without SSO.
 * `account` is set for a built-in account (signed in with e-mail and password): it holds their role, and sign-out is `DELETE SESSION_PATH`.
 */
export type MeResponse = (Person & { logoutUrl: string | null; account?: { role: AccountRole; sso?: true }; noAccess?: NoAccess }) | null;

/** Set on `GET /api/me` for someone the SSO let in but whom Redline's account list does not know (or has deactivated): they get the no-access screen. */
export interface NoAccess {
  admins: { name: string; email: string }[];
}

export const SESSION_PATH = "/api/session";
export const SETUP_PATH = "/api/setup";
/** Open to people who are not signed in: `GET ?token=` reads an invitation, `POST` accepts it (creates the account). */
export const INVITATION_PATH = "/api/invitation";
/** Admins only: `GET` lists accounts and pending invitations. */
export const ACCOUNTS_PATH = "/api/accounts";
/** Admins only: `POST` creates an invitation, `DELETE /<id>` cancels a pending one. */
export const INVITATIONS_PATH = "/api/accounts/invitations";

export const INVITATION_DAYS = 7;

/** Open to people who are not signed in: `GET ?token=` reads a password link, `POST` chooses the new password with it. */
export const PASSWORD_LINK_PATH = "/api/password-link";
export const PASSWORD_LINK_HOURS = 24;
/** Mon compte: `PATCH` changes the name of the signed-in account. */
export const MY_ACCOUNT_PATH = "/api/account";
/** Mon compte: `POST { currentPassword, newPassword }` changes the password and signs the other devices out. */
export const MY_PASSWORD_PATH = "/api/account/password";

export interface AccountEntry extends Person {
  role: AccountRole;
  status: "active" | "deactivated";
  /** ISO time of the last sign-in; null for an account that never signed in. */
  lastSignInAt: string | null;
  /** Titles of the projects the account owns: they pass to the admin who deactivates it. */
  ownedProjects: string[];
  /** How many share links the account created that work today: "Désactiver aussi ses liens". */
  linkCount: number;
}

/** `POST /api/accounts/<id>/deactivate`: with `disableLinks`, the links the account created stop working too. */
export interface DeactivateRequest {
  disableLinks?: boolean;
}

/** `POST /api/accounts/<id>/password-link`: admins only. The link is `#/mot-de-passe/<token>`, single use. */
export interface PasswordLinkEntry {
  token: string;
  expiresAt: string;
}

export interface PasswordLinkPreview {
  email: string;
  expiresAt: string;
}

export interface InvitationEntry {
  id: string;
  email: string;
  role: AccountRole;
  /** Name of the admin who invited. */
  invitedBy: string;
  createdAt: string;
  /** Null for an entry added in proxy mode: it waits for the person's first SSO sign-in and does not expire. */
  expiresAt: string | null;
  /** The secret part of the link: `#/invitation/<token>`. A pending invitation can be copied again; empty in proxy mode (no link). */
  token: string;
}

export interface AccountsResponse {
  /** True in proxy mode: people sign in through the SSO, pending entries are "ajouts", and there are no password actions. */
  sso: boolean;
  accounts: AccountEntry[];
  invitations: InvitationEntry[];
}

/** What the invitee sees before choosing a name and a password. */
export interface InvitationPreview {
  email: string;
  role: AccountRole;
  invitedBy: string;
  expiresAt: string;
}
/** The header the web UI adds to its API calls: with a JSON content type, it is what a mutating call must carry in built-in account mode. */
export const REDLINE_HEADER = "x-redline";

export const ME_PATH = "/api/me";

/** The viewer's own label next to anything they did. */
export const OWN_LABEL = "Toi";
export const UNKNOWN_PERSON_LABEL = "Utilisateur inconnu";

/** Where a name shows: `message` is the author of a message, `history` a meta line or list (no name when unknown), `launcher` the Sessions "Lancé par" column. */
export type PersonPlace = "message" | "history" | "launcher";

/**
 * The one display rule for a signed action. `viewer` is who is looking (`useMe()`), null without SSO.
 * - the viewer's own person: "Toi"; another person: their name (user id when they have none);
 * - no person while an SSO is configured: "Utilisateur inconnu" in a message, nothing (undefined) in a history or list, "—" in "Lancé par";
 * - no SSO: today's labels, "Toi" in a message and nothing elsewhere ("—" in "Lancé par").
 */
export function personLabel(person: Person | undefined, viewer: Pick<Person, "id"> | null, place: PersonPlace): string | undefined {
  if (viewer === null) return place === "message" ? OWN_LABEL : place === "launcher" ? "—" : undefined;
  if (!person) return place === "message" ? UNKNOWN_PERSON_LABEL : place === "launcher" ? "—" : undefined;
  return person.id === viewer.id ? OWN_LABEL : person.name || person.id;
}

/** Up to two capital letters: the first letters of the first and last words of the name (of the user id when there is no name). */
export function initialsOf(name: string, id: string): string {
  const words = (name.trim() || id).split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  return letters.join("").toUpperCase();
}
