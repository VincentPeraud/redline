import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Compares two secrets without leaking, through timing, how much of them matches (both are hashed to the same length first). */
export function tokensEqual(given: string | undefined, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return given !== undefined && timingSafeEqual(digest(given), digest(expected));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ASSET_UPLOAD = /^\/api\/projects\/[^/]+\/assets\//;

/** The host the browser used: the proxy's `X-Forwarded-Host` when there is one, else `Host`. */
function requestHost(headers: { host?: string; "x-forwarded-host"?: string | string[] }): string | undefined {
  const forwarded = headers["x-forwarded-host"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0].trim()) || headers.host;
}

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/**
 * Defences of the browser-facing server. State-changing calls to `/api` must come from the UI's own origin when
 * the browser says where they come from (`Origin`), and carry JSON when they carry a body (the raw asset upload
 * has its own content type, so it only gets the origin check): a page on another site cannot forge them with a plain form.
 * Responses cannot be framed by another site.
 */
export function registerRequestHardening(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith("/api/")) return;
    const { origin } = req.headers;
    if (origin !== undefined && hostOf(origin) !== requestHost(req.headers)) {
      return reply.code(403).send({ error: "Cross-origin request refused." });
    }
    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    const isJson = /^application\/json\b/i.test(req.headers["content-type"] ?? "");
    if (hasBody && !isJson && !(req.method === "PUT" && ASSET_UPLOAD.test(req.url))) {
      return reply.code(415).send({ error: "Send JSON (content-type: application/json)." });
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-frame-options", "SAMEORIGIN");
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "frame-ancestors 'self'");
  });
}
