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

/** "Fil « titre »", "Conversation « titre »", "Terminal", "Tweak", "Restauration", "Création". */
export function originLabel(origin: AuthorOrigin, title?: string): string {
  if (origin === "thread" || origin === "conversation") {
    const kind = origin === "thread" ? "Fil" : "Conversation";
    return title ? `${kind} « ${title} »` : kind;
  }
  return FIXED_LABELS[origin];
}

/** "Claude · fil « … »", "Claude · conversation « … »", "Terminal", "toi": who last changed DESIGN.md, to sit after "par". */
export function designMdAuthor(origin: AuthorOrigin, title?: string): string {
  if (origin === "thread" || origin === "conversation") {
    const kind = origin === "thread" ? "fil" : "conversation";
    return title ? `Claude · ${kind} « ${title} »` : `Claude · ${kind}`;
  }
  return origin === "user" ? "toi" : originLabel(origin);
}

/** Origin line of a DESIGN.md rule; the user's rules from the project's first version read "création du projet". */
export function ruleOrigin(origin: AuthorOrigin, title: string | undefined, fromFirstVersion: boolean): string {
  if (origin === "user") return fromFirstVersion ? "Toi · création du projet" : "Toi";
  return originLabel(origin, title);
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
