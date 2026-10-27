/** Someone signed in through the SSO, identified by the user-id header value. */
export interface Person {
  id: string;
  /** The display name the SSO gave; empty when it gave none. */
  name: string;
  email: string;
  initials: string;
}

/** `GET /api/me`: the viewing person and where "Se déconnecter" leads (null when none is set); the body is `null` without SSO. */
export type MeResponse = (Person & { logoutUrl: string | null }) | null;

export const ME_PATH = "/api/me";

/** Up to two capital letters: the first letters of the first and last words of the name (of the user id when there is no name). */
export function initialsOf(name: string, id: string): string {
  const words = (name.trim() || id).split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  return letters.join("").toUpperCase();
}
