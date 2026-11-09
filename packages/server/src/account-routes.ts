import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_PATH, SETUP_PATH } from "@redline/shared";
import { AccountError, SESSION_DAYS } from "./accounts.js";
import { SESSION_COOKIE, cookieOf } from "./access.js";
import { LoginThrottle } from "./login-throttle.js";
import type { Store } from "./store.js";

export const WRONG_CREDENTIALS = "Email ou mot de passe incorrect.";
export const TOO_MANY_ATTEMPTS = "Trop d'essais. Réessaie dans 15 minutes, ou demande à un admin un lien pour changer ton mot de passe.";

/** The proxy in front appends the address it saw as the last entry; earlier ones are whatever the client sent. */
function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").pop()?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

function sessionCookie(req: FastifyRequest, value: string, maxAgeSeconds: number): string {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function signIn(store: Store, req: FastifyRequest, reply: FastifyReply, personId: string): void {
  const { token } = store.accounts.createSession(personId);
  reply.header("set-cookie", sessionCookie(req, token, SESSION_DAYS * 86_400));
}

/** Setup link, sign-in and sign-out of the built-in accounts. All three paths are open to people who are not signed in. */
export function registerAccountRoutes(app: FastifyInstance, store: Store): void {
  const throttle = new LoginThrottle();

  app.get<{ Querystring: { token?: string } }>(SETUP_PATH, async (req, reply) =>
    store.accounts.isSetupTokenValid(req.query.token ?? "") ? reply.send({ valid: true }) : reply.code(404).send({ error: "This setup link is used or unknown." }),
  );

  app.post<{ Body: { token?: string; name?: string; email?: string; password?: string } }>(SETUP_PATH, async (req, reply) => {
    const { token = "", name = "", email = "", password = "" } = req.body ?? {};
    try {
      const person = await store.accounts.createFirstAdmin(token, { name, email, password });
      signIn(store, req, reply, person.id);
      return reply.code(201).send({ ...person, account: { role: "admin" } });
    } catch (error) {
      if (!(error instanceof AccountError)) throw error;
      return reply.code(error.code === "invalid-link" ? 404 : 400).send({ error: error.message, code: error.code });
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>(SESSION_PATH, async (req, reply) => {
    const { email = "", password = "" } = req.body ?? {};
    const ip = clientIp(req);
    if (throttle.isLocked(email, ip)) return reply.code(429).send({ error: TOO_MANY_ATTEMPTS });
    const person = await store.accounts.authenticate(email, password);
    if (!person) {
      throttle.recordFailure(email, ip);
      return reply.code(401).send({ error: WRONG_CREDENTIALS });
    }
    throttle.recordSuccess(email, ip);
    signIn(store, req, reply, person.id);
    return reply.send(person);
  });

  app.delete(SESSION_PATH, async (req, reply) => {
    const token = cookieOf(req, SESSION_COOKIE);
    if (token) store.accounts.deleteSession(token);
    return reply.header("set-cookie", sessionCookie(req, "", 0)).code(204).send();
  });
}
