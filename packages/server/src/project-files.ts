import type { FastifyInstance } from "fastify";
import {
  ASSETS_DIR,
  DESIGN_MD_PATH,
  PROJECT_STYLE_PATH,
  MAX_ASSET_BYTES,
  MANIFEST_PATH,
  isSafePath,
  classesUsedIn,
  componentClassesOf,
  type ComponentInfo,
  type DesignMdAuthor,
  type DesignSystemContext,
  type DesignMdInfo,
  type DesignMdResponse,
  type DesignMdRule,
  type DesignMdVersion,
  type ProjectAsset,
  type ProjectContext,
  type SaveDesignMdRequest,
} from "@redline/shared";
import { componentFilesOf } from "./components.js";
import type { Store } from "./store.js";

/** Design system a page uses (as of one of its versions when given): the one its manifest names if it exists, else the neutral one. */
export function designSystemIdOf(store: Store, pageId: string, versionId?: string): string {
  const manifest = versionId === undefined ? store.readPageFile(pageId, MANIFEST_PATH) : store.readVersionFile(pageId, versionId, MANIFEST_PATH);
  return store.designSystemIdOfManifest(manifest?.toString("utf8"));
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What a project session gets of its design system: the CURRENT diffusion (never the draft) as the files of
 * `.design-system/`, and which of the design system's pages the project's pages use (through component classes).
 */
function designSystemContext(store: Store, projectId: string, designSystemId: string): DesignSystemContext {
  const designSystem = store.getDesignSystem(designSystemId)!;
  const { number } = store.currentDiffusion(designSystemId)!;
  const read = (file: Parameters<Store["readDiffusionFile"]>[2]) => store.readDiffusionFile(designSystemId, number, file);
  const components = JSON.parse(read("components.json") ?? "[]") as ComponentInfo[];
  const indexes = JSON.parse(read("index.json") ?? "{}") as Record<string, string>;
  const componentFiles = JSON.parse(read("component-files.json") ?? "{}") as Record<string, string>;

  const classesOfPage = new Map<string, Set<string>>();
  for (const component of components) {
    const classes = classesOfPage.get(component.page.id) ?? new Set<string>();
    for (const name of componentClassesOf(componentFiles[component.file] ?? "")) classes.add(name);
    classesOfPage.set(component.page.id, classes);
  }
  const used = new Set<string>();
  for (const page of store.listPages(projectId)) {
    for (const [path, content] of Object.entries(store.readPageFiles(page.id)?.files ?? {})) {
      if (!path.endsWith(".html")) continue;
      const classes = classesUsedIn(content);
      for (const [pageId, own] of classesOfPage) if ([...own].some((name) => classes.has(name))) used.add(pageId);
    }
  }

  const taken = new Set<string>();
  const pages = Object.keys(indexes).map((id) => {
    const own = components.filter((c) => c.page.id === id);
    const title = store.getPage(id)?.title ?? own[0]?.page.title ?? id;
    let slug = slugOf(title);
    for (let n = 2; taken.has(slug); n++) slug = `${slugOf(title)}-${n}`;
    taken.add(slug);
    return { id, title, slug, own };
  });
  const files: Record<string, string> = {
    "tokens.css": read("tokens.css") ?? "",
    "DESIGN.md": read("DESIGN.md") ?? "",
    ...componentFiles,
  };
  for (const { id, title, slug } of pages) {
    files[`pages/${slug}.md`] = `# ${title}\n\n${indexes[id].trim() === "" ? "No component on this page.\n" : indexes[id]}`;
  }
  files["index.md"] = [
    `# ${designSystem.title} (diffusion ${number})`,
    "",
    "Pages of the design system (read the page file to see its components; the full files are in components/):",
    "",
    ...pages.map(({ title, slug, own }) => `- ${title} (pages/${slug}.md): ${plural(own.length, "component")}${own.length ? ` (${own.map((c) => c.name).join(", ")})` : ""}`),
    "",
  ].join("\n");
  return {
    id: designSystem.id,
    title: designSystem.title,
    diffusion: number,
    files,
    pages: pages.map(({ id, title, own }) => ({ title, components: own.length, used: used.has(id) })),
  };
}

/** DESIGN.md, assets, project style and design system that go into the working copy of a page. */
export function projectContext(store: Store, pageId: string): ProjectContext {
  const page = store.getPage(pageId)!;
  const assets: Record<string, string> = {};
  for (const { name } of store.listProjectFiles(page.projectId, `${ASSETS_DIR}/`)) {
    assets[name] = store.readProjectFile(page.projectId, `${ASSETS_DIR}/${name}`)!.toString("base64");
  }
  const own = store.getDesignSystem(page.projectId);
  return {
    designMd: store.readProjectFile(page.projectId, DESIGN_MD_PATH)?.toString("utf8") ?? "",
    assets,
    // A project's style, or the draft tokens of a design system's own project: the same root file either way.
    projectStyle: store.readProjectFile(page.projectId, PROJECT_STYLE_PATH)?.toString("utf8") ?? "",
    ...(own ? {} : { projectComponents: componentFilesOf(store, page.projectId) }),
    ...(own ? { editsDesignSystem: { id: own.id, title: own.title } } : { designSystem: designSystemContext(store, page.projectId, designSystemIdOf(store, pageId)) }),
  };
}

/** Asset name from a URL wildcard (the router already percent-decoded it: decoding again would break "50%.png"), or undefined if unsafe. */
function assetNameOf(name: string): string | undefined {
  return isSafePath(name) ? name : undefined;
}

/**
 * Stores an asset sent as raw bytes (`PUT .../assets/<name>`), for the web UI and for agents.
 * Asset bodies may reach `MAX_ASSET_BYTES`; every other request body keeps Fastify's 1 MB limit.
 */
export function putProjectAsset(store: Store, projectId: string, name: string, body: unknown): ProjectAsset | { error: string } {
  const safe = assetNameOf(name);
  if (safe === undefined) return { error: "invalid asset name" };
  if (!Buffer.isBuffer(body)) return { error: "file content is required" };
  const hash = store.setProjectFile(projectId, `${ASSETS_DIR}/${safe}`, body);
  return { name: safe, hash, size: body.length };
}

/** An asset of the project the page belongs to, so every artboard reaches it as `assets/<name>`. */
export function readPageAsset(store: Store, pageId: string, rawName: string): Buffer | undefined {
  const page = store.getPage(pageId);
  const name = assetNameOf(rawName);
  return page && name !== undefined ? store.readProjectFile(page.projectId, `${ASSETS_DIR}/${name}`) : undefined;
}

const authorOf = ({ origin, originId, originLabel }: DesignMdAuthor): DesignMdAuthor => ({
  origin,
  ...(originId ? { originId } : {}),
  ...(originLabel ? { originLabel } : {}),
});

const linesOf = (content: string): { text: string; line: number }[] =>
  content
    .split("\n")
    .map((raw, i) => ({ text: raw.trim(), line: i + 1 }))
    .filter((l) => l.text !== "");

/**
 * Where each rule (non-blank line, see `DesignMdRule`) of the current DESIGN.md comes from. `versions` is newest first.
 * The k-th occurrence of a text is introduced by the oldest version from which that text occurs at least k times in
 * every version up to the current one.
 */
export function designMdRules(versions: DesignMdVersion[]): DesignMdRule[] {
  if (versions.length === 0) return [];
  const counts = versions.map((v) => {
    const byText = new Map<string, number>();
    for (const { text } of linesOf(v.content)) byText.set(text, (byText.get(text) ?? 0) + 1);
    return byText;
  });
  const seen = new Map<string, number>();
  return linesOf(versions[0].content).map(({ text, line }): DesignMdRule => {
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);
    let introducedBy = 0;
    while (introducedBy + 1 < versions.length && (counts[introducedBy + 1].get(text) ?? 0) >= occurrence) introducedBy++;
    const version = versions[introducedBy];
    return { line, text, versionId: version.id, createdAt: version.createdAt, ...authorOf(version) };
  });
}

export async function registerProjectFileRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/design-md", async (req, reply): Promise<DesignMdResponse> => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return { content: store.readProjectFile(req.params.projectId, DESIGN_MD_PATH)?.toString("utf8") ?? "" };
  });

  app.put<{ Params: { projectId: string }; Body: SaveDesignMdRequest }>("/api/projects/:projectId/design-md", async (req, reply) => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const content = req.body?.content;
    if (typeof content !== "string") return reply.code(400).send({ error: "content is required" });
    store.saveDesignMd(req.params.projectId, DESIGN_MD_PATH, Buffer.from(content, "utf8"));
    return { content };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/project-style", async (req, reply): Promise<DesignMdResponse> => {
    if (!store.projectExists(req.params.projectId) || store.isDesignSystemProject(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return { content: store.readProjectFile(req.params.projectId, PROJECT_STYLE_PATH)?.toString("utf8") ?? "" };
  });

  app.put<{ Params: { projectId: string }; Body: SaveDesignMdRequest }>("/api/projects/:projectId/project-style", async (req, reply) => {
    if (!store.projectExists(req.params.projectId) || store.isDesignSystemProject(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const content = req.body?.content;
    if (typeof content !== "string") return reply.code(400).send({ error: "content is required" });
    store.saveDesignMd(req.params.projectId, PROJECT_STYLE_PATH, Buffer.from(content, "utf8"));
    return { content };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/project-style/versions", async (req, reply): Promise<DesignMdVersion[]> => {
    if (!store.projectExists(req.params.projectId) || store.isDesignSystemProject(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return store.listDesignMdVersions(req.params.projectId, PROJECT_STYLE_PATH);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/design-md/versions", async (req, reply): Promise<DesignMdVersion[]> => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return store.listDesignMdVersions(req.params.projectId);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/design-md/info", async (req, reply): Promise<DesignMdInfo> => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const versions = store.listDesignMdVersions(req.params.projectId);
    const last = versions[0];
    return {
      versionCount: versions.length,
      lastModified: last ? { versionId: last.id, createdAt: last.createdAt, ...authorOf(last) } : null,
      rules: designMdRules(versions),
    };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/assets", async (req, reply): Promise<ProjectAsset[]> => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return store.listProjectFiles(req.params.projectId, `${ASSETS_DIR}/`);
  });

  // Raw bytes: `PUT /api/projects/:id/assets/<name>` with the file as body, any content type.
  await app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { projectId: string; "*": string }; Body: Buffer }>("/api/projects/:projectId/assets/*", { bodyLimit: MAX_ASSET_BYTES }, async (req, reply) => {
      if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
      const asset = putProjectAsset(store, req.params.projectId, req.params["*"], req.body);
      return reply.code("error" in asset ? 400 : 201).send(asset);
    });
  });
}
