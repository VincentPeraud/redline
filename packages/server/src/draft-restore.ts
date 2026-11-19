import { assembleComponents, breaksOf, instanceTagOf, instanceUsesIn, MANIFEST_PATH, type InstanceBreak } from "@redline/shared";
import { componentPages } from "./components.js";
import { designSystemInState, designSystemSeenBy } from "./design-system-view.js";
import type { Store } from "./store.js";
import type { PageLock } from "./page-lock.js";
import { dispatchThread } from "./work.js";
import { modelChoiceOf } from "./validation.js";

export const DRAFT_RESTORE_THREAD_TITLE = "Restauration d'une version du brouillon";

const breakText = (item: InstanceBreak): string => {
  switch (item.kind) {
    case "component": return `le composant ${instanceTagOf(item.component)}`;
    case "setting": return `le réglage ${item.setting} de ${instanceTagOf(item.component)}`;
    case "value": return `${item.setting}="${item.value}" de ${instanceTagOf(item.component)}`;
    case "slot": return `l'emplacement « ${item.slot} » de ${instanceTagOf(item.component)}`;
  }
};

/**
 * Whether restoring `versionId` puts back files drawn with a draft the project no longer follows: such a restore is allowed
 * even when the diffusion lacks what the files use (the check of unknown tags is skipped).
 */
export function restoresDraftVersionOnDiffusion(store: Store, pageId: string, versionId: string): boolean {
  const page = store.getPage(pageId);
  return page !== undefined && store.versionOnDraft(pageId, versionId) && !store.isDesignSystemPage(pageId) && !store.projectFollowsDraft(page.projectId);
}

/**
 * The instances of `files` (restored on `pageId`) that the draft offered and the diffusion the project sees now does not: the
 * artboard to put the thread on, and what breaks. Undefined when nothing breaks. Local check, narrower than the shared
 * broken-pages computation: components, settings, values and slots only.
 */
export function draftRestoreBreaks(store: Store, pageId: string, files: Record<string, string>, only?: string[]): { artboard: string; breaks: string[] } | undefined {
  const page = store.getPage(pageId);
  const manifest = files[MANIFEST_PATH];
  const designSystemId = store.sharedDesignSystemIdForManifest(pageId, manifest);
  const current = store.currentDiffusion(designSystemId ?? "");
  if (!page || designSystemId === undefined || !current) return undefined;
  const drawnWith = designSystemInState(store, designSystemId, { kind: "draft", afterDiffusion: current.number }).definitions();
  const own = assembleComponents(componentPages(store, page.projectId, { pageId, files })).definitions;
  const ownNames = new Set(own.map((d) => d.name));
  const seen = designSystemSeenBy(store, page.projectId, designSystemId)?.definitions() ?? [];
  const found = { artboard: "", breaks: [] as string[] };
  for (const [file, content] of Object.entries(files)) {
    if (!file.endsWith(".html") || file.startsWith("components/") || (only && !only.includes(file))) continue;
    for (const use of instanceUsesIn(content)) {
      if (ownNames.has(use.name)) continue;
      const texts = breaksOf(use, drawnWith, seen).map(breakText);
      if (texts.length === 0 || !store.hasArtboard(pageId, file)) continue;
      if (found.artboard === "") found.artboard = file;
      for (const text of texts) if (!found.breaks.includes(text)) found.breaks.push(text);
    }
  }
  return found.artboard === "" ? undefined : found;
}

/** Opens the "Redline" thread listing what a restored draft version breaks, if anything does. */
export function openDraftRestoreThread(store: Store, lock: PageLock, pageId: string, files: Record<string, string>, only?: string[]): void {
  const broken = draftRestoreBreaks(store, pageId, files, only);
  const page = store.getPage(pageId);
  if (!broken || !page) return;
  const body = `Cette version a été publiée avec le brouillon du design system. Le projet suit maintenant la dernière diffusion, qui n'a pas : ${broken.breaks.join(", ")}. Mets à jour les instances concernées.`;
  const thread = store.createThread(pageId, { target: { kind: "artboard", artboard: broken.artboard }, title: DRAFT_RESTORE_THREAD_TITLE, body }, undefined, true);
  dispatchThread(store, lock, page.projectId, thread, modelChoiceOf({}));
}
