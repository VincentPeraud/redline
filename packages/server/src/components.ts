import { assembleComponents, componentNameOf, INSTANCE_TAG_PREFIX, MANIFEST_PATH, parseManifest, type ComponentAssembly, type ComponentDefinition, type ComponentPage } from "@redline/shared";
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

/** Error message when publishing `files` on `pageId` would define a component name twice in its project, else null. */
export function versionComponentsError(store: Store, pageId: string, files: Record<string, string>): string | null {
  const page = store.getPage(pageId)!;
  const assembly = assembleComponents(componentPages(store, page.projectId, { pageId, files }));
  if (assembly.duplicates[0]) return assembly.duplicates[0];
  const designSystemId = store.sharedDesignSystemIdForManifest(pageId, files[MANIFEST_PATH]);
  return instanceUsageError(files, store.isDesignSystemPage(pageId) ? [] : designSystemDefinitions(store, designSystemId), assembly.definitions);
}

/** Error message when a new page with `files` would define a component name twice in the project, else null. */
export function newPageComponentsError(store: Store, projectId: string, title: string, files: Record<string, string>): string | null {
  const assembly = assembleComponents([...componentPages(store, projectId), { id: "", title, files }]);
  if (assembly.duplicates[0]) return assembly.duplicates[0];
  return instanceUsageError(files, designSystemDefinitions(store, designSystemOfNewPage(store, projectId, files[MANIFEST_PATH])), assembly.definitions);
}

/** Definitions of the current diffusion of a design system, none when there is no shared one. */
function designSystemDefinitions(store: Store, designSystemId: string | undefined): ComponentDefinition[] {
  const current = designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId);
  return designSystemId === undefined || !current ? [] : store.diffusionDefinitions(designSystemId, current.number);
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
 * page, whose `assembled` definitions are the draft), `assembled` those of the project's pages, which win on a name clash.
 */
function instanceUsageError(files: Record<string, string>, designSystem: ComponentDefinition[], assembled: ComponentDefinition[]): string | null {
  const definitions = new Map<string, ComponentDefinition>();
  for (const definition of [...designSystem, ...assembled]) definitions.set(definition.tag, definition);
  const tags = [...definitions.keys()].sort();
  const available = tags.length === 0 ? "no component exists" : `available tags: ${tags.map((t) => `<${t}>`).join(", ")}`;
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".html") || componentNameOf(path) !== null) continue;
    const open: string[] = [];
    for (const [, closing, tag, attributes] of withoutOpaqueBlocks(content).matchAll(TAG)) {
      const name = tag.toLowerCase();
      if (closing) {
        const index = open.lastIndexOf(name);
        if (index >= 0) open.length = index;
        continue;
      }
      const attribute = (wanted: string) => attributeOf(attributes, wanted);
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
      if (!VOID_ELEMENTS.has(name) && !attributes.endsWith("/")) open.push(name);
    }
  }
  return null;
}
