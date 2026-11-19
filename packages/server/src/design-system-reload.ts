import type { FastifyInstance } from "fastify";
import { projectComponents } from "./components.js";
import type { Store } from "./store.js";

/** A burst of publishes while Claude works on the design system reloads a following project once, this long after the first. */
const DRAFT_RELOAD_DELAY_MS = 400;

/**
 * Artboards load a design system's tokens through a stylesheet link, so a page open in a browser keeps the old
 * tokens until it reloads. A design system's own pages show its draft, so they reload when one of them gets a new
 * version; project pages show its current diffusion, so they reload when a diffusion is created (`announceDiffusion`),
 * unless the project follows the draft: its pages then reload like the design system's own, coalesced per project.
 */
export function registerDesignSystemReload(app: FastifyInstance, store: Store): void {
  // Project pages also link the project's assembled components, live: when a version of one of its pages changes
  // them, every page of the project reloads. The first version seen after a start has nothing to compare with.
  const componentsCss = new Map<string, string>();
  const reloadsPending = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  const reloadDraftFollowers = (designSystemId: string) => {
    for (const project of store.listProjects("active")) {
      if (store.sharedDesignSystemIdOfProject(project.id) !== designSystemId || !store.projectFollowsDraft(project.id) || reloadsPending.has(project.id)) continue;
      reloadsPending.add(project.id);
      const timer = setTimeout(() => {
        timers.delete(timer);
        reloadsPending.delete(project.id);
        store.emit({ type: "design-system-updated", designSystemId, pageIds: store.listPages(project.id).map((p) => p.id) });
      }, DRAFT_RELOAD_DELAY_MS);
      timers.add(timer);
    }
  };
  const unsubscribe = store.onChange((event) => {
    if (event.type !== "page-updated") return;
    const designSystem = store.designSystemOfPage(event.pageId);
    if (!designSystem) {
      const page = store.getPage(event.pageId);
      if (!page) return;
      const css = projectComponents(store, page.projectId).css;
      if (componentsCss.get(page.projectId) === css) return;
      componentsCss.set(page.projectId, css);
      const designSystemId = store.sharedDesignSystemIdOfProject(page.projectId);
      store.emit({ type: "design-system-updated", ...(designSystemId ? { designSystemId } : {}), pageIds: store.listPages(page.projectId).map((p) => p.id) });
      return;
    }
    const pageIds = store.listPages(designSystem.id).map((page) => page.id);
    store.emit({ type: "design-system-updated", designSystemId: designSystem.id, pageIds });
    reloadDraftFollowers(designSystem.id);
  });
  app.addHook("onClose", async () => {
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
  });
}

/** Tells the pages of the projects that follow a design system to reload: a new diffusion was created. */
export function announceDiffusion(store: Store, designSystemId: string): void {
  const pageIds = store.listPageIds().filter((pageId) => !store.isDesignSystemPage(pageId) && store.sharedDesignSystemIdOfPage(pageId) === designSystemId);
  store.emit({ type: "design-system-updated", designSystemId, pageIds });
}
