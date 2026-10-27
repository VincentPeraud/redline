/** "15 octobre à 10:05": how a version's date reads in the French UI copy of a restore message. */
export function formatDate(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function validTimeZone(timeZone: unknown): boolean {
  if (timeZone === undefined) return true;
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: timeZone as string });
    return typeof timeZone === "string";
  } catch {
    return false;
  }
}

export const restoredVersionMessage = (createdAt: string, timeZone: string | undefined) => `Version du ${formatDate(createdAt, timeZone)} restaurée`;
