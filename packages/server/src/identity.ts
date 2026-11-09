import type { FastifyInstance, FastifyRequest } from "fastify";
import { ME_PATH, type DesignMdAuthor, type MeResponse, type Person } from "@redline/shared";
import type { OriginRef } from "./store.js";

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

/** The viewer as the signature of a version they make; undefined without SSO. */
export function personRef(req: FastifyRequest): OriginRef | undefined {
  return req.person && { person: req.person };
}

/** A DESIGN.md or tokens save made by the viewer in the editor. */
export function editorAuthor(req: FastifyRequest): DesignMdAuthor {
  return { origin: "user", ...personRef(req) };
}

/** Serves `/api/me`: who the viewer is, with the SSO's logout page. The viewer itself is resolved by the access module. */
export function registerIdentity(app: FastifyInstance, config: IdentityConfig = DEFAULT_IDENTITY): void {
  app.get(ME_PATH, async (req, reply) => {
    const me: MeResponse = req.person ? { ...req.person, logoutUrl: config.logoutUrl ?? null } : null;
    return reply.type("application/json").send(JSON.stringify(me));
  });
}
