import { assembleComponents, componentNameOf, type ComponentAssembly, type ComponentPage } from "@redline/shared";
import type { Store } from "./store.js";

/** The pages of a project (a design system is one) as the component assembly takes them, `replacing` the files of one page. */
export function componentPages(store: Store, projectId: string, replacing?: { pageId: string; files: Record<string, string> }): ComponentPage[] {
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

/** The component files (`components/<name>.html`) of the pages of a project or design system, by path. */
export function componentFilesOf(store: Store, projectId: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const page of componentPages(store, projectId)) {
    for (const [path, content] of Object.entries(page.files)) if (componentNameOf(path) !== null) files[path] = content;
  }
  return files;
}

const componentsError = (assembly: ComponentAssembly) => assembly.duplicates[0] ?? assembly.cycles[0] ?? null;

/** Error message when publishing `files` on `pageId` would define a component name twice in its project or make components contain each other in a loop, else null. */
export function versionComponentsError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const page = store.getPage(pageId)!;
  return componentsError(assembleComponents(componentPages(store, page.projectId, { pageId, files })));
}

/** Error message when a new page with `files` would define a component name twice in the project, else null. */
export function newPageComponentsError(store: Store, projectId: string, title: string, files: Record<string, string>): string | null {
  return componentsError(assembleComponents([...componentPages(store, projectId), { id: "", title, files }]));
}
