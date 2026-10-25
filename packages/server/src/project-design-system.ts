import type { FastifyInstance } from "fastify";
import {
  CORE_TOKENS,
  DESIGN_SYSTEM_TOKENS_PATH,
  NEUTRAL_TOKENS_PAGE_HTML,
  PROJECT_STYLE_PATH,
  parseTokens,
  removeToken,
  setToken,
  tokenValueError,
  type ProjectComponentInfo,
  type ProjectDesignSystem,
  type ProjectStyleToken,
  type PromoteProjectStyleRequest,
  type SetProjectTokenRequest,
  type SetProjectDesignSystemRequest,
} from "@redline/shared";
import { componentFilesOf, projectComponents } from "./components.js";
import type { Store } from "./store.js";
import { requiredString } from "./validation.js";

const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/** The project's Design system page: tokens against the current diffusion, project components, counts. */
export function projectDesignSystem(store: Store, projectId: string): ProjectDesignSystem {
  const project = store.getProject(projectId)!;
  const shared = project.designSystem === null ? undefined : store.getDesignSystem(project.designSystem);
  const diffusion = shared ? store.currentDiffusion(shared.id) : undefined;
  const designSystemTokens = new Map(
    parseTokens(shared && diffusion ? (store.readDiffusionFile(shared.id, diffusion.number, "tokens.css") ?? "") : "").map((t) => [t.name, t]),
  );
  const projectTokens = parseTokens(store.readProjectFile(projectId, PROJECT_STYLE_PATH)?.toString("utf8") ?? "");
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
    (JSON.parse((shared && diffusion ? store.readDiffusionFile(shared.id, diffusion.number, "components.json") : undefined) ?? "[]") as { name: string }[]).map((c) => c.name),
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

export function registerProjectDesignSystemRoutes(app: FastifyInstance, store: Store): void {
  const hasProjectStyle = (projectId: string) => store.projectExists(projectId) && !store.isDesignSystemProject(projectId);
  const styleOf = (projectId: string) => store.readProjectFile(projectId, PROJECT_STYLE_PATH)?.toString("utf8") ?? "";
  const save = (projectId: string, css: string) => store.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(css, "utf8"));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/design-system", async (req, reply) => {
    if (!hasProjectStyle(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return projectDesignSystem(store, req.params.projectId);
  });

  app.put<{ Params: { projectId: string }; Body: SetProjectDesignSystemRequest }>("/api/projects/:projectId/design-system", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    const designSystem = req.body?.designSystem ?? null;
    if (designSystem !== null && (typeof designSystem !== "string" || !store.getDesignSystem(designSystem))) {
      return reply.code(400).send({ error: "designSystem must be the id of an existing design system, or null for none" });
    }
    store.setProjectDesignSystem(projectId, designSystem, "user");
    return projectDesignSystem(store, projectId);
  });

  // "En faire un design system…": the project style becomes a shared design system (diffusion 1) the project then follows, with an empty style.
  app.post<{ Params: { projectId: string }; Body: PromoteProjectStyleRequest }>("/api/projects/:projectId/design-system/promote", async (req, reply) => {
    const { projectId } = req.params;
    if (!hasProjectStyle(projectId)) return reply.code(404).send({ error: "project not found" });
    if (store.getProject(projectId)!.designSystem !== null) return reply.code(400).send({ error: "the project already follows a shared design system" });
    const title = req.body?.title;
    if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
    const components = componentFilesOf(store, projectId);
    const preview = "index.html";
    const manifest = { artboards: [preview, ...Object.keys(components)].map((file, i) => ({ file, x: i * 300, y: 0, width: 280, height: 200 })) };
    const designSystem = store.createDesignSystem(title.trim(), {
      [DESIGN_SYSTEM_TOKENS_PATH]: styleOf(projectId),
      [preview]: NEUTRAL_TOKENS_PAGE_HTML,
      ...components,
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    });
    save(projectId, "");
    store.setProjectDesignSystem(projectId, designSystem.id, "user");
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
