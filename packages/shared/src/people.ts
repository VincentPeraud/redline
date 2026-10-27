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
