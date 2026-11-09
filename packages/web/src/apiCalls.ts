import { REDLINE_HEADER } from "@redline/shared";

export const UNAUTHORIZED_EVENT = "redline:unauthorized";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!SAFE_METHODS.has(method)) headers.set(REDLINE_HEADER, "1");
    const response = await send(input, { ...init, headers });
    const own = url.pathname === "/api/session" || url.pathname === "/api/me" || url.pathname === "/api/setup";
    if (response.status === 401 && !own) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    return response;
  };
}
