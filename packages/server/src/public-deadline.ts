import type { Socket } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";

const SWEEP_INTERVAL_MS = 60_000;

/** Reads `REDLINE_PUBLIC_UNTIL` (an ISO date); unset means no deadline, an unreadable date stops the server rather than leaving it open. */
export function publicDeadlineFromEnv(env: NodeJS.ProcessEnv): Date | undefined {
  const value = env.REDLINE_PUBLIC_UNTIL?.trim();
  if (!value) return undefined;
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime())) throw new Error(`REDLINE_PUBLIC_UNTIL is not a date: ${value}`);
  return deadline;
}

/** The host the client asked for, from the raw `Host` header only: `X-Forwarded-Host` can be set by anyone behind a tunnel. */
function hostOf(req: FastifyRequest): string {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

export function isLocalHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/**
 * After the deadline, refuses (403) every request whose `Host` is not a local name, so a tunnel to this
 * machine stops working even if nothing closes it. No timer decides the refusal, each request compares the clock;
 * a sweep only closes the connections that public hosts opened (live streams, keep-alive) once the time is up.
 */
export function registerPublicDeadline(app: FastifyInstance, deadline: Date | undefined, now: () => number = Date.now): void {
  if (!deadline) return;
  const until = deadline.getTime();
  const publicSockets = new Set<Socket>();
  const closeIfDue = () => {
    if (now() < until) return;
    for (const socket of publicSockets) socket.destroy();
    publicSockets.clear();
  };

  app.addHook("onRequest", async (req, reply) => {
    if (isLocalHost(hostOf(req))) return;
    if (now() >= until) return reply.code(403).send();
    const socket = req.raw.socket;
    if (!publicSockets.has(socket)) {
      publicSockets.add(socket);
      socket.once("close", () => publicSockets.delete(socket));
    }
  });

  const sweep = setInterval(closeIfDue, SWEEP_INTERVAL_MS);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));
}
