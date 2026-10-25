import { useEffect, useState } from "react";
import { artboardHash, pageHash, playHash } from "@redline/shared";

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "agents" }
  | { name: "sessions" }
  | { name: "designSystems" }
  | { name: "designSystem"; designSystemId: string }
  | { name: "project"; projectId: string }
  | { name: "designMd"; projectId: string }
  | { name: "projectDesignSystem"; projectId: string }
  | { name: "page"; pageId: string; artboard?: string; play?: string; renderingParam?: string; previewOf?: string };

export type PageRoute = Extract<Route, { name: "page" }>;

/** Route of an artboard in play mode; `renderingParam` is the `?rendu=` value as written. */
export const playRoute = (pageId: string, file: string, renderingParam?: string): PageRoute => ({
  name: "page",
  pageId,
  play: file,
  ...(renderingParam === undefined ? {} : { renderingParam }),
});

/** `?apercu=<design system id>` on a page address: the page is shown read-only with that design system's draft (nothing stored). */
const PREVIEW_PARAM = "apercu";

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.split("?", 2);
  const [, section, id, sub, subId] = path.split("/").map(decodeURIComponent);
  if (section === "agents") return { name: "agents" };
  if (section === "sessions") return { name: "sessions" };
  if (section === "projects" && !id) return { name: "projects" };
  if (section === "design-systems" && id) return { name: "designSystem", designSystemId: id };
  if (section === "design-systems") return { name: "designSystems" };
  if (section === "projects" && id && sub === "design-md") return { name: "designMd", projectId: id };
  if (section === "projects" && id && sub === "design-system") return { name: "projectDesignSystem", projectId: id };
  if (section === "projects" && id) return { name: "project", projectId: id };
  if (section === "pages" && id && sub === "artboards" && subId) return { name: "page", pageId: id, artboard: subId };
  if (section === "pages" && id && sub === "play" && subId) {
    const renderingParam = new URLSearchParams(query).get("rendu");
    return playRoute(id, subId, renderingParam ?? undefined);
  }
  if (section === "pages" && id) {
    const previewOf = new URLSearchParams(query).get(PREVIEW_PARAM);
    return { name: "page", pageId: id, ...(previewOf === null ? {} : { previewOf }) };
  }
  return { name: "home" };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "projects":
      return "#/projects";
    case "agents":
      return "#/agents";
    case "sessions":
      return "#/sessions";
    case "designSystems":
      return "#/design-systems";
    case "designSystem":
      return `#/design-systems/${encodeURIComponent(route.designSystemId)}`;
    case "project":
      return `#/projects/${encodeURIComponent(route.projectId)}`;
    case "designMd":
      return `#/projects/${encodeURIComponent(route.projectId)}/design-md`;
    case "projectDesignSystem":
      return `#/projects/${encodeURIComponent(route.projectId)}/design-system`;
    case "page": {
      if (route.play !== undefined) return `${playHash(route.pageId, route.play)}${route.renderingParam === undefined ? "" : `?rendu=${encodeURIComponent(route.renderingParam)}`}`;
      if (route.previewOf !== undefined) return `${pageHash(route.pageId)}?${PREVIEW_PARAM}=${encodeURIComponent(route.previewOf)}`;
      return route.artboard === undefined ? pageHash(route.pageId) : artboardHash(route.pageId, route.artboard);
    }
  }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}

/** Moves to a route: pushes a history entry, or replaces the current one (no `hashchange` fires for that, so it is dispatched by hand). */
export function navigateTo(route: Route, mode: "push" | "replace" = "push") {
  const href = routeHref(route);
  if (mode === "push") {
    window.location.hash = href;
    return;
  }
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
