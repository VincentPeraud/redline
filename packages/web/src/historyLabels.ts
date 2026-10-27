import type { VersionOrigin } from "@redline/shared";

/** Who made a version: a page version origin, or "user" for a DESIGN.md saved by hand. */
export type AuthorOrigin = VersionOrigin | "user";

const FIXED_LABELS: Record<Exclude<AuthorOrigin, "thread" | "conversation">, string> = {
  terminal: "Terminal",
  tweak: "Tweak",
  restore: "Restauration",
  creation: "Création",
  user: "Toi",
};

/** Who is named next to an action. `sso`: the server has an SSO, so names mean something; `name`: the person's label ("Toi", their name), absent when nobody is known. */
export interface Who {
  sso: boolean;
  name?: string;
}

const NOBODY: Who = { sso: false };

/**
 * "Claude · fil « titre », demandé par Ariane Martin" (history) or "… · demandé par …" (rule), "Tweak · Ariane Martin",
 * "Terminal", "Création"; the person only when an SSO names one. Without SSO the labels stay as they were:
 * "Fil « titre »", "Tweak", "Toi".
 */
export function originLabel(origin: AuthorOrigin, title?: string, who: Who = NOBODY, style: "history" | "rule" = "history"): string {
  if (origin === "thread" || origin === "conversation") {
    const kind = origin === "thread" ? "fil" : "conversation";
    if (!who.sso) {
      const plain = origin === "thread" ? "Fil" : "Conversation";
      return title ? `${plain} « ${title} »` : plain;
    }
    const claude = title ? `Claude · ${kind} « ${title} »` : `Claude · ${kind}`;
    return who.name ? `${claude}${style === "rule" ? " · demandé par " : ", demandé par "}${who.name}` : claude;
  }
  if (!who.sso) return FIXED_LABELS[origin];
  if (origin === "user") return who.name ?? "";
  return who.name ? `${FIXED_LABELS[origin]} · ${who.name}` : FIXED_LABELS[origin];
}

/** A meta line: its non-empty parts separated by " · ". */
export const metaLine = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(" · ");

/** "Claude · fil « … »", "Claude · conversation « … »", "Terminal", "toi": who last changed DESIGN.md, to sit after "par". */
export function designMdAuthor(origin: AuthorOrigin, title?: string): string {
  if (origin === "thread" || origin === "conversation") {
    const kind = origin === "thread" ? "fil" : "conversation";
    return title ? `Claude · ${kind} « ${title} »` : `Claude · ${kind}`;
  }
  return origin === "user" ? "toi" : originLabel(origin);
}

/** "Dernière modification par toi · aujourd'hui" without SSO; "Modifié par Ariane Martin · il y a 2 h" with one ("Modifié · …" when nobody is known). */
export function designMdStatus(origin: AuthorOrigin, title: string | undefined, when: string, who: Who = NOBODY): string {
  if (!who.sso) return `Dernière modification par ${designMdAuthor(origin, title)} · ${when}`;
  const author = origin === "user" ? who.name : originLabel(origin, title, who, "rule");
  return author ? `Modifié par ${author} · ${when}` : `Modifié · ${when}`;
}

/** Origin line of a DESIGN.md rule; the user's rules from the project's first version read "création du projet". Empty when nobody is known. */
export function ruleOrigin(origin: AuthorOrigin, title: string | undefined, fromFirstVersion: boolean, who: Who = NOBODY): string {
  if (!who.sso) {
    if (origin === "user") return fromFirstVersion ? "Toi · création du projet" : "Toi";
    return originLabel(origin, title);
  }
  if (origin === "user" && fromFirstVersion) return who.name ? `${who.name} · création du projet` : "Création du projet";
  return originLabel(origin, title, who, "rule");
}

const dayNumber = (date: Date) => Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000);

const clock = (date: Date) => date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** "aujourd'hui", "hier", "mar. 20 oct.", "3 déc. 2025". */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const days = dayNumber(new Date(now)) - dayNumber(new Date(iso));
  return days === 0 ? "aujourd'hui" : historyDate(iso, { now });
}

/** "il y a 2 min", "il y a 3 h" within the day, "hier" (", 16:40" with `withTime`), "lun. 20 oct.", "3 déc. 2025". */
export function historyDate(iso: string, { now = Date.now(), withTime = false }: { now?: number; withTime?: boolean } = {}): string {
  const date = new Date(iso);
  const today = new Date(now);
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  const days = dayNumber(today) - dayNumber(date);
  if (days === 0) {
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    return `il y a ${Math.floor(minutes / 60)} h`;
  }
  if (days === 1) return withTime ? `hier, ${clock(date)}` : "hier";
  const sameYear = date.getFullYear() === today.getFullYear();
  return sameYear
    ? date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })
    : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}
