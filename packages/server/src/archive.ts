import type { FastifyInstance } from "fastify";
import { AGENT_API_PREFIX, NEUTRAL_DESIGN_SYSTEM_ID, type ArchiveRefusal, type ArchiveStatus, type Page } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import { BLOB_MIN_AGE_MS, type Store } from "./store.js";

/** Routes that change an archived project or page on purpose: everything else that writes to one is refused by `registerArchivedGuard`. */
const ARCHIVE_ROUTES = new Set([
  "POST /api/projects/:projectId/archive",
  "POST /api/projects/:projectId/unarchive",
  "DELETE /api/projects/:projectId",
  "POST /api/pages/:pageId/archive",
  "POST /api/pages/:pageId/unarchive",
  "DELETE /api/pages/:pageId",
  `POST ${AGENT_API_PREFIX}/pages/:pageId/archive`,
  `POST ${AGENT_API_PREFIX}/projects/:projectId/archive`,
]);

/** The page a request writes to, from its route parameters. */
function pageOf(store: Store, params: Record<string, string>): string | undefined {
  return params.pageId ?? (params.threadId && store.getThread(params.threadId)?.pageId) ?? (params.conversationId && store.getConversation(params.conversationId)?.pageId) ?? undefined;
}

/** The project or design system a request writes to, from its route parameters. */
function targetOf(store: Store, params: Record<string, string>): string | undefined {
  if (params.projectId) return params.projectId;
  if (params.designSystemId) return params.designSystemId;
  const pageId = pageOf(store, params);
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

export const ARCHIVED_PAGE_ERROR = "This page is archived, so it is read-only: unarchive it in Redline to change it.";

export const archivedError = (store: Store, id: string) =>
  store.getDesignSystem(id)
    ? "This design system is archived, so it is read-only: unarchive it in Redline to change it."
    : "This project is archived, so it is read-only: unarchive it in Redline to change it.";

/**
 * An archived project, design system or page is read-only, for the web UI and for sessions alike: every request that writes
 * to it (anything but GET) is refused, except archiving, unarchiving and deleting it.
 */
export function registerArchivedGuard(app: FastifyInstance, store: Store): void {
  app.addHook("preValidation", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || ARCHIVE_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const target = targetOf(store, params);
    if (target && store.isArchived(target)) return reply.code(409).send({ error: archivedError(store, target) });
    const pageId = pageOf(store, params);
    if (pageId && store.isPageArchived(pageId)) return reply.code(409).send({ error: ARCHIVED_PAGE_ERROR });
  });
}

const BUSY_PAGE: ArchiveRefusal = { error: "An agent is working on this page: wait until it has finished to archive it.", reason: "busy" };

/** Why archiving the page is refused (status and error), or undefined when it can be archived: a design system's page never is. */
function pageArchiveError(store: Store, pageLock: PageLock, page: Page): { status: number; body: { error: string } } | undefined {
  if (store.isDesignSystemProject(page.projectId)) return { status: 400, body: { error: "A design system's page cannot be archived." } };
  if (store.isArchived(page.projectId)) return { status: 409, body: { error: archivedError(store, page.projectId) } };
  if (pageLock.hasWorkOn(new Set([page.id]))) return { status: 409, body: BUSY_PAGE };
  return undefined;
}

/**
 * Archives a page, from the web UI or a session's `archive_page` (never deleted from a session): an archived page leaves the
 * page lists and sessions but keeps its versions, threads and conversations, and can be unarchived.
 */
export function archivePage(store: Store, pageLock: PageLock, page: Page): { status: number; body: unknown } {
  if (page.archivedAt) return { status: 200, body: page };
  const refused = pageArchiveError(store, pageLock, page);
  if (refused) return refused;
  store.setPageArchived(page.id, true);
  // Its waiting items now wait for the page to be unarchived (and say so); a waiting terminal publish gets its refusal.
  pageLock.reconsider();
  return { status: 200, body: store.getPage(page.id) };
}

/** A project or design system (not the neutral one): what the archive routes, the web's and terminal mode's, act on. */
export const archivableExists = (store: Store, id: string) => id !== NEUTRAL_DESIGN_SYSTEM_ID && store.projectExists(id);

/** The project or design system as the routes answer it. */
export const projectOrDesignSystem = (store: Store, id: string) => store.getDesignSystem(id) ?? store.getProject(id);

const projectBusy = (store: Store, pageLock: PageLock, id: string) => pageLock.hasWorkOn(new Set(store.listPages(id).map((page) => page.id)));

/** Why archiving the project or design system `id` is refused right now, if it is. */
function projectArchiveRefusal(store: Store, pageLock: PageLock, id: string): ArchiveRefusal | undefined {
  if (projectBusy(store, pageLock, id)) return { error: "An agent is working on it: wait until it has finished to archive it.", reason: "busy" };
  const followers = store.getDesignSystem(id) ? store.projectsUsingDesignSystem(id) : [];
  if (followers.length > 0) return { error: "Projects still follow this design system: change their design system first.", reason: "followed", projects: followers };
  return undefined;
}

/** Archives a project or design system (`id` exists), from the web UI or terminal mode's `archive_project` (never deleted from a session). */
export function archiveProject(store: Store, pageLock: PageLock, id: string): { refusal: ArchiveRefusal } | { archived: ReturnType<typeof projectOrDesignSystem> } {
  const refusal = projectArchiveRefusal(store, pageLock, id);
  if (refusal) return { refusal };
  if (!store.isArchived(id)) store.setArchived(id, true);
  return { archived: projectOrDesignSystem(store, id) };
}

/**
 * Archiving, unarchiving and deleting projects and design systems from the web UI (terminal mode archives through `archiveProject`).
 * A design system's id is its project's, so the same routes serve both.
 */
export function registerArchiveRoutes(app: FastifyInstance, store: Store, pageLock: PageLock): void {
  const exists = (id: string) => archivableExists(store, id);
  const busy = (id: string) => projectBusy(store, pageLock, id);
  const current = (id: string) => projectOrDesignSystem(store, id);
  const refusal = (id: string) => projectArchiveRefusal(store, pageLock, id);

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
    const result = archiveProject(store, pageLock, id);
    return "refusal" in result ? reply.code(409).send(result.refusal) : result.archived;
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

  // The project overview shows a page card's archive icon disabled, with the reason, before any click.
  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/archive", async (req, reply): Promise<ArchiveStatus | undefined> => {
    const page = store.getPage(req.params.pageId);
    if (!page) return void reply.code(404).send({ error: "page not found" });
    if (page.archivedAt) return { archivedAt: page.archivedAt };
    return pageLock.hasWorkOn(new Set([page.id])) ? { refusal: BUSY_PAGE } : {};
  });

  app.post<{ Params: { pageId: string } }>("/api/pages/:pageId/archive", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const { status, body } = archivePage(store, pageLock, page);
    return reply.code(status).send(body);
  });

  app.post<{ Params: { pageId: string } }>("/api/pages/:pageId/unarchive", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    if (store.isArchived(page.projectId)) return reply.code(409).send({ error: archivedError(store, page.projectId) });
    store.setPageArchived(page.id, false);
    pageLock.reconsider();
    return store.getPage(page.id);
  });

  // As for a project, the body repeats the page's exact title: a request sent blindly deletes nothing.
  app.delete<{ Params: { pageId: string }; Body: { title?: unknown } }>("/api/pages/:pageId", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    if (!page.archivedAt) return reply.code(409).send({ error: "Only an archived page can be deleted: archive it first." });
    if (req.body?.title !== page.title) return reply.code(400).send({ error: "Send the exact title of the page to delete it." });
    if (store.isArchived(page.projectId)) return reply.code(409).send({ error: archivedError(store, page.projectId) });
    if (pageLock.hasWorkOn(new Set([page.id]))) return reply.code(409).send({ error: "An agent is working on this page: wait until it has finished to delete it." });
    const blobs = store.deletePage(page.id);
    pageLock.forgetPages(new Set([page.id]));
    freeBlobs(store, blobs);
    return reply.code(204).send();
  });
}
