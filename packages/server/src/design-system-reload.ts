import type { FastifyInstance } from "fastify";
import { designSystemIdOf } from "./project-files.js";
import type { Store } from "./store.js";

/**
 * Artboards load a design system's tokens through a stylesheet link, so a page open in a browser keeps the old
 * tokens until it reloads. When a design system gets a new version, tell which pages use it.
 */
export function registerDesignSystemReload(app: FastifyInstance, store: Store): void {
  const unsubscribe = store.onChange((event) => {
    if (event.type !== "page-updated") return;
    const designSystem = store.designSystemOfPage(event.pageId);
    if (!designSystem) return;
    const pageIds = store.listPageIds().filter((pageId) => designSystemIdOf(store, pageId) === designSystem.id);
    store.emit({ type: "design-system-updated", designSystemId: designSystem.id, pageIds });
  });
  app.addHook("onClose", async () => unsubscribe());
}
