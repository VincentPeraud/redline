import type { IncomingMessage } from "node:http";
import type { FastifyRequest } from "fastify";
import { LINK_PATH_PREFIX } from "@redline/shared";

const LINK_API_URL = new RegExp(`^${LINK_PATH_PREFIX}/([^/?#]+)(/api(?:[/?].*)?)$`);
const tokens = new WeakMap<IncomingMessage, string>();

/**
 * A visitor's calls come as `/s/<token>/api/...`. The router sees them as `/api/...` (so a link only ever reaches the
 * routes a member reaches), and the token is kept aside for the access module to resolve.
 */
export function rewriteLinkUrl(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const match = LINK_API_URL.exec(url);
  if (!match) return url;
  tokens.set(req, decodeURIComponent(match[1]));
  return match[2];
}

/** The link token the request came with, if it came through a link address. */
export function linkTokenOf(req: FastifyRequest): string | undefined {
  return tokens.get(req.raw);
}
