import type { FastifyInstance } from "fastify";
import { designSystemIdOf } from "./project-files.js";
import type { Store } from "./store.js";

/**
 * Artboards load a design system's tokens through a stylesheet link, so a page open in a browser keeps the old
 * tokens until it reloads. A design system's own pages show its draft, so they reload when one of them gets a new
 * version; project pages show its current diffusion, so they reload when a diffusion is created (`announceDiffusion`).
 */
export function registerDesignSystemReload(app: FastifyInstance, store: Store): void {
  const unsubscribe = store.onChange((event) => {
    if (event.type !== "page-updated") return;
    const designSystem = store.designSystemOfPage(event.pageId);
    if (!designSystem) return;
    const pageIds = store.listPages(designSystem.id).map((page) => page.id);
    store.emit({ type: "design-system-updated", designSystemId: designSystem.id, pageIds });
  });
  app.addHook("onClose", async () => unsubscribe());
}

/** Tells the pages of the projects that follow a design system to reload: a new diffusion was created. */
export function announceDiffusion(store: Store, designSystemId: string): void {
  const pageIds = store.listPageIds().filter((pageId) => !store.isDesignSystemPage(pageId) && designSystemIdOf(store, pageId) === designSystemId);
  store.emit({ type: "design-system-updated", designSystemId, pageIds });
}
