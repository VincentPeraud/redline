import {
  PROJECT_STYLE_PATH,
  breaksOf,
  instanceTagOf,
  instanceUsesIn,
  parseTokens,
  type BrokenElement,
  type BrokenPage,
  type InstanceBreak,
} from "@redline/shared";
import { projectComponentNames } from "./components.js";
import { currentDiffusionOf, draftOf, type DesignSystemView } from "./design-system-view.js";
import { pageArtboards } from "./page-artboards.js";
import { referencesToken } from "./removals.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { modelChoiceOf } from "./validation.js";
import { dispatchReply, dispatchThread } from "./work.js";

const elementOf = (item: InstanceBreak): Omit<BrokenElement, "places"> => {
  const name = instanceTagOf(item.component);
  switch (item.kind) {
    case "component": return { kind: "component", name, blocksPublishing: true };
    case "setting": return { kind: "setting", name, setting: item.setting, blocksPublishing: true };
    case "value": return { kind: "value", name, setting: item.setting, value: item.value, blocksPublishing: true };
    case "slot": return { kind: "slot", name, slot: item.slot, blocksPublishing: true };
  }
};

const keyOf = (element: Omit<BrokenElement, "places">) => [element.kind, element.name, element.setting, element.value, element.slot].join("\u0000");

/** The tokens of `to` with this value that `from` lacks: the new name of a token that disappeared, when there is exactly one. */
function renamedTo(value: string, from: Set<string>, to: ReturnType<typeof parseTokens>): string | undefined {
  const candidates = to.filter((t) => !from.has(t.name) && t.value === value);
  return candidates.length === 1 ? candidates[0].name : undefined;
}

/**
 * The pages of a project that use something `from` offers and `to` does not: a component, a setting, a setting value or a slot
 * (these refuse publishing) or a token (the page renders without it). Only the pages' artboards are read, and what the project
 * defines itself (components of its own, tokens of its project style) is never broken. Pages and artboards keep their order.
 * `only` narrows it to one page, and to some of its artboards (files) when listed: what a restore just put back.
 */
export function brokenPagesBetween(store: Store, projectId: string, from: DesignSystemView, to: DesignSystemView, only?: { pageId: string; artboards?: string[] }): BrokenPage[] {
  const fromDefinitions = from.definitions();
  const toDefinitions = to.definitions();
  const own = projectComponentNames(store, projectId);
  const projectTokens = new Set(parseTokens(store.readProjectText(projectId, PROJECT_STYLE_PATH)).map((t) => t.name));
  const fromTokens = parseTokens(from.tokensCss());
  const toTokens = parseTokens(to.tokensCss());
  const toNames = new Set(toTokens.map((t) => t.name));
  const fromNames = new Set(fromTokens.map((t) => t.name));
  const lostTokens = fromTokens.filter((t) => !toNames.has(t.name) && !projectTokens.has(t.name));

  const pages: BrokenPage[] = [];
  for (const page of store.listPages(projectId)) {
    if (only && only.pageId !== page.id) continue;
    const elements = new Map<string, BrokenElement>();
    let artboard = "";
    for (const { file, place, content } of pageArtboards(store.readPageFiles(page.id)?.files ?? {})) {
      if (only?.artboards && !only.artboards.includes(file)) continue;
      const note = (element: Omit<BrokenElement, "places">, instances?: number) => {
        const key = keyOf(element);
        const known = elements.get(key) ?? { ...element, places: [] };
        const at = known.places.find((p) => p.artboard === place);
        if (!at) known.places.push({ artboard: place, ...(instances !== undefined && { instances }) });
        else if (instances !== undefined) at.instances = (at.instances ?? 0) + instances;
        elements.set(key, known);
        if (artboard === "") artboard = file;
      };
      for (const use of instanceUsesIn(content)) {
        if (own.has(use.name)) continue;
        for (const item of breaksOf(use, fromDefinitions, toDefinitions)) note(elementOf(item), 1);
      }
      for (const token of lostTokens) {
        if (referencesToken(content, token.name)) {
          const renamed = renamedTo(token.value, fromNames, toTokens);
          note({ kind: "token", name: token.name, ...(renamed && { renamedTo: renamed }), blocksPublishing: false });
        }
      }
    }
    if (elements.size > 0) pages.push({ pageId: page.id, title: page.title, artboard, elements: [...elements.values()] });
  }
  return pages;
}

/**
 * The pages that break when the project switches to following the draft (`followsDraft` true: the diffusion's elements are
 * compared with the draft's) or back to the latest diffusion (false). Empty without a shared design system.
 */
export function brokenPagesOnFollowChange(store: Store, projectId: string, followsDraft: boolean): BrokenPage[] {
  const designSystemId = store.sharedDesignSystemIdOfProject(projectId);
  const diffusion = designSystemId === undefined ? undefined : currentDiffusionOf(store, designSystemId);
  const draft = designSystemId === undefined ? undefined : draftOf(store, designSystemId);
  if (!diffusion || !draft) return [];
  return followsDraft ? brokenPagesBetween(store, projectId, diffusion, draft) : brokenPagesBetween(store, projectId, draft, diffusion);
}

/** One broken element in words, for the body of a thread. */
export function brokenElementText(element: BrokenElement): string {
  switch (element.kind) {
    case "component": return `le composant ${element.name}`;
    case "setting": return `le réglage « ${element.setting} » de ${element.name}`;
    case "value": return `la valeur ${element.setting}="${element.value}" de ${element.name}`;
    case "slot": return `l'emplacement « ${element.slot} » de ${element.name}`;
    case "token": return `la variable ${element.name}${element.renamedTo ? ` (renommée ${element.renamedTo})` : ""}`;
  }
}

/** Whether the body of a thread written by `openBrokenPageThreads` words this element, whole (`ui-button` is not `ui-button-group`). */
const wordsElement = (body: string, element: BrokenElement): boolean => {
  const text = brokenElementText(element);
  for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + 1)) {
    const next = body[at + text.length];
    if (next === "," || next === ".") return true;
  }
  return false;
};

/** Whether an open thread, signed Redline, with this title already names every broken element. */
function openThreadFor(store: Store, pageId: string, title: string, elements: BrokenElement[]) {
  return store.listThreads(pageId).find((thread) => thread.automatic === true && thread.status === "open" && thread.title === title && elements.every((element) => wordsElement(thread.body, element)));
}

/**
 * Opens, on each broken page, a thread signed Redline that lists its broken elements, routed like any thread.
 * With `replyIn` (a title), a page that already has an open thread of that title for the same elements gets a reply in it instead.
 */
export function openBrokenPageThreads(store: Store, lock: PageLock, pages: BrokenPage[], title: string, intro: string, replyIn?: string): void {
  for (const { pageId, artboard, elements } of pages) {
    const body = `${intro} : ${elements.map(brokenElementText).join(", ")}. Mets à jour la page en conséquence.`;
    const projectId = store.getPage(pageId)!.projectId;
    const open = replyIn === undefined ? undefined : openThreadFor(store, pageId, replyIn, elements);
    if (open) {
      store.addReply(open.id, body, "redline");
      dispatchReply(store, lock, projectId, open, body, modelChoiceOf({}), "Redline");
      continue;
    }
    const thread = store.createThread(pageId, { target: { kind: "artboard", artboard }, title, body }, undefined, true);
    dispatchThread(store, lock, projectId, thread, modelChoiceOf({}));
  }
}
