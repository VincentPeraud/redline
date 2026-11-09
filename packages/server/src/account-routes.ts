import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ACCOUNTS_PATH, INVITATIONS_PATH, INVITATION_PATH, MY_ACCOUNT_PATH, MY_PASSWORD_PATH, PASSWORD_LINK_PATH, SESSION_PATH, SETUP_PATH } from "@redline/shared";
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

const STATUS_OF_ERROR: Record<AccountError["code"], number> = {
  "invalid-link": 404,
  "password-too-short": 400,
  "invalid-email": 400,
  "invalid-role": 400,
  "email-taken": 409,
  "invitation-pending": 409,
  "unknown-account": 404,
  "last-admin": 409,
  "self-deactivation": 409,
  "wrong-password": 400,
  "invalid-name": 400,
};

/** The accounts screen: admins only (a member gets 403, nobody 401 before this runs). */
const isAdmin = (req: FastifyRequest) => req.viewer.kind === "account" && req.viewer.role === "admin";
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "Only an admin manages accounts." });

/** Runs an account action and turns its refusals into their status; other errors are bugs. */
async function answering<T>(reply: FastifyReply, action: () => T | Promise<T>, success: (value: T) => unknown = (value) => value) {
  try {
    return success(await action());
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    return reply.code(STATUS_OF_ERROR[error.code]).send({ error: error.message, code: error.code });
  }
}

/** Setup link, invitation, sign-in and sign-out of the built-in accounts, and the accounts screen. The setup, invitation and session paths are open to people who are not signed in. */
export function registerAccountRoutes(app: FastifyInstance, store: Store, mode: "local" | "proxy"): void {
  /** Behind an SSO the same screen adds people by e-mail, with no link and no password: the built-in sign-in routes are not there. */
  if (mode === "local") registerBuiltInSignIn(app, store);
  registerAccountManagement(app, store, mode);
}

function registerBuiltInSignIn(app: FastifyInstance, store: Store): void {
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
      return reply.code(STATUS_OF_ERROR[error.code]).send({ error: error.message, code: error.code });
    }
  });

  app.get<{ Querystring: { token?: string } }>(INVITATION_PATH, async (req, reply) => {
    const preview = store.accounts.previewInvitation(req.query.token ?? "");
    return preview ?? reply.code(404).send({ error: "This invitation link is expired, used or cancelled.", code: "invalid-link" });
  });

  app.post<{ Body: { token?: string; name?: string; password?: string } }>(INVITATION_PATH, async (req, reply) => {
    const { token = "", name = "", password = "" } = req.body ?? {};
    try {
      const person = await store.accounts.acceptInvitation(token, { name, password });
      signIn(store, req, reply, person.id);
      return reply.code(201).send(person);
    } catch (error) {
      if (!(error instanceof AccountError)) throw error;
      return reply.code(STATUS_OF_ERROR[error.code]).send({ error: error.message, code: error.code });
    }
  });

  app.post<{ Params: { id: string } }>(`${ACCOUNTS_PATH}/:id/password-link`, async (req, reply) =>
    isAdmin(req) ? answering(reply, () => store.accounts.issuePasswordLink(req.params.id), (link) => reply.code(201).send(link)) : forbidden(reply),
  );

  app.get<{ Querystring: { token?: string } }>(PASSWORD_LINK_PATH, async (req, reply) =>
    store.accounts.previewPasswordLink(req.query.token ?? "") ?? reply.code(404).send({ error: "This password link is expired or used.", code: "invalid-link" }),
  );

  app.post<{ Body: { token?: string; password?: string } }>(PASSWORD_LINK_PATH, async (req, reply) =>
    answering(reply, () => store.accounts.choosePassword(req.body?.token ?? "", req.body?.password ?? ""), (person) => {
      signIn(store, req, reply, person.id);
      return person;
    }),
  );

  /** Mon compte: any signed-in account changes its own name and password. */
  app.patch<{ Body: { name?: string } }>(MY_ACCOUNT_PATH, async (req, reply) => answering(reply, () => store.accounts.rename(req.person!.id, req.body?.name ?? "")));

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(MY_PASSWORD_PATH, async (req, reply) =>
    answering(reply, () => store.accounts.changePassword(req.person!.id, cookieOf(req, SESSION_COOKIE), req.body?.currentPassword ?? "", req.body?.newPassword ?? ""), () => reply.code(204).send()),
  );

  app.post<{ Body: { email?: string; password?: string } }>(SESSION_PATH, async (req, reply) => {
    const { email = "", password = "" } = req.body ?? {};
    const ip = clientIp(req);
    if (throttle.isLocked(email, ip)) return reply.code(429).send({ error: TOO_MANY_ATTEMPTS });
    const person = await store.accounts.authenticate(email, password);
    if (!person) {
      throttle.recordFailure(email, ip);
      if (throttle.isLocked(email, ip)) return reply.code(429).send({ error: TOO_MANY_ATTEMPTS });
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

function registerAccountManagement(app: FastifyInstance, store: Store, mode: "local" | "proxy"): void {
  app.get(ACCOUNTS_PATH, async (req, reply) => (isAdmin(req) ? { ...store.accounts.list(), sso: mode === "proxy" } : forbidden(reply)));

  app.post<{ Body: { email?: string; role?: string } }>(INVITATIONS_PATH, async (req, reply) => {
    if (!isAdmin(req)) return forbidden(reply);
    try {
      return reply.code(201).send(store.accounts.invite(req.person!.id, { email: req.body?.email ?? "", role: req.body?.role ?? "" }, mode === "proxy" ? "never" : "7-days"));
    } catch (error) {
      if (!(error instanceof AccountError)) throw error;
      return reply.code(STATUS_OF_ERROR[error.code]).send({ error: error.message, code: error.code });
    }
  });

  app.delete<{ Params: { id: string } }>(`${INVITATIONS_PATH}/:id`, async (req, reply) => {
    if (!isAdmin(req)) return forbidden(reply);
    return store.accounts.cancelInvitation(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "This invitation is unknown or already used." });
  });

  app.patch<{ Params: { id: string }; Body: { role?: string } }>(`${ACCOUNTS_PATH}/:id`, async (req, reply) =>
    isAdmin(req) ? answering(reply, () => store.accounts.setRole(req.params.id, req.body?.role ?? "")) : forbidden(reply),
  );

  app.post<{ Params: { id: string } }>(`${ACCOUNTS_PATH}/:id/deactivate`, async (req, reply) =>
    isAdmin(req) ? answering(reply, () => store.accounts.deactivate(req.person!.id, req.params.id)) : forbidden(reply),
  );

  app.post<{ Params: { id: string } }>(`${ACCOUNTS_PATH}/:id/reactivate`, async (req, reply) =>
    isAdmin(req) ? answering(reply, () => store.accounts.reactivate(req.params.id)) : forbidden(reply),
  );
}
