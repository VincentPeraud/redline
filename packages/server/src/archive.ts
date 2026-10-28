import type { FastifyInstance } from "fastify";
import { NEUTRAL_DESIGN_SYSTEM_ID, type ArchiveRefusal, type ArchiveStatus } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import { BLOB_MIN_AGE_MS, type Store } from "./store.js";

/** Routes that change an archived project on purpose: everything else that writes to one is refused by `registerArchivedGuard`. */
const ARCHIVE_ROUTES = new Set(["POST /api/projects/:projectId/archive", "POST /api/projects/:projectId/unarchive", "DELETE /api/projects/:projectId"]);

/** The project or design system a request writes to, from its route parameters. */
function targetOf(store: Store, params: Record<string, string>): string | undefined {
  if (params.projectId) return params.projectId;
  if (params.designSystemId) return params.designSystemId;
  const pageId = params.pageId ?? (params.threadId && store.getThread(params.threadId)?.pageId) ?? (params.conversationId && store.getConversation(params.conversationId)?.pageId);
  return pageId ? store.projectIdOfPage(pageId) : undefined;
}

/** Frees the disk of a deleted project's blobs that nothing else uses; the ones too fresh to remove now are retried later. Never fails the delete. */
function freeBlobs(store: Store, blobs: string[]): void {
  try {
    const { tooYoung } = store.collectGarbage(blobs);
    if (tooYoung.length > 0) setTimeout(() => freeBlobs(store, tooYoung), BLOB_MIN_AGE_MS).unref();
  } catch {
    // The store was closed meanwhile (server stopped): the blobs stay, unused.
  }
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

  /** Why archiving `id` is refused right now, if it is. */
  const refusal = (id: string): ArchiveRefusal | undefined => {
    if (busy(id)) return { error: "An agent is working on it: wait until it has finished to archive it.", reason: "busy" };
    const followers = store.getDesignSystem(id) ? store.projectsUsingDesignSystem(id) : [];
    if (followers.length > 0) return { error: "Projects still follow this design system: change their design system first.", reason: "followed", projects: followers };
    return undefined;
  };

  // The project and design system pages show the archive link disabled, with the reason, before any click.
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/archive", async (req, reply): Promise<ArchiveStatus | undefined> => {
    const id = req.params.projectId;
    if (!exists(id)) return void reply.code(404).send({ error: "project not found" });
    const archivedAt = (store.getDesignSystem(id) ?? store.getProject(id))?.archivedAt;
    const refused = archivedAt ? undefined : refusal(id);
    return { ...(archivedAt ? { archivedAt } : {}), ...(refused ? { refusal: refused } : {}) };
  });

  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/archive", async (req, reply) => {
    const id = req.params.projectId;
    if (!exists(id)) return reply.code(404).send({ error: "project not found" });
    const refused = refusal(id);
    if (refused) return reply.code(409).send(refused);
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

  // The body repeats the exact title (what the dialog asks to type): a request sent blindly, by a script or a session, deletes nothing.
  app.delete<{ Params: { projectId: string }; Body: { title?: unknown } }>("/api/projects/:projectId", async (req, reply) => {
    const id = req.params.projectId;
    if (!exists(id)) return reply.code(404).send({ error: "project not found" });
    const title = (store.getDesignSystem(id) ?? store.getProject(id))!.title;
    if (req.body?.title !== title) return reply.code(400).send({ error: "Send the exact title of the project or design system to delete it." });
    if (!store.isArchived(id)) return reply.code(409).send({ error: "Only an archived project or design system can be deleted: archive it first." });
    if (busy(id)) return reply.code(409).send({ error: "An agent is working on it: wait until it has finished to delete it." });
    if (store.getDesignSystem(id) && store.projectsUsingDesignSystem(id).length > 0) {
      return reply.code(409).send({ error: "Projects still follow this design system: change their design system first." });
    }
    const pageIds = new Set(store.listPages(id).map((page) => page.id));
    const blobs = store.deleteProject(id);
    pageLock.forgetPages(pageIds);
    freeBlobs(store, blobs);
    return reply.code(204).send();
  });
}
