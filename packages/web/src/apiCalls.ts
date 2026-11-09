import { REDLINE_HEADER } from "@redline/shared";
import { isNoAccess, reportNoAccess } from "./NoAccess.js";
import { API_PREFIX, LINK_TOKEN } from "./linkAddress.js";

export const UNAUTHORIZED_EVENT = "redline:unauthorized";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What a link visitor has none of: the team's agents, runs, queue and gaps. The app is told "nothing" instead of being refused. */
const EMPTY_FOR_VISITORS = [/^\/api\/agents$/, /^\/api\/sessions$/, /^\/api\/pages\/[^/]+\/(queue|runs|deleted-artboards|held)$/];
const MISSING_FOR_VISITORS = [/^\/api\/pages\/[^/]+\/(gaps|terminal-holder)$/];

function answerForVisitor(method: string, path: string): Response | undefined {
  if (method !== "GET") return undefined;
  if (EMPTY_FOR_VISITORS.some((pattern) => pattern.test(path))) return Response.json([]);
  if (MISSING_FOR_VISITORS.some((pattern) => pattern.test(path))) return new Response(null, { status: 404 });
  return undefined;
}

/**
 * Makes every API call of the page say it comes from the UI (the header built-in accounts ask of mutating calls),
 * and tells the app when the server stops recognising the session. Sign-in and sign-out calls are left out of the second part:
 * their 401 is an answer, not a lost session.
 */
export function installApiCalls(): void {
  const send = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return send(input, init);
    const stub = LINK_TOKEN === undefined ? undefined : answerForVisitor(method, url.pathname);
    if (stub) return stub;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!SAFE_METHODS.has(method)) headers.set(REDLINE_HEADER, "1");
    // A visitor's calls go under their link, where only what the link allows is served.
    const underLink = `${API_PREFIX}${url.pathname}${url.search}`;
    const target = API_PREFIX === "" ? input : input instanceof Request ? new Request(underLink, input) : underLink;
    const response = await send(target, { ...init, headers });
    const own = url.pathname === "/api/session" || url.pathname === "/api/me" || url.pathname === "/api/setup";
    if (response.status === 401 && !own) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    if (response.status === 403 && response.headers.get("content-type")?.includes("json")) {
      const refusal: unknown = await response.clone().json();
      if (isNoAccess(refusal)) reportNoAccess(refusal);
    }
    return response;
  };
}
