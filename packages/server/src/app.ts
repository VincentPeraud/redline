import { existsSync } from "node:fs";
import { extname } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  type PageViewSettings,
  COMPONENTS_CSS_PATH,
  DESIGN_SYSTEM_TOKENS_PATH,
  PROJECT_STYLE_PATH,
  parseTokens,
  MANIFEST_PATH,
  MAX_ASSET_BYTES,
  MAX_PAGE_BYTES,
  TWEAKS_PATH,
  parseManifest,
  starterDesignSystemFiles,
  parseTweaks,
  tweakValueError,
  type SetTweakRequest,
  type CreateDesignSystemRequest,
  type DesignSystemDetail,
  type DiffusionListItem,
  diffDiffusionStates,
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
  type MoveArtboardRequest,
  type UpdatePageRequest,
  type UpdateProjectRequest,
} from "@redline/shared";
import { BRIDGE_PATH, BRIDGE_SOURCE, injectBridge, injectDesignSystem } from "./bridge.js";
import type { Store } from "./store.js";
import { registerAgentRoutes } from "./agents.js";
import { registerAgentApi } from "./agent-api.js";
import { projectDesignSystem, registerProjectDesignSystemRoutes } from "./project-design-system.js";
import { designSystemIdOf, projectContext, readPageAsset, registerProjectFileRoutes } from "./project-files.js";
import { registerEventRoutes } from "./events.js";
import { withServedBy } from "./agent-selection.js";
import { PageLock } from "./page-lock.js";
import { newPageComponentsError, projectComponents, versionComponentsError } from "./components.js";
import { crossPageReferencesError } from "./cross-page-references.js";
import { createThreadRequestError, designSystemError, filesError, modelChoiceError, modelChoiceOf, pageFilesError, requiredString, titleError, versionRequestError, viewSettingsError } from "./validation.js";
import { registerContextTracking } from "./context.js";
import { sourcePagesMessage } from "./design-system-source.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerRunRoutes } from "./runs.js";
import { registerArtboardHistoryRoutes } from "./artboard-history.js";
import { registerRequestHardening } from "./request-hardening.js";
import { announceDiffusion, registerDesignSystemReload } from "./design-system-reload.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerHomeRoutes } from "./home.js";
import { moveArtboard } from "./move-artboard.js";
import { dispatchBatch, dispatchReply, dispatchThread } from "./work.js";

const PALETTE_TOKENS = ["--color-primary", "--color-text", "--color-background"];

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
  registerProjectDesignSystemRoutes(app, store);
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
      const invalid = invalidFiles ?? newPageComponentsError(store, req.params.projectId, title, files!);
      if (invalid) return reply.code(400).send({ error: invalid });
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

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId", async (req, reply): Promise<DesignSystemDetail | undefined> => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (!designSystem) return void reply.code(404).send({ error: "design system not found" });
    const current = store.currentDiffusion(designSystem.id)!;
    const usedBy = store.projectsUsingDesignSystem(designSystem.id);
    const draft = store.designSystemDraft(designSystem.id);
    const pending = diffDiffusionStates(store.diffusionState(designSystem.id, current.number), draft.state);
    const changed = new Set(pending.tokens.changed.map((token) => token.name));
    const overrides = usedBy.flatMap((project) => {
      const style = store.readProjectFile(project.id, PROJECT_STYLE_PATH)?.toString("utf8") ?? "";
      const tokens = parseTokens(style).map((token) => token.name).filter((name) => changed.has(name));
      return tokens.length > 0 ? [{ ...project, tokens }] : [];
    });
    const components = projectComponents(store, designSystem.id).components;
    const notDiffused = new Set([...pending.components.added, ...pending.components.changed]);
    const draftTokens = parseTokens(draft.state.tokensCss);
    const colours = draftTokens.filter((token) => token.isColor);
    const preferred = PALETTE_TOKENS.flatMap((name) => colours.filter((token) => token.name === name));
    const palette = [...preferred, ...colours.filter((token) => !preferred.includes(token))].slice(0, 3).map((token) => token.value);
    return {
      ...designSystem,
      pages: store.listPages(designSystem.id).map((page) => {
        const own = components.filter((component) => component.page.id === page.id).map((component) => component.name).sort();
        return { id: page.id, title: page.title, componentCount: own.length, componentNames: own, pendingCount: own.filter((name) => notDiffused.has(name)).length };
      }),
      usedBy: usedBy.map((project) => {
        const style = projectDesignSystem(store, project.id);
        return { ...project, overrideCount: style.overrideCount, componentCount: style.components.length };
      }),
      componentCount: components.length,
      tokenCount: draftTokens.length,
      palette,
      current,
      overrides,
      pending,
    };
  });

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/diffusions", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    const id = req.params.designSystemId;
    const diffusions = store.listDiffusions(id);
    return diffusions.map((diffusion, index): DiffusionListItem => {
      const previous = diffusions[index + 1];
      const before = previous ? store.diffusionState(id, previous.number) : { tokensCss: "", designMd: "", components: [] };
      return { ...diffusion, changes: diffDiffusionStates(before, store.diffusionState(id, diffusion.number)) };
    });
  });

  // User action only: Claude never diffuses (no equivalent in the agent API or the session tools).
  app.post<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/diffusions", async (req, reply) => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (!designSystem) return reply.code(404).send({ error: "design system not found" });
    const pending = diffDiffusionStates(store.diffusionState(designSystem.id, store.currentDiffusion(designSystem.id)!.number), store.designSystemDraft(designSystem.id).state);
    if (pending.count === 0) return reply.code(409).send({ error: "nothing to diffuse" });
    const created = store.createDiffusion(designSystem.id, "user");
    announceDiffusion(store, designSystem.id);
    return reply.code(201).send(created);
  });

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/tokens", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    return { content: store.readProjectFile(req.params.designSystemId, DESIGN_SYSTEM_TOKENS_PATH)?.toString("utf8") ?? "" };
  });

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/tokens/versions", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    return store.listDesignMdVersions(req.params.designSystemId, DESIGN_SYSTEM_TOKENS_PATH);
  });

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
    return page ? { ...page, viewSettings: store.getViewSettings(page.id) } : reply.code(404).send({ error: "page not found" });
  });

  app.post<{ Params: { pageId: string }; Body: PageViewSettings }>("/api/pages/:pageId/view-settings", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const invalid = viewSettingsError(req.body);
    if (invalid) return reply.code(400).send({ error: invalid });
    return store.setViewSettings(req.params.pageId, req.body);
  });

  app.post<{ Params: { pageId: string }; Body: Partial<MoveArtboardRequest> }>("/api/pages/:pageId/move-artboard", async (req, reply) => {
    const outcome = moveArtboard(store, pageLock, req.params.pageId, req.body, { origin: "restore" });
    return reply.code(outcome.status).send(outcome.body);
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
      const invalid = createThreadRequestError(req.body);
      if (invalid) return reply.code(400).send({ error: invalid });
      const request = req.body;
      if ("target" in request && request.target.kind === "artboard" && !store.hasArtboard(req.params.pageId, request.target.artboard)) {
        return reply.code(400).send({ error: "artboard is not on the page" });
      }
      if ("target" in request && request.target.kind === "canvas-element" && !store.canvasElement(req.params.pageId, request.target.elementId)) {
        return reply.code(400).send({ error: "element is not on the page's canvas" });
      }
      const thread = store.createThread(req.params.pageId, request);
      if (thread.status === "held") return reply.code(201).send(thread);
      dispatchThread(pageLock, store.getPage(req.params.pageId)!.projectId, thread, modelChoiceOf(request));
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
      const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId)) ?? crossPageReferencesError(store, req.params.pageId, req.body.files) ?? versionComponentsError(store, req.params.pageId, req.body.files);
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

  const sendStylesheet = (reply: FastifyReply, css: string | Buffer, cacheControl = "no-cache") =>
    reply.header("content-security-policy", "sandbox allow-scripts").header("cache-control", cacheControl).type(MIME[".css"]).send(css);

  app.get<{ Params: { designSystemId: string; number: string; file: string } }>("/design-systems/:designSystemId/diffusions/:number/:file", async (req, reply) => {
    const { designSystemId, number, file } = req.params;
    const content = file === "tokens.css" || file === "components.css" ? store.readDiffusionFile(designSystemId, Number(number), file) : undefined;
    if (content === undefined) return reply.code(404).send("not found");
    return sendStylesheet(reply, content, "public, max-age=31536000, immutable");
  });

  // One component alone, for the diffusion dialog: with the files of `?diffusion=n` (before) or the draft (after).
  app.get<{ Params: { designSystemId: string; name: string }; Querystring: { diffusion?: string } }>("/design-systems/:designSystemId/component-previews/:name", async (req, reply) => {
    const { designSystemId, name } = req.params;
    if (!store.getDesignSystem(designSystemId)) return reply.code(404).send("not found");
    const component = store.designSystemDraft(designSystemId).assembly.components.find((c) => c.name === name);
    const html = component && store.readPageFile(component.page.id, component.file)?.toString("utf8");
    if (html === undefined) return reply.code(404).send("not found");
    const diffusion = req.query.diffusion === undefined ? undefined : Number(req.query.diffusion);
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .header("cache-control", "no-cache")
      .type(MIME[".html"])
      // The component's own style blocks are what components.css assembles: dropped here so that the chosen diffusion's css decides.
      .send(injectDesignSystem(html.replace(/<style\b[^>]*\bdata-component\b[^>]*>[\s\S]*?<\/style>/gi, ""), designSystemId, undefined, diffusion));
  });

  app.get<{ Params: { designSystemId: string; "*": string } }>("/design-systems/:designSystemId/*", async (req, reply) => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (designSystem && req.params["*"] === COMPONENTS_CSS_PATH) return sendStylesheet(reply, projectComponents(store, designSystem.id).css);
    const content = designSystem && req.params["*"] === DESIGN_SYSTEM_TOKENS_PATH ? store.readProjectFile(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH) : undefined;
    if (!content) return reply.code(404).send("not found");
    return sendStylesheet(reply, content);
  });

  app.get<{ Params: { projectId: string } }>(`/projects/:projectId/${COMPONENTS_CSS_PATH}`, async (req, reply) =>
    store.projectExists(req.params.projectId) ? sendStylesheet(reply, projectComponents(store, req.params.projectId).css) : reply.code(404).send("not found"),
  );

  app.get<{ Params: { projectId: string; "*": string } }>("/project-styles/:projectId/*", async (req, reply) => {
    const { projectId } = req.params;
    if (!store.projectExists(projectId) || store.isDesignSystemProject(projectId) || req.params["*"] !== PROJECT_STYLE_PATH) return reply.code(404).send("not found");
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .header("cache-control", "no-cache")
      .type(MIME[extname(PROJECT_STYLE_PATH)] ?? "text/css")
      .send(store.readProjectFile(projectId, PROJECT_STYLE_PATH) ?? "");
  });

  // A page as it was in one version (history preview): same sandbox and injections as the live artboards, read-only.
  app.get<{ Params: { pageId: string; versionId: string; "*": string } }>("/page-versions/:pageId/:versionId/*", async (req, reply) =>
    serveArtboardFile(req.params.pageId, req.params["*"], reply, store.readVersionFile(req.params.pageId, req.params.versionId, req.params["*"]), req.params.versionId),
  );

  app.get<{ Params: { pageId: string; "*": string } }>("/pages/:pageId/*", async (req, reply) =>
    serveArtboardFile(req.params.pageId, req.params["*"], reply, store.readPageFile(req.params.pageId, req.params["*"])),
  );

  /** The page's project when it has a project style (every project but a design system's own). */
  function projectStyleProjectOf(pageId: string): string | undefined {
    const projectId = store.getPage(pageId)?.projectId;
    return projectId !== undefined && !store.isDesignSystemProject(projectId) ? projectId : undefined;
  }

  /** The design system a page is rendered with: its own project's when it is a design system page, else the one its manifest names. */
  function renderedDesignSystemOf(pageId: string, versionId?: string): string {
    return store.designSystemOfPage(pageId)?.id ?? designSystemIdOf(store, pageId, versionId);
  }

  /** Diffusion a page is rendered with: the current one for a project's pages, the one recorded with the version for a version preview, none (the draft) for a design system's own pages. */
  function diffusionOf(pageId: string, versionId?: string): number | undefined {
    if (store.isDesignSystemPage(pageId)) return undefined;
    if (versionId !== undefined) return store.versionDiffusion(pageId, versionId);
    return store.currentDiffusion(renderedDesignSystemOf(pageId))?.number;
  }

  function serveArtboardFile(pageId: string, path: string, reply: FastifyReply, pageFile: Buffer | undefined, versionId?: string) {
    const asset = pageFile ?? (path.startsWith("assets/") ? readPageAsset(store, pageId, path.slice("assets/".length)) : undefined);
    if (!asset) return reply.code(404).send("not found");
    // Artboards are opaque-origin, so fonts of the project assets need CORS to load.
    if (!pageFile) reply.header("access-control-allow-origin", "*");
    const content = asset;
    const isHtml = extname(path) === ".html";
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .type(MIME[extname(path)] ?? "application/octet-stream")
      .send(isHtml ? injectBridge(injectDesignSystem(content.toString("utf8"), renderedDesignSystemOf(pageId, versionId), projectStyleProjectOf(pageId), diffusionOf(pageId, versionId))) : content);
  }

  return app;
}
