import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_VISITOR_NAME_LENGTH, isAccessLevel, linkPath, type LinkAuthor, type AccessLevel, type CreateLinkRequest, type ShareLink, type ShareLinkView, type UpdateLinkRequest } from "@redline/shared";
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
  if (viewer.kind !== "link" || viewer.link.kind === "personal") return undefined;
  if (typeof visitorName !== "string" || visitorName.trim() === "" || visitorName.trim().length > MAX_VISITOR_NAME_LENGTH) return `visitorName must be 1 to ${MAX_VISITOR_NAME_LENGTH} characters`;
  return undefined;
}

/** What a comment through a link is signed with: the name of a personal link, the visitor's name on a generic one. Undefined for members. */
export function linkAuthorOf(viewer: Viewer, visitorName: unknown): LinkAuthor | undefined {
  if (viewer.kind !== "link") return undefined;
  return { linkId: viewer.link.id, name: viewer.link.kind === "personal" ? viewer.link.name : (visitorName as string).trim() };
}

/**
 * Share links: members create, list, edit, disable and reactivate them (page links here, project links in their own ticket),
 * and a visitor asks `GET /s/<token>/api/link` what its link opens. Which routes a visitor may call at all is `LINK_ROUTES`.
 */
export function registerLinkRoutes(app: FastifyInstance, store: Store, access: Access): void {
  /** The link as the viewer sees it: with whether they may change it. */
  const viewOf = (req: FastifyRequest, link: StoredLink): ShareLink => ({ ...link, canManage: canManage(req, link) });

  /** Its author, the creator of the project and the admins. */
  const canManage = (req: FastifyRequest, link: StoredLink): boolean => {
    if (req.viewer.kind !== "account") return access.mode === "none";
    return link.createdBy?.id === req.viewer.person.id || access.manages(req.viewer, projectOf(link));
  };
  const projectOf = (link: StoredLink): string => (link.scope === "project" ? link.scopeId : (store.projectIdOfPage(link.scopeId) ?? ""));

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/links", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.links.list("page", req.params.pageId).map((link) => viewOf(req, link));
  });

  app.post<{ Params: { pageId: string }; Body: CreateLinkRequest }>("/api/pages/:pageId/links", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    const body = req.body ?? ({} as Partial<CreateLinkRequest>);
    if (body.kind !== "personal" && body.kind !== "generic") return reply.code(400).send({ error: "kind must be personal or generic" });
    if (typeof body.name !== "string" || !isAccessLevel(body.level)) return reply.code(400).send({ error: "name and level are required" });
    const invalid = linkRequestError(body, body.kind);
    if (invalid) return reply.code(400).send({ error: invalid });
    const link = store.links.create({
      scope: "page",
      scopeId: req.params.pageId,
      kind: body.kind,
      name: body.name.trim(),
      level: body.level,
      direct: body.level === "comment" && body.direct === true,
      expiresAt: body.expiresAt ?? null,
      createdBy: req.person,
    });
    return reply.code(201).send(viewOf(req, link));
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
    return viewOf(req, store.links.update(link.id, { name: body.name?.trim(), level: body.level, direct: body.direct, expiresAt: body.expiresAt })!);
  });

  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/disable", async (req, reply) => {
    const link = manageable(req, reply);
    return link ? viewOf(req, store.links.setActive(link.id, false, req.person)!) : undefined;
  });

  app.post<{ Params: { linkId: string } }>("/api/links/:linkId/reactivate", async (req, reply) => {
    const link = manageable(req, reply);
    return link ? viewOf(req, store.links.setActive(link.id, true)!) : undefined;
  });

  app.get("/api/link", async (req, reply): Promise<ShareLinkView | undefined> => {
    const viewer = req.viewer;
    if (viewer.kind !== "link") return void reply.code(404).send({ error: "not found" });
    const { link } = viewer;
    const page = store.getPage(link.scopeId)!;
    const project = store.getProject(page.projectId)!;
    const memberLevel = viewer.member && access.levelOf(viewer.member, { pageId: page.id });
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
    return { scope: link.scope, kind: link.kind, level: link.level, name: link.name, page: { id: page.id, title: page.title }, project: { id: project.id, title: project.title }, memberRedirect };
  });
}
