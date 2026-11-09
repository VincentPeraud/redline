import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  type PageViewSettings,
  type TerminalHolder,
  COMPONENTS_CSS_PATH,
  withoutComponentStyles,
  DESIGN_SYSTEM_TOKENS_PATH,
  PROJECT_STYLE_PATH,
  parseTokens,
  MANIFEST_PATH,
  MAX_FIT_HEIGHT,
  MAX_ASSET_BYTES,
  MAX_PAGE_BYTES,
  TWEAKS_PATH,
  parseManifest,
  starterDesignSystemFiles,
  parseTweaks,
  tweakValueError,
  type SetTweakRequest,
  type CreateDesignSystemRequest,
  type ChangeRecord,
  type DesignSystemDetail,
  type DiffusionListItem,
  type DiffusionReview,
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
  type FitArtboardHeightRequest,
  type MoveArtboardRequest,
  type UpdatePageRequest,
  type UpdateProjectRequest,
  type ProjectSharing,
  type ProjectVisibility,
  CLI_TARBALL_PATH,
  ARTBOARD_CAPABILITY_SEGMENT,
} from "@redline/shared";
import { BRIDGE_PATH, BRIDGE_SOURCE, ERRORS_PATH, ERRORS_SOURCE, injectBridge, injectDesignSystem } from "./bridge.js";
import { INSTANCES_PATH, INSTANCES_SOURCE, injectInstances, instanceLayersOf } from "./instances.js";
import type { Store } from "./store.js";
import { registerAgentRoutes } from "./agents.js";
import { registerAgentApi } from "./agent-api.js";
import { TerminalSessions } from "./terminal-sessions.js";
import { projectDesignSystem, registerProjectDesignSystemRoutes } from "./project-design-system.js";
import { projectContext, readPageAsset, readProjectAsset, registerProjectFileRoutes } from "./project-files.js";
import { registerEventRoutes } from "./events.js";
import { withServedBy } from "./agent-selection.js";
import { PageLock } from "./page-lock.js";
import { removalsError, rollbackImpact } from "./removals.js";
import { diffusionReview, reviewLineCount } from "./diffusion-review.js";
import { componentComparison } from "./component-comparison.js";
import { brokenPagesAtDiffusion, instanceChangesError, rollbackInstancesError } from "./instance-guards.js";
import { settleMovedUp } from "./move-up.js";
import { refuseChange, refuseRequest, relaunchUndo } from "./refusals.js";
import { settleUndoneChanges } from "./undone-changes.js";
import { closeDiffusedRequests, requestsClosedBy, returnPendingOn } from "./diffusion-returns.js";
import { newPageComponentsError, projectComponents, versionComponentsError } from "./components.js";
import { crossPageReferencesError } from "./cross-page-references.js";
import { createThreadRequestError, designSystemError, filesError, modelChoiceError, modelChoiceOf, pageFilesError, isVisibility, requiredString, titleError, versionRequestError, viewSettingsError } from "./validation.js";
import { registerContextTracking } from "./context.js";
import { sourcePagesMessage } from "./design-system-source.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerRunRoutes } from "./runs.js";
import { registerArtboardHistoryRoutes } from "./artboard-history.js";
import { validTimeZone } from "./version-dates.js";
import { registerGapRoutes } from "./gaps.js";
import type { ArtboardCapabilities } from "./artboard-capabilities.js";
import { createAccess, registerAccess, type Access, type AuthMode } from "./access.js";
import { DEFAULT_IDENTITY, registerIdentity, personRef, type IdentityConfig } from "./identity.js";
import { type CliBuild } from "./cli-build.js";
import { registerHealthRoute, registerProxySecretCheck, type ProxySecrets } from "./proxy-secrets.js";
import { registerPublicDeadline } from "./public-deadline.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerRequestHardening } from "./request-hardening.js";
import { announceDiffusion, registerDesignSystemReload } from "./design-system-reload.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerHomeRoutes } from "./home.js";
import { archivedError, registerArchiveRoutes, registerArchivedGuard } from "./archive.js";
import { moveArtboard } from "./move-artboard.js";
import { dispatchBatch, dispatchReply, dispatchThread, handOverThread } from "./work.js";

const PALETTE_TOKENS = ["--color-primary", "--color-text", "--color-background"];

/** Up to three colours that sum up a design system's tokens: the main tokens first, then the others in order. */
function paletteOf(tokensCss: string): string[] {
  const colours = parseTokens(tokensCss).filter((token) => token.isColor);
  const preferred = PALETTE_TOKENS.flatMap((name) => colours.filter((token) => token.name === name));
  return [...preferred, ...colours.filter((token) => !preferred.includes(token))].slice(0, 3).map((token) => token.value);
}

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
  options: { retryDelaysMs?: number[]; terminalPresenceTimeoutMs?: number; proxySecrets?: ProxySecrets; identity?: IdentityConfig; authMode?: AuthMode; cliBuild?: CliBuild; publicUntil?: Date; capabilities?: ArtboardCapabilities } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_PAGE_BYTES });
  registerPublicDeadline(app, options.publicUntil);
  registerProxySecretCheck(app, options.proxySecrets);
  registerHealthRoute(app);
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const authMode = options.authMode ?? (options.proxySecrets ? "proxy" : "none");
  const access = createAccess({ mode: authMode, store, secrets: options.proxySecrets, identity });
  registerAccess(app, access);
  registerIdentity(app, identity, authMode);
  if (authMode === "local") registerAccountRoutes(app, store);
  const { cliBuild } = options;
  store.setServerBuildHash(cliBuild?.hash);
  if (cliBuild) {
    app.get(CLI_TARBALL_PATH, async (_req, reply) =>
      reply.type("application/gzip").header("content-disposition", 'attachment; filename="redline-cli.tgz"').send(createReadStream(cliBuild.tarballPath)),
    );
  }
  registerRequestHardening(app, { requireJsonOrHeader: authMode === "local" });
  explainTooLarge(app);
  registerArchivedGuard(app, store);
  const agents = await registerAgentRoutes(app, store);
  const pageLock = new PageLock(store, agents, options.retryDelaysMs);
  app.addHook("onClose", async () => pageLock.dispose());
  const terminalSessions = new TerminalSessions(store, pageLock, options.terminalPresenceTimeoutMs);
  app.addHook("onClose", async () => terminalSessions.dispose());
  await registerAgentApi(app, store, pageLock, terminalSessions);
  await registerProjectFileRoutes(app, store);
  registerProjectDesignSystemRoutes(app, store);
  registerEventRoutes(app, store, pageLock, access);
  registerDesignSystemReload(app, store);
  const runs = registerRunRoutes(app, store);
  registerHomeRoutes(app, store, pageLock, access);
  registerArchiveRoutes(app, store, pageLock, (pageIds) => returnPendingOn(store, pageLock, terminalSessions, pageIds));
  const knownWindows = new Map<string, number>();
  registerContextTracking(app, store, pageLock, knownWindows);
  const { sendMessage, lastWorkOf: lastConversationWork } = registerConversationRoutes(app, store, pageLock, knownWindows);
  registerSessionRoutes(app, store, pageLock, runs, lastConversationWork, access);
  registerArtboardHistoryRoutes(app, store);
  registerGapRoutes(app, store);
  pageLock.restore();
  terminalSessions.restore();

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/queue", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return pageLock.waiting(req.params.pageId);
  });

  app.post<{ Params: { pageId: string; workId: string } }>("/api/pages/:pageId/runs/:workId/retry", async (req, reply) => {
    // The item must be one of this page's: the archive guard judged the request by its page.
    if (pageLock.itemOf(req.params.workId)?.pageId !== req.params.pageId || !pageLock.retry(req.params.workId)) {
      return reply.code(404).send({ error: "no failed run to retry" });
    }
    return reply.code(204).send();
  });

  app.get("/api/config", async () => config);

  // The pass the app puts in artboard urls; `registerAccess` has already asked `may` for this project.
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/artboard-capability", async (req, reply) => {
    if (!options.capabilities) return reply.code(404).send({ error: "artboard capabilities are not available" });
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return options.capabilities.issueFor(access, req.viewer, req.params.projectId) ?? reply.code(403).send({ error: "forbidden" });
  });

  app.post<{ Body: CreateProjectRequest }>("/api/projects", async (req, reply) => {
    const { title, instructions, designSystem, visibility } = req.body ?? ({} as Partial<CreateProjectRequest>);
    if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
    if (visibility !== undefined && !isVisibility(visibility)) return reply.code(400).send({ error: "visibility must be team or private" });
    if (instructions !== undefined && typeof instructions !== "string") {
      return reply.code(400).send({ error: "instructions must be a string" });
    }
    if (designSystem != null && typeof designSystem !== "string") {
      return reply.code(400).send({ error: "designSystem must be a string" });
    }
    if (designSystem && store.isArchived(designSystem)) return reply.code(400).send({ error: "This design system is archived: choose another one." });
    return reply.code(201).send(store.createProject(title, undefined, instructions, designSystem ?? null, { createdBy: req.person, visibility }));
  });

  app.get<{ Querystring: { archived?: string } }>("/api/projects", async (req) =>
    store
      .listProjects(req.query.archived ? "archived" : "active")
      .filter((project) => access.may(req.viewer, "read", { projectId: project.id }))
      .map((project) => withServedBy(store, project)),
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/sharing", async (req, reply): Promise<ProjectSharing | undefined> => {
    const project = store.getProject(req.params.projectId);
    if (!project) return void reply.code(404).send({ error: "project not found" });
    const accounts = store.accounts.activeAccounts();
    const wouldLoseAccess = project.visibility === "private" ? [] : accounts.filter((a) => a.role !== "admin" && a.id !== project.createdBy?.id).map(({ role: _role, ...person }) => person);
    return { visibility: project.visibility, accountCount: accounts.length, ...(project.createdBy ? { createdBy: project.createdBy } : {}), canChange: access.manages(req.viewer, project.id), wouldLoseAccess };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const project = store.getProject(req.params.projectId);
    return project ? withServedBy(store, project) : reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { projectId: string }; Body: UpdateProjectRequest }>("/api/projects/:projectId", async (req, reply) => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    const { title, globalTakeoverOverride, visibility } = req.body ?? ({} as Partial<UpdateProjectRequest>);
    if (title !== undefined && titleError(title)) return reply.code(400).send({ error: titleError(title) });
    if (globalTakeoverOverride !== undefined && globalTakeoverOverride !== null && typeof globalTakeoverOverride !== "boolean") {
      return reply.code(400).send({ error: "globalTakeoverOverride must be a boolean or null" });
    }
    if (visibility !== undefined) {
      if (!isVisibility(visibility)) return reply.code(400).send({ error: "visibility must be team or private" });
      if (!access.manages(req.viewer, req.params.projectId)) return reply.code(403).send({ error: "Only the creator of the project or an admin changes who sees it." });
      store.setProjectVisibility(req.params.projectId, visibility);
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
      return reply.code(201).send(store.createPage(req.params.projectId, title, files!, "user", req.person));
    },
  );

  app.get<{ Querystring: { archived?: string } }>("/api/design-systems", async (req) =>
    (req.query.archived ? store.listArchivedDesignSystems() : store.listChoosableDesignSystems()).map((designSystem) => {
      const { draft } = store.pendingDiffusion(designSystem.id);
      return {
        ...designSystem,
        usedBy: store.projectsUsingDesignSystem(designSystem.id).filter((project) => access.may(req.viewer, "read", { projectId: project.id })),
        updatedAt: store.listVersions(designSystem.pageId)[0]?.createdAt,
        pendingChanges: reviewLineCount(diffusionReview(store, designSystem.id)),
        requests: store.listDesignSystemRequests(designSystem.id).length,
        pageCount: store.listPages(designSystem.id).length,
        componentCount: draft.assembly.components.length,
        diffusion: store.currentDiffusion(designSystem.id)!.number,
        palette: paletteOf(draft.state.tokensCss),
      };
    }),
  );

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId", async (req, reply): Promise<DesignSystemDetail | undefined> => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (!designSystem) return void reply.code(404).send({ error: "design system not found" });
    const current = store.currentDiffusion(designSystem.id)!;
    const usedBy = store.projectsUsingDesignSystem(designSystem.id).filter((project) => access.may(req.viewer, "read", { projectId: project.id }));
    const { draft, pending } = store.pendingDiffusion(designSystem.id);
    const changed = new Set(pending.tokens.changed.map((token) => token.name));
    const overrides = usedBy.flatMap((project) => {
      const style = store.readProjectText(project.id, PROJECT_STYLE_PATH);
      const tokens = parseTokens(style).map((token) => token.name).filter((name) => changed.has(name));
      return tokens.length > 0 ? [{ ...project, tokens }] : [];
    });
    const components = projectComponents(store, designSystem.id).components;
    const notDiffused = new Set([...pending.components.added, ...pending.components.changed]);
    const draftTokens = parseTokens(draft.state.tokensCss);
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
      palette: paletteOf(draft.state.tokensCss),
      current,
      overrides,
      pending,
      reviewLines: reviewLineCount(diffusionReview(store, designSystem.id)),
      requests: store.listDesignSystemRequests(designSystem.id),
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

  // The changes recorded since the current diffusion, for the review (tickets 12 and following).
  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/changes", async (req, reply): Promise<ChangeRecord[] | undefined> => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    return store.listChanges(req.params.designSystemId);
  });

  // What the Diffuse dialog reviews: tokens, DESIGN.md and one card per changed component.
  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/review", async (req, reply): Promise<DiffusionReview | undefined> => {
    if (!store.getDesignSystem(req.params.designSystemId)) return void reply.code(404).send({ error: "design system not found" });
    return diffusionReview(store, req.params.designSystemId);
  });

  // The before / after view of one component (the diffused and the draft artboard, numbered markers).
  app.get<{ Params: { designSystemId: string; name: string } }>("/api/design-systems/:designSystemId/components/:name/comparison", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    const comparison = componentComparison(store, req.params.designSystemId, req.params.name);
    return comparison ?? reply.code(404).send({ error: "component has no pending change" });
  });

  // "Refuser" is a user action of the web UI: on a change born of a request, or on a whole request.
  app.post<{ Params: { changeId: string }; Body: { answer?: unknown } | undefined }>("/api/changes/:changeId/refuse", async (req, reply) => {
    const outcome = refuseChange(store, pageLock, terminalSessions, req.params.changeId, req.body?.answer);
    return reply.code(outcome.status).send(outcome.body);
  });
  app.post<{ Params: { changeId: string } }>("/api/changes/:changeId/relaunch", async (req, reply) => {
    const outcome = relaunchUndo(store, pageLock, terminalSessions, req.params.changeId);
    return reply.code(outcome.status).send(outcome.body);
  });
  app.post<{ Params: { threadId: string }; Body: { answer?: unknown } | undefined }>("/api/threads/:threadId/refuse", async (req, reply) => {
    const outcome = refuseRequest(store, pageLock, terminalSessions, req.params.threadId, req.body?.answer);
    return reply.code(outcome.status).send(outcome.body);
  });

  // User action only: Claude never diffuses (no equivalent in the agent API or the session tools).
  app.post<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/diffusions", async (req, reply) => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (!designSystem) return reply.code(404).send({ error: "design system not found" });
    if (store.pendingDiffusion(designSystem.id).pending.count === 0) return reply.code(409).send({ error: "nothing to diffuse" });
    if (store.listChanges(designSystem.id).some((change) => change.state === "refused")) return reply.code(409).send({ error: "A refused change is not undone in the draft yet." });
    const broken = brokenPagesAtDiffusion(store, designSystem.id);
    const closing = requestsClosedBy(store, designSystem.id);
    const created = store.createDiffusion(designSystem.id, "user");
    closeDiffusedRequests(store, pageLock, terminalSessions, closing, created.number);
    settleMovedUp(store, designSystem.id);
    announceDiffusion(store, designSystem.id);
    // A removal the user confirmed breaks instances: each affected page gets a thread signed Redline, routed like any thread.
    for (const { pageId, artboard, breaks } of broken) {
      const body = `Le design system « ${designSystem.title} » a retiré ce que cette page utilise : ${breaks.join(", ")}. Mets à jour les instances concernées.`;
      const thread = store.createThread(pageId, { target: { kind: "artboard", artboard }, title: "Retrait dans le design system", body }, undefined, true);
      dispatchThread(pageLock, store.getPage(pageId)!.projectId, thread, modelChoiceOf({}), terminalSessions);
    }
    return reply.code(201).send(created);
  });

  // Undo and rollback add pointers, they delete nothing: the design system's pages (the draft) stay as they are.
  app.post<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/diffusions/undo", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    const back = store.undoDiffusion(req.params.designSystemId);
    if (!back) return reply.code(409).send({ error: "nothing to undo" });
    announceDiffusion(store, req.params.designSystemId);
    return back;
  });

  /** The diffusion number to roll back to, or the status and message to answer. */
  function rollbackTarget(designSystemId: string, number: string): { target: number } | { status: number; error: string } {
    const target = Number(number);
    if (!store.getDesignSystem(designSystemId) || !store.listDiffusions(designSystemId).some((d) => d.number === target)) return { status: 404, error: "diffusion not found" };
    if (store.currentDiffusion(designSystemId)!.number === target) return { status: 409, error: "already the current diffusion" };
    return { target };
  }

  app.get<{ Params: { designSystemId: string; number: string } }>("/api/design-systems/:designSystemId/diffusions/:number/rollback-impact", async (req, reply) => {
    const found = rollbackTarget(req.params.designSystemId, req.params.number);
    if ("error" in found) return reply.code(found.status).send({ error: found.error });
    return rollbackImpact(store, req.params.designSystemId, found.target);
  });

  app.post<{ Params: { designSystemId: string; number: string } }>("/api/design-systems/:designSystemId/diffusions/:number/rollback", async (req, reply) => {
    const found = rollbackTarget(req.params.designSystemId, req.params.number);
    if ("error" in found) return reply.code(found.status).send({ error: found.error });
    const lacking = rollbackInstancesError(store, req.params.designSystemId, found.target);
    if (lacking) return reply.code(409).send({ error: lacking });
    const created = store.rollbackDiffusion(req.params.designSystemId, found.target);
    announceDiffusion(store, req.params.designSystemId);
    return reply.code(201).send(created);
  });

  app.get<{ Params: { designSystemId: string } }>("/api/design-systems/:designSystemId/tokens", async (req, reply) => {
    if (!store.getDesignSystem(req.params.designSystemId)) return reply.code(404).send({ error: "design system not found" });
    return { content: store.readProjectText(req.params.designSystemId, DESIGN_SYSTEM_TOKENS_PATH) };
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
    if (source?.archivedAt) return reply.code(409).send({ error: archivedError(store, source.id) });
    const invalid = designSystemError(files);
    if (invalid) return reply.code(400).send({ error: invalid });
    const designSystem = store.createDesignSystem(title, files);
    const brief = instructions?.trim() ?? "";
    if (source || brief !== "") {
      const conversation = store.createConversation(designSystem.pageId, "Création du design system", req.person);
      const body = brief !== "" ? brief : `Derive this design system from the pages of the project "${source!.title}".`;
      // The source project's agent serves the run: it has the project's code.
      sendMessage(conversation, body, modelChoiceOf({ model, effort }), {
        projectId: source?.id,
        extraContext: source && sourcePagesMessage(store, source),
        person: req.person,
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

  // The project's pages; `?archived=1` lists its archived pages instead, the most recently archived first.
  app.get<{ Params: { projectId: string }; Querystring: { archived?: string } }>("/api/projects/:projectId/pages", async (req) =>
    store.listPages(req.params.projectId, req.query.archived ? "archived" : "active"),
  );

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    return page ? { ...page, viewSettings: store.getViewSettings(page.id), designSystem: store.isDesignSystemProject(page.projectId) } : reply.code(404).send({ error: "page not found" });
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/terminal-holder", async (req, reply): Promise<TerminalHolder | null> => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return terminalSessions.holderOf(req.params.pageId) ?? null;
  });

  // "Confier la page à l'agent": the hold ends and what waited for the terminal session goes to the agents, until a terminal session publishes again.
  app.post<{ Params: { pageId: string } }>("/api/pages/:pageId/terminal-release", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    terminalSessions.releasePage(req.params.pageId, { handedOverBy: req.person });
    return reply.code(204).send();
  });

  app.post<{ Params: { pageId: string }; Body: PageViewSettings }>("/api/pages/:pageId/view-settings", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const invalid = viewSettingsError(req.body);
    if (invalid) return reply.code(400).send({ error: invalid });
    return store.setViewSettings(req.params.pageId, req.body);
  });

  app.post<{ Params: { pageId: string }; Body: Partial<MoveArtboardRequest> }>("/api/pages/:pageId/move-artboard", async (req, reply) => {
    const outcome = moveArtboard(store, pageLock, req.params.pageId, req.body, { origin: "user", ref: personRef(req) });
    return reply.code(outcome.status).send(outcome.body);
  });

  // "Ajuster la hauteur au contenu": the page height the viewer's browser measured becomes the artboard's height.
  app.post<{ Params: { pageId: string }; Body: Partial<FitArtboardHeightRequest> }>("/api/pages/:pageId/fit-height", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const { file, height } = req.body ?? {};
    if (typeof file !== "string" || !store.hasArtboard(page.id, file)) return reply.code(404).send({ error: `${String(file)} is not an artboard of "${page.title}"` });
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > MAX_FIT_HEIGHT) return reply.code(400).send({ error: `height must be a positive number of at most ${MAX_FIT_HEIGHT}` });
    const manifestText = store.readPageFile(page.id, MANIFEST_PATH)?.toString("utf8");
    const artboard = manifestText === undefined ? undefined : parseManifest(manifestText).artboards.find((a) => a.file === file);
    if (artboard?.fitHeight || artboard?.responsive || artboard?.matrix) {
      return reply.code(400).send({ error: `${file} already follows the height of its page, or has no single height` });
    }
    if (pageLock.isHeldByOther(page.id)) return reply.code(409).send({ error: `A session is working on "${page.title}": try again once it is done.` });
    const rounded = Math.ceil(height);
    return reply.code(201).send(store.setArtboardHeight(page.id, file, rounded, `Hauteur de ${file} ajustée au contenu (${rounded} px)`, "user", personRef(req)));
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
      const thread = store.createThread(req.params.pageId, request, req.person);
      if (thread.status === "held") return reply.code(201).send(thread);
      dispatchThread(pageLock, store.getPage(req.params.pageId)!.projectId, thread, modelChoiceOf(request), terminalSessions);
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
    const message = store.addReply(thread.id, body, "user", [], req.person)!;
    dispatchReply(store, pageLock, store.getPage(thread.pageId)!.projectId, thread, body, modelChoiceOf(req.body), terminalSessions);
    return reply.code(201).send(message);
  });

  // "Confier à l'agent": a thread waiting for the terminal session goes to the agents; the page stays held.
  app.post<{ Params: { threadId: string } }>("/api/threads/:threadId/hand-over", async (req, reply) => {
    if (!store.getThread(req.params.threadId)) return reply.code(404).send({ error: "thread not found" });
    if (!handOverThread(store, pageLock, req.params.threadId, req.person)) return reply.code(409).send({ error: "this thread is not waiting for a terminal session" });
    return reply.code(204).send();
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
      dispatchBatch(pageLock, page.projectId, held, modelChoiceOf(req.body ?? {}), terminalSessions);
    }
    const response: SendHeldResponse = { threads: held.length };
    return response;
  });

  // The only way to resolve a thread: a user action of the web UI. Agents get no such route.
  app.post<{ Params: { threadId: string } }>("/api/threads/:threadId/resolve", async (req, reply) => {
    // A request closes by a diffusion or a refusal, never by "Résoudre".
    if (store.getThread(req.params.threadId)?.request) return reply.code(409).send({ error: "a request to the design system cannot be resolved" });
    const thread = store.resolveThread(req.params.threadId);
    return thread ?? reply.code(404).send({ error: "thread not found" });
  });

  // A user action of the web UI too: a resolved thread goes back to the open threads, without starting a run.
  app.post<{ Params: { threadId: string } }>("/api/threads/:threadId/reopen", async (req, reply) => {
    const thread = store.reopenThread(req.params.threadId);
    if (thread) return thread;
    if (!store.getThread(req.params.threadId)) return reply.code(404).send({ error: "thread not found" });
    return reply.code(409).send({ error: "only a resolved thread can be reopened" });
  });

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/versions", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listVersions(req.params.pageId);
  });

  app.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>(
    "/api/pages/:pageId/versions",
    async (req, reply) => {
      if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
      const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId)) ?? crossPageReferencesError(store, req.params.pageId, req.body.files) ?? versionComponentsError(store, req.params.pageId, req.body.files) ?? removalsError(store, req.params.pageId, req.body.files, req.body.files[DESIGN_SYSTEM_TOKENS_PATH], req.body.confirmRemovals === true) ?? instanceChangesError(store, req.params.pageId, req.body.files, req.body.confirmRemovals === true);
      if (invalid) return reply.code(400).send({ error: invalid });
      const { files, message, origin } = req.body;
      const version = store.addVersion(req.params.pageId, files, message, origin, personRef(req));
      settleUndoneChanges(store, req.params.pageId);
      return reply.code(201).send(version);
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
      .send(store.setPageFile(page.id, TWEAKS_PATH, JSON.stringify(values, null, 2), `Tweak: ${tweak.label} = ${value}`, "tweak", personRef(req)));
  });

  app.post<{ Params: { pageId: string; versionId: string }; Body: { timeZone?: string } | undefined }>(
    "/api/pages/:pageId/versions/:versionId/restore",
    async (req, reply) => {
      const timeZone = req.body?.timeZone;
      if (!validTimeZone(timeZone)) return reply.code(400).send({ error: "invalid timeZone" });
      const files = store.readVersionFiles(req.params.pageId, req.params.versionId);
      // Restoring publishes the old files again: the same checks as a publish apply.
      const invalid = files && (versionComponentsError(store, req.params.pageId, files) ?? removalsError(store, req.params.pageId, files, undefined, false) ?? instanceChangesError(store, req.params.pageId, files, false));
      if (invalid) return reply.code(400).send({ error: invalid });
      const restored = store.restoreVersion(req.params.pageId, req.params.versionId, personRef(req), timeZone);
      if (restored) settleUndoneChanges(store, req.params.pageId);
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
export async function buildArtboardApp(
  store: Store,
  { proxySecrets, publicUntil, capabilities, authMode }: { proxySecrets?: ProxySecrets; publicUntil?: Date; capabilities: ArtboardCapabilities; authMode: AuthMode },
): Promise<FastifyInstance> {
  // A capability is longer than the default 100 characters of a path parameter.
  const app = Fastify({ routerOptions: { maxParamLength: 500 } });
  registerPublicDeadline(app, publicUntil);
  registerProxySecretCheck(app, proxySecrets, { artboards: true });
  // Every url carries a capability (`/c/<capability>/pages/...`); mode `none` has no login to protect and also serves the plain urls.
  await app.register(
    async (scope) => {
      if (authMode !== "none") scope.addHook("preHandler", requireCapability(store, capabilities));
      registerArtboardRoutes(scope, store);
    },
    { prefix: `/${ARTBOARD_CAPABILITY_SEGMENT}/:capability` },
  );
  if (authMode === "none") await app.register(async (scope) => registerArtboardRoutes(scope, store));
  return app;
}

/** Whether `capabilityProject` may be served the files of `requestedId`: itself, or a design system it uses. */
function coversProject(store: Store, capabilityProject: string, requestedId: string): boolean {
  if (requestedId === capabilityProject) return true;
  if (!store.isDesignSystemProject(requestedId)) return false;
  return store.sharedDesignSystemIdOfProject(capabilityProject) === requestedId || store.listPages(capabilityProject).some((page) => store.sharedDesignSystemIdOfPage(page.id) === requestedId);
}

/** Refuses (403) a request without a valid capability for the project of what it asks: the page, project or design system named in its path. */
function requireCapability(store: Store, capabilities: ArtboardCapabilities) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { capability: string; pageId?: string; projectId?: string; designSystemId?: string };
    const project = capabilities.projectOf(params.capability);
    if (project === undefined) return reply.code(403).send("capability required");
    const requested = params.pageId !== undefined ? store.projectIdOfPage(params.pageId) : (params.projectId ?? params.designSystemId);
    if (params.pageId !== undefined && requested === undefined) return reply.code(404).send("not found");
    if (requested !== undefined && !coversProject(store, project, requested)) return reply.code(403).send("capability is for another project");
  };
}

function registerArtboardRoutes(app: FastifyInstance, store: Store): void {
  /** The url prefix the request came under, for the links injected into the page. */
  const baseOf = (req: FastifyRequest) => {
    const capability = (req.params as { capability?: string }).capability;
    return capability === undefined ? "" : `/${ARTBOARD_CAPABILITY_SEGMENT}/${capability}`;
  };

  app.get(BRIDGE_PATH, async (_req, reply) =>
    reply.header("content-security-policy", "sandbox allow-scripts").header("cache-control", "no-cache").type(MIME[".js"]).send(BRIDGE_SOURCE),
  );
  app.get(INSTANCES_PATH, async (_req, reply) =>
    reply.header("content-security-policy", "sandbox allow-scripts").type(MIME[".js"]).send(INSTANCES_SOURCE),
  );

  app.get(ERRORS_PATH, async (_req, reply) =>
    reply.header("content-security-policy", "sandbox allow-scripts").header("cache-control", "no-cache").type(MIME[".js"]).send(ERRORS_SOURCE),
  );

  const sendStylesheet = (reply: FastifyReply, css: string | Buffer, cacheControl = "no-cache") =>
    reply.header("content-security-policy", "sandbox allow-scripts").header("cache-control", cacheControl).type(MIME[".css"]).send(css);

  // A url(assets/…) in a stylesheet resolves against the stylesheet, so each stylesheet route serves its project's assets beside it.
  // CORS on the 404 too: without it, an opaque-origin artboard reports a missing font as a CORS error.
  const sendStylesheetAsset = (reply: FastifyReply, projectId: string, name: string) => {
    reply.header("access-control-allow-origin", "*");
    const asset = readProjectAsset(store, projectId, name);
    if (!asset) return reply.code(404).send("not found");
    return reply.header("content-security-policy", "sandbox allow-scripts").type(MIME[extname(name)] ?? "application/octet-stream").send(asset);
  };

  app.get<{ Params: { designSystemId: string; "*": string } }>("/design-systems/:designSystemId/diffusions/:number/assets/*", async (req, reply) =>
    sendStylesheetAsset(reply, req.params.designSystemId, req.params["*"]),
  );

  app.get<{ Params: { designSystemId: string; number: string; file: string } }>("/design-systems/:designSystemId/diffusions/:number/:file", async (req, reply) => {
    const { designSystemId, number, file } = req.params;
    const content =
      /^\d+$/.test(number) && (file === DESIGN_SYSTEM_TOKENS_PATH || file === COMPONENTS_CSS_PATH) ? store.readDiffusionFile(designSystemId, Number(number), file) : undefined;
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
    if (req.query.diffusion !== undefined && !/^\d+$/.test(req.query.diffusion)) return reply.code(400).send("diffusion must be a number");
    const diffusion = req.query.diffusion === undefined ? undefined : Number(req.query.diffusion);
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .header("cache-control", "no-cache")
      .type(MIME[".html"])
      // The component's own style blocks are what components.css assembles: dropped here so that the chosen diffusion's css decides.
      .send(injectDesignSystem(withoutComponentStyles(html), designSystemId, undefined, diffusion, baseOf(req)));
  });

  app.get<{ Params: { designSystemId: string; "*": string } }>("/design-systems/:designSystemId/*", async (req, reply) => {
    const designSystem = store.getDesignSystem(req.params.designSystemId);
    if (designSystem && req.params["*"].startsWith("assets/")) return sendStylesheetAsset(reply, designSystem.id, req.params["*"].slice("assets/".length));
    if (designSystem && req.params["*"] === COMPONENTS_CSS_PATH) return sendStylesheet(reply, projectComponents(store, designSystem.id).css);
    const content = designSystem && req.params["*"] === DESIGN_SYSTEM_TOKENS_PATH ? store.readProjectFile(designSystem.id, DESIGN_SYSTEM_TOKENS_PATH) : undefined;
    if (!content) return reply.code(404).send("not found");
    return sendStylesheet(reply, content);
  });

  app.get<{ Params: { projectId: string } }>(`/projects/:projectId/${COMPONENTS_CSS_PATH}`, async (req, reply) =>
    store.projectExists(req.params.projectId) ? sendStylesheet(reply, projectComponents(store, req.params.projectId).css) : reply.code(404).send("not found"),
  );

  app.get<{ Params: { projectId: string; "*": string } }>("/projects/:projectId/assets/*", async (req, reply) => sendStylesheetAsset(reply, req.params.projectId, req.params["*"]));

  app.get<{ Params: { projectId: string; "*": string } }>("/project-styles/:projectId/*", async (req, reply) => {
    const { projectId } = req.params;
    if (req.params["*"].startsWith("assets/")) return sendStylesheetAsset(reply, projectId, req.params["*"].slice("assets/".length));
    if (!store.projectExists(projectId) || store.isDesignSystemProject(projectId) || req.params["*"] !== PROJECT_STYLE_PATH) return reply.code(404).send("not found");
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .header("cache-control", "no-cache")
      .type(MIME[extname(PROJECT_STYLE_PATH)] ?? "text/css")
      .send(store.readProjectFile(projectId, PROJECT_STYLE_PATH) ?? "");
  });

  // A page as it was in one version (history preview): same sandbox and injections as the live artboards, read-only.
  app.get<{ Params: { pageId: string; versionId: string; "*": string } }>("/page-versions/:pageId/:versionId/*", async (req, reply) =>
    serveArtboardFile(req.params.pageId, req.params["*"], reply, store.readVersionFile(req.params.pageId, req.params.versionId, req.params["*"]), { versionId: req.params.versionId, base: baseOf(req) }),
  );

  // `?preview=draft`: the viewer's preview of a project with the design system draft; it is the same call without a diffusion number.
  // `?diffusion=n` on a design system page's component file: the file as that diffusion froze it (the "before" of the before / after view).
  app.get<{ Params: { pageId: string; "*": string }; Querystring: { preview?: string; diffusion?: string } }>("/pages/:pageId/*", async (req, reply) => {
    const { pageId } = req.params;
    const path = req.params["*"];
    if (req.query.diffusion === undefined) return serveArtboardFile(pageId, path, reply, store.readPageFile(pageId, path), { draftPreview: req.query.preview === "draft", base: baseOf(req) });
    const designSystemId = store.isDesignSystemPage(pageId) ? store.getPage(pageId)?.projectId : undefined;
    if (designSystemId === undefined || !/^\d+$/.test(req.query.diffusion)) return reply.code(404).send("not found");
    const number = Number(req.query.diffusion);
    const frozen = store.diffusionComponentFiles(designSystemId, number)[path];
    // Only through the page that held the component in that diffusion.
    const heldBy = store.diffusionComponents(designSystemId, number).find((component) => component.file === path)?.page.id;
    if (frozen === undefined || heldBy !== pageId) return reply.code(404).send("not found");
    return serveArtboardFile(pageId, path, reply, Buffer.from(frozen), { frozenDiffusion: number, base: baseOf(req) });
  });

  /** The page's project when it has a project style (every project but a design system's own). */
  function projectStyleProjectOf(pageId: string): string | undefined {
    const projectId = store.getPage(pageId)?.projectId;
    return projectId !== undefined && !store.isDesignSystemProject(projectId) ? projectId : undefined;
  }

  /** Diffusion a page is rendered with: the current one for a project's pages, the one recorded with the version for a version preview, none (the draft) for a design system's own pages. */
  function diffusionOf(pageId: string, versionId?: string): number | undefined {
    if (store.isDesignSystemPage(pageId)) return undefined;
    if (versionId !== undefined) return store.versionDiffusion(pageId, versionId) ?? 1;
    const designSystemId = store.sharedDesignSystemIdOfPage(pageId);
    return designSystemId === undefined ? undefined : store.currentDiffusion(designSystemId)?.number;
  }

  function serveArtboardFile(pageId: string, path: string, reply: FastifyReply, pageFile: Buffer | undefined, { versionId, draftPreview = false, frozenDiffusion, base = "" }: { versionId?: string; draftPreview?: boolean; frozenDiffusion?: number; base?: string } = {}) {
    const asset = pageFile ?? (path.startsWith("assets/") ? readPageAsset(store, pageId, path.slice("assets/".length)) : undefined);
    if (!asset) return reply.code(404).send("not found");
    // Artboards are opaque-origin, so fonts of the project assets need CORS to load.
    if (!pageFile) reply.header("access-control-allow-origin", "*");
    const isHtml = extname(path) === ".html";
    if (!isHtml) return reply.header("content-security-policy", "sandbox allow-scripts").type(MIME[extname(path)] ?? "application/octet-stream").send(asset);
    const diffusion = frozenDiffusion ?? (draftPreview ? undefined : diffusionOf(pageId, versionId));
    const withDesignSystem = injectDesignSystem(asset.toString("utf8"), store.sharedDesignSystemIdOfPage(pageId, versionId), projectStyleProjectOf(pageId), diffusion, base);
    return reply
      .header("content-security-policy", "sandbox allow-scripts")
      .type(MIME[".html"])
      .send(injectBridge(injectInstances(withDesignSystem, instanceLayersOf(store, pageId, diffusion, versionId), base), base));
  }
}
