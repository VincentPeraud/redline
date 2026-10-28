import type { FastifyInstance } from "fastify";
import { NEUTRAL_DESIGN_SYSTEM_ID, type ArchiveRefusal } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/** Routes that change an archived project on purpose: everything else that writes to one is refused by `registerArchivedGuard`. */
const ARCHIVE_ROUTES = new Set(["POST /api/projects/:projectId/archive", "POST /api/projects/:projectId/unarchive", "DELETE /api/projects/:projectId"]);

/** The project or design system a request writes to, from its route parameters. */
function targetOf(store: Store, params: Record<string, string>): string | undefined {
  if (params.projectId) return params.projectId;
  if (params.designSystemId) return params.designSystemId;
  const pageId = params.pageId ?? (params.threadId && store.getThread(params.threadId)?.pageId) ?? (params.conversationId && store.getConversation(params.conversationId)?.pageId);
  return pageId ? store.getPage(pageId)?.projectId : undefined;
}

export const archivedError = (store: Store, id: string) =>
  store.getDesignSystem(id)
    ? "This design system is archived, so it is read-only: unarchive it in Redline to change it."
    : "This project is archived, so it is read-only: unarchive it in Redline to change it.";

/**
 * An archived project or design system is read-only, for the web UI and for sessions alike: every request that writes to it
 * (anything but GET) is refused, except archiving, unarchiving and deleting it.
 */
export function registerArchivedGuard(app: FastifyInstance, store: Store): void {
  app.addHook("preValidation", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || ARCHIVE_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) return;
    const target = targetOf(store, (req.params ?? {}) as Record<string, string>);
    if (target && store.isArchived(target)) return reply.code(409).send({ error: archivedError(store, target) });
  });
}

/**
 * Archiving, unarchiving and deleting projects and design systems: from the web UI only (no session tool calls them).
 * A design system's id is its project's, so the same routes serve both.
 */
export function registerArchiveRoutes(app: FastifyInstance, store: Store, pageLock: PageLock): void {
  const exists = (id: string) => id !== NEUTRAL_DESIGN_SYSTEM_ID && store.projectExists(id);
  const busy = (id: string) => pageLock.hasWorkOn(new Set(store.listPages(id).map((page) => page.id)));
  const current = (id: string) => store.getDesignSystem(id) ?? store.getProject(id);

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/archive", async (req, reply) => {
    const id = req.params.projectId;
    if (!exists(id)) return reply.code(404).send({ error: "project not found" });
    if (busy(id)) {
      const refusal: ArchiveRefusal = { error: "An agent is working on it: wait until it has finished to archive it.", reason: "busy" };
      return reply.code(409).send(refusal);
    }
    const followers = store.getDesignSystem(id) ? store.projectsUsingDesignSystem(id) : [];
    if (followers.length > 0) {
      const refusal: ArchiveRefusal = { error: "Projects still follow this design system: change their design system first.", reason: "followed", projects: followers };
      return reply.code(409).send(refusal);
    }
    if (!store.isArchived(id)) store.setArchived(id, true);
    return current(id);
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/unarchive", async (req, reply) => {
    const id = req.params.projectId;
    if (!exists(id)) return reply.code(404).send({ error: "project not found" });
    store.setArchived(id, false);
    pageLock.reconsider();
    return current(id);
  });

  app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const id = req.params.projectId;
    if (!exists(id)) return reply.code(404).send({ error: "project not found" });
    if (!store.isArchived(id)) return reply.code(409).send({ error: "Only an archived project or design system can be deleted: archive it first." });
    if (busy(id)) return reply.code(409).send({ error: "An agent is working on it: wait until it has finished to delete it." });
    const pageIds = new Set(store.listPages(id).map((page) => page.id));
    store.deleteProject(id);
    pageLock.forgetPages(pageIds);
    return reply.code(204).send();
  });
}
