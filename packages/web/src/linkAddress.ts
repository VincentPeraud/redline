import { LINK_PATH_PREFIX } from "@redline/shared";

const ADDRESS = new RegExp(`^${LINK_PATH_PREFIX}/([^/]+)`);

/** The token of the share link the page was opened through (`/s/<token>`), or undefined for the normal app. */
export const LINK_TOKEN: string | undefined = typeof window === "undefined" ? undefined : (() => {
  const match = ADDRESS.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
})();

/** Where the API lives for this page: a link visitor's calls go under their link, a member's at the root. */
export const API_PREFIX = LINK_TOKEN === undefined ? "" : `${LINK_PATH_PREFIX}/${encodeURIComponent(LINK_TOKEN)}`;
