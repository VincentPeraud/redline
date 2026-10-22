import { existsSync } from "node:fs";
import { extname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { CreatePageRequest, ServerConfig } from "@redline/shared";
import type { Store } from "./store.js";
import { registerAgentRoutes } from "./agents.js";

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

function isSafePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.split("/").includes("..");
}

/** API and web UI. */
export async function buildMainApp(store: Store, config: ServerConfig, webDir?: string): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAgentRoutes(app, store);

  app.get("/api/config", async () => config);

  app.post<{ Body: { title: string } }>("/api/projects", async (req, reply) => {
    const { title } = req.body ?? {};
    if (typeof title !== "string" || title.trim() === "") return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send(store.createProject(title));
  });

  app.get("/api/projects", async () => store.listProjects());

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
      return reply.code(201).send(store.createPage(req.params.projectId, title, type, files));
    },
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/pages", async (req) =>
    store.listPages(req.params.projectId),
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    return page ?? reply.code(404).send({ error: "page not found" });
  });

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

  app.get<{ Params: { pageId: string; "*": string } }>("/pages/:pageId/*", async (req, reply) => {
    const path = req.params["*"];
    const content = store.readPageFile(req.params.pageId, path);
    if (!content) return reply.code(404).send("not found");
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .type(MIME[extname(path)] ?? "application/octet-stream")
      .send(content);
  });

  return app;
}
