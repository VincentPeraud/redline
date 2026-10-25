import { DESIGN_SYSTEM_TOKENS_PATH, PROJECT_STYLE_PATH, assembleComponents, classesUsedIn, componentClassesOf, parseTokens } from "@redline/shared";
import { componentPages } from "./components.js";
import type { Store } from "./store.js";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `css` or markup reads the custom property `name`: `var(--name` not followed by more of a longer name. */
export function referencesToken(text: string, name: string): boolean {
  return new RegExp(`var\\(\\s*${escapeRegExp(name)}(?![A-Za-z0-9_-])`).test(text);
}

/**
 * Where the latest version of the pages of the projects using `designSystemId`, and their project styles, still read
 * the given tokens or use the given components' classes. Each entry of the result names its places, e.g. `page "Stories" of project "Halloween"`.
 * Reusable by anything that must know what a change of the design system would break (removals, rollbacks).
 */
export function designSystemUsages(
  store: Store,
  designSystemId: string,
  wanted: { tokens: string[]; components: { name: string; classes: string[] }[] },
): { tokens: Map<string, string[]>; components: Map<string, string[]> } {
  const tokens = new Map<string, string[]>(wanted.tokens.map((name) => [name, []]));
  const components = new Map<string, string[]>(wanted.components.map((c) => [c.name, []]));
  for (const project of store.projectsUsingDesignSystem(designSystemId)) {
    const style = store.readProjectFile(project.id, PROJECT_STYLE_PATH)?.toString("utf8") ?? "";
    for (const name of wanted.tokens) if (referencesToken(style, name)) tokens.get(name)!.push(`project style of "${project.title}"`);
    for (const page of store.listPages(project.id)) {
      const files = Object.entries(store.readPageFiles(page.id)?.files ?? {});
      const where = `page "${page.title}" of project "${project.title}"`;
      for (const name of wanted.tokens) if (files.some(([, content]) => referencesToken(content, name))) tokens.get(name)!.push(where);
      const classes = new Set<string>();
      for (const [path, content] of files) if (path.endsWith(".html")) for (const used of classesUsedIn(content)) classes.add(used);
      for (const component of wanted.components) if (component.classes.some((c) => classes.has(c))) components.get(component.name)!.push(where);
    }
  }
  return { tokens, components };
}

function removedTokenNames(store: Store, designSystemId: string, newTokensCss: string): string[] {
  const kept = new Set(parseTokens(newTokensCss).map((t) => t.name));
  const current = store.readProjectFile(designSystemId, DESIGN_SYSTEM_TOKENS_PATH)?.toString("utf8") ?? "";
  return parseTokens(current).map((t) => t.name).filter((name) => !kept.has(name));
}

/**
 * Error message when publishing `files` on the design system page `pageId` (with `tokensCss` as the new `tokens.css`, when it changes)
 * removes a token or a component that pages of a using project still reference, naming them; null when nothing used is removed,
 * the page is not a design system's, or the request confirms the removals. Core tokens are refused elsewhere (`tokensError`).
 */
export function removalsError(store: Store, pageId: string, files: Record<string, string>, tokensCss: string | undefined, confirmed: boolean): string | null {
  const designSystem = store.designSystemOfPage(pageId);
  if (!designSystem || confirmed) return null;

  const removedTokens = tokensCss === undefined ? [] : removedTokenNames(store, designSystem.id, tokensCss);

  const before = componentPages(store, designSystem.id);
  const after = assembleComponents(componentPages(store, designSystem.id, { pageId, files })).components.map((c) => c.name);
  const removedComponents = assembleComponents(before).components.filter((c) => !after.includes(c.name));
  const classes = removedComponents.map((c) => ({
    name: c.name,
    classes: componentClassesOf(before.find((p) => p.id === c.page.id)!.files[c.file] ?? ""),
  }));

  if (removedTokens.length === 0 && classes.length === 0) return null;
  const used = designSystemUsages(store, designSystem.id, { tokens: removedTokens, components: classes });
  const lines = [
    ...removedTokens.filter((name) => used.tokens.get(name)!.length > 0).map((name) => `token ${name} is still used by ${used.tokens.get(name)!.join(", ")}`),
    ...classes.filter((c) => used.components.get(c.name)!.length > 0).map((c) => `component "${c.name}" is still used by ${used.components.get(c.name)!.join(", ")}`),
  ];
  if (lines.length === 0) return null;
  return `Removal refused: ${lines.join("; ")}. Ask the user; only if they agree, publish again with confirmRemovals: true. To rename a token instead, keep the old name as a deprecated alias.`;
}
