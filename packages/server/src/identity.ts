import type { FastifyInstance, FastifyRequest } from "fastify";
import { ME_PATH, type DesignMdAuthor, type MeResponse, type Person } from "@redline/shared";
import { hasHumanSecret, type ProxySecrets } from "./proxy-secrets.js";
import type { OriginRef, Store } from "./store.js";

export interface IdentityConfig {
  /** Names of the request headers the SSO puts the signed-in person in (Authelia's by default). */
  userHeader: string;
  nameHeader: string;
  emailHeader: string;
  /** Where "Se déconnecter" leads: the SSO's logout page. */
  logoutUrl?: string;
}

export const DEFAULT_IDENTITY: IdentityConfig = { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" };

export function identityFromEnv(env: NodeJS.ProcessEnv): IdentityConfig {
  return {
    userHeader: (env.REDLINE_IDENTITY_HEADER_USER || DEFAULT_IDENTITY.userHeader).toLowerCase(),
    nameHeader: (env.REDLINE_IDENTITY_HEADER_NAME || DEFAULT_IDENTITY.nameHeader).toLowerCase(),
    emailHeader: (env.REDLINE_IDENTITY_HEADER_EMAIL || DEFAULT_IDENTITY.emailHeader).toLowerCase(),
    logoutUrl: env.REDLINE_LOGOUT_URL || undefined,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in person who made the request; undefined without SSO or when the SSO sent no user id. */
    person?: Person;
  }
}

/** The viewer as the signature of a version they make; undefined without SSO. */
export function personRef(req: FastifyRequest): OriginRef | undefined {
  return req.person && { person: req.person };
}

/** A DESIGN.md or tokens save made by the viewer in the editor. */
export function editorAuthor(req: FastifyRequest): DesignMdAuthor {
  return { origin: "user", ...personRef(req) };
}

/** Node decodes header bytes as latin1, SSOs send UTF-8. */
function headerText(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? "" : Buffer.from(first, "latin1").toString("utf8").trim();
}

/**
 * Reads the signed-in person from the SSO headers, on `/api` requests carrying the human proxy secret only. An SSO
 * is "configured" when the proxy secrets are: without them anyone could forge the headers, so they are never read.
 */
export function registerIdentity(app: FastifyInstance, store: Store, secrets: ProxySecrets | undefined, config: IdentityConfig = DEFAULT_IDENTITY): void {
  app.decorateRequest("person", undefined);
  if (secrets) {
    app.addHook("onRequest", async (req) => {
      if (!req.url.startsWith("/api/") || !hasHumanSecret(req, secrets)) return;
      const id = headerText(req, config.userHeader);
      if (id === "") return;
      req.person = store.savePerson(id, headerText(req, config.nameHeader), headerText(req, config.emailHeader));
    });
  }
  app.get(ME_PATH, async (req, reply) => {
    const me: MeResponse = req.person ? { ...req.person, logoutUrl: config.logoutUrl ?? null } : null;
    return reply.type("application/json").send(JSON.stringify(me));
  });
}
