import type { FastifyInstance, FastifyRequest } from "fastify";
import { INVITATION_PATH, NO_ACCESS_CODE, SESSION_PATH, SETUP_PATH, type AccountRole, type NoAccessResponse, type Person } from "@redline/shared";
import { HEALTH_PATH, hasHumanSecret, isMachinePath, type ProxySecrets } from "./proxy-secrets.js";
import { isLocalHost } from "./public-deadline.js";
import type { Store } from "./store.js";

export type AuthMode = "local" | "proxy" | "none";

/** Who made a request: exactly one of these, resolved once per request. */
export type Viewer =
  | { kind: "account"; person: Person; role?: AccountRole }
  | { kind: "link"; token: string }
  | { kind: "agent" }
  | { kind: "nobody" };

export type Action = "read" | "write";

/** What an action is about; empty means the instance itself (home, settings, design systems list). */
export interface Resource {
  projectId?: string;
  pageId?: string;
  designSystemId?: string;
  /** A thread or a conversation: it belongs to a page, so to a project. */
  threadId?: string;
  conversationId?: string;
}

/** The only place that knows the authentication mode: callers ask what a viewer may do, never which mode runs. */
export interface Access {
  readonly mode: AuthMode;
  viewerOf(req: FastifyRequest): Viewer;
  may(viewer: Viewer, action: Action, resource: Resource): boolean;
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
const OPEN_PATHS = new Set(["/api/me", HEALTH_PATH, SESSION_PATH, SETUP_PATH, INVITATION_PATH]);

export const SESSION_COOKIE = "redline_session";

/** The value of one cookie of the request, if it is there. */
export function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export interface AccessOptions {
  mode: AuthMode;
  store: Store;
  secrets?: ProxySecrets;
  /** Names of the SSO identity headers, read in proxy mode only. */
  identity: { userHeader: string; nameHeader: string; emailHeader: string };
}

/** Node decodes header bytes as latin1, SSOs send UTF-8. */
function headerText(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? "" : Buffer.from(first, "latin1").toString("utf8").trim();
}

export function createAccess({ mode, store, secrets, identity }: AccessOptions): Access {
  const viewerOf = (req: FastifyRequest): Viewer => {
    if (isMachinePath(req.url)) return { kind: "agent" };
    if (mode === "proxy" && secrets && req.url.startsWith("/api/") && hasHumanSecret(req, secrets)) {
      const id = headerText(req, identity.userHeader);
      if (id !== "") return { kind: "account", person: store.savePerson(id, headerText(req, identity.nameHeader), headerText(req, identity.emailHeader)) };
    }
    if (mode === "local" && req.url.startsWith("/api/")) {
      const session = cookieOf(req, SESSION_COOKIE);
      const account = session && store.accounts.accountOfSession(session);
      if (account) return { kind: "account", person: { id: account.id, name: account.name, email: account.email, initials: account.initials }, role: account.role };
    }
    return NOBODY;
  };
  const projectIdOf = (resource: Resource): string | undefined => {
    const pageId = resource.pageId ?? (resource.threadId ? store.getThread(resource.threadId)?.pageId : undefined) ?? (resource.conversationId ? store.getConversation(resource.conversationId)?.pageId : undefined);
    return resource.projectId ?? (pageId ? store.getPage(pageId)?.projectId : undefined);
  };
  /** The admins and the creator see every project; an Équipe project is seen by every account. */
  const sees = (viewer: Viewer, projectId: string): boolean => {
    if (viewer.kind !== "account") return true;
    if (viewer.role === "admin") return true;
    const ownership = store.projectOwnership(projectId);
    return !ownership || ownership.visibility === "team" || ownership.createdBy === viewer.person.id;
  };
  const may = (viewer: Viewer, _action: Action, resource: Resource): boolean => {
    // `none` and `proxy` allow everything today; `local` decides by role and visibility (levels come with member levels).
    if (mode !== "local") return true;
    // Machine paths check the agent token themselves.
    if (viewer.kind === "agent") return true;
    if (viewer.kind !== "account") return false;
    const projectId = projectIdOf(resource);
    return projectId === undefined || sees(viewer, projectId);
  };
  const manages = (viewer: Viewer, projectId: string): boolean => {
    if (mode !== "local") return true;
    return viewer.kind === "account" && (viewer.role === "admin" || store.projectOwnership(projectId)?.createdBy === viewer.person.id);
  };
  const creatorOf = (resource: Resource): Person | undefined => {
    const projectId = projectIdOf(resource);
    return projectId === undefined ? undefined : store.getProject(projectId)?.createdBy;
  };
  return { mode, viewerOf, may, manages, creatorOf };
}

function actionOf(req: FastifyRequest): Action {
  return req.method === "GET" || req.method === "HEAD" ? "read" : "write";
}

function resourceOf(req: FastifyRequest): Resource {
  const params = (req.params ?? {}) as Record<string, string | undefined>;
  return { projectId: params.projectId, pageId: params.pageId, designSystemId: params.designSystemId, threadId: params.threadId, conversationId: params.conversationId };
}

/** Resolves the viewer of every request, then refuses (403) what the viewer may not do, before any route runs. */
export function registerAccess(app: FastifyInstance, access: Access): void {
  app.decorateRequest("viewer", undefined as never);
  app.decorateRequest("person", undefined);
  app.addHook("onRequest", async (req) => {
    req.viewer = access.viewerOf(req);
    if (req.viewer.kind === "account") req.person = req.viewer.person;
  });
  app.addHook("preHandler", async (req, reply) => {
    if (OPEN_PATHS.has(req.url.split("?")[0])) return;
    // The web app's own files (the static handler and the single-page fallback) are what shows the sign-in screen.
    const route = req.routeOptions.url;
    if (route === undefined || route === "/*" || route === "/") return;
    const resource = resourceOf(req);
    if (!access.may(req.viewer, actionOf(req), resource)) {
      if (req.viewer.kind === "nobody" && access.mode === "local") return reply.code(401).send({ error: "sign-in required" });
      const creator = access.creatorOf(resource);
      const refusal: NoAccessResponse = { error: "no access to this project", code: NO_ACCESS_CODE, ...(creator ? { creator } : {}) };
      return reply.code(403).send(req.viewer.kind === "account" ? refusal : { error: "forbidden" });
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
export function assertModeCanStart(mode: AuthMode, options: { host: string; artboardOrigin?: string; publicUntil?: Date; proxySecrets?: ProxySecrets }): void {
  if (mode === "proxy" && !options.proxySecrets) {
    throw new Error('Mode "proxy" needs the proxy secrets: set REDLINE_PROXY_SECRET_HUMAN_FILE and REDLINE_PROXY_SECRET_MACHINE_FILE.');
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
  // 0.0.0.0 and :: are what a container binds; the compose file publishes them on loopback only.
  if (!["0.0.0.0", "::"].includes(options.host) && !isLocalHost(options.host)) refuse(`on a host that is not local (${options.host})`);
}
