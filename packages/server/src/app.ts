import { existsSync } from "node:fs";
import { extname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  DESIGN_SYSTEM_TOKENS_PATH,
  MANIFEST_PATH,
  TWEAKS_PATH,
  NEUTRAL_DESIGN_SYSTEM_ID,
  VERSION_ORIGINS,
  missingCoreTokens,
  parseManifest,
  parseTweaks,
  tweakValueError,
  type SetTweakRequest,
  type CreateDesignSystemRequest,
  type CreatePageRequest,
  type CreateProjectRequest,
  type CreateThreadRequest,
  type CreateVersionRequest,
  type ServerConfig,
} from "@redline/shared";
import { BRIDGE_PATH, BRIDGE_SOURCE, injectBridge, injectDesignSystem } from "./bridge.js";
import type { Store } from "./store.js";
import { registerAgentRoutes } from "./agents.js";
import { registerAgentApi } from "./agent-api.js";
import { registerEventRoutes } from "./events.js";
import { registerRunRoutes } from "./runs.js";
import { dispatchThread } from "./work.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

/** Error message when the files carry a manifest or tweaks file that does not parse, else null. */
function manifestError(files: Record<string, string>): string | null {
  try {
    if (files[MANIFEST_PATH] !== undefined) parseManifest(files[MANIFEST_PATH]);
    if (files[TWEAKS_PATH] !== undefined) parseTweaks(files[TWEAKS_PATH]);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Error message when a design system's files miss `tokens.css` or a core token, else null. */
function designSystemError(files: Record<string, string>): string | null {
  const css = files[DESIGN_SYSTEM_TOKENS_PATH];
  if (css === undefined) return `${DESIGN_SYSTEM_TOKENS_PATH} is required`;
  const missing = missingCoreTokens(css);
  return missing.length === 0 ? null : `Missing core tokens: ${missing.join(", ")}`;
}

/** Design system a page uses: the one its manifest names if it exists, else the neutral one. */
function designSystemIdOf(store: Store, pageId: string): string {
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

function isSafePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.split("/").includes("..");
}

/** API and web UI. */
export async function buildMainApp(store: Store, config: ServerConfig, webDir?: string): Promise<FastifyInstance> {
  const app = Fastify();
  const agents = await registerAgentRoutes(app, store);
  await registerAgentApi(app, store);
  registerEventRoutes(app, store);
  registerRunRoutes(app, store);

  app.get("/api/config", async () => config);

  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (req, reply) => {
    const { title, instructions, designSystem } = req.body ?? ({} as Partial<CreateProjectRequest>);
    if (typeof title !== "string" || title.trim() === "") return reply.code(400).send({ error: "title is required" });
    if (instructions !== undefined && typeof instructions !== "string") {
      return reply.code(400).send({ error: "instructions must be a string" });
    }
    if (designSystem != null && typeof designSystem !== "string") {
      return reply.code(400).send({ error: "designSystem must be a string" });
    }
    return reply.code(201).send(store.createProject(title, undefined, instructions, designSystem ?? null));
  });

  app.get("/api/projects", async () => store.listProjects());

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    return store.getProject(req.params.projectId) ?? reply.code(404).send({ error: "project not found" });
  });

  app.post<{ Params: { projectId: string }; Body: CreatePageRequest }>(
    "/api/projects/:projectId/pages",
    async (req, reply) => {
      if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
      const { title, type, files } = req.body ?? ({} as Partial<CreatePageRequest>);
      if (typeof title !== "string" || title.trim() === "") return reply.code(400).send({ error: "title is required" });
      if (type !== "prototype" && type !== "comparison") return reply.code(400).send({ error: "invalid type" });
      if (!files || typeof files !== "object") return reply.code(400).send({ error: "files are required" });
      const entries = Object.entries(files);
      if (entries.some(([path, content]) => !isSafePath(path) || typeof content !== "string")) {
        return reply.code(400).send({ error: "invalid files" });
      }
      const invalidManifest = manifestError(files);
      if (invalidManifest) return reply.code(400).send({ error: invalidManifest });
      return reply.code(201).send(store.createPage(req.params.projectId, title, type, files));
    },
  );

  app.get("/api/design-systems", async () => store.listDesignSystems());

  app.post<{ Body: CreateDesignSystemRequest }>("/api/design-systems", async (req, reply) => {
    const { title, files } = req.body ?? ({} as Partial<CreateDesignSystemRequest>);
    if (typeof title !== "string" || title.trim() === "") return reply.code(400).send({ error: "title is required" });
    if (!files || typeof files !== "object") return reply.code(400).send({ error: "files are required" });
    if (Object.entries(files).some(([path, content]) => !isSafePath(path) || typeof content !== "string")) {
      return reply.code(400).send({ error: "invalid files" });
    }
    const invalid = designSystemError(files);
    if (invalid) return reply.code(400).send({ error: invalid });
    return reply.code(201).send(store.createDesignSystem(title, files));
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/working-copy", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const read = (pageId: string, hashes: Record<string, string>) =>
      Object.fromEntries(Object.keys(hashes).map((path) => [path, store.readPageFile(pageId, path)!.toString("utf8")]));
    const designSystem = store.getDesignSystem(designSystemIdOf(store, page.id))!;
    const designSystemPage = store.getPage(designSystem.pageId)!;
    return {
      files: read(page.id, page.version.files),
      designSystem: { id: designSystem.id, files: read(designSystem.pageId, designSystemPage.version.files) },
    };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/pages", async (req) =>
    store.listPages(req.params.projectId),
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    return page ?? reply.code(404).send({ error: "page not found" });
  });

  app.post<{ Params: { pageId: string }; Body: CreateThreadRequest }>(
    "/api/pages/:pageId/threads",
    async (req, reply) => {
      if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
      const pin = req.body ?? ({} as Partial<CreateThreadRequest>);
      const isPct = (v: unknown) => typeof v === "number" && v >= 0 && v <= 100;
      if (typeof pin.body !== "string" || pin.body.trim() === "") return reply.code(400).send({ error: "body is required" });
      if (typeof pin.selector !== "string" || pin.selector === "") return reply.code(400).send({ error: "selector is required" });
      if (typeof pin.artboard !== "string" || !isSafePath(pin.artboard)) return reply.code(400).send({ error: "invalid artboard" });
      if (!isPct(pin.xPct) || !isPct(pin.yPct)) return reply.code(400).send({ error: "position must be a percentage" });
      const thread = store.createThread(req.params.pageId, pin as CreateThreadRequest);
      dispatchThread(store, agents, store.getPage(req.params.pageId)!.projectId, thread);
      return reply.code(201).send(thread);
    },
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/threads", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listThreads(req.params.pageId);
  });

  // The only way to resolve a thread: a user action of the web UI. Agents get no such route.
  app.post<{ Params: { threadId: string } }>("/api/threads/:threadId/resolve", async (req, reply) => {
    const thread = store.resolveThread(req.params.threadId);
    return thread ?? reply.code(404).send({ error: "thread not found" });
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/versions", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listVersions(req.params.pageId);
  });

  app.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>(
    "/api/pages/:pageId/versions",
    async (req, reply) => {
      if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
      const { files, message, origin } = req.body ?? ({} as Partial<CreateVersionRequest>);
      if (!files || typeof files !== "object") return reply.code(400).send({ error: "files are required" });
      if (Object.entries(files).some(([path, content]) => !isSafePath(path) || typeof content !== "string")) {
        return reply.code(400).send({ error: "invalid files" });
      }
      const invalidManifest = manifestError(files);
      if (invalidManifest) return reply.code(400).send({ error: invalidManifest });
      if (store.isDesignSystemPage(req.params.pageId)) {
        const invalidDesignSystem = designSystemError(files);
        if (invalidDesignSystem) return reply.code(400).send({ error: invalidDesignSystem });
      }
      if (typeof message !== "string" || message.trim() === "") {
        return reply.code(400).send({ error: "message is required" });
      }
      if (!(VERSION_ORIGINS as readonly string[]).includes(origin)) return reply.code(400).send({ error: "invalid origin" });
      return reply.code(201).send(store.addVersion(req.params.pageId, files, message, origin));
    },
  );

  app.post<{ Params: { pageId: string }; Body: SetTweakRequest }>("/api/pages/:pageId/tweaks", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const { id, value } = req.body ?? ({} as Partial<SetTweakRequest>);
    const manifestText = store.readPageFile(page.id, MANIFEST_PATH)?.toString("utf8");
    const tweak = manifestText === undefined ? undefined : parseManifest(manifestText).tweaks.find((t) => t.id === id);
    if (!tweak) return reply.code(400).send({ error: "unknown tweak" });
    const invalid = tweakValueError(tweak, value);
    if (invalid) return reply.code(400).send({ error: invalid });
    const stored = store.readPageFile(page.id, TWEAKS_PATH)?.toString("utf8");
    const values = { ...(stored === undefined ? {} : parseTweaks(stored)), [tweak.id]: value };
    return reply
      .code(201)
      .send(store.setPageFile(page.id, TWEAKS_PATH, JSON.stringify(values, null, 2), `Tweak: ${tweak.label} = ${value}`, "tweak"));
  });

  app.post<{ Params: { pageId: string; versionId: string } }>(
    "/api/pages/:pageId/versions/:versionId/restore",
    async (req, reply) => {
      const restored = store.restoreVersion(req.params.pageId, req.params.versionId);
      return restored ? reply.code(201).send(restored) : reply.code(404).send({ error: "version not found" });
    },
  );

  app.get<{ Params: { pageId: string; "*": string } }>("/api/pages/:pageId/files/*", async (req, reply) => {
    const path = req.params["*"];
    const content = store.readPageFile(req.params.pageId, path);
    if (!content) return reply.code(404).send({ error: "file not found" });
    return reply.type("application/octet-stream").send(content);
  });

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/**
 * Artboards live on their own origin and only that origin: a mock-up's scripts must never
 * share an origin with the API. The CSP sandbox (without allow-same-origin) also gives
 * the document an opaque origin, even if someone opens the URL directly.
 */
export async function buildArtboardApp(store: Store): Promise<FastifyInstance> {
  const app = Fastify();

  app.get(BRIDGE_PATH, async (_req, reply) =>
    reply.header("content-security-policy", "sandbox allow-scripts").type(MIME[".js"]).send(BRIDGE_SOURCE),
  );

  app.get<{ Params: { designSystemId: string; "*": string } }>("/design-systems/:designSystemId/*", async (req, reply) => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    const content = designSystem && store.readPageFile(designSystem.pageId, req.params["*"]);
    if (!content) return reply.code(404).send("not found");
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .header("cache-control", "no-cache")
      .type(MIME[extname(req.params["*"])] ?? "application/octet-stream")
      .send(content);
  });

  app.get<{ Params: { pageId: string; "*": string } }>("/pages/:pageId/*", async (req, reply) => {
    const path = req.params["*"];
    const content = store.readPageFile(req.params.pageId, path);
    if (!content) return reply.code(404).send("not found");
    const isHtml = extname(path) === ".html";
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .type(MIME[extname(path)] ?? "application/octet-stream")
      .send(isHtml ? injectBridge(injectDesignSystem(content.toString("utf8"), designSystemIdOf(store, req.params.pageId))) : content);
  });

  return app;
}
