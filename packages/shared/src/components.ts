// Components (lot E, ticket 07). A component is an artboard file `components/<name>.html` of any page of a design
// system or of a project; this pure module assembles them.

import { MANIFEST_PATH, parseManifest, type Manifest, type ManifestTweak } from "./index.js";
import { componentDefinitionOf, instanceTagOf, type ComponentDefinition } from "./componentDefinition.js";
import { groupTitlesOf, readingOrder } from "./readingOrder.js";

export const COMPONENTS_DIR = "components";

export const COMPONENTS_CSS_PATH = "components.css";

/** Path on the artboard origin serving a design system's assembled components, live. */
export const designSystemComponentsUrlPath = (designSystemId: string) => `/design-systems/${encodeURIComponent(designSystemId)}/${COMPONENTS_CSS_PATH}`;

/** Path on the artboard origin serving a project's assembled components, live. */
export const projectComponentsUrlPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/${COMPONENTS_CSS_PATH}`;

const COMPONENT_FILE = /^components\/([a-z0-9-]+)\.html$/;

/** Name of the component an artboard file is (its file name), null when the file is not a component. */
export function componentNameOf(file: string): string | null {
  return COMPONENT_FILE.exec(file)?.[1] ?? null;
}

/** A page with its files, as the assembly takes it. */
export interface ComponentPage {
  id: string;
  title: string;
  files: Record<string, string>;
}

export interface ComponentInfo {
  name: string;
  file: string;
  page: { id: string; title: string };
  /** Group title the component falls under on its page; a sub-family of the page. */
  groupTitle: string | null;
  description: string;
  usage: string;
  /** The tweaks declared for the component's artboard. */
  variants: ManifestTweak[];
  hash: string;
}

export interface ComponentAssembly {
  /** Style blocks of every component, page then reading order. */
  css: string;
  /** Page then reading order. */
  components: ComponentInfo[];
  /** What instances render from, one per component that has a `<template data-component>`. */
  definitions: ComponentDefinition[];
  /** Index text given to sessions, per page id. */
  indexes: Record<string, string>;
  /** One message per component name defined twice, naming both files. */
  duplicates: string[];
  /** One message per cycle of components containing each other, naming it ("Components form a cycle: ui-a > ui-b > ui-a"). */
  cycles: string[];
}

function cyclesOf(definitions: ComponentDefinition[]): string[] {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const cycles: string[] = [];
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    const at = path.indexOf(name);
    if (at !== -1) {
      cycles.push(`Components form a cycle: ${[...path.slice(at), name].map(instanceTagOf).join(" > ")}`);
      return;
    }
    if (done.has(name)) return;
    for (const inner of byName.get(name)?.contains ?? []) if (byName.has(inner)) visit(inner, [...path, name]);
    done.add(name);
  };
  for (const definition of definitions) visit(definition.name, []);
  return cycles;
}

function hashOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

const unescapeHtml = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function descriptionOf(html: string): string {
  for (const [meta] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']description["']/i.test(meta)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(meta);
    return unescapeHtml((content?.[1] ?? content?.[2] ?? "").trim());
  }
  return "";
}

const usageOf = (html: string) => /<template\b[^>]*\bdata-usage\b[^>]*>([\s\S]*?)<\/template>/i.exec(html)?.[1].trim() ?? "";

const STYLE_BLOCK = /<style\b[^>]*\bdata-component\b[^>]*>([\s\S]*?)<\/style>/gi;

const styleBlocksOf = (html: string) => [...html.matchAll(STYLE_BLOCK)].map((match) => match[1].trim());

/** The HTML without its `<style data-component>` blocks (the component's own css). */
export const withoutComponentStyles = (html: string) => html.replace(STYLE_BLOCK, "");

/** Class names a component defines: the class selectors of its `<style data-component>` blocks. */
export function componentClassesOf(html: string): string[] {
  const classes = new Set<string>();
  for (const block of styleBlocksOf(html)) {
    // Only selectors (what precedes a `{`), not declarations: `0.5em` or `url(a.png)` are not classes.
    for (const [, prelude] of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
      if (prelude.trim().startsWith("@")) continue;
      for (const [, name] of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(name);
    }
  }
  return [...classes];
}

/** Class names an HTML document puts in `class` attributes. */
export function classesUsedIn(html: string): Set<string> {
  const used = new Set<string>();
  for (const [, double, single] of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const name of (double ?? single ?? "").split(/\s+/)) if (name) used.add(name);
  }
  return used;
}

function manifestOf(page: ComponentPage): Manifest {
  const text = page.files[MANIFEST_PATH];
  try {
    if (text !== undefined) return parseManifest(text);
  } catch {
    // A stored manifest that no longer parses must not break serving components.
  }
  return { artboards: [], elements: [], links: [], tweaks: [] };
}

function pageComponents(page: ComponentPage): ComponentInfo[] {
  const manifest = manifestOf(page);
  const ordered = readingOrder(manifest.artboards, groupTitlesOf(manifest)).map((a) => ({ file: a.file, groupTitle: a.groupTitle }));
  const laidOut = new Set(ordered.map((a) => a.file));
  const unplaced = Object.keys(page.files)
    .filter((file) => !laidOut.has(file))
    .sort()
    .map((file) => ({ file, groupTitle: null }));
  return [...ordered, ...unplaced].flatMap(({ file, groupTitle }) => {
    const name = componentNameOf(file);
    const html = page.files[file];
    if (name === null || html === undefined) return [];
    const variants = manifest.tweaks.filter((tweak) => tweak.artboard === file);
    return [
      {
        name,
        file,
        page: { id: page.id, title: page.title },
        groupTitle,
        description: descriptionOf(html),
        usage: usageOf(html),
        variants,
        hash: hashOf(variants.length > 0 ? `${html}\n${JSON.stringify(variants)}` : html),
      },
    ];
  });
}

const variantLine = (tweak: ManifestTweak) => `${tweak.id} (${tweak.label}${tweak.type === "choice" && tweak.options ? `: ${tweak.options.join(", ")}` : ""})`;

function indexText(components: ComponentInfo[]): string {
  const sections: string[] = [];
  const groups: (string | null)[] = [];
  for (const component of components) if (!groups.includes(component.groupTitle)) groups.push(component.groupTitle);
  for (const group of groups) {
    const lines = group === null ? [] : [`## ${group}`];
    for (const component of components.filter((c) => c.groupTitle === group)) {
      lines.push(`- ${component.name}${component.description ? `: ${component.description}` : ""}`);
      if (component.usage) lines.push(`  usage: ${component.usage}`);
      if (component.variants.length > 0) lines.push(`  variants: ${component.variants.map(variantLine).join(", ")}`);
    }
    sections.push(lines.join("\n") + "\n");
  }
  return sections.join("\n");
}

/** Definitions of the components that have a template, in the order of `components`; the first of a duplicated name wins. */
export function definitionsOf(components: ComponentInfo[], fileOf: (component: ComponentInfo) => string): ComponentDefinition[] {
  const definitions = new Map<string, ComponentDefinition>();
  for (const component of components) {
    const definition = definitions.has(component.name) ? null : componentDefinitionOf(component.name, fileOf(component), component.variants);
    if (definition) definitions.set(component.name, definition);
  }
  return [...definitions.values()];
}

/** Assembles the components of the pages of one design system or one project, pages given in their order. */
export function assembleComponents(pages: ComponentPage[]): ComponentAssembly {
  const perPage = pages.map((page) => ({ page, components: pageComponents(page) }));
  const components = perPage.flatMap((entry) => entry.components);
  const css = components
    .flatMap((component) => styleBlocksOf(pages.find((p) => p.id === component.page.id)!.files[component.file]))
    .map((block) => `${block}\n`)
    .join("");
  const duplicates: string[] = [];
  const seen = new Map<string, ComponentInfo>();
  for (const component of components) {
    const first = seen.get(component.name);
    if (first) {
      duplicates.push(`Component "${component.name}" is defined twice: ${first.file} of page "${first.page.title}" and ${component.file} of page "${component.page.title}"`);
    } else {
      seen.set(component.name, component);
    }
  }
  const indexes = Object.fromEntries(perPage.map(({ page, components: own }) => [page.id, indexText(own)]));
  const definitions = definitionsOf(components, (component) => pages.find((p) => p.id === component.page.id)!.files[component.file]);
  return { css, components, definitions, indexes, duplicates, cycles: cyclesOf(definitions) };
}
