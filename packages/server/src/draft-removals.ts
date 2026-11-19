import { MANIFEST_PATH, componentNameOf, defaultManifest, instanceUsesIn, parseManifest, type DraftChangeUsers } from "@redline/shared";
import { brokenPagesBetween, openBrokenPageThreads } from "./broken-pages.js";
import { currentDiffusionOf, designSystemInState, type DesignSystemView } from "./design-system-view.js";
import { projectComponents } from "./components.js";
import { returnToOrigin } from "./diffusion-returns.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

const frozen = (view: DesignSystemView): DesignSystemView => {
  const definitions = view.definitions();
  const tokensCss = view.tokensCss();
  return { ...view, definitions: () => definitions, tokensCss: () => tokensCss };
};

/**
 * Call before a publish or restore on a page; call the returned function once the publish is fully recorded. On a design system page,
 * what the publish removed from the draft is reported at once on the broken pages of the projects following the draft ("Retrait dans
 * le design system" threads, so the next diffusion does not repeat them), and a refused change the publish undid reopens the
 * request's origins of those projects, with the refusal's answer. Does nothing on other pages.
 */
export function watchDraftRemovals(store: Store, pageLock: PageLock, pageId: string): () => void {
  const designSystem = store.designSystemOfPage(pageId);
  const current = designSystem && currentDiffusionOf(store, designSystem.id);
  const followers = designSystem ? store.projectsUsingDesignSystem(designSystem.id).filter((project) => !project.archived && store.projectFollowsDraft(project.id)) : [];
  if (!designSystem || !current || followers.length === 0) return () => undefined;
  const draftNow = () => designSystemInState(store, designSystem.id, { kind: "draft", afterDiffusion: current.diffusion });
  const before = frozen(draftNow());
  const refusedBefore = store.listChanges(designSystem.id).filter((change) => change.state === "refused");

  return () => {
    const after = draftNow();
    if (JSON.stringify(before.definitions()) !== JSON.stringify(after.definitions()) || before.tokensCss() !== after.tokensCss()) {
      for (const project of followers) {
        const pages = brokenPagesBetween(store, project.id, before, after);
        openBrokenPageThreads(store, pageLock, pages, "Retrait dans le design system", `Le brouillon du design system « ${designSystem.title} » a retiré ce que cette page utilise`);
      }
    }
    const left = new Set(store.listChanges(designSystem.id).map((change) => change.id));
    const undone = refusedBefore.filter((change) => !left.has(change.id) && change.threadId);
    const labelsByRequest = new Map<string, string[]>();
    for (const change of undone) {
      const threadId = store.keptRequestId(change.threadId!);
      labelsByRequest.set(threadId, [...(labelsByRequest.get(threadId) ?? []), change.label]);
    }
    const onDraft = new Set(followers.map((project) => project.id));
    for (const [threadId, labels] of labelsByRequest) {
      const request = store.getThread(threadId)?.request;
      if (!request) continue;
      const answer = request.refusalAnswer ? ` Réponse du design system : ${request.refusalAnswer}` : "";
      const message = `Refusé par le design system : ${labels.join(" ; ")}.${answer} Ce changement a été retiré du brouillon, que ce projet suit : mets l'instance à jour.`;
      for (const origin of request.origins) if (onDraft.has(origin.projectId)) returnToOrigin(store, pageLock, origin, message);
    }
  };
}

/** The pages of projects following the draft of `designSystemId` that write an instance of `component` (the project's own components left out). */
export function draftPagesUsing(store: Store, designSystemId: string, component: string): DraftChangeUsers {
  const pages: DraftChangeUsers["pages"] = [];
  for (const project of store.projectsUsingDesignSystem(designSystemId)) {
    if (project.archived || !store.projectFollowsDraft(project.id)) continue;
    const own = new Set(projectComponents(store, project.id).definitions.map((definition) => definition.name));
    if (own.has(component)) continue;
    for (const page of store.listPages(project.id)) {
      const files = store.readPageFiles(page.id)?.files ?? {};
      const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]);
      const used = manifest.artboards.some((entry) => {
        const content = files[entry.file];
        return content !== undefined && entry.file.endsWith(".html") && componentNameOf(entry.file) === null && instanceUsesIn(content).some((use) => use.name === component);
      });
      if (used) pages.push({ pageId: page.id, projectTitle: project.title, pageTitle: page.title });
    }
  }
  return { pages };
}
