import type { FastifyInstance } from "fastify";
import {
  AGENT_API_PREFIX,
  type AgentCheckout,
  type CreateReplyRequest,
  type CreateVersionRequest,
  PAGE_TYPES,
  type PageType,
  starterPageFiles,
} from "@redline/shared";
import { mergeOntoCurrent } from "./publish.js";
import { tokensEqual } from "./request-hardening.js";
import { requiredString, versionRequestError } from "./validation.js";
import { projectContext } from "./project-files.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/** HTTP API for agents and their sessions' MCP tools, guarded by the agent token (see `AGENT_API_PREFIX`). */
export async function registerAgentApi(app: FastifyInstance, store: Store, pageLock: PageLock): Promise<void> {
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req, reply) => {
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
        const { files, message, origin, baseVersionId } = req.body;
        if (!requiredString(baseVersionId)) return reply.code(400).send({ error: "baseVersionId is required" });
        const record = () => {
          const result = mergeOntoCurrent(store, req.params.pageId, files, baseVersionId);
          if ("error" in result) return reply.code(result.conflict ? 409 : 400).send({ error: result.error });
          const invalidMerged = versionRequestError({ ...req.body, files: result.files }, store.isDesignSystemPage(req.params.pageId));
          if (invalidMerged) return reply.code(409).send({ error: invalidMerged });
          const version = store.addVersion(req.params.pageId, result.files, message, origin);
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

      api.post<{ Params: { pageId: string }; Body: { title?: unknown; type?: unknown } }>(
        "/pages/:pageId/siblings",
        async (req, reply) => {
          const page = store.getPage(req.params.pageId);
          if (!page) return reply.code(404).send({ error: "page not found" });
          const { title, type } = req.body ?? {};
          if (!requiredString(title)) return reply.code(400).send({ error: "title is required" });
          if (!(PAGE_TYPES as readonly unknown[]).includes(type)) return reply.code(400).send({ error: "invalid type" });
          const designSystem = store.getProject(page.projectId)?.designSystem;
          const files = starterPageFiles(title, type as PageType, designSystem);
          return reply.code(201).send(store.createPage(page.projectId, title, type as PageType, files));
        },
      );

      api.post<{ Params: { threadId: string }; Body: CreateReplyRequest }>("/threads/:threadId/replies", async (req, reply) => {
        const body = req.body?.body;
        if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
        const created = store.addReply(req.params.threadId, body);
        return created ? reply.code(201).send(created) : reply.code(404).send({ error: "thread not found" });
      });
    },
    { prefix: AGENT_API_PREFIX },
  );
}
