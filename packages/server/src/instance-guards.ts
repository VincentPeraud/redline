import {
  assembleComponents,
  breaksOf,
  defaultChangesOf,
  instanceUsesIn,
  type ComponentDefinition,
  type DefaultChange,
  type InstanceBreak,
  type InstanceUse,
  type UsagePlace,
} from "@redline/shared";
import { componentPages, projectComponents } from "./components.js";
import { placeText } from "./removals.js";
import type { Store } from "./store.js";

/** An instance of a design system component, written in a page of a project following the design system or in a component's template. */
export interface UseSite {
  use: InstanceUse;
  /** Absent for a component template. */
  place?: UsagePlace;
  /** The page file (artboard) writing it; absent for a component template. */
  page?: { id: string; file: string };
  /** The design system component whose template writes it. */
  template?: string;
}

/**
 * The instances written in the current version of the pages of the projects following `designSystemId` (leaving out the
 * instances of a name the project defines itself) and in the templates of `templates`.
 */
export function useSites(store: Store, designSystemId: string, templates: ComponentDefinition[]): UseSite[] {
  const sites: UseSite[] = [];
  for (const project of store.projectsUsingDesignSystem(designSystemId)) {
    const own = new Set(projectComponents(store, project.id).definitions.map((d) => d.name));
    for (const page of componentPages(store, project.id)) {
      for (const [file, content] of Object.entries(page.files)) {
        if (!file.endsWith(".html")) continue;
        for (const use of instanceUsesIn(content)) if (!own.has(use.name)) sites.push({ use, place: { project: project.title, page: page.title }, page: { id: page.id, file } });
      }
    }
  }
  for (const definition of templates) {
    for (const use of instanceUsesIn(definition.template)) sites.push({ use, template: definition.name });
  }
  return sites;
}

const siteText = (site: UseSite) => (site.place ? placeText(site.place) : `component "${site.template}"`);
const unique = (texts: string[]) => [...new Set(texts)];

function breakText(item: InstanceBreak): string {
  switch (item.kind) {
    case "component": return `component ui-${item.component}`;
    case "setting": return `setting ${item.setting} of ui-${item.component}`;
    case "value": return `${item.setting}="${item.value}" of ui-${item.component}`;
    case "slot": return `slot "${item.slot}" of ui-${item.component}`;
  }
}

interface BrokenUse {
  site: UseSite;
  breaks: InstanceBreak[];
}

function brokenUses(sites: UseSite[], before: ComponentDefinition[], after: ComponentDefinition[]): BrokenUse[] {
  return sites.flatMap((site) => {
    const breaks = breaksOf(site.use, before, after);
    return breaks.length > 0 ? [{ site, breaks }] : [];
  });
}

/** `ui-modal size="lg" is still used by page ..., component "dialog"` for each thing removed that something uses. */
function removalLines(broken: BrokenUse[], verb: string): string[] {
  const byBreak = new Map<string, { item: InstanceBreak; sites: UseSite[] }>();
  for (const { site, breaks } of broken) {
    for (const item of breaks) {
      const key = breakText(item);
      byBreak.set(key, { item, sites: [...(byBreak.get(key)?.sites ?? []), site] });
    }
  }
  return [...byBreak].map(([text, { sites }]) => `${text} ${verb} ${unique(sites.map(siteText)).join(", ")}`);
}

function defaultLine(change: DefaultChange, sites: UseSite[]): string | null {
  const omitting = sites.filter((s) => s.use.name === change.component && s.use.attributes[change.setting] === undefined);
  if (omitting.length === 0) return null;
  const pages = unique(omitting.filter((s) => s.page).map(siteText));
  const templates = unique(omitting.filter((s) => s.template !== undefined).map(siteText));
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const where = [...pages, ...templates].join(", ");
  return `default of ${change.setting} on ui-${change.component} goes from ${change.from} to ${change.to}: ${count(omitting.length, "instance")} without ${change.setting} in ${count(pages.length, "page")}${templates.length > 0 ? ` and ${count(templates.length, "component template")}` : ""} (${where})`;
}

/**
 * Error message when publishing `files` on the design system page `pageId` removes a setting, a setting value, a slot or a
 * component that an instance of a following project's page or of another component's template uses, or changes the default
 * of a setting that such instances omit; null otherwise, on a page that is not a design system's, or when the request confirms.
 */
export function instanceChangesError(store: Store, pageId: string, files: Record<string, string>, confirmed: boolean): string | null {
  const designSystem = store.designSystemOfPage(pageId);
  if (!designSystem || confirmed) return null;
  const before = projectComponents(store, designSystem.id).definitions;
  const after = assembleComponents(componentPages(store, designSystem.id, { pageId, files })).definitions;

  const sites = useSites(store, designSystem.id, after);
  const removals = removalLines(brokenUses(sites, before, after), "is still used by");
  const defaults = defaultChangesOf(before, after).flatMap((change) => defaultLine(change, sites) ?? []);
  if (removals.length === 0 && defaults.length === 0) return null;
  return `Removal refused: ${[...removals, ...defaults].join("; ")}. Ask the user; only if they agree, publish again with confirmRemovals: true.`;
}

/** Error message when going back to diffusion `target` would leave a page or a component using something that diffusion lacks, else null. */
export function rollbackInstancesError(store: Store, designSystemId: string, target: number): string | null {
  const before = store.diffusionDefinitions(designSystemId, store.currentDiffusion(designSystemId)!.number);
  const after = store.diffusionDefinitions(designSystemId, target);
  const lines = removalLines(brokenUses(useSites(store, designSystemId, before.filter((d) => after.some((a) => a.name === d.name))), before, after), "is used by");
  return lines.length === 0 ? null : `Rollback refused: ${lines.join("; ")}. Update those pages first.`;
}

/** A page that uses what the draft of a design system removes compared to its current diffusion. */
export interface BrokenPage {
  pageId: string;
  /** The first artboard of the page writing a broken instance. */
  artboard: string;
  breaks: string[];
}

/** The pages whose instances break when the draft of the design system becomes its next diffusion. */
export function brokenPagesAtDiffusion(store: Store, designSystemId: string): BrokenPage[] {
  const before = store.diffusionDefinitions(designSystemId, store.currentDiffusion(designSystemId)!.number);
  const after = projectComponents(store, designSystemId).definitions;
  const pages = new Map<string, BrokenPage>();
  for (const { site, breaks } of brokenUses(useSites(store, designSystemId, []), before, after)) {
    const { id, file } = site.page!;
    const page = pages.get(id) ?? { pageId: id, artboard: "", breaks: [] };
    if (page.artboard === "" && store.hasArtboard(id, file)) page.artboard = file;
    for (const text of breaks.map(breakText)) if (!page.breaks.includes(text)) page.breaks.push(text);
    pages.set(id, page);
  }
  return [...pages.values()].filter((page) => page.artboard !== "");
}
