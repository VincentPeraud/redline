import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_VISITOR_NAME_LENGTH, MY_LINKS_PATH, isAccessLevel, linkPath, type LinkAuthor, type AccessLevel, type CreateLinkRequest, type MyLink, type ShareLink, type ShareLinkView, type UpdateLinkRequest } from "@redline/shared";
import { cookieOf, type Access, type Viewer } from "./access.js";
import type { StoredLink } from "./link-store.js";
import type { Store } from "./store.js";

export const LINK_DEVICE_COOKIE = "redline_link_device";
const DEVICE_COOKIE_SECONDS = 365 * 86_400;
const MAX_NAME_LENGTH = 80;
const LEVEL_RANK: Record<AccessLevel, number> = { read: 0, comment: 1, write: 2 };

/** Why a link request is refused, or undefined: the name, the kind and level pair, and the expiry. */
function linkRequestError(body: Partial<CreateLinkRequest & UpdateLinkRequest>, kind: ShareLink["kind"]): string | undefined {
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "" || body.name.trim().length > MAX_NAME_LENGTH)) return `name must be 1 to ${MAX_NAME_LENGTH} characters`;
  if (body.level !== undefined && !isAccessLevel(body.level)) return "level must be read, comment or write";
  if (kind === "generic" && body.level === "write") return "A link for anyone opens in Lecture or Commentaire only.";
  if (body.expiresAt !== undefined && body.expiresAt !== null && (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt)))) return "expiresAt must be an ISO date or null";
  if (body.direct !== undefined && typeof body.direct !== "boolean") return "direct must be a boolean";
  return undefined;
}

/** Why a comment through a link cannot be signed, or undefined: a generic link needs the name the visitor gave. */
export function visitorNameError(viewer: Viewer, visitorName: unknown): string | undefined {
  if (viewer.kind !== "link" || viewer.link.kind === "personal" || viewer.member) return undefined;
  if (typeof visitorName !== "string" || visitorName.trim() === "" || visitorName.trim().length > MAX_VISITOR_NAME_LENGTH) return `visitorName must be 1 to ${MAX_VISITOR_NAME_LENGTH} characters`;
  return undefined;
}

/** What a comment through a link is signed with: the account name of a member who opened it, else the name of a personal link, else the visitor's name on a generic one. Undefined for members at their own level. */
export function linkAuthorOf(viewer: Viewer, visitorName: unknown): LinkAuthor | undefined {
  if (viewer.kind !== "link") return undefined;
  if (viewer.member) return { linkId: viewer.link.id, name: viewer.member.person.name };
  return { linkId: viewer.link.id, name: viewer.link.kind === "personal" ? viewer.link.name : (visitorName as string).trim() };
}

/** The link as a viewer sees it: with whether they may change it (its author, the creator of the project and the admins). */
export function linkViews(store: Store, access: Access): (viewer: Viewer, link: StoredLink) => ShareLink {
  const projectOf = (link: StoredLink): string => (link.scope === "project" ? link.scopeId : (store.projectIdOfPage(link.scopeId) ?? ""));
  return (viewer, link) => {
    const canManage = viewer.kind !== "account" ? access.mode === "none" : link.createdBy?.id === viewer.person.id || access.manages(viewer, projectOf(link));
    return { ...link, canManage };
  };
}

/**
 * Share links: members create, list, edit, disable and reactivate them (page and project links),
 * and a visitor asks `GET /s/<token>/api/link` what its link opens. Which routes a visitor may call at all is `LINK_ROUTES`.
 */
export function registerLinkRoutes(app: FastifyInstance, store: Store, access: Access): void {
  const viewOf = (req: FastifyRequest, link: StoredLink): ShareLink => linkViews(store, access)(req.viewer, link);
  const canManage = (req: FastifyRequest, link: StoredLink): boolean => viewOf(req, link).canManage;

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/links", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.links.list("page", req.params.pageId).map((link) => viewOf(req, link));
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/links", async (req, reply) => {
    if (!store.projectExists(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return store.links.list("project", req.params.projectId).map((link) => viewOf(req, link));
  });

  const projectOfLink = (link: StoredLink): string => (link.scope === "project" ? link.scopeId : (store.projectIdOfPage(link.scopeId) ?? ""));

  /** Why the viewer may not give a link of this level on its scope, or undefined: Privé projects keep links to their creator and the admins, and a link never gives more than the viewer's own level. */
  const grantError = (viewer: Viewer, scope: ShareLink["scope"], scopeId: string, projectId: string, level: AccessLevel): string | undefined => {
    if (store.getProject(projectId)?.visibility === "private" && !access.manages(viewer, projectId)) return "On a private project only its creator and the admins create links.";
    const own = access.levelOf(viewer, scope === "page" ? { pageId: scopeId } : { projectId });
    if (own === undefined || LEVEL_RANK[level] > LEVEL_RANK[own]) return "A link cannot give more than your own level.";
    return undefined;
  };

  /** Creates a link on a scope, under the rules: the kind and level pair, Privé projects, and never above the creator's own level. */
  const createLink = (req: FastifyRequest<{ Body: CreateLinkRequest }>, reply: FastifyReply, scope: ShareLink["scope"], scopeId: string, projectId: string) => {
    const body = req.body ?? ({} as Partial<CreateLinkRequest>);
    if (body.kind !== "personal" && body.kind !== "generic") return reply.code(400).send({ error: "kind must be personal or generic" });
    if (typeof body.name !== "string" || !isAccessLevel(body.level)) return reply.code(400).send({ error: "name and level are required" });
    const invalid = linkRequestError(body, body.kind);
    if (invalid) return reply.code(400).send({ error: invalid });
    const refused = grantError(req.viewer, scope, scopeId, projectId, body.level);
    if (refused) return reply.code(403).send({ error: refused });
    const link = store.links.create({
      scope,
      scopeId,
      kind: body.kind,
      name: body.name.trim(),
      level: body.level,
      direct: body.level === "comment" && body.direct === true,
      expiresAt: body.expiresAt ?? null,
      createdBy: req.person,
    });
    return reply.code(201).send(viewOf(req, link));
  };

  app.post<{ Params: { pageId: string }; Body: CreateLinkRequest }>("/api/pages/:pageId/links", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return createLink(req, reply, "page", req.params.pageId, store.projectIdOfPage(req.params.pageId)!);
  });

  app.post<{ Params: { projectId: string }; Body: CreateLinkRequest }>("/api/projects/:projectId/links", async (req, reply) => {
    if (!store.projectExists(req.params.projectId) || store.isDesignSystemProject(req.params.projectId)) return reply.code(404).send({ error: "project not found" });
    return createLink(req, reply, "project", req.params.projectId, req.params.projectId);
  });

  /** The link a member route is about, when the viewer may change it; answers the refusal itself otherwise. */
  const manageable = (req: FastifyRequest<{ Params: { linkId: string } }>, reply: FastifyReply): StoredLink | undefined => {
    const link = store.links.get(req.params.linkId);
    if (!link) return void reply.code(404).send({ error: "link not found" });
    if (!canManage(req, link)) return void reply.code(403).send({ error: "Only its author, the creator of the project and the admins change a link." });
    return link;
  };

  app.patch<{ Params: { linkId: string }; Body: UpdateLinkRequest }>("/api/links/:linkId", async (req, reply) => {
    const link = manageable(req, reply);
    if (!link) return;
    const body = req.body ?? {};
    const invalid = linkRequestError(body, link.kind);
    if (invalid) return reply.code(400).send({ error: invalid });
    const refused = grantError(req.viewer, link.scope, link.scopeId, projectOfLink(link), body.level ?? link.level);
    if (refused) return reply.code(403).send({ error: refused });
    return viewOf(req, store.links.update(link.id, { name: body.name?.trim(), level: body.level, direct: body.direct, expiresAt: body.expiresAt })!);
  });

  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/disable", async (req, reply) => {
    const link = manageable(req, reply);
    if (!link) return undefined;
    const disabled = viewOf(req, store.links.setActive(link.id, false, req.person)!);
    // Streams resolve their viewer again on every event: this one closes the visitor's at once.
    store.emit({ type: "agents-updated" });
    return disabled;
  });

  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/reactivate", async (req, reply) => {
    const link = manageable(req, reply);
    if (!link) return undefined;
    const refused = grantError(req.viewer, link.scope, link.scopeId, projectOfLink(link), link.level);
    if (refused) return reply.code(403).send({ error: refused });
    return viewOf(req, store.links.setActive(link.id, true)!);
  });

  app.get(MY_LINKS_PATH, async (req): Promise<MyLink[]> => {
    if (req.viewer.kind !== "account") return [];
    const views = linkViews(store, access);
    return store.links.createdBy(req.viewer.person.id).flatMap((stored): MyLink[] => {
      const page = stored.scope === "page" ? store.getPage(stored.scopeId) : undefined;
      const project = store.getProject(page ? page.projectId : stored.scopeId);
      if (!project) return [];
      return [{ link: views(req.viewer, stored), projectId: project.id, projectTitle: project.title, ...(page ? { pageId: page.id, pageTitle: page.title } : {}) }];
    });
  });

  app.get("/api/link", async (req, reply): Promise<ShareLinkView | undefined> => {
    const viewer = req.viewer;
    if (viewer.kind !== "link") return void reply.code(404).send({ error: "not found" });
    const { link } = viewer;
    const page = link.scope === "page" ? store.getPage(link.scopeId)! : undefined;
    const project = store.getProject(page ? page.projectId : link.scopeId)!;
    const memberLevel = viewer.member && access.levelOf(viewer.member, page ? { pageId: page.id } : { projectId: project.id });
    const memberRedirect = memberLevel !== undefined && LEVEL_RANK[memberLevel] >= LEVEL_RANK[link.level];
    if (!memberRedirect) {
      const known = cookieOf(req, LINK_DEVICE_COOKIE);
      const device = known ?? randomUUID();
      store.links.recordOpening(link.id, device);
      if (known === undefined) {
        const secure = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
        reply.header("set-cookie", `${LINK_DEVICE_COOKIE}=${device}; Path=${linkPath(viewer.token)}; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_SECONDS}${secure ? "; Secure" : ""}`);
      }
    }
    return { scope: link.scope, kind: link.kind, level: link.level, name: link.name, page: page ? { id: page.id, title: page.title } : null, project: { id: project.id, title: project.title }, memberRedirect };
  });
}
