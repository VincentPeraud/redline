import type { FastifyInstance } from "fastify";
import {
  AGENT_API_PREFIX,
  DESIGN_MD_PATH,
  DESIGN_SYSTEM_TOKENS_PATH,
  PROJECT_STYLE_PATH,
  MAX_ASSET_BYTES,
  type AgentCheckout,
  type AgentReplyRequest,
  type CreateSiblingRequest,
  type CreateVersionRequest,
  type MoveArtboardRequest,
  type DesignMdAuthor,
  starterDesignSystemFiles,
  starterPageFiles,
  type AgentDesignSystem,
  type ProjectStyleStart,
} from "@redline/shared";
import { mergeOntoCurrent } from "./publish.js";
import { moveArtboard } from "./move-artboard.js";
import { tokensEqual } from "./request-hardening.js";
import { versionComponentsError } from "./components.js";
import { removalsError } from "./removals.js";
import { crossPageReferencesError } from "./cross-page-references.js";
import { requiredString, titleError, tokensError, versionRequestError } from "./validation.js";
import { projectContext, putProjectAsset } from "./project-files.js";
import { designSystemChangeError } from "./project-design-system.js";
import type { PageLock } from "./page-lock.js";
import type { OriginRef, Store } from "./store.js";

/** The thread or conversation a running work item answers, as version/DESIGN.md origin; none when the item is unknown or belongs to another page. */
export function workOrigin(store: Store, pageLock: PageLock, workId: unknown, pageId: string): (OriginRef & { kind: "thread" | "conversation" }) | undefined {
  const item = typeof workId === "string" ? pageLock.itemOf(workId) : undefined;
  if (!item || item.pageId !== pageId) return undefined;
  if (item.conversationId) {
    const conversation = store.getConversation(item.conversationId);
    return { kind: "conversation", originId: item.conversationId, ...(conversation ? { originLabel: conversation.title } : {}) };
  }
  const first = item.threads[0] && store.getThread(item.threads[0].threadId);
  return first ? { kind: "thread", originId: first.id, originLabel: first.title } : undefined;
}

/** HTTP API for agents and their sessions' MCP tools, guarded by the agent token (see `AGENT_API_PREFIX`). */
export async function registerAgentApi(app: FastifyInstance, store: Store, pageLock: PageLock): Promise<void> {
  await app.register(
    async (api) => {
      // onRequest, not preHandler: a wrong token is refused before its body (up to 20 MB for assets) is read.
      api.addHook("onRequest", async (req, reply) => {
        const given = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice("Bearer ".length) : undefined;
        if (!tokensEqual(given, store.getAgentToken())) {
          return reply.code(401).send({ error: "Wrong or missing agent token." });
        }
      });

      // `redline init` / `redline agent` pick or create the project a folder serves, before they have anything else to call.
      api.get("/projects", async () => store.listProjects());

      api.post<{ Body: { title?: unknown; designSystem?: unknown } }>("/projects", async (req, reply) => {
        const { title } = req.body ?? {};
        const designSystem = req.body?.designSystem || null;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        if (designSystem !== null && (typeof designSystem !== "string" || !store.getDesignSystem(designSystem))) {
          return reply.code(400).send({ error: "designSystem must be the id of an existing design system" });
        }
        return reply.code(201).send(store.createProject((title as string).trim(), undefined, undefined, designSystem));
      });

      // Terminal mode sets up brands: list and create design systems, and point a project at one (or at none).
      api.get("/design-systems", async (): Promise<AgentDesignSystem[]> =>
        store.listDesignSystems().map((designSystem) => ({
          ...designSystem,
          pages: store.listPages(designSystem.id).map((page) => ({ id: page.id, title: page.title })),
          usedBy: store.projectsUsingDesignSystem(designSystem.id),
        })),
      );

      api.post<{ Body: { title?: unknown } }>("/design-systems", async (req, reply) => {
        const title = req.body?.title;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        return reply.code(201).send(store.createDesignSystem((title as string).trim(), starterDesignSystemFiles()));
      });

      api.put<{ Params: { projectId: string }; Body: { designSystem?: unknown; startFrom?: unknown } }>("/projects/:projectId/design-system", async (req, reply) => {
        const designSystem = req.body?.designSystem ?? null;
        if (store.getDesignSystem(req.params.projectId) || !store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
        const invalid = designSystemChangeError(store, req.params.projectId, designSystem, req.body?.startFrom);
        if (invalid) return reply.code(400).send({ error: invalid });
        store.setProjectDesignSystem(req.params.projectId, designSystem, "terminal", req.body?.startFrom as ProjectStyleStart | undefined);
        return store.getProject(req.params.projectId);
      });

      // Terminal mode finds and creates pages without having one checked out. A design system's own project is not one of them.
      const projectFor = (projectId: string) => (store.getDesignSystem(projectId) ? undefined : store.getProject(projectId));

      api.get<{ Params: { projectId: string } }>("/projects/:projectId/pages", async (req, reply) => {
        if (!projectFor(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
        return store.listPages(req.params.projectId);
      });

      api.post<{ Params: { projectId: string }; Body: { title?: unknown } }>("/projects/:projectId/pages", async (req, reply) => {
        const project = projectFor(req.params.projectId);
        if (!project) return reply.code(404).send({ error: "project not found" });
        const title = req.body?.title;
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        const name = (title as string).trim();
        return reply.code(201).send(store.createPage(project.id, name, starterPageFiles(name, project.designSystem), "claude"));
      });

      api.get<{ Params: { pageId: string } }>("/pages/:pageId/files", async (req, reply): Promise<AgentCheckout> => {
        const checkout = store.readPageFiles(req.params.pageId);
        if (!checkout) return reply.code(404).send({ error: "page not found" });
        return { ...checkout, project: projectContext(store, req.params.pageId) };
      });

      api.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>("/pages/:pageId/versions", async (req, reply) => {
        if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
        const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId), true) ?? crossPageReferencesError(store, req.params.pageId, req.body.files) ?? versionComponentsError(store, req.params.pageId, req.body.files);
        if (invalid) return reply.code(400).send({ error: invalid });
        const { files, message, origin, baseVersionId, workId, designMd, projectStyle } = req.body;
        // A session works inside its own project: its work never publishes to the pages of another one (a shared design system's, say).
        const workPage = typeof workId === "string" ? pageLock.itemOf(workId)?.pageId : undefined;
        if (workPage !== undefined && store.getPage(workPage)?.projectId !== store.getPage(req.params.pageId)!.projectId) {
          return reply.code(403).send({ error: "This work belongs to a page of another project: it cannot publish here." });
        }
        if (!requiredString(baseVersionId)) return reply.code(400).send({ error: "baseVersionId is required" });
        if (designMd !== undefined && (typeof designMd?.content !== "string" || typeof designMd.base !== "string")) {
          return reply.code(400).send({ error: "designMd needs content and base" });
        }
        if (projectStyle !== undefined && (typeof projectStyle?.content !== "string" || typeof projectStyle.base !== "string")) {
          return reply.code(400).send({ error: "projectStyle needs content and base" });
        }
        const record = () => {
          const result = mergeOntoCurrent(store, req.params.pageId, files, baseVersionId);
          if ("error" in result) return reply.code(result.conflict ? 409 : 400).send({ error: result.error });
          const invalidMerged = versionRequestError({ ...req.body, files: result.files }, store.isDesignSystemPage(req.params.pageId)) ?? versionComponentsError(store, req.params.pageId, result.files);
          if (invalidMerged) return reply.code(409).send({ error: invalidMerged });
          const projectId = store.getPage(req.params.pageId)!.projectId;
          const storedDesignMd = store.readProjectText(projectId, DESIGN_MD_PATH);
          const designMdChanged = designMd !== undefined && designMd.content !== storedDesignMd;
          if (designMdChanged && storedDesignMd !== designMd.base) {
            return reply.code(409).send({ error: "DESIGN.md changed since it was checked out. Check the page out again and redo the DESIGN.md change." });
          }
          const storedStyle = store.readProjectText(projectId, PROJECT_STYLE_PATH);
          const styleChanged = projectStyle !== undefined && projectStyle.content !== storedStyle;
          if (styleChanged && storedStyle !== projectStyle.base) {
            return reply.code(409).send({ error: "The project style (tokens.css) changed since it was checked out. Check the page out again and redo the tokens.css change." });
          }
          // On a design system's own project this file is the design system's tokens: the core tokens must stay.
          const invalidStyle = styleChanged && store.isDesignSystemProject(projectId) ? tokensError(projectStyle.content) : null;
          if (invalidStyle) return reply.code(400).send({ error: invalidStyle });
          const invalidRemoval = removalsError(store, req.params.pageId, result.files, styleChanged && store.isDesignSystemProject(projectId) ? projectStyle.content : result.files[DESIGN_SYSTEM_TOKENS_PATH], req.body.confirmRemovals === true);
          if (invalidRemoval) return reply.code(400).send({ error: invalidRemoval });
          const from = workOrigin(store, pageLock, workId, req.params.pageId);
          const ref: OriginRef | undefined = from && { originId: from.originId, originLabel: from.originLabel };
          const author = (): DesignMdAuthor => (from ? { origin: from.kind, ...ref } : { origin: origin === "terminal" ? "terminal" : "user" });
          const version = store.addVersion(req.params.pageId, result.files, message, origin, ref);
          if (designMdChanged) store.saveDesignMd(projectId, DESIGN_MD_PATH, Buffer.from(designMd.content, "utf8"), author());
          if (styleChanged) store.saveDesignMd(projectId, PROJECT_STYLE_PATH, Buffer.from(projectStyle.content, "utf8"), author());
          return reply.code(201).send(result.merged ? { ...version, merged: true } : version);
        };
        if (origin !== "terminal") return record();
        // Terminal mode takes its turn on the page like a thread: wait while a session runs on it.
        const release = await pageLock.acquire(req.params.pageId);
        try {
          return record();
        } finally {
          release();
        }
      });

      // Raw bytes: an asset a session added or changed under `assets/` of its working copy, stored in the page's project.
      await api.register(async (scope) => {
        scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
        scope.put<{ Params: { pageId: string; "*": string }; Body: Buffer }>("/pages/:pageId/assets/*", { bodyLimit: MAX_ASSET_BYTES }, async (req, reply) => {
          const page = store.getPage(req.params.pageId);
          if (!page) return reply.code(404).send({ error: "page not found" });
          const asset = putProjectAsset(store, page.projectId, req.params["*"], req.body);
          return reply.code("error" in asset ? 400 : 201).send(asset);
        });
      });

      api.post<{ Params: { pageId: string }; Body: Partial<CreateSiblingRequest> }>("/pages/:pageId/siblings", async (req, reply) => {
        const page = store.getPage(req.params.pageId);
        if (!page) return reply.code(404).send({ error: "page not found" });
        const { title, workId } = req.body ?? {};
        if (titleError(title)) return reply.code(400).send({ error: titleError(title) });
        const name = (title as string).trim();
        const designSystem = store.getProject(page.projectId)?.designSystem;
        const created = store.createPage(page.projectId, name, starterPageFiles(name, designSystem), "claude");
        if (workOrigin(store, pageLock, workId, page.id)) store.recordCreatedPage(workId!, created.id);
        return reply.code(201).send(created);
      });

      api.post<{ Params: { pageId: string }; Body: Partial<MoveArtboardRequest> }>("/pages/:pageId/move-artboard", async (req, reply) => {
        const { workId } = req.body ?? {};
        const from = workOrigin(store, pageLock, workId, req.params.pageId);
        const outcome = moveArtboard(store, pageLock, req.params.pageId, req.body, {
          origin: from?.kind ?? "terminal",
          ref: from && { originId: from.originId, originLabel: from.originLabel },
          exceptWorkId: from ? workId : undefined,
        });
        return reply.code(outcome.status).send(outcome.body);
      });

      api.post<{ Params: { threadId: string }; Body: AgentReplyRequest }>("/threads/:threadId/replies", async (req, reply) => {
        const body = req.body?.body;
        if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
        const thread = store.getThread(req.params.threadId);
        if (!thread) return reply.code(404).send({ error: "thread not found" });
        // The pages the run created appear under its first answer.
        const workId = req.body.workId;
        const createdPageIds = workOrigin(store, pageLock, workId, thread.pageId) ? store.takeCreatedPages(workId!) : [];
        return reply.code(201).send(store.addReply(thread.id, body, "claude", createdPageIds));
      });
    },
    { prefix: AGENT_API_PREFIX },
  );
}
