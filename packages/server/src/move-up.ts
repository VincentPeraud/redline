import {
  ASSETS_DIR,
  componentNameOf,
  defaultManifest,
  MANIFEST_PATH,
  manifestWithoutArtboard,
  parseManifest,
  type ManifestArtboard,
} from "@redline/shared";
import { componentFilesOf, projectComponents, versionComponentsError } from "./components.js";
import type { OriginRef, Store } from "./store.js";

const ASSET_REFERENCE = /\bassets\/([A-Za-z0-9._\/-]+)/g;
const COMPONENT_GAP = 100;

/** Project assets the given component files reference, by asset name. */
export function assetsUsedBy(store: Store, projectId: string, components: Record<string, string>): Record<string, Buffer> {
  const assets: Record<string, Buffer> = {};
  for (const content of Object.values(components)) {
    for (const [, name] of content.matchAll(ASSET_REFERENCE)) {
      const asset = store.readProjectFile(projectId, `${ASSETS_DIR}/${name}`);
      if (asset) assets[name] = asset;
    }
  }
  return assets;
}

/**
 * Removes the component files of the project's active pages (an archived page is read-only), one user version per page: all of them,
 * or only the named components. The manifests lose their artboards, tweaks and links.
 */
export function removeComponentCopies(store: Store, projectId: string, ref?: OriginRef, names?: string[]): void {
  const isRemoved = (path: string) => {
    const name = componentNameOf(path);
    return name !== null && (names === undefined || names.includes(name));
  };
  for (const page of store.listPages(projectId, "active")) {
    const files = store.readPageFiles(page.id)?.files ?? {};
    const removed = Object.keys(files).filter(isRemoved);
    if (removed.length === 0) continue;
    const kept = Object.fromEntries(Object.entries(files).filter(([path]) => !removed.includes(path)));
    if (kept[MANIFEST_PATH] !== undefined) {
      // Raw document on purpose: `manifestWithoutArtboard` works on the stored JSON (the parsed form turns `below`/`rightOf` into `anchor`).
      let manifest = JSON.parse(kept[MANIFEST_PATH]) as { artboards?: { file: string }[]; elements?: Record<string, unknown>[]; tweaks?: { artboard?: string }[]; links?: { from: string; to: string }[] };
      for (const file of removed) manifest = manifestWithoutArtboard(manifest, file);
      if (manifest.tweaks) manifest.tweaks = manifest.tweaks.filter((t) => t.artboard === undefined || !removed.includes(t.artboard));
      if (manifest.links) manifest.links = manifest.links.filter((l) => !removed.includes(l.from) && !removed.includes(l.to));
      kept[MANIFEST_PATH] = `${JSON.stringify(manifest, null, 2)}\n`;
    }
    store.addVersion(page.id, kept, "Components moved to the design system", "user", ref);
  }
}

export type MoveResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

const refused = (status: 400 | 404 | 409, error: string): MoveResult => ({ ok: false, status, error });

const manifestOfFiles = (files: Record<string, string>) => (files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]));

/**
 * "Remonter": copies the project's component (file, artboard entry, tweaks, assets) into the draft of a design system page as a
 * request-free change, and marks it moved up. The project keeps using its own copy until a diffusion contains the name (`settleMovedUp`).
 */
export function moveUpComponent(store: Store, projectId: string, name: string, pageId: unknown, ref?: OriginRef): MoveResult {
  const designSystemId = store.sharedDesignSystemIdOfProject(projectId);
  if (designSystemId === undefined) return refused(409, "the project does not follow a shared design system");
  const component = projectComponents(store, projectId).components.find((c) => c.name === name);
  if (!component) return refused(404, "component not found in the project");
  const target = typeof pageId === "string" ? store.getPage(pageId) : undefined;
  if (!target || target.projectId !== designSystemId) return refused(400, "pageId must be a page of the project's design system");
  if (projectComponents(store, designSystemId).components.some((c) => c.name === name)) return refused(409, `the design system already has a component named ${name}`);

  const projectTitle = store.getProject(projectId)!.title;
  const content = componentFilesOf(store, projectId)[component.file]!;
  const source = manifestOfFiles(store.readPageFiles(component.page.id)?.files ?? {});
  const sourceArtboard = source.artboards.find((a) => a.file === component.file);
  const files = store.readPageFiles(target.id)?.files ?? {};
  const manifest = manifestOfFiles(files);
  const below = manifest.artboards.length === 0 ? 0 : Math.max(...manifest.artboards.map((a) => a.y + a.height)) + COMPONENT_GAP;
  const artboard: ManifestArtboard = { ...(sourceArtboard ?? { width: 320, height: 240 }), file: component.file, x: 0, y: below };
  manifest.artboards.push(artboard);
  manifest.tweaks.push(...source.tweaks.filter((t) => t.artboard === component.file));

  const after = { ...files, [component.file]: content, [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n` };
  const invalid = versionComponentsError(store, target.id, after);
  if (invalid) return refused(400, invalid);

  for (const [asset, bytes] of Object.entries(assetsUsedBy(store, projectId, { [component.file]: content }))) store.setProjectFile(designSystemId, `${ASSETS_DIR}/${asset}`, bytes);
  const version = store.addVersion(target.id, after, `Component ${name} moved up from ${projectTitle}`, "user", ref);
  store.recordChanges(designSystemId, version.id, [{ component: name, label: `Composant remonté depuis ${projectTitle}`, kind: "added" }]);
  store.setMovedUpComponents(projectId, { ...store.movedUpComponents(projectId), [name]: { designSystemId } });
  return { ok: true };
}

/** "Passer à celui du design system": deletes the project's component whose name the design system diffuses; its tags show the design system's. */
export function useDesignSystemComponent(store: Store, projectId: string, name: string, ref?: OriginRef): MoveResult {
  const designSystemId = store.sharedDesignSystemIdOfProject(projectId);
  const current = designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId);
  if (!projectComponents(store, projectId).components.some((c) => c.name === name)) return refused(404, "component not found in the project");
  const shared = designSystemId !== undefined && current !== undefined && Object.keys(store.diffusionComponentFiles(designSystemId, current.number)).some((path) => componentNameOf(path) === name);
  if (!shared) return refused(409, `the design system has no component named ${name}`);
  removeComponentCopies(store, projectId, ref, [name]);
  const { [name]: _gone, ...rest } = store.movedUpComponents(projectId);
  store.setMovedUpComponents(projectId, rest);
  return { ok: true };
}

/** After a diffusion: the projects that moved a component up lose their copy once the design system diffuses that name. */
export function settleMovedUp(store: Store, designSystemId: string): void {
  const current = store.currentDiffusion(designSystemId);
  if (!current) return;
  const diffused = new Set(Object.keys(store.diffusionComponentFiles(designSystemId, current.number)).map((path) => componentNameOf(path)));
  for (const project of store.projectsUsingDesignSystem(designSystemId)) {
    const moved = store.movedUpComponents(project.id);
    const settled = Object.entries(moved).filter(([name, mark]) => mark.designSystemId === designSystemId && diffused.has(name)).map(([name]) => name);
    if (settled.length === 0) continue;
    removeComponentCopies(store, project.id, undefined, settled);
    store.setMovedUpComponents(project.id, Object.fromEntries(Object.entries(moved).filter(([name]) => !settled.includes(name))));
  }
}
