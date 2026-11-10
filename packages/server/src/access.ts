import type { FastifyInstance, FastifyRequest } from "fastify";
import { INSUFFICIENT_LEVEL_CODE, INVITATION_PATH, LINK_DEAD_CODE, type LinkDeadResponse, NO_ACCESS_CODE, PASSWORD_LINK_PATH, initialsOf, SESSION_PATH, SETUP_PATH, type AccessLevel, type AccountRole, type InsufficientLevelResponse, type NoAccessResponse, type Person } from "@redline/shared";
import { HEALTH_PATH, hasHumanSecret, isMachinePath, type ProxySecrets } from "./proxy-secrets.js";
import { isLocalHost } from "./public-deadline.js";
import type { Store } from "./store.js";
import type { StoredLink } from "./link-store.js";
import { linkTokenOf } from "./link-url.js";

export type AuthMode = "local" | "proxy" | "none";

/** Who made a request: exactly one of these, resolved once per request. */
export type AccountViewer = { kind: "account"; person: Person; role?: AccountRole };
export type Viewer =
  | AccountViewer
  /** Someone holding a working share link; `member` is the signed-in account that opened it, if any. */
  | { kind: "link"; token: string; link: StoredLink; member?: AccountViewer }
  /** A machine caller (agent, CLI, terminal session). With a `person`, its token is that account's and it only works where that person has Écriture. */
  | { kind: "agent"; person?: Person; role?: AccountRole }
  | { kind: "nobody"; /** In proxy mode, the SSO person Redline has no account for: they are told whom to ask. */ ssoPerson?: Person };

/** What a request needs: a level of the project (`read` views, `comment` comments, `write` works on pages), or `manage` (creator and admins). */
export type Action = AccessLevel | "manage";

const LEVEL_RANK: Record<AccessLevel, number> = { read: 0, comment: 1, write: 2 };
/** Writes a member at Commentaire may make: comment and reply. Resolving and reopening need Écriture. */
const COMMENT_ROUTES = new Set(["POST /api/pages/:pageId/threads", "POST /api/threads/:threadId/messages"]);
/** Writes that stay with the creator of the project and the admins. */
const MANAGE_ROUTES = new Set(["POST /api/projects/:projectId/archive", "POST /api/projects/:projectId/unarchive", "DELETE /api/projects/:projectId", "PUT /api/projects/:projectId/members/:personId", "DELETE /api/projects/:projectId/members/:personId"]);

/** The calls a link visitor may make, each with the lowest link level that allows it. Tickets for the higher levels add their routes here. */
export const LINK_ROUTES: Record<string, AccessLevel> = {
  "GET /api/pages/:pageId": "read",
  "GET /api/pages/:pageId/files/*": "read",
  "GET /api/pages/:pageId/threads": "read",
  "POST /api/pages/:pageId/threads": "comment",
  "POST /api/threads/:threadId/messages": "comment",
  "GET /api/projects/:projectId": "read",
  "GET /api/projects/:projectId/artboard-capability": "read",
  "GET /api/projects/:projectId/pages": "read",
  "GET /api/projects/:projectId/threads": "write",
  // From here on, an Écriture link works like a member on its scope; links, archive, delete and agents stay out.
  "POST /api/projects/:projectId/pages": "write",
  "GET /api/pages/:pageId/versions": "write",
  "POST /api/pages/:pageId/versions/:versionId/restore": "write",
  "POST /api/pages/:pageId/tweaks": "write",
  "POST /api/pages/:pageId/view-settings": "write",
  "POST /api/pages/:pageId/fit-height": "write",
  "GET /api/pages/:pageId/artboard-versions": "write",
  "GET /api/pages/:pageId/deleted-artboards": "write",
  "POST /api/pages/:pageId/artboards/restore": "write",
  "POST /api/threads/:threadId/resolve": "write",
  "POST /api/threads/:threadId/reopen": "write",
  "POST /api/pages/:pageId/send-review": "write",
  "POST /api/pages/:pageId/send-held": "write",
  "PATCH /api/pages/:pageId": "write",
  "POST /api/threads/:threadId/hand-over": "write",
};
/** Calls a project link may make but a page link may not: a page link reaches its own page, never the pages around it. */
const LINK_PROJECT_ONLY_ROUTES = new Set(["POST /api/projects/:projectId/pages"]);
/** Calls that name no project or page and tell a visitor nothing beyond its own link. */
const LINK_OPEN_ROUTES = new Set(["GET /api/link", "GET /api/config", "GET /api/events"]);

/** Reads that stay with members in Écriture: they show what the team shares. */
const READS_NEEDING_WRITE = new Set(["GET /api/pages/:pageId/links", "GET /api/projects/:projectId/links"]);

/** What an action is about; empty means the instance itself (home, settings, design systems list). */
export interface Resource {
  projectId?: string;
  pageId?: string;
  designSystemId?: string;
  /** A thread or a conversation: it belongs to a page, so to a project. */
  threadId?: string;
  conversationId?: string;
  /** A share link: it belongs to a page or a project, so to a project. */
  linkId?: string;
}

/** The only place that knows the authentication mode: callers ask what a viewer may do, never which mode runs. */
export interface Access {
  readonly mode: AuthMode;
  viewerOf(req: FastifyRequest): Viewer;
  may(viewer: Viewer, action: Action, resource: Resource): boolean;
  /** The viewer's effective level on the project a resource belongs to, or undefined without access. Everyone is at Écriture where there is no project (and in modes without accounts). */
  levelOf(viewer: Viewer, resource: Resource): AccessLevel | undefined;
  /** Whether the viewer decides who sees the project and at which level: its creator and the admins. */
  manages(viewer: Viewer, projectId: string): boolean;
  /** The creator of the project a resource belongs to, to name who to ask when `may` says no. */
  creatorOf(resource: Resource): Person | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    viewer: Viewer;
    /** The signed-in person who made the request: the viewer when it is an account, else undefined. */
    person?: Person;
  }
}

const NOBODY: Viewer = { kind: "nobody" };
/** Paths a viewer may always reach: they say who the viewer is, or answer the container's probe. */
const OPEN_PATHS = new Set(["/api/me", HEALTH_PATH, SESSION_PATH, SETUP_PATH, INVITATION_PATH, PASSWORD_LINK_PATH]);

export const SESSION_COOKIE = "redline_session";

/** The value of one cookie of the request, if it is there. */
export function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The level an account has on a project: admins and the creator at Écriture; Équipe, the lowered level else Écriture; Privé, the chosen level else none. */
export function accountLevelIn(store: Store, account: { id: string; role?: AccountRole }, projectId: string): AccessLevel | undefined {
  if (account.role === "admin") return "write";
  const ownership = store.projectOwnership(projectId);
  if (!ownership) return "write";
  if (ownership.createdBy === account.id) return "write";
  const own = store.memberLevel(projectId, account.id);
  return ownership.visibility === "team" ? (own ?? "write") : own;
}

export interface AccessOptions {
  mode: AuthMode;
  store: Store;
  secrets?: ProxySecrets;
  /** Names of the SSO identity headers, read in proxy mode only. */
  identity: { userHeader: string; nameHeader: string; emailHeader: string };
  /** Proxy mode: the only e-mail that becomes the first admin of an instance with no account. */
  firstAdminEmail?: string;
}

/** Node decodes header bytes as latin1, SSOs send UTF-8. */
function headerText(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? "" : Buffer.from(first, "latin1").toString("utf8").trim();
}

export function createAccess({ mode, store, secrets, identity, firstAdminEmail }: AccessOptions): Access {
  /** The signed-in account behind the request, else the SSO person without an account, else nobody. */
  const signedInOf = (req: FastifyRequest): Viewer => {
    if (mode === "proxy" && secrets && req.url.startsWith("/api/") && hasHumanSecret(req, secrets)) {
      const id = headerText(req, identity.userHeader);
      if (id !== "") {
        const name = headerText(req, identity.nameHeader);
        const email = headerText(req, identity.emailHeader);
        const account = store.accounts.signInThroughSso({ id, name, email }, firstAdminEmail);
        if (!account) return { kind: "nobody", ssoPerson: { id, name, email, initials: initialsOf(name, id) } };
        return { kind: "account", person: { id: account.id, name: account.name, email: account.email, initials: account.initials }, role: account.role };
      }
    }
    if (mode === "local" && req.url.startsWith("/api/")) {
      const session = cookieOf(req, SESSION_COOKIE);
      const account = session && store.accounts.accountOfSession(session);
      if (account) return { kind: "account", person: { id: account.id, name: account.name, email: account.email, initials: account.initials }, role: account.role };
    }
    return NOBODY;
  };
  const viewerOf = (req: FastifyRequest): Viewer => {
    if (isMachinePath(req.url)) {
      const given = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice("Bearer ".length) : undefined;
      const account = store.accounts.agentActorOf(given)?.account;
      return account ? { kind: "agent", person: { id: account.id, name: account.name, email: account.email, initials: account.initials }, role: account.role } : { kind: "agent" };
    }
    const token = linkTokenOf(req);
    if (token === undefined) return signedInOf(req);
    const link = store.links.live(token);
    if (!link) return NOBODY;
    const signedIn = signedInOf(req);
    return { kind: "link", token, link, ...(signedIn.kind === "account" ? { member: signedIn } : {}) };
  };
  const projectIdOf = (resource: Resource): string | undefined => {
    const link = resource.linkId ? store.links.get(resource.linkId) : undefined;
    const pageId = resource.pageId ?? (link?.scope === "page" ? link.scopeId : undefined) ?? (resource.threadId ? store.getThread(resource.threadId)?.pageId : undefined) ?? (resource.conversationId ? store.getConversation(resource.conversationId)?.pageId : undefined);
    return resource.projectId ?? (link?.scope === "project" ? link.scopeId : undefined) ?? (pageId ? store.getPage(pageId)?.projectId : undefined);
  };
  const levelIn = (viewer: Viewer, projectId: string): AccessLevel | undefined => {
    if (mode === "none") return "write";
    if (viewer.kind === "agent") {
      // An agent has its person's rights, but only works where that person writes.
      if (!viewer.person) return "write";
      return accountLevelIn(store, { id: viewer.person.id, role: viewer.role }, projectId) === "write" ? "write" : undefined;
    }
    if (viewer.kind !== "account") return undefined;
    return accountLevelIn(store, { id: viewer.person.id, role: viewer.role }, projectId);
  };
  /** A link opens its page (and, for the capability and the trimmed project, that page's project): nothing else, whatever its level. */
  const inLinkScope = (link: StoredLink, resource: Resource): boolean => {
    const projectId = projectIdOf(resource);
    if (link.scope === "project") {
      const pageId = resource.pageId ?? (resource.threadId ? store.getThread(resource.threadId)?.pageId : undefined) ?? (resource.conversationId ? store.getConversation(resource.conversationId)?.pageId : undefined);
      // A project link covers its present and future pages, not the archived ones.
      if (pageId !== undefined && store.getPage(pageId)?.archivedAt) return false;
      return projectId === link.scopeId;
    }
    const pageId = resource.pageId ?? (resource.threadId ? store.getThread(resource.threadId)?.pageId : undefined) ?? (resource.conversationId ? store.getConversation(resource.conversationId)?.pageId : undefined);
    if (pageId !== undefined) return pageId === link.scopeId;
    return projectId !== undefined && projectId === store.projectIdOfPage(link.scopeId);
  };
  const levelOf = (viewer: Viewer, resource: Resource): AccessLevel | undefined => {
    if (viewer.kind === "link") return inLinkScope(viewer.link, resource) ? viewer.link.level : undefined;
    if (mode === "none" || (viewer.kind === "agent" && !viewer.person)) return "write";
    if (viewer.kind !== "account" && viewer.kind !== "agent") return undefined;
    const projectId = projectIdOf(resource);
    return projectId === undefined ? "write" : levelIn(viewer, projectId);
  };
  const manages = (viewer: Viewer, projectId: string): boolean => {
    if (viewer.kind === "link") return false;
    if (mode === "none") return true;
    if (viewer.kind === "agent" && !viewer.person) return true;
    if (viewer.kind !== "account" && viewer.kind !== "agent") return false;
    // A design system is a project row with no creator: any account manages it, as it sees it.
    if (viewer.role === "admin" || store.getDesignSystem(projectId) || !store.projectOwnership(projectId)) return true;
    return store.projectOwnership(projectId)?.createdBy === viewer.person!.id;
  };
  const may = (viewer: Viewer, action: Action, resource: Resource): boolean => {
    const level = levelOf(viewer, resource);
    if (level === undefined) return false;
    if (action === "manage") {
      const projectId = projectIdOf(resource);
      return projectId === undefined || manages(viewer, projectId);
    }
    return LEVEL_RANK[level] >= LEVEL_RANK[action];
  };
  const creatorOf = (resource: Resource): Person | undefined => {
    const projectId = projectIdOf(resource);
    return projectId === undefined ? undefined : store.getProject(projectId)?.createdBy;
  };
  return { mode, viewerOf, may, levelOf, manages, creatorOf };
}

/** A copy of `value` where every `person` is reduced to its name and initials. */
function withoutAccountDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAccountDetails);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (key === "person" && typeof inner === "object" && inner !== null) {
        const { name, initials } = inner as Person;
        return [key, { name, initials }];
      }
      return [key, withoutAccountDetails(inner)];
    }),
  );
}

function actionOf(req: FastifyRequest): Action {
  const route = `${req.method} ${req.routeOptions.url}`;
  if (READS_NEEDING_WRITE.has(route)) return "write";
  if (req.method === "GET" || req.method === "HEAD") return "read";
  return MANAGE_ROUTES.has(route) ? "manage" : COMMENT_ROUTES.has(route) ? "comment" : "write";
}

function resourceOf(req: FastifyRequest): Resource {
  const params = (req.params ?? {}) as Record<string, string | undefined>;
  return { projectId: params.projectId, pageId: params.pageId, designSystemId: params.designSystemId, threadId: params.threadId, conversationId: params.conversationId, linkId: params.linkId };
}

/** Resolves the viewer of every request, then refuses (403) what the viewer may not do, before any route runs. */
export function registerAccess(app: FastifyInstance, access: Access): void {
  app.decorateRequest("viewer", undefined as never);
  app.decorateRequest("person", undefined);
  app.addHook("onRequest", async (req, reply) => {
    req.viewer = access.viewerOf(req);
    if (req.viewer.kind === "account") req.person = req.viewer.person;
    // One answer for every link that does not work, so a visitor learns nothing about why.
    if (linkTokenOf(req) !== undefined && req.viewer.kind !== "link") {
      const dead: LinkDeadResponse = { error: "This link does not work any more.", code: LINK_DEAD_CODE };
      return reply.code(404).send(dead);
    }
  });
  // A visitor learns who wrote what by name, never by e-mail or account id.
  app.addHook("preSerialization", async (req, _reply, payload) => (req.viewer.kind === "link" ? withoutAccountDetails(payload) : payload));
  app.addHook("preHandler", async (req, reply) => {
    if (OPEN_PATHS.has(req.url.split("?")[0])) return;
    // The web app's own files (the static handler and the single-page fallback) are what shows the sign-in screen.
    const route = req.routeOptions.url;
    if (route === undefined || route === "/*" || route === "/") return;
    const resource = resourceOf(req);
    if (req.viewer.kind === "link") {
      const key = `${req.method} ${route}`;
      if (LINK_OPEN_ROUTES.has(key)) return;
      const needed = LINK_ROUTES[key];
      if (needed === undefined || !access.may(req.viewer, needed, resource)) return reply.code(403).send({ error: "forbidden" });
      if (LINK_PROJECT_ONLY_ROUTES.has(key) && req.viewer.link.scope !== "project") return reply.code(403).send({ error: "forbidden" });
      return;
    }
    if (!access.may(req.viewer, actionOf(req), resource)) {
      if (req.viewer.kind === "nobody" && access.mode === "local") return reply.code(401).send({ error: "sign-in required" });
      if (req.viewer.kind === "agent" && req.viewer.person) return reply.code(403).send({ error: "your account does not have Écriture on this project, so your agent cannot work on it" });
      if (req.viewer.kind !== "account") return reply.code(403).send({ error: "forbidden" });
      const creator = access.creatorOf(resource);
      const found = creator ? { creator } : {};
      if (access.levelOf(req.viewer, resource) === undefined) {
        const refusal: NoAccessResponse = { error: "no access to this project", code: NO_ACCESS_CODE, ...found };
        return reply.code(403).send(refusal);
      }
      const refusal: InsufficientLevelResponse = { error: "your level on this project does not allow this", code: INSUFFICIENT_LEVEL_CODE, ...found };
      return reply.code(403).send(refusal);
    }
  });
}

export function authModeFromEnv(env: NodeJS.ProcessEnv): AuthMode | undefined {
  const value = env.REDLINE_AUTH_MODE?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "local" || value === "none" || value === "proxy") return value;
  throw new Error(`REDLINE_AUTH_MODE must be local, proxy or none, not "${value}".`);
}

/** The mode a process runs in: the one named, else `proxy` behind the proxy secrets, else the built-in accounts. */
export function resolveAuthMode(env: NodeJS.ProcessEnv, proxySecrets: ProxySecrets | undefined): AuthMode {
  return authModeFromEnv(env) ?? (proxySecrets ? "proxy" : "local");
}

/** Mode `none` has no login: it refuses to start wherever someone else could reach it. */
export function assertModeCanStart(mode: AuthMode, options: { host: string; artboardOrigin?: string; publicUntil?: Date; proxySecrets?: ProxySecrets; publicUrl?: string; firstAdminEmail?: string }): void {
  if (mode === "proxy" && !options.proxySecrets) {
    throw new Error('Mode "proxy" needs the proxy secrets: set REDLINE_PROXY_SECRET_HUMAN_FILE and REDLINE_PROXY_SECRET_MACHINE_FILE.');
  }
  if (mode === "proxy" && !options.firstAdminEmail?.trim()) {
    throw new Error("Mode \"proxy\" needs REDLINE_FIRST_ADMIN_EMAIL: the e-mail of the SSO person who becomes the first admin.");
  }
  if (mode !== "proxy" && options.proxySecrets) {
    throw new Error(`Proxy secrets are set but the mode is "${mode}": use mode "proxy", or remove the secrets.`);
  }
  if (mode !== "none") return;
  const refuse = (why: string) => {
    throw new Error(`Mode "none" has no login and refuses to start ${why}. Use mode "proxy" behind an SSO, or remove it.`);
  };
  if (options.publicUntil) refuse("with REDLINE_PUBLIC_UNTIL set (a public share)");
  if (options.artboardOrigin && !isLocalHost(new URL(options.artboardOrigin).hostname.replace(/^(?=.*:)(.*)$/, "[$1]"))) {
    refuse(`behind a tunnel (artboard origin ${options.artboardOrigin} is not a local name)`);
  }
  if (options.publicUrl && !isLocalHost(new URL(options.publicUrl).hostname.replace(/^(?=.*:)(.*)$/, "[$1]"))) {
    refuse(`with REDLINE_PUBLIC_URL ${options.publicUrl} (not a local name)`);
  }
  // 0.0.0.0 and :: are what a container binds; the compose file publishes them on loopback only.
  if (!["0.0.0.0", "::"].includes(options.host) && !isLocalHost(options.host)) refuse(`on a host that is not local (${options.host})`);
}
