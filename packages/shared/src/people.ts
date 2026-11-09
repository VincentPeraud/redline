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
export type MeResponse = (Person & { logoutUrl: string | null; account?: { role: AccountRole } }) | null;

export const SESSION_PATH = "/api/session";
export const SETUP_PATH = "/api/setup";
/** Open to people who are not signed in: `GET ?token=` reads an invitation, `POST` accepts it (creates the account). */
export const INVITATION_PATH = "/api/invitation";
/** Admins only: `GET` lists accounts and pending invitations. */
export const ACCOUNTS_PATH = "/api/accounts";
/** Admins only: `POST` creates an invitation, `DELETE /<id>` cancels a pending one. */
export const INVITATIONS_PATH = "/api/accounts/invitations";

export const INVITATION_DAYS = 7;

export interface AccountEntry extends Person {
  role: AccountRole;
  status: "active" | "deactivated";
  /** ISO time of the last sign-in; null for an account that never signed in. */
  lastSignInAt: string | null;
}

export interface InvitationEntry {
  id: string;
  email: string;
  role: AccountRole;
  /** Name of the admin who invited. */
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** The secret part of the link: `#/invitation/<token>`. A pending invitation can be copied again. */
  token: string;
}

export interface AccountsResponse {
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
