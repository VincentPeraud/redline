import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ASSETS_DIR,
  CORE_TOKENS,
  DESIGN_SYSTEM_TOKENS_PATH,
  MANIFEST_PATH,
  NEUTRAL_TOKENS_PAGE_HTML,
  PROJECT_STYLE_PATH,
  componentNameOf,
  defaultManifest,
  parseManifest,
  parseTokens,
  removeToken,
  setToken,
  styleDefinesTokens,
  tokenValueError,
  type ManifestArtboard,
  type ManifestTitleElement,
  type ManifestTweak,
  type MoveUpComponentRequest,
  type ProjectComponentInfo,
  type ProjectDesignSystem,
  type ProjectStyleToken,
  type PromoteProjectStyleRequest,
  type SetProjectTokenRequest,
  type SetProjectDesignSystemRequest,
} from "@redline/shared";
import { componentFilesOf, currentDefinitions, instanceNamesByPage, projectComponents } from "./components.js";
import { assetsUsedBy, moveUpComponent, removeComponentCopies, useDesignSystemComponent } from "./move-up.js";
import { personRef, editorAuthor } from "./identity.js";
import { excludedComponents, switchDesignSystem, switchPreview } from "./switch-design-system.js";
import type { OriginRef, Store } from "./store.js";
import { titleError } from "./validation.js";

const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/** The project's Design system page: tokens against the current diffusion, project components, counts. */
export function projectDesignSystem(store: Store, projectId: string): ProjectDesignSystem {
  const sharedId = store.sharedDesignSystemIdOfProject(projectId);
  const shared = sharedId === undefined ? undefined : store.getDesignSystem(sharedId);
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

  const usesByPage = instanceNamesByPage(store, projectId);
  const sharedNames = new Set(currentDefinitions(store, sharedId).map((d) => d.name));
  const moved = store.movedUpComponents(projectId);
  const components = projectComponents(store, projectId).components.map(
    (c): ProjectComponentInfo => ({
      name: c.name,
      file: c.file,
      page: c.page,
      instances: usesByPage.reduce((sum, names) => sum + names.filter((name) => name === c.name).length, 0),
      pages: usesByPage.filter((names) => names.includes(c.name)).length,
      inDesignSystem: sharedNames.has(c.name),
      ...(sharedId !== undefined && sharedNames.has(c.name) ? { diffusedSince: diffusedSince(store, sharedId, c.name) } : {}),
      movedUp: sharedId !== undefined && moved[c.name]?.designSystemId === sharedId,
    }),
  );

  const last = store.listDesignMdVersions(projectId, PROJECT_STYLE_PATH)[0];
  return {
    designSystem: shared ? { id: shared.id, title: shared.title } : null,
    diffusion: diffusion ?? null,
    tokens,
    styleDefinesTokens: styleDefinesTokens(store.readProjectText(projectId, PROJECT_STYLE_PATH)),
    components,
    designSystemPages: shared ? store.listPages(shared.id).map((page) => ({ id: page.id, title: page.title })) : [],
    excluded: excludedComponents(store, projectId),
    overrideCount: tokens.filter((t) => t.status === "overridden").length,
    lastModified: last ? { createdAt: last.createdAt, origin: last.origin, ...(last.originId ? { originId: last.originId } : {}), ...(last.originLabel ? { originLabel: last.originLabel } : {}), ...(last.person ? { person: last.person } : {}) } : null,
  };
}

/** The first diffusion of the unbroken run, up to the current one, that has a component of this name. */
function diffusedSince(store: Store, designSystemId: string, name: string): number {
  const current = store.currentDiffusion(designSystemId)!;
  let since = current.number;
  for (const diffusion of store.listDiffusions(designSystemId)) {
    if (diffusion.number >= current.number || diffusion.undone) continue;
    if (!Object.keys(store.diffusionComponentFiles(designSystemId, diffusion.number)).some((path) => componentNameOf(path) === name)) break;
    since = diffusion.number;
  }
  return since;
}

const PREVIEW_ARTBOARD = { file: "index.html", x: 0, y: 0, width: 280, height: 200 };
const PAGE_GAP = 100;

/**
 * The manifest of a design system made from a project's components: each component keeps its artboard entry, its tweaks (the variants)
 * and the title above it on its page; the source pages are stacked under the preview artboard so nothing overlaps.
 */
function promotedManifest(store: Store, projectId: string): { artboards: ManifestArtboard[]; elements: ManifestTitleElement[]; tweaks: ManifestTweak[] } {
  const artboards: ManifestArtboard[] = [PREVIEW_ARTBOARD];
  const elements: ManifestTitleElement[] = [];
  const tweaks: ManifestTweak[] = [];
  let nextY = PREVIEW_ARTBOARD.y + PREVIEW_ARTBOARD.height + PAGE_GAP;
  // An archived page is read-only: its components are neither promoted nor removed (see `removeComponentCopies`).
  for (const page of store.listPages(projectId, "active")) {
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

/** Error message when `designSystem` is not a valid change for the project (shared by `/api` and `/agent-api`), else null. */
export function designSystemChangeError(store: Store, designSystem: unknown): string | null {
  if (designSystem !== null && (typeof designSystem !== "string" || !store.getDesignSystem(designSystem))) {
    return "designSystem must be the id of an existing design system, or null for none";
  }
  if (designSystem !== null && store.isArchived(designSystem)) return "This design system is archived: choose another one.";
  return null;
}

export function registerProjectDesignSystemRoutes(app: FastifyInstance, store: Store): void {
  const hasProjectStyle = (projectId: string) => store.projectExists(projectId) && !store.isDesignSystemProject(projectId);
  const styleOf = (projectId: string) => store.readProjectText(projectId, PROJECT_STYLE_PATH);
  const save = (req: FastifyRequest, projectId: string, css: string) => store.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(css, "utf8"), editorAuthor(req));

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
    switchDesignSystem(store, projectId, designSystem, "user", req.person, req.body?.ticked);
    return projectDesignSystem(store, projectId);
  });

  // The switch dialog: the design system components the pages use, compared with the target's current diffusion.
  app.get<{ Params: { projectId: string }; Querystring: { to?: string } }>("/api/projects/:projectId/design-system/switch", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const invalid = designSystemChangeError(store, req.query.to ?? null);
    if (invalid || !req.query.to) return reply.code(400).send({ error: invalid ?? "to is required" });
    return switchPreview(store, projectId, req.query.to);
  });

  // Takes a component left out at a switch: its instances render from the design system again.
  app.post<{ Params: { projectId: string; name: string } }>("/api/projects/:projectId/design-system/components/:name/take", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const left = excludedComponents(store, projectId).find((c) => c.name === name);
    if (!left) return reply.code(404).send({ error: "this component was not left out" });
    if (!left.available) return reply.code(400).send({ error: `${left.from} has no component named ${name}` });
    const { [name]: _taken, ...rest } = store.excludedComponents(projectId);
    store.setExcludedComponents(projectId, rest);
    return projectDesignSystem(store, projectId);
  });

  // "Remonter au design system": copies the component into a page of the design system's draft.
  app.post<{ Params: { projectId: string; name: string }; Body: MoveUpComponentRequest }>("/api/projects/:projectId/design-system/components/:name/move-up", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const result = moveUpComponent(store, projectId, name, req.body?.pageId, personRef(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return projectDesignSystem(store, projectId);
  });

  // "Passer à celui du design system": deletes the project's component whose name the design system diffuses.
  app.post<{ Params: { projectId: string; name: string } }>("/api/projects/:projectId/design-system/components/:name/use-design-system", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const result = useDesignSystemComponent(store, projectId, name, personRef(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return projectDesignSystem(store, projectId);
  });

  // "En faire un design system…": the project style becomes a shared design system (diffusion 1) the project then follows, with an empty style.
  app.post<{ Params: { projectId: string }; Body: PromoteProjectStyleRequest }>("/api/projects/:projectId/design-system/promote", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (store.sharedDesignSystemIdOfProject(projectId) !== undefined) return reply.code(400).send({ error: "the project already follows a shared design system" });
    const title = req.body?.title;
    if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
    if (!styleDefinesTokens(styleOf(projectId))) return reply.code(400).send({ error: "the project style defines no token yet: there is nothing to make a design system of" });
    const components = componentFilesOf(store, projectId);
    const manifest = promotedManifest(store, projectId);
    const designSystem = store.createDesignSystem((title as string).trim(), {
      [DESIGN_SYSTEM_TOKENS_PATH]: styleOf(projectId),
      [PREVIEW_ARTBOARD.file]: NEUTRAL_TOKENS_PAGE_HTML,
      ...components,
      [MANIFEST_PATH]: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    for (const [name, asset] of Object.entries(assetsUsedBy(store, projectId, components))) store.setProjectFile(designSystem.id, `${ASSETS_DIR}/${name}`, asset);
    save(req, projectId, "");
    switchDesignSystem(store, projectId, designSystem.id, "user", req.person);
    removeComponentCopies(store, projectId, personRef(req));
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
    save(req, projectId, setToken(styleOf(projectId), name, value.trim()));
    return projectDesignSystem(store, projectId);
  });

  // Reset: the project stops setting the token, so the design system value applies again.
  app.delete<{ Params: { projectId: string; name: string } }>("/api/projects/:projectId/project-style/tokens/:name", async (req, reply) => {
    const { projectId, name } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (!parseTokens(styleOf(projectId)).some((t) => t.name === name)) return reply.code(404).send({ error: "token is not set by the project" });
    save(req, projectId, removeToken(styleOf(projectId), name));
    return projectDesignSystem(store, projectId);
  });
}
