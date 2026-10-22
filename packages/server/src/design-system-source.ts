import { DESIGN_SYSTEM_TOKENS_PATH, CORE_TOKENS, type Project } from "@redline/shared";
import type { Store } from "./store.js";

const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 60_000;

/** What Claude is told about the pages of the project a design system is derived from. */
export function sourcePagesMessage(store: Store, project: Project): string {
  let budget = MAX_TOTAL_CHARS;
  const pages = store.listPages(project.id).map((page) => {
    const files = Object.entries(store.readPageFiles(page.id)?.files ?? {}).map(([path, content]) => {
      const shown = content.slice(0, Math.max(0, Math.min(MAX_FILE_CHARS, budget)));
      budget -= shown.length;
      if (shown === "") return `File ${path} (omitted)`;
      return `File ${path}:\n${shown}${shown.length < content.length ? "\n[truncated]" : ""}`;
    });
    return [`Page "${page.title}" (id ${page.id}, ${page.type})`, ...files].join("\n\n");
  });
  return [
    `This design system is being derived from the pages of the project "${project.title}" (id ${project.id}).`,
    `Reuse the colors, typography, spacing, radius and components those pages already use. Fill every core token (${CORE_TOKENS.join(", ")}) in ${DESIGN_SYSTEM_TOKENS_PATH}, keep the preview page in sync, and add components as needed.`,
    pages.length === 0 ? "The project has no page yet." : "Its pages:",
    ...pages,
  ].join("\n\n");
}
