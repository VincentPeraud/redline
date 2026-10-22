import type { FastifyInstance } from "fastify";
import {
  ASSETS_DIR,
  DESIGN_MD_PATH,
  MANIFEST_PATH,
  NEUTRAL_DESIGN_SYSTEM_ID,
  isSafePath,
  parseManifest,
  type DesignMdResponse,
  type ProjectAsset,
  type ProjectContext,
  type SaveDesignMdRequest,
} from "@redline/shared";
import type { Store } from "./store.js";

/** Largest asset (image, font) accepted by `PUT /api/projects/:id/assets/*`; every other request body keeps Fastify's 1 MB limit. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** Design system a page uses: the one its manifest names if it exists, else the neutral one. */
export function designSystemIdOf(store: Store, pageId: string): string {
  const text = store.readPageFile(pageId, MANIFEST_PATH)?.toString("utf8");
  if (text !== undefined) {
    try {
      const id = parseManifest(text).designSystem;
      if (id !== undefined && store.getDesignSystem(id)) return id;
    } catch {
      // An invalid stored manifest must not break serving the artboard.
    }
  }
  return NEUTRAL_DESIGN_SYSTEM_ID;
}

/** DESIGN.md, assets and design system that go into the working copy of a page. */
export function projectContext(store: Store, pageId: string): ProjectContext {
  const page = store.getPage(pageId)!;
  const designSystem = store.getDesignSystem(designSystemIdOf(store, pageId))!;
  const assets: Record<string, string> = {};
  for (const { name } of store.listProjectFiles(page.projectId, `${ASSETS_DIR}/`)) {
    assets[name] = store.readProjectFile(page.projectId, `${ASSETS_DIR}/${name}`)!.toString("base64");
  }
  return {
    designMd: store.readProjectFile(page.projectId, DESIGN_MD_PATH)?.toString("utf8") ?? "",
    assets,
    designSystem: { id: designSystem.id, files: store.readPageFiles(designSystem.pageId)!.files },
  };
}

/** Asset name from a raw (still percent-encoded) URL path, or undefined if malformed or unsafe. */
function assetNameOf(rawName: string): string | undefined {
  try {
    const name = decodeURIComponent(rawName);
    return isSafePath(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** An asset of the project the page belongs to, so every artboard reaches it as `assets/<name>`. */
export function readPageAsset(store: Store, pageId: string, rawName: string): Buffer | undefined {
  const page = store.getPage(pageId);
  const name = assetNameOf(rawName);
  return page && name !== undefined ? store.readProjectFile(page.projectId, `${ASSETS_DIR}/${name}`) : undefined;
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
    store.setProjectFile(req.params.projectId, DESIGN_MD_PATH, Buffer.from(content, "utf8"));
    return { content };
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
      const name = assetNameOf(req.params["*"]);
      if (name === undefined) return reply.code(400).send({ error: "invalid asset name" });
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "file content is required" });
      const hash = store.setProjectFile(req.params.projectId, `${ASSETS_DIR}/${name}`, req.body);
      return reply.code(201).send({ name, hash, size: req.body.length } satisfies ProjectAsset);
    });
  });
}
