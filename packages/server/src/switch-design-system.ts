import {
  componentNameOf,
  instanceTagOf,
  instanceUsesIn,
  type ComponentDefinition,
  type DesignSystemSwitchPreview,
  type ExcludedComponent,
  type Person,
  type SwitchComponent,
  type SwitchDifference,
  type SwitchMatch,
  type VersionOrigin,
} from "@redline/shared";
import { currentDefinitions, instanceNamesByPage, projectComponents } from "./components.js";
import type { Store } from "./store.js";

/** What makes two components "the same settings": the variants and the content slots (defaults are not compared). */
const shapeOf = (definition: ComponentDefinition) =>
  JSON.stringify({
    settings: [...definition.settings].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ name: s.name, type: s.type, options: s.options ? [...s.options].sort() : undefined })),
    slots: [...definition.slots].sort(),
  });

interface Usage {
  name: string;
  instances: number;
  pages: Set<string>;
  attributes: Record<string, string>[];
}

/** The components written as instances in the non-component files of the project's active pages, in order of first use. */
function usageOf(store: Store, projectId: string): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  for (const page of store.listPages(projectId, "active")) {
    for (const [path, content] of Object.entries(store.readPageFiles(page.id)?.files ?? {})) {
      if (!path.endsWith(".html") || componentNameOf(path) !== null) continue;
      for (const use of instanceUsesIn(content)) {
        const entry = usage.get(use.name) ?? { name: use.name, instances: 0, pages: new Set<string>(), attributes: [] };
        entry.instances++;
        entry.pages.add(page.title);
        entry.attributes.push(use.attributes);
        usage.set(use.name, entry);
      }
    }
  }
  return usage;
}

function differenceOf(source: ComponentDefinition | undefined, target: ComponentDefinition, usage: Usage): SwitchDifference {
  for (const setting of target.settings) {
    if (!setting.options) continue;
    const missing = usage.attributes.map((attributes) => attributes[setting.name]).find((value) => value !== undefined && !setting.options!.includes(value));
    if (missing !== undefined) return { kind: "value", value: missing };
  }
  for (const attributes of usage.attributes) {
    const unknown = Object.keys(attributes).find((name) => source?.settings.some((s) => s.name === name) && !target.settings.some((s) => s.name === name));
    if (unknown) return { kind: "setting", name: unknown };
  }
  return { kind: "settings" };
}

/** What the switch dialog shows: each design system component the pages use, compared with the target's current diffusion. */
export function switchPreview(store: Store, projectId: string, targetId: string): DesignSystemSwitchPreview {
  const target = store.getDesignSystem(targetId)!;
  const sourceId = store.sharedDesignSystemIdOfProject(projectId);
  const source = sourceId === undefined ? undefined : store.getDesignSystem(sourceId);
  const own = new Set(projectComponents(store, projectId).definitions.map((d) => d.name));
  const sourceDefinitions = new Map(currentDefinitions(store, sourceId).map((d) => [d.name, d]));
  const targetDefinitions = new Map(currentDefinitions(store, targetId).map((d) => [d.name, d]));
  const leftOut = store.excludedComponents(projectId);
  const components: SwitchComponent[] = [];
  for (const usage of usageOf(store, projectId).values()) {
    if (own.has(usage.name) || (!sourceDefinitions.has(usage.name) && leftOut[usage.name] === undefined)) continue;
    const wanted = targetDefinitions.get(usage.name);
    const before = sourceDefinitions.get(usage.name);
    const match: SwitchMatch = !wanted ? "absent" : before && shapeOf(before) === shapeOf(wanted) ? "same" : "different";
    components.push({
      name: usage.name,
      tag: instanceTagOf(usage.name),
      instances: usage.instances,
      pages: usage.pages.size,
      page: [...usage.pages][0],
      match,
      ...(match === "different" ? { difference: differenceOf(before, wanted!, usage) } : {}),
    });
  }
  return { from: source ? { id: source.id, title: source.title } : null, to: { id: target.id, title: target.title }, components, own: [...own].map(instanceTagOf) };
}

/**
 * Points the project at `designSystem` and remembers what it left out: with a new shared design system, every used component not
 * ticked (and every absent one) stays broken in its pages, even if the new design system has the name. `ticked` defaults to the
 * pre-ticked ones. No thread is opened and the project's own components are untouched.
 */
export function switchDesignSystem(store: Store, projectId: string, designSystem: string | null, origin: VersionOrigin, person?: Person, ticked?: string[]): void {
  const previous = store.sharedDesignSystemIdOfProject(projectId);
  const target = designSystem === null ? undefined : store.getDesignSystem(designSystem) ? designSystem : undefined;
  if (target === previous) {
    store.setProjectDesignSystem(projectId, designSystem, origin, person);
    return;
  }
  const left: Record<string, string> = {};
  if (target !== undefined) {
    for (const component of switchPreview(store, projectId, target).components) {
      const taken = component.match !== "absent" && (ticked ? ticked.includes(component.tag) : component.match === "same");
      if (!taken && component.match !== "absent") left[component.name] = target;
    }
  }
  store.setProjectDesignSystem(projectId, designSystem, origin, person);
  store.setExcludedComponents(projectId, left);
}

/**
 * The components a project's pages write that `designSystem` (the one it follows by default) does not give them: the ones left out
 * by choice at a switch (stored, "non repris de"), and the ones it lacks ("absent de", not stored: they come back by themselves
 * once the design system's current diffusion has the name).
 */
export function excludedComponents(store: Store, projectId: string, designSystem = store.sharedDesignSystemIdOfProject(projectId)): ExcludedComponent[] {
  if (designSystem === undefined) return [];
  const defined = new Set(currentDefinitions(store, designSystem).map((d) => d.name));
  const own = new Set(projectComponents(store, projectId).definitions.map((d) => d.name));
  const title = store.getDesignSystem(designSystem)!.title;
  const stored = Object.entries(store.excludedComponents(projectId)).filter(([, from]) => from === designSystem).map(([name]) => name);
  const absent = [...new Set(instanceNamesByPage(store, projectId).flat())].filter((name) => !defined.has(name) && !own.has(name) && !stored.includes(name));
  return [...stored, ...absent].map((name) => ({ name, tag: instanceTagOf(name), from: title, available: defined.has(name) }));
}
