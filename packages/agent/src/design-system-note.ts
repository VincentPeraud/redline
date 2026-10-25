import { classesUsedIn, componentClassesOf, componentNameOf, type ProjectContext } from "@redline/shared";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the session message says about the design system: where it is, its pages, and the pages this project uses. */
export function designSystemNote({ designSystem, editsDesignSystem, projectComponents }: ProjectContext): string {
  if (editsDesignSystem) {
    return `This page belongs to the design system "${editsDesignSystem.title}": you edit its draft (tokens.css and DESIGN.md at the root of the working copy, and its pages). Projects only see the draft once the user diffuses it.`;
  }
  const own = Object.keys(projectComponents ?? {}).flatMap((path) => componentNameOf(path) ?? []);
  const projectNote = own.length === 0 ? "" : `\nComponents of this project (every page), read-only in .project-components/: ${own.join(", ")}. Reuse them; edit one in the page that defines it.`;
  if (!designSystem) return projectNote.trim();
  const used = designSystem.pages.filter((page) => page.used).map((page) => page.title);
  return [
    `Design system: ${designSystem.title} (diffusion ${designSystem.diffusion}), read-only in .design-system/ (start with index.md; never edit it, propose changes to the user).`,
    `Pages of the design system: ${designSystem.pages.map((page) => `${page.title} (${plural(page.components, "component")})`).join(", ") || "none"}.`,
    used.length > 0 ? `Ce projet utilise : ${used.join(", ")}.` : "Ce projet n'utilise aucun composant du design system.",
  ].join("\n") + projectNote;
}

/**
 * A hint (shown, never stored) for the artboards of `pageFiles` that use no class of the design system's components while
 * it has some; null when there is nothing to say.
 */
export function designSystemHint(pageFiles: Record<string, string>, designSystemFiles: Record<string, string> | undefined): string | null {
  if (!designSystemFiles) return null;
  const classes = new Set(Object.entries(designSystemFiles).flatMap(([path, html]) => (componentNameOf(path) === null ? [] : componentClassesOf(html))));
  if (classes.size === 0) return null;
  const free = Object.entries(pageFiles)
    .filter(([path]) => path.endsWith(".html") && componentNameOf(path) === null)
    .filter(([, html]) => ![...classesUsedIn(html)].some((name) => classes.has(name)))
    .map(([path]) => path);
  if (free.length === 0) return null;
  return `Hint: ${free.join(", ")} use${free.length === 1 ? "s" : ""} no component class of the design system, which has components (see .design-system/index.md). Reuse them where they fit, or ignore this if the artboard is deliberately free.`;
}
