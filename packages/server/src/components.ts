import { assembleComponents, type ComponentAssembly, type ComponentPage } from "@redline/shared";
import type { Store } from "./store.js";

/** The pages of a project (a design system is one) as the component assembly takes them, `replacing` the files of one page. */
function componentPages(store: Store, projectId: string, replacing?: { pageId: string; files: Record<string, string> }): ComponentPage[] {
  return store.listPages(projectId).map((page) => ({
    id: page.id,
    title: page.title,
    files: replacing?.pageId === page.id ? replacing.files : (store.readPageFiles(page.id)?.files ?? {}),
  }));
}

/** Components assembled from the current pages of a project or design system. */
export function projectComponents(store: Store, projectId: string): ComponentAssembly {
  return assembleComponents(componentPages(store, projectId));
}

/** Error message when publishing `files` on `pageId` would define a component name twice in its project, else null. */
export function versionComponentsError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const page = store.getPage(pageId)!;
  return assembleComponents(componentPages(store, page.projectId, { pageId, files })).duplicates[0] ?? null;
}

/** Error message when a new page with `files` would define a component name twice in the project, else null. */
export function newPageComponentsError(store: Store, projectId: string, title: string, files: Record<string, string>): string | null {
  return assembleComponents([...componentPages(store, projectId), { id: "", title, files }]).duplicates[0] ?? null;
}
