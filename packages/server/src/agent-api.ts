import type { FastifyInstance } from "fastify";
import {
  AGENT_API_PREFIX,
  DESIGN_MD_PATH,
  MAX_ASSET_BYTES,
  type AgentCheckout,
  type AgentReplyRequest,
  type CreateSiblingRequest,
  type CreateVersionRequest,
  type DesignMdAuthor,
  starterPageFiles,
} from "@redline/shared";
import { mergeOntoCurrent } from "./publish.js";
import { tokensEqual } from "./request-hardening.js";
import { requiredString, versionRequestError } from "./validation.js";
import { projectContext, putProjectAsset } from "./project-files.js";
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

      api.post<{ Body: { title?: unknown } }>("/projects", async (req, reply) => {
        const title = req.body?.title;
        if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
        return reply.code(201).send(store.createProject(title.trim()));
      });

      api.get<{ Params: { pageId: string } }>("/pages/:pageId/files", async (req, reply): Promise<AgentCheckout> => {
        const checkout = store.readPageFiles(req.params.pageId);
        if (!checkout) return reply.code(404).send({ error: "page not found" });
        return { ...checkout, project: projectContext(store, req.params.pageId) };
      });

      api.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>("/pages/:pageId/versions", async (req, reply) => {
        if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
        const invalid = versionRequestError(req.body, store.isDesignSystemPage(req.params.pageId));
        if (invalid) return reply.code(400).send({ error: invalid });
        const { files, message, origin, baseVersionId, workId, designMd } = req.body;
        if (!requiredString(baseVersionId)) return reply.code(400).send({ error: "baseVersionId is required" });
        if (designMd !== undefined && (typeof designMd?.content !== "string" || typeof designMd.base !== "string")) {
          return reply.code(400).send({ error: "designMd needs content and base" });
        }
        const record = () => {
          const result = mergeOntoCurrent(store, req.params.pageId, files, baseVersionId);
          if ("error" in result) return reply.code(result.conflict ? 409 : 400).send({ error: result.error });
          const invalidMerged = versionRequestError({ ...req.body, files: result.files }, store.isDesignSystemPage(req.params.pageId));
          if (invalidMerged) return reply.code(409).send({ error: invalidMerged });
          const projectId = store.getPage(req.params.pageId)!.projectId;
          const storedDesignMd = store.readProjectFile(projectId, DESIGN_MD_PATH)?.toString("utf8") ?? "";
          const designMdChanged = designMd !== undefined && designMd.content !== storedDesignMd;
          if (designMdChanged && storedDesignMd !== designMd.base) {
            return reply.code(409).send({ error: "DESIGN.md changed since it was checked out. Check the page out again and redo the DESIGN.md change." });
          }
          const from = workOrigin(store, pageLock, workId, req.params.pageId);
          const ref: OriginRef | undefined = from && { originId: from.originId, originLabel: from.originLabel };
          const version = store.addVersion(req.params.pageId, result.files, message, origin, ref);
          if (designMdChanged) {
            const author: DesignMdAuthor = from ? { origin: from.kind, ...ref } : { origin: origin === "terminal" ? "terminal" : "user" };
            store.saveDesignMd(projectId, DESIGN_MD_PATH, Buffer.from(designMd.content, "utf8"), author);
          }
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
        if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
        const designSystem = store.getProject(page.projectId)?.designSystem;
        const created = store.createPage(page.projectId, title, starterPageFiles(title, designSystem), "claude");
        if (workOrigin(store, pageLock, workId, page.id)) store.recordCreatedPage(workId!, created.id);
        return reply.code(201).send(created);
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
