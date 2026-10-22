import type { FastifyInstance } from "fastify";
import {
  AGENT_API_PREFIX,
  type AgentCheckout,
  type CreateReplyRequest,
  type CreateVersionRequest,
  type PageType,
  starterPageFiles,
} from "@redline/shared";
import { versionRequestError } from "./files.js";
import { projectContext } from "./project-files.js";
import type { Store } from "./store.js";

/** HTTP API for agents and their sessions' MCP tools, guarded by the agent token (see `AGENT_API_PREFIX`). */
export async function registerAgentApi(app: FastifyInstance, store: Store): Promise<void> {
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req, reply) => {
        if (req.headers.authorization !== `Bearer ${store.getAgentToken()}`) {
          return reply.code(401).send({ error: "Wrong or missing agent token." });
        }
      });

      api.get<{ Params: { pageId: string } }>("/pages/:pageId/files", async (req, reply): Promise<AgentCheckout> => {
        const checkout = store.readPageFiles(req.params.pageId);
        if (!checkout) return reply.code(404).send({ error: "page not found" });
        return { ...checkout, project: projectContext(store, req.params.pageId) };
      });

      api.post<{ Params: { pageId: string }; Body: CreateVersionRequest }>("/pages/:pageId/versions", async (req, reply) => {
        if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
        const invalid = versionRequestError(req.body);
        if (invalid) return reply.code(400).send({ error: invalid });
        const { files, message, origin } = req.body;
        return reply.code(201).send(store.addVersion(req.params.pageId, files, message, origin));
      });

      api.post<{ Params: { pageId: string }; Body: { title?: unknown; type?: unknown } }>(
        "/pages/:pageId/siblings",
        async (req, reply) => {
          const page = store.getPage(req.params.pageId);
          if (!page) return reply.code(404).send({ error: "page not found" });
          const { title, type } = req.body ?? {};
          if (typeof title !== "string" || title.trim() === "") return reply.code(400).send({ error: "title is required" });
          if (type !== "prototype" && type !== "comparison") return reply.code(400).send({ error: "invalid type" });
          const designSystem = store.getProject(page.projectId)?.designSystem;
          const files = starterPageFiles(title, type as PageType, designSystem);
          return reply.code(201).send(store.createPage(page.projectId, title, type as PageType, files));
        },
      );

      api.post<{ Params: { threadId: string }; Body: CreateReplyRequest }>("/threads/:threadId/replies", async (req, reply) => {
        const body = req.body?.body;
        if (typeof body !== "string" || body.trim() === "") return reply.code(400).send({ error: "body is required" });
        const created = store.addReply(req.params.threadId, body);
        return created ? reply.code(201).send(created) : reply.code(404).send({ error: "thread not found" });
      });
    },
    { prefix: AGENT_API_PREFIX },
  );
}
