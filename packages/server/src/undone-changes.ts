import { assembleComponents } from "@redline/shared";
import { projectComponents } from "./components.js";
import type { Store } from "./store.js";

/** The hash of a component in the files of one page version (html and tweaks), undefined when the page has no such component. */
function hashIn(store: Store, pageId: string, versionId: string | undefined, name: string): string | undefined {
  const files = versionId === undefined ? undefined : store.readVersionFiles(pageId, versionId);
  if (!files) return undefined;
  return assembleComponents([{ id: pageId, title: "", files }]).components.find((component) => component.name === name)?.hash;
}

/**
 * A refused change awaiting its undo is undone, whether or not the session recorded it, once its component in the draft is back to
 * what it was just before the publish that recorded the change, or to what the current diffusion has (the same file and tweaks,
 * compared by hash). A change whose publish did not alter its component cannot be recognised this way: it waits for the
 * session's record_change. Called after every publish or restore on a design system page.
 */
export function settleUndoneChanges(store: Store, pageId: string): void {
  const designSystem = store.designSystemOfPage(pageId);
  if (!designSystem) return;
  const refused = store.listChanges(designSystem.id).filter((change) => change.state === "refused");
  if (refused.length === 0) return;
  const draft = projectComponents(store, designSystem.id).components;
  const current = store.currentDiffusion(designSystem.id);
  const diffused = current ? store.diffusionComponents(designSystem.id, current.number) : [];
  const undone = refused.filter((change) => {
    const now = draft.find((component) => component.name === change.component)?.hash;
    if (now === diffused.find((component) => component.name === change.component)?.hash) return true;
    const recorded = store.versionContext(change.versionId);
    if (!recorded) return false;
    const before = hashIn(store, recorded.pageId, recorded.previousId, change.component);
    const atChange = hashIn(store, recorded.pageId, change.versionId, change.component);
    return atChange !== before && now === before;
  });
  if (undone.length > 0) store.deleteChanges(undone.map((change) => change.id));
}
