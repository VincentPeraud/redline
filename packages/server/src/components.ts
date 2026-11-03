import { assembleComponents, componentClassesOf, componentNameOf, DS_FREE_ATTRIBUTE, instanceTagOf, INSTANCE_TAG_PREFIX, MANIFEST_PATH, parseManifest, type ComponentAssembly, type ComponentDefinition, type ComponentPage } from "@redline/shared";
import type { Store } from "./store.js";

/** The pages of a project (a design system is one) as the component assembly takes them, `replacing` the files of one page. */
export function componentPages(store: Store, projectId: string, replacing?: { pageId: string; files: Record<string, string> }): ComponentPage[] {
  return store.listPages(projectId).map((page) => ({
    id: page.id,
    title: page.title,
    files: replacing?.pageId === page.id ? replacing.files : (store.readPageFiles(page.id)?.files ?? {}),
  }));
}

/** Components assembled from the current pages of a project or design system. */
export function projectComponents(store: Store, projectId: string): ComponentAssembly {
  return assembleComponents(componentPages(store, projectId));
}

/** The component files (`components/<name>.html`) of the pages of a project or design system, by path. */
export function componentFilesOf(store: Store, projectId: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const page of componentPages(store, projectId)) {
    for (const [path, content] of Object.entries(page.files)) if (componentNameOf(path) !== null) files[path] = content;
  }
  return files;
}

const componentsError = (assembly: ComponentAssembly) => assembly.duplicates[0] ?? assembly.cycles[0] ?? null;

/** Error message when publishing `files` on `pageId` would define a component name twice in its project or make components contain each other in a loop, else null. */
export function versionComponentsError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const page = store.getPage(pageId)!;
  const assembly = assembleComponents(componentPages(store, page.projectId, { pageId, files }));
  const invalid = componentsError(assembly);
  if (invalid) return invalid;
  const designSystemId = store.sharedDesignSystemIdForManifest(pageId, files[MANIFEST_PATH]);
  if (store.isDesignSystemPage(pageId)) return instanceUsageError(files, [], assembly.definitions, new Map());
  const pagesAfter = componentPages(store, page.projectId, { pageId, files });
  const taken = takenNameError(store, designSystemId, componentPages(store, page.projectId), pagesAfter);
  if (taken) return taken;
  const classes = classesByTag(store, designSystemId, pagesAfter);
  return instanceUsageError(files, designSystemDefinitions(store, designSystemId), assembly.definitions, classes);
}

/** Error message when a new page with `files` would define a component name twice in the project, else null. */
export function newPageComponentsError(store: Store, projectId: string, title: string, files: Record<string, string>): string | null {
  const assembly = assembleComponents([...componentPages(store, projectId), { id: "", title, files }]);
  const invalid = componentsError(assembly);
  if (invalid) return invalid;
  const designSystemId = designSystemOfNewPage(store, projectId, files[MANIFEST_PATH]);
  const pagesAfter = [...componentPages(store, projectId), { id: "", title, files }];
  const taken = takenNameError(store, designSystemId, componentPages(store, projectId), pagesAfter);
  if (taken) return taken;
  const classes = classesByTag(store, designSystemId, pagesAfter);
  return instanceUsageError(files, designSystemDefinitions(store, designSystemId), assembly.definitions, classes);
}

const contentsByName = (pages: ComponentPage[]) =>
  new Map(
    pages.flatMap((page) =>
      Object.entries(page.files).flatMap(([path, content]) => {
        const name = componentNameOf(path);
        return name === null ? [] : [[name, content] as const];
      }),
    ),
  );

/**
 * Error message when a project component takes the name of a component of its design system's current diffusion, else null. A component
 * the project already had, unchanged, is left alone (the design system added the name later and the project keeps its own); touching it is refused.
 */
function takenNameError(store: Store, designSystemId: string | undefined, before: ComponentPage[], after: ComponentPage[]): string | null {
  const current = designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId);
  if (designSystemId === undefined || !current) return null;
  const shared = new Set(Object.keys(store.diffusionComponentFiles(designSystemId, current.number)).map((path) => componentNameOf(path)));
  const previous = contentsByName(before);
  for (const [name, content] of contentsByName(after)) {
    if (shared.has(name) && previous.get(name) !== content) {
      return `Component "${name}" already exists in the design system: use <${instanceTagOf(name)}>, or ask the user for a new setting or slot. A project component cannot take the name of a design system component.`;
    }
  }
  return null;
}

/** Definitions of the current diffusion of a design system, none when there is no shared one. */
function designSystemDefinitions(store: Store, designSystemId: string | undefined): ComponentDefinition[] {
  const current = designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId);
  return designSystemId === undefined || !current ? [] : store.diffusionDefinitions(designSystemId, current.number);
}

/** The class names each component defines, by tag; a project component wins over a design system one of the same name. */
function classesByTag(store: Store, designSystemId: string | undefined, projectPages: ComponentPage[]): Map<string, string[]> {
  const current = designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId);
  const shared = designSystemId === undefined || !current ? {} : store.diffusionComponentFiles(designSystemId, current.number);
  const classes = new Map<string, string[]>();
  const files = [...Object.entries(shared), ...projectPages.flatMap((page) => Object.entries(page.files))];
  for (const [path, content] of files) {
    const name = componentNameOf(path);
    if (name !== null) classes.set(instanceTagOf(name), componentClassesOf(content));
  }
  return classes;
}

function designSystemOfNewPage(store: Store, projectId: string, manifestText: string | undefined): string | undefined {
  try {
    const named = manifestText === undefined ? undefined : parseManifest(manifestText).designSystem;
    if (named !== undefined && store.getDesignSystem(named)) return named;
  } catch {
    // An invalid manifest is refused by its own check.
  }
  return store.sharedDesignSystemIdOfProject(projectId);
}

const TAG = /<(\/?)([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The page without comments, scripts and styles, whose text could look like tags. */
const withoutOpaqueBlocks = (html: string) => html.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");

/** Value of an attribute in the text of a start tag, null when absent (an attribute without value is ""). */
function attributeOf(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=\\s|/|$)`, "i").exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

const slotText = (slot: string) => (slot === "" ? "(default)" : slot);

/**
 * Error message when an HTML file of `files` uses a `ui-` tag no component defines, a value a choice setting does not offer, or a slot
 * the component lacks; it lists what exists. `designSystem` are the definitions of the current diffusion (none on a design system's own
 * page, whose `assembled` definitions are the draft), `assembled` those of the project's pages, which win on a name clash. It also
 * refuses the classes of a component with a template used outside an instance (`classesOf`, by tag), except inside `data-ds-libre`.
 */
function instanceUsageError(files: Record<string, string>, designSystem: ComponentDefinition[], assembled: ComponentDefinition[], classesOf: Map<string, string[]>): string | null {
  const definitions = new Map<string, ComponentDefinition>();
  for (const definition of [...designSystem, ...assembled]) definitions.set(definition.tag, definition);
  const tags = [...definitions.keys()].sort();
  const available = tags.length === 0 ? "no component exists" : `available tags: ${tags.map((t) => `<${t}>`).join(", ")}`;
  const ownerOfClass = new Map<string, ComponentDefinition>();
  for (const [tag, classes] of classesOf) {
    const definition = definitions.get(tag);
    if (definition) for (const name of classes) ownerOfClass.set(name, definition);
  }
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".html") || componentNameOf(path) !== null) continue;
    const open: string[] = [];
    let freeAt: number | null = null;
    for (const [, closing, tag, attributes] of withoutOpaqueBlocks(content).matchAll(TAG)) {
      const name = tag.toLowerCase();
      if (closing) {
        const index = open.lastIndexOf(name);
        if (index >= 0) open.length = index;
        if (freeAt !== null && open.length <= freeAt) freeAt = null;
        continue;
      }
      const attribute = (wanted: string) => attributeOf(attributes, wanted);
      const free = freeAt !== null || attribute(DS_FREE_ATTRIBUTE) !== null;
      const copied = free ? undefined : (attribute("class") ?? "").split(/\s+/).map((name) => [name, ownerOfClass.get(name)] as const).find(([, owner]) => owner);
      if (copied?.[1]) {
        const settings = copied[1].settings.map((s) => s.name);
        return `${path}: class "${copied[0]}" belongs to <${copied[1].tag}>, so its markup must not be copied. Use <${copied[1].tag}> instead (${settings.length === 0 ? "no settings" : `settings: ${settings.join(", ")}`}), or ask the user for a new setting.`;
      }
      if (name.startsWith(INSTANCE_TAG_PREFIX)) {
        const definition = definitions.get(name);
        if (!definition) return `${path}: <${name}> is not a component (${available}). Use one of them, or ask the user for a new component.`;
        for (const setting of definition.settings) {
          const value = attribute(setting.name);
          if (setting.type === "choice" && setting.options && value !== null && !setting.options.includes(value))
            return `${path}: <${name}> has no ${setting.name}="${value}" (${setting.name} values: ${setting.options.join(", ")}). Use one of them, or ask the user for a new value.`;
        }
      }
      const slot = attribute("slot");
      const owner = slot !== null && open.length > 0 ? definitions.get(open[open.length - 1]) : undefined;
      if (owner && slot !== null && !owner.slots.includes(slot))
        return `${path}: <${owner.tag}> has no slot="${slot}" (slots: ${owner.slots.map(slotText).join(", ")}). Use one of them, or ask the user for a new slot.`;
      if (!VOID_ELEMENTS.has(name) && !attributes.endsWith("/")) {
        open.push(name);
        if (freeAt === null && free) freeAt = open.length - 1;
      }
    }
  }
  return null;
}
