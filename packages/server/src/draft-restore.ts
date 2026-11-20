import { brokenElementText, brokenPagesBetween } from "./broken-pages.js";
import { designSystemSeenBy, draftOf } from "./design-system-view.js";
import type { Store } from "./store.js";
import type { PageLock } from "./page-lock.js";
import { dispatchThread } from "./work.js";
import { modelChoiceOf } from "./validation.js";

export const DRAFT_RESTORE_THREAD_TITLE = "Restauration d'une version du brouillon";

/**
 * Whether restoring `versionId` puts back files drawn with a draft the project no longer follows: such a restore is allowed
 * even when the diffusion lacks what the files use (the check of unknown tags accepts what the draft offers).
 */
export function restoresDraftVersionOnDiffusion(store: Store, pageId: string, versionId: string): boolean {
  const page = store.getPage(pageId);
  return page !== undefined && store.versionOnDraft(pageId, versionId) && !store.isDesignSystemPage(pageId) && !store.projectFollowsDraft(page.projectId);
}

/**
 * Call once the restore is recorded: opens the "Redline" thread listing what the restored files use that the draft offered and
 * the diffusion the project sees now does not (the shared broken-pages computation), on the first broken artboard. `artboards`
 * narrows it to the artboards the restore touched. Nothing is opened when nothing breaks.
 */
export function openDraftRestoreThread(store: Store, lock: PageLock, pageId: string, artboards?: string[]): void {
  const page = store.getPage(pageId);
  const designSystemId = page && store.sharedDesignSystemIdOfProject(page.projectId);
  const draft = designSystemId ? draftOf(store, designSystemId) : undefined;
  const seen = designSystemId ? designSystemSeenBy(store, page.projectId, designSystemId) : undefined;
  if (!page || !draft || !seen) return;
  const broken = brokenPagesBetween(store, page.projectId, draft, seen, { pageId, artboards })[0];
  if (!broken) return;
  const body = `Cette version a été publiée avec le brouillon du design system. Le projet suit maintenant la dernière diffusion, qui n'a pas : ${broken.elements.map(brokenElementText).join(", ")}. Mets à jour les instances concernées.`;
  const thread = store.createThread(pageId, { target: { kind: "artboard", artboard: broken.artboard }, title: DRAFT_RESTORE_THREAD_TITLE, body }, undefined, true);
  dispatchThread(store, lock, page.projectId, thread, modelChoiceOf({}));
}
