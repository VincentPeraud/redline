import type { DesignMdAuthor, DesignMdRule } from "@redline/shared";

/** A line of DESIGN.md shown in "Origine des règles"; `versionId` is undefined while the line is only in the editor. */
export interface ShownRule extends Partial<DesignMdAuthor> {
  text: string;
  versionId: string | undefined;
  createdAt?: string;
}

/**
 * The lines of the editor text (blank lines and headings left out, the dash of a bullet dropped) with the origin the
 * server computed for the saved text. Repeated lines are matched to the saved rules of the same text in order.
 */
export function rulesToShow(text: string, saved: DesignMdRule[]): ShownRule[] {
  const used = new Map<string, number>();
  const shown: ShownRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const occurrence = used.get(line) ?? 0;
    used.set(line, occurrence + 1);
    if (line.startsWith("#")) continue;
    const display = line.startsWith("- ") ? line.slice(2).trim() : line;
    const match = saved.filter((rule) => rule.text === line)[occurrence];
    shown.push(match ? { text: display, versionId: match.versionId, origin: match.origin, originLabel: match.originLabel, person: match.person, createdAt: match.createdAt } : { text: display, versionId: undefined });
  }
  return shown;
}
