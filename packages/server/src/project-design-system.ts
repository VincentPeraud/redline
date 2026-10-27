import type { FastifyInstance } from "fastify";
import {
  ASSETS_DIR,
  CORE_TOKENS,
  DESIGN_SYSTEM_TOKENS_PATH,
  MANIFEST_PATH,
  manifestWithoutArtboard,
  NEUTRAL_TOKENS_PAGE_HTML,
  PROJECT_STYLE_PATH,
  componentNameOf,
  defaultManifest,
  parseManifest,
  parseTokens,
  removeToken,
  setToken,
  tokenValueError,
  type ManifestArtboard,
  type ManifestTitleElement,
  type ManifestTweak,
  type ProjectComponentInfo,
  type ProjectDesignSystem,
  type ProjectStyleToken,
  type PromoteProjectStyleRequest,
  type SetProjectTokenRequest,
  type SetProjectDesignSystemRequest,
} from "@redline/shared";
import { componentFilesOf, projectComponents } from "./components.js";
import type { Store } from "./store.js";
import { titleError } from "./validation.js";

const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/** The project's Design system page: tokens against the current diffusion, project components, counts. */
export function projectDesignSystem(store: Store, projectId: string): ProjectDesignSystem {
  const project = store.getProject(projectId)!;
  const shared = project.designSystem === null ? undefined : store.getDesignSystem(project.designSystem);
  const diffusion = shared ? store.currentDiffusion(shared.id) : undefined;
  const designSystemTokens = new Map(
    parseTokens(shared && diffusion ? (store.readDiffusionFile(shared.id, diffusion.number, "tokens.css") ?? "") : "").map((t) => [t.name, t]),
  );
  const projectTokens = parseTokens(store.readProjectText(projectId, PROJECT_STYLE_PATH));
  const projectValues = new Map(projectTokens.map((t) => [t.name, t]));
  const names = [...designSystemTokens.keys(), ...projectTokens.map((t) => t.name).filter((name) => !designSystemTokens.has(name))];

  const tokens = names.map((name): ProjectStyleToken => {
    const fromDesignSystem = designSystemTokens.get(name);
    const fromProject = projectValues.get(name);
    const value = fromProject?.value ?? fromDesignSystem!.value;
    const deprecatedFor = (fromProject ?? fromDesignSystem)?.deprecatedFor;
    return {
      name,
      designSystemValue: fromDesignSystem?.value ?? null,
      projectValue: fromProject?.value ?? null,
      value,
      isColor: (fromProject ?? fromDesignSystem)!.isColor,
      core: CORE_TOKENS.includes(name as (typeof CORE_TOKENS)[number]),
      ...(deprecatedFor ? { deprecatedFor } : {}),
      status: !shared ? "own" : !fromDesignSystem ? "new" : fromProject ? "overridden" : "inherited",
    };
  });

  const diffusedComponents = new Set(
    (shared && diffusion ? store.diffusionComponents(shared.id, diffusion.number) : []).map((c) => c.name),
  );
  const components = projectComponents(store, projectId).components.map(
    (c): ProjectComponentInfo => ({ name: c.name, file: c.file, page: c.page, status: diffusedComponents.has(c.name) ? "override" : "new" }),
  );

  const last = store.listDesignMdVersions(projectId, PROJECT_STYLE_PATH)[0];
  return {
    designSystem: shared ? { id: shared.id, title: shared.title } : null,
    diffusion: diffusion ?? null,
    tokens,
    components,
    overrideCount: tokens.filter((t) => t.status === "overridden").length,
    lastModified: last ? { createdAt: last.createdAt, origin: last.origin, ...(last.originId ? { originId: last.originId } : {}), ...(last.originLabel ? { originLabel: last.originLabel } : {}) } : null,
  };
}

const PREVIEW_ARTBOARD = { file: "index.html", x: 0, y: 0, width: 280, height: 200 };
const PAGE_GAP = 100;
const ASSET_REFERENCE = /\bassets\/([A-Za-z0-9._\/-]+)/g;

/**
 * The manifest of a design system made from a project's components: each component keeps its artboard entry, its tweaks (the variants)
 * and the title above it on its page; the source pages are stacked under the preview artboard so nothing overlaps.
 */
function promotedManifest(store: Store, projectId: string): { artboards: ManifestArtboard[]; elements: ManifestTitleElement[]; tweaks: ManifestTweak[] } {
  const artboards: ManifestArtboard[] = [PREVIEW_ARTBOARD];
  const elements: ManifestTitleElement[] = [];
  const tweaks: ManifestTweak[] = [];
  let nextY = PREVIEW_ARTBOARD.y + PREVIEW_ARTBOARD.height + PAGE_GAP;
  for (const page of store.listPages(projectId)) {
    const files = store.readPageFiles(page.id)?.files ?? {};
    const manifest = files[MANIFEST_PATH] === undefined ? defaultManifest(Object.keys(files)) : parseManifest(files[MANIFEST_PATH]);
    const mine = manifest.artboards.filter((a) => componentNameOf(a.file) !== null && files[a.file] !== undefined);
    if (mine.length === 0) continue;
    const titles = new Set<ManifestTitleElement>();
    for (const artboard of mine) {
      const above = manifest.elements.filter((e): e is ManifestTitleElement => e.kind === "title" && e.y <= artboard.y).sort((a, b) => b.y - a.y)[0];
      if (above) titles.add(above);
    }
    const top = Math.min(...mine.map((a) => a.y), ...[...titles].map((t) => t.y));
    const shift = nextY - top;
    artboards.push(...mine.map((a) => ({ ...a, y: a.y + shift })));
    elements.push(...[...titles].map((t) => ({ ...t, y: t.y + shift })));
    tweaks.push(...manifest.tweaks.filter((t) => t.artboard !== undefined && mine.some((a) => a.file === t.artboard)));
    nextY = Math.max(...mine.map((a) => a.y + shift + a.height)) + PAGE_GAP;
  }
  return { artboards, elements, tweaks };
}

/** Project assets the given component files reference, by asset name. */
function assetsUsedBy(store: Store, projectId: string, components: Record<string, string>): Record<string, Buffer> {
  const assets: Record<string, Buffer> = {};
  for (const content of Object.values(components)) {
    for (const [, name] of content.matchAll(ASSET_REFERENCE)) {
      const asset = store.readProjectFile(projectId, `${ASSETS_DIR}/${name}`);
      if (asset) assets[name] = asset;
    }
  }
  return assets;
}

/** Error message when `designSystem` is not a valid change for the project (shared by `/api` and `/agent-api`), else null. */
export function designSystemChangeError(store: Store, designSystem: unknown): string | null {
  if (designSystem !== null && (typeof designSystem !== "string" || !store.getDesignSystem(designSystem))) {
    return "designSystem must be the id of an existing design system, or null for none";
  }
  return null;
}

/** After a promotion the design system is the only source of the components: remove the project's copies from its pages, one user version per page. */
function removeComponentCopies(store: Store, projectId: string): void {
  for (const page of store.listPages(projectId)) {
    const files = store.readPageFiles(page.id)?.files ?? {};
    const removed = Object.keys(files).filter((path) => componentNameOf(path) !== null);
    if (removed.length === 0) continue;
    const kept = Object.fromEntries(Object.entries(files).filter(([path]) => !removed.includes(path)));
    if (kept[MANIFEST_PATH] !== undefined) {
      let manifest = JSON.parse(kept[MANIFEST_PATH]) as { artboards?: { file: string }[]; elements?: Record<string, unknown>[]; tweaks?: { artboard?: string }[]; links?: { from: string; to: string }[] };
      for (const file of removed) manifest = manifestWithoutArtboard(manifest, file);
      if (manifest.tweaks) manifest.tweaks = manifest.tweaks.filter((t) => t.artboard === undefined || !removed.includes(t.artboard));
      if (manifest.links) manifest.links = manifest.links.filter((l) => !removed.includes(l.from) && !removed.includes(l.to));
      kept[MANIFEST_PATH] = `${JSON.stringify(manifest, null, 2)}\n`;
    }
    store.addVersion(page.id, kept, "Components moved to the design system", "user");
  }
}

export function registerProjectDesignSystemRoutes(app: FastifyInstance, store: Store): void {
  const hasProjectStyle = (projectId: string) => store.projectExists(projectId) && !store.isDesignSystemProject(projectId);
  const styleOf = (projectId: string) => store.readProjectText(projectId, PROJECT_STYLE_PATH);
  const save = (projectId: string, css: string) => store.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(css, "utf8"));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/design-system", async (req, reply) => {
    if (!hasProjectStyle(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return projectDesignSystem(store, req.params.projectId);
  });

  app.put<{ Params: { projectId: string }; Body: SetProjectDesignSystemRequest }>("/api/projects/:projectId/design-system", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const designSystem = req.body?.designSystem ?? null;
    const invalid = designSystemChangeError(store, designSystem);
    if (invalid) return reply.code(400).send({ error: invalid });
    store.setProjectDesignSystem(projectId, designSystem, "user");
    return projectDesignSystem(store, projectId);
  });

  // "En faire un design system…": the project style becomes a shared design system (diffusion 1) the project then follows, with an empty style.
  app.post<{ Params: { projectId: string }; Body: PromoteProjectStyleRequest }>("/api/projects/:projectId/design-system/promote", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (store.getProject(projectId)!.designSystem !== null) return reply.code(400).send({ error: "the project already follows a shared design system" });
    const title = req.body?.title;
    if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
    const components = componentFilesOf(store, projectId);
    const manifest = promotedManifest(store, projectId);
    const designSystem = store.createDesignSystem((title as string).trim(), {
      [DESIGN_SYSTEM_TOKENS_PATH]: styleOf(projectId),
      [PREVIEW_ARTBOARD.file]: NEUTRAL_TOKENS_PAGE_HTML,
      ...components,
      [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    for (const [name, asset] of Object.entries(assetsUsedBy(store, projectId, components))) store.setProjectFile(designSystem.id, `${ASSETS_DIR}/${name}`, asset);
    save(projectId, "");
    store.setProjectDesignSystem(projectId, designSystem.id, "user");
    removeComponentCopies(store, projectId);
    return reply.code(201).send(designSystem);
  });

  app.put<{ Params: { projectId: string; name: string }; Body: SetProjectTokenRequest }>("/api/projects/:projectId/project-style/tokens/:name", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (!TOKEN_NAME.test(name)) return reply.code(400).send({ error: "token name must look like --name" });
    const value = req.body?.value;
    if (typeof value !== "string") return reply.code(400).send({ error: "value is required" });
    const invalid = tokenValueError(value);
    if (invalid) return reply.code(400).send({ error: invalid });
    save(projectId, setToken(styleOf(projectId), name, value.trim()));
    return projectDesignSystem(store, projectId);
  });

  // Reset: the project stops setting the token, so the design system value applies again.
  app.delete<{ Params: { projectId: string; name: string } }>("/api/projects/:projectId/project-style/tokens/:name", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (!parseTokens(styleOf(projectId)).some((t) => t.name === name)) return reply.code(404).send({ error: "token is not set by the project" });
    save(projectId, removeToken(styleOf(projectId), name));
    return projectDesignSystem(store, projectId);
  });
}
