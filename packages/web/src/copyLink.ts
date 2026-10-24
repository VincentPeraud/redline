import { routeHref, type Route } from "./router.js";

/** Time the "Lien copié" bubble stays up. */
export const COPIED_BUBBLE_MS = 1500;

/** Full address (origin included) of a route, as it goes in the clipboard. */
export function absoluteAddress(route: Route): string {
  return `${window.location.origin}${window.location.pathname}${routeHref(route)}`;
}

export function copyAddress(route: Route): Promise<void> {
  return navigator.clipboard.writeText(absoluteAddress(route));
}
