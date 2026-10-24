import { existsSync } from "node:fs";
import { extname } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  MANIFEST_PATH,
  MAX_ASSET_BYTES,
  MAX_PAGE_BYTES,
  TWEAKS_PATH,
  MAX_ELEMENT_NAME_LENGTH,
  isSafePath,
  parseManifest,
  starterDesignSystemFiles,
  parseTweaks,
  tweakValueError,
  type SetTweakRequest,
  type CreateDesignSystemRequest,
  type CreatePageRequest,
  type CreateProjectRequest,
  type CreateReplyRequest,
  type CreateThreadRequest,
  type CreateVersionRequest,
  type SendHeldRequest,
  type SendHeldResponse,
  type UpdateThreadRequest,
  type ServerConfig,
  type Settings,
  type UpdatePageRequest,
  type UpdateProjectRequest,
} from "@redline/shared";
import { BRIDGE_PATH, BRIDGE_SOURCE, injectBridge, injectDesignSystem } from "./bridge.js";
import type { Store } from "./store.js";
import { registerAgentRoutes } from "./agents.js";
import { registerAgentApi } from "./agent-api.js";
import { designSystemIdOf, projectContext, readPageAsset, registerProjectFileRoutes } from "./project-files.js";
import { registerEventRoutes } from "./events.js";
import { withServedBy } from "./agent-selection.js";
import { PageLock } from "./page-lock.js";
import { designSystemError, filesError, modelChoiceError, modelChoiceOf, pageFilesError, requiredString, titleError, versionRequestError } from "./validation.js";
import { registerContextTracking } from "./context.js";
import { sourcePagesMessage } from "./design-system-source.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerRunRoutes } from "./runs.js";
import { registerArtboardHistoryRoutes } from "./artboard-history.js";
import { registerRequestHardening } from "./request-hardening.js";
import { registerDesignSystemReload } from "./design-system-reload.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerHomeRoutes } from "./home.js";
import { dispatchBatch, dispatchReply, dispatchThread } from "./work.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;


/** Answers a body over its limit with what to do about it, instead of Fastify's bare "Payload Too Large". */
function explainTooLarge(app: FastifyInstance): void {
  app.setErrorHandler(async (error, req, reply) => {
    if ((error as { code?: string }).code !== "FST_ERR_CTP_BODY_TOO_LARGE") return reply.send(error);
    const asset = /\/assets\//.test(req.url);
    // A body up to twice its limit is read to the end first, so the client gets this answer instead of a reset connection.
    const limit = asset ? MAX_ASSET_BYTES : MAX_PAGE_BYTES;
    if (Number(req.headers["content-length"] ?? Infinity) <= 2 * limit && !req.raw.readableEnded) {
      await new Promise((resolve) => req.raw.on("end", resolve).on("error", resolve).on("close", resolve).resume());
    }
    const message = asset
      ? `Asset too large: ${megabytes(MAX_ASSET_BYTES)} at most per file.`
      : `Page too heavy: a version carries ${megabytes(MAX_PAGE_BYTES)} at most. Put images and fonts in assets/ instead of inlining them in the HTML.`;
    return reply.code(413).header("connection", "close").send({ error: message });
  });
}

/** API and web UI. */
export async function buildMainApp(
  store: Store,
  config: ServerConfig,
  webDir?: string,
  options: { retryDelaysMs?: number[] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_PAGE_BYTES });
  registerRequestHardening(app);
  explainTooLarge(app);
  const agents = await registerAgentRoutes(app, store);
  const pageLock = new PageLock(store, agents, options.retryDelaysMs);
  app.addHook("onClose", async () => pageLock.dispose());
  await registerAgentApi(app, store, pageLock);
  await registerProjectFileRoutes(app, store);
  registerEventRoutes(app, store);
  registerDesignSystemReload(app, store);
  const runs = registerRunRoutes(app, store);
  registerHomeRoutes(app, store, pageLock);
  const knownWindows = new Map<string, number>();
  registerContextTracking(app, store, pageLock, knownWindows);
  const { sendMessage, lastWorkOf: lastConversationWork } = registerConversationRoutes(app, store, pageLock, knownWindows);
  registerSessionRoutes(app, store, pageLock, runs, lastConversationWork);
  registerArtboardHistoryRoutes(app, store);
  pageLock.restore();

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/queue", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return pageLock.waiting(req.params.pageId);
  });

  app.post<{ Params: { pageId: string; workId: string } }>("/api/pages/:pageId/runs/:workId/retry", async (req, reply) => {
    if (!pageLock.retry(req.params.workId)) return reply.code(404).send({ error: "no failed run to retry" });
    return reply.code(204).send();
  });

  app.get("/api/config", async () => config);

  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (req, reply) => {
    const { title, instructions, designSystem } = req.body ?? ({} as Partial<CreateProjectRequest>);
    if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
    if (instructions !== undefined && typeof instructions !== "string") {
      return reply.code(400).send({ error: "instructions must be a string" });
    }
    if (designSystem != null && typeof designSystem !== "string") {
      return reply.code(400).send({ error: "designSystem must be a string" });
    }
    return reply.code(201).send(store.createProject(title, undefined, instructions, designSystem ?? null));
  });

  app.get("/api/projects", async () => store.listProjects().map((project) => withServedBy(store, project)));

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const project = store.getProject(req.params.projectId);
    return project ? withServedBy(store, project) : reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { projectId: string }; Body: UpdateProjectRequest }>("/api/projects/:projectId", async (req, reply) => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const { title, globalTakeoverOverride } = req.body ?? ({} as Partial<UpdateProjectRequest>);
    if (title !== undefined && titleError(title)) return reply.code(400).send({ error: titleError(title) });
    if (globalTakeoverOverride !== undefined && globalTakeoverOverride !== null && typeof globalTakeoverOverride !== "boolean") {
      return reply.code(400).send({ error: "globalTakeoverOverride must be a boolean or null" });
    }
    if (title !== undefined) store.renameProject(req.params.projectId, title.trim());
    if (globalTakeoverOverride !== undefined) {
      store.setTakeoverOverride(req.params.projectId, globalTakeoverOverride);
      pageLock.reconsider();
    }
    return withServedBy(store, store.getProject(req.params.projectId)!);
  });

  app.get("/api/settings", async (): Promise<Settings> => ({ globalTakeover: store.getGlobalTakeover() }));

  app.patch<{ Body: Partial<Settings> }>("/api/settings", async (req, reply): Promise<Settings> => {
    const { globalTakeover } = req.body ?? {};
    if (globalTakeover !== undefined) {
      if (typeof globalTakeover !== "boolean") return reply.code(400).send({ error: "globalTakeover must be a boolean" });
      store.setGlobalTakeover(globalTakeover);
      pageLock.reconsider();
    }
    return { globalTakeover: store.getGlobalTakeover() };
  });

  app.post<{ Params: { projectId: string }; Body: CreatePageRequest }>(
    "/api/projects/:projectId/pages",
    async (req, reply) => {
      if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
      const { title, files } = req.body ?? ({} as Partial<CreatePageRequest>);
      if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
      const invalidFiles = pageFilesError(files);
      if (invalidFiles) return reply.code(400).send({ error: invalidFiles });
      return reply.code(201).send(store.createPage(req.params.projectId, title, files!));
    },
  );

  app.get("/api/design-systems", async () =>
    store.listDesignSystems().map((designSystem) => ({
      ...designSystem,
      usedBy: store.projectsUsingDesignSystem(designSystem.id),
      updatedAt: store.listVersions(designSystem.pageId)[0]?.createdAt,
    })),
  );

  app.post<{ Body: CreateDesignSystemRequest }>("/api/design-systems", async (req, reply) => {
    const { title, files = starterDesignSystemFiles(), fromProjectId, instructions, model, effort } =
      req.body ?? ({} as Partial<CreateDesignSystemRequest>);
    if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
    const invalidFiles = filesError(files);
    if (invalidFiles) return reply.code(400).send({ error: invalidFiles });
    if (instructions !== undefined && typeof instructions !== "string") return reply.code(400).send({ error: "instructions must be a string" });
    const invalidChoice = modelChoiceError({ model, effort });
    if (invalidChoice) return reply.code(400).send({ error: invalidChoice });
    const source = fromProjectId === undefined ? undefined : store.getProject(fromProjectId);
    if (fromProjectId !== undefined && !source) return reply.code(404).send({ error: "project not found" });
    const invalid = designSystemError(files);
    if (invalid) return reply.code(400).send({ error: invalid });
    const designSystem = store.createDesignSystem(title, files);
    const brief = instructions?.trim() ?? "";
    if (source || brief !== "") {
      const conversation = store.createConversation(designSystem.pageId, "Création du design system");
      const body = brief !== "" ? brief : `Derive this design system from the pages of the project "${source!.title}".`;
      // The source project's agent serves the run: it has the project's code.
      sendMessage(conversation, body, modelChoiceOf({ model, effort }), {
        projectId: source?.id,
        extraContext: source && sourcePagesMessage(store, source),
      });
    }
    return reply.code(201).send(designSystem);
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/working-copy", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const files = Object.fromEntries(
      Object.keys(page.version.files).map((path) => [path, store.readPageFile(page.id, path)!.toString("utf8")]),
    );
    return { files, ...projectContext(store, page.id) };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/pages", async (req) =>
    store.listPages(req.params.projectId),
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    return page ?? reply.code(404).send({ error: "page not found" });
  });

  app.patch<{ Params: { pageId: string }; Body: UpdatePageRequest }>("/api/pages/:pageId", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const title = req.body?.title;
    const invalid = titleError(title);
    if (invalid) return reply.code(400).send({ error: invalid });
    store.renamePage(req.params.pageId, (title as string).trim());
    return store.getPage(req.params.pageId);
  });

  app.post<{ Params: { pageId: string }; Body: CreateThreadRequest }>(
    "/api/pages/:pageId/threads",
    async (req, reply) => {
      if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
      const pin = req.body ?? ({} as Partial<CreateThreadRequest>);
      const isPct = (v: unknown) => typeof v === "number" && v >= 0 && v <= 100;
      if (!requiredString(pin.body)) return reply.code(400).send({ error: "body is required" });
      if (typeof pin.selector !== "string" || pin.selector === "") return reply.code(400).send({ error: "selector is required" });
      if (typeof pin.artboard !== "string" || !isSafePath(pin.artboard)) return reply.code(400).send({ error: "invalid artboard" });
      if (!isPct(pin.xPct) || !isPct(pin.yPct)) return reply.code(400).send({ error: "position must be a percentage" });
      if (pin.title !== undefined && !requiredString(pin.title)) return reply.code(400).send({ error: "title must be a non-empty string" });
      if (pin.held !== undefined && typeof pin.held !== "boolean") return reply.code(400).send({ error: "held must be a boolean" });
      if (pin.elementName !== undefined && (typeof pin.elementName !== "string" || pin.elementName.length > MAX_ELEMENT_NAME_LENGTH)) {
        return reply.code(400).send({ error: `elementName must be a string of at most ${MAX_ELEMENT_NAME_LENGTH} characters` });
      }
      const invalidChoice = modelChoiceError(pin);
      if (invalidChoice) return reply.code(400).send({ error: invalidChoice });
      const thread = store.createThread(req.params.pageId, pin as CreateThreadRequest);
      if (thread.status === "held") return reply.code(201).send(thread);
      dispatchThread(pageLock, store.getPage(req.params.pageId)!.projectId, thread, modelChoiceOf(pin));
      return reply.code(201).send(thread);
    },
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/threads", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listThreads(req.params.pageId);
  });

  // The user's reply in a thread: resumes the thread's session on the agent that opened it.
  app.post<{ Params: { threadId: string }; Body: CreateReplyRequest }>("/api/threads/:threadId/messages", async (req, reply) => {
    const thread = store.getThread(req.params.threadId);
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const body = req.body?.body;
    if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
    const invalidChoice = modelChoiceError(req.body);
    if (invalidChoice) return reply.code(400).send({ error: invalidChoice });
    const message = store.addReply(thread.id, body, "user")!;
    dispatchReply(store, pageLock, store.getPage(thread.pageId)!.projectId, thread, body, modelChoiceOf(req.body));
    return reply.code(201).send(message);
  });

  app.patch<{ Params: { threadId: string }; Body: UpdateThreadRequest }>("/api/threads/:threadId", async (req, reply) => {
    const body = req.body?.body;
    if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
    const thread = store.updateHeldThread(req.params.threadId, body);
    return thread ?? reply.code(409).send({ error: "only a held comment can be edited" });
  });

  app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (req, reply) => {
    if (!store.deleteHeldThread(req.params.threadId)) return reply.code(409).send({ error: "only a held comment can be deleted" });
    return reply.code(204).send();
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/held", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listHeldThreads(req.params.pageId);
  });

  // "Tout envoyer": the held comments of the page leave as one message to one session.
  app.post<{ Params: { pageId: string }; Body: SendHeldRequest }>("/api/pages/:pageId/send-held", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const invalidChoice = modelChoiceError(req.body ?? {});
    if (invalidChoice) return reply.code(400).send({ error: invalidChoice });
    const held = store.listHeldThreads(page.id);
    if (held.length > 0) {
      for (const thread of held) store.releaseHeldThread(thread.id);
      dispatchBatch(pageLock, page.projectId, held, modelChoiceOf(req.body ?? {}));
    }
    const response: SendHeldResponse = { threads: held.length };
    return response;
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
      const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId));
      if (invalid) return reply.code(400).send({ error: invalid });
      const { files, message, origin } = req.body;
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
    // Stored files can be anything a session wrote: served as a download, never rendered on the UI's origin.
    return reply
      .type("application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment")
      .send(content);
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

  // A page as it was in one version (history preview): same sandbox and injections as the live artboards, read-only.
  app.get<{ Params: { pageId: string; versionId: string; "*": string } }>("/page-versions/:pageId/:versionId/*", async (req, reply) =>
    serveArtboardFile(req.params.pageId, req.params["*"], reply, store.readVersionFile(req.params.pageId, req.params.versionId, req.params["*"])),
  );

  app.get<{ Params: { pageId: string; "*": string } }>("/pages/:pageId/*", async (req, reply) =>
    serveArtboardFile(req.params.pageId, req.params["*"], reply, store.readPageFile(req.params.pageId, req.params["*"])),
  );

  function serveArtboardFile(pageId: string, path: string, reply: FastifyReply, pageFile: Buffer | undefined) {
    const asset = pageFile ?? (path.startsWith("assets/") ? readPageAsset(store, pageId, path.slice("assets/".length)) : undefined);
    if (!asset) return reply.code(404).send("not found");
    // Artboards are opaque-origin, so fonts of the project assets need CORS to load.
    if (!pageFile) reply.header("access-control-allow-origin", "*");
    const content = asset;
    const isHtml = extname(path) === ".html";
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .type(MIME[extname(path)] ?? "application/octet-stream")
      .send(isHtml ? injectBridge(injectDesignSystem(content.toString("utf8"), designSystemIdOf(store, pageId))) : content);
  }

  return app;
}
