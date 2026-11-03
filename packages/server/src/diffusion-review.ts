import {
  defaultChangeLabel,
  defaultChangesOf,
  requestOriginLabel,
  type ChangeRecord,
  type DiffusionReview,
  type ReviewChange,
  type ReviewComponent,
  type ReviewOrigin,
  type ReviewPage,
  type ReviewWhere,
} from "@redline/shared";
import { instanceNamesByPage, projectComponents } from "./components.js";
import { useSites, type UseSite } from "./instance-guards.js";
import type { Store } from "./store.js";

const DIRECT: ReviewOrigin = { kind: "direct" };

/** Where a recorded change comes from: the request it answers (the kept one when it was merged), else the design system's own work. */
function originOf(store: Store, change: ChangeRecord): { origin: ReviewOrigin; refusable: boolean } {
  const thread = change.threadId ? store.getThread(store.keptRequestId(change.threadId)) : undefined;
  if (!thread?.request) return { origin: DIRECT, refusable: false };
  const { origins } = thread.request;
  const comment = origins.length > 0 && origins.every((o) => o.threadId !== undefined);
  return { origin: { kind: comment ? "comment" : "request", from: origins.map(requestOriginLabel) }, refusable: true };
}

function whereOf(name: string, sites: UseSite[], keptBy: string[], movedUp: ReviewWhere["movedUp"]): ReviewWhere {
  const pages = new Map<string, ReviewPage>();
  for (const { use, place, page } of sites) {
    if (use.name !== name || !place || !page) continue;
    const known = pages.get(page.id);
    if (known) known.instances += 1;
    else pages.set(page.id, { projectTitle: place.project, pageId: page.id, pageTitle: place.page ?? "", instances: 1 });
  }
  const list = [...pages.values()];
  return { instances: list.reduce((total, page) => total + page.instances, 0), pages: list, keptBy, movedUp };
}

/** Number of lines the review lists that can still be diffused: what the alerts count (a refused change awaiting its undo is left out). */
export function reviewLineCount(review: DiffusionReview): number {
  return review.tokens.length + (review.designMdChanged ? 1 : 0) + review.components.reduce((sum, card) => sum + card.changes.filter((change) => !change.undoing).length, 0);
}

/** Everything changed since the current diffusion of a design system, for the Diffuse dialog. */
export function diffusionReview(store: Store, designSystemId: string): DiffusionReview {
  const { pending } = store.pendingDiffusion(designSystemId);
  const following = store.projectsUsingDesignSystem(designSystemId);
  const sites = useSites(store, designSystemId, []);
  const recorded = store.listChanges(designSystemId);
  const before = store.diffusionDefinitions(designSystemId, store.currentDiffusion(designSystemId)!.number);
  const defaults = defaultChangesOf(before, projectComponents(store, designSystemId).definitions);
  const ownNames = following.map((project) => ({
    title: project.title,
    names: new Set(projectComponents(store, project.id).definitions.map((d) => d.name)),
    moved: store.movedUpComponents(project.id),
    uses: instanceNamesByPage(store, project.id),
  }));

  const tokens = [
    ...pending.tokens.changed.map((t) => ({ name: t.name, kind: "changed" as const, from: t.from, to: t.to })),
    ...pending.tokens.added.map((t) => ({ name: t.name, kind: "added" as const, to: t.value })),
    ...pending.tokens.removed.map((t) => ({ name: t.name, kind: "removed" as const, from: t.value })),
  ];

  const cardOf = (name: string, kind: ReviewComponent["kind"]): ReviewComponent => {
    const changes: ReviewChange[] = recorded
      .filter((change) => change.component === name)
      .map((change): ReviewChange => {
        const undoing = change.state === "refused";
        const { origin, refusable } = originOf(store, change);
        return { label: change.label, changeId: change.id, origin, refusable: refusable && !undoing, undoing };
      });
    for (const change of defaults.filter((d) => d.component === name)) {
      changes.push({ label: defaultChangeLabel(change.setting, change.from, change.to), origin: DIRECT, refusable: false, undoing: false });
    }
    if (changes.length === 0) changes.push({ label: "Modification sans description", origin: DIRECT, refusable: false, undoing: false });
    const movedHere = (project: (typeof ownNames)[number]) => project.moved[name]?.designSystemId === designSystemId;
    const keptBy = ownNames.filter((project) => project.names.has(name) && !movedHere(project)).map((project) => project.title);
    const movedUp = ownNames.filter(movedHere).map((project) => ({ project: project.title, instances: project.uses.reduce((sum, names) => sum + names.filter((n) => n === name).length, 0) }));
    // A card that only changes defaults reaches the instances that omit the setting, like the guard at publish.
    const changedDefaults = defaults.filter((d) => d.component === name);
    const defaultsOnly = changedDefaults.length > 0 && !recorded.some((change) => change.component === name);
    const reached = defaultsOnly ? sites.filter((site) => site.use.name !== name || changedDefaults.some((d) => site.use.attributes[d.setting] === undefined)) : sites;
    return { name, kind, changes, where: whereOf(name, reached, keptBy, movedUp) };
  };

  const { changed, added, removed } = pending.components;
  return {
    tokens,
    designMdChanged: pending.designMdChanged,
    projects: following.filter((project) => !project.archived).map((project) => project.title),
    undoing: recorded.filter((change) => change.state === "refused").length,
    components: [...changed.map((n) => cardOf(n, "changed")), ...added.map((n) => cardOf(n, "added")), ...removed.map((n) => cardOf(n, "removed"))],
  };
}
