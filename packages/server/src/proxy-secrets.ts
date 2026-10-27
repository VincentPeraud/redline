import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { AGENT_API_PREFIX, AGENT_ENDPOINT } from "@redline/shared";
import { tokensEqual } from "./request-hardening.js";

export const PROXY_SECRET_HEADER = "x-redline-proxy-secret";
export const HEALTH_PATH = "/healthz";
const CLI_PREFIX = "/cli";
const MIN_SECRET_LENGTH = 32;

export interface ProxySecrets {
  /** Added by the proxy on the routes of signed-in people: UI, API and artboard origin. */
  human: string;
  /** Added by the proxy on the machine route only: `/agent`, `/agent-api/*` and `/cli/*`. */
  machine: string;
}

/** Reads the two secret files named by the environment; none set means no check. */
export function proxySecretsFromEnv(env: NodeJS.ProcessEnv): ProxySecrets | undefined {
  const humanFile = env.REDLINE_PROXY_SECRET_HUMAN_FILE;
  const machineFile = env.REDLINE_PROXY_SECRET_MACHINE_FILE;
  if (!humanFile && !machineFile) return undefined;
  if (!humanFile || !machineFile) {
    throw new Error("Set both REDLINE_PROXY_SECRET_HUMAN_FILE and REDLINE_PROXY_SECRET_MACHINE_FILE, or neither.");
  }
  return { human: readFileSync(humanFile, "utf8").trim(), machine: readFileSync(machineFile, "utf8").trim() };
}

export function assertValidProxySecrets({ human, machine }: ProxySecrets): void {
  if (human.length < MIN_SECRET_LENGTH || machine.length < MIN_SECRET_LENGTH) {
    throw new Error(`Proxy secrets must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }
  if (human === machine) throw new Error("The human and machine proxy secrets must be different.");
}

function pathOf(url: string): string {
  return url.split("?")[0];
}

function isMachinePath(url: string): boolean {
  const path = pathOf(url);
  return path === AGENT_ENDPOINT || path.startsWith(`${AGENT_API_PREFIX}/`) || path.startsWith(`${CLI_PREFIX}/`);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Answers the container's own health probe: only from its loopback, and without the proxy secret. */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get(HEALTH_PATH, async (req, reply) => {
    if (!isLoopback(req.socket.remoteAddress)) return reply.code(403).send();
    return reply.send("ok");
  });
}

/** Refuses (403, no detail) every request that does not carry the secret of the route it reached. No secrets, no check. */
export function registerProxySecretCheck(app: FastifyInstance, secrets: ProxySecrets | undefined, options: { artboards?: boolean } = {}): void {
  if (!secrets) return;
  app.addHook("onRequest", async (req, reply) => {
    if (pathOf(req.url) === HEALTH_PATH && isLoopback(req.socket.remoteAddress)) return;
    const given = req.headers[PROXY_SECRET_HEADER];
    const expected = !options.artboards && isMachinePath(req.url) ? secrets.machine : secrets.human;
    if (typeof given !== "string" || !tokensEqual(given, expected)) return reply.code(403).send();
  });
}
