import type { FastifyInstance } from "fastify";
import { projectComponents } from "./components.js";
import type { Store } from "./store.js";

/**
 * Artboards load a design system's tokens through a stylesheet link, so a page open in a browser keeps the old
 * tokens until it reloads. A design system's own pages show its draft, so they reload when one of them gets a new
 * version; project pages show its current diffusion, so they reload when a diffusion is created (`announceDiffusion`).
 */
export function registerDesignSystemReload(app: FastifyInstance, store: Store): void {
  // Project pages also link the project's assembled components, live: when a version of one of its pages changes
  // them, every page of the project reloads. The first version seen after a start has nothing to compare with.
  const componentsCss = new Map<string, string>();
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
  });
  app.addHook("onClose", async () => unsubscribe());
}

/** Tells the pages of the projects that follow a design system to reload: a new diffusion was created. */
export function announceDiffusion(store: Store, designSystemId: string): void {
  const pageIds = store.listPageIds().filter((pageId) => !store.isDesignSystemPage(pageId) && store.sharedDesignSystemIdOfPage(pageId) === designSystemId);
  store.emit({ type: "design-system-updated", designSystemId, pageIds });
}
