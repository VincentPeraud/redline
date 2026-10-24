import { useEffect, useState } from "react";
import { artboardHash, pageHash, playHash } from "@redline/shared";

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "agents" }
  | { name: "sessions" }
  | { name: "designSystems" }
  | { name: "project"; projectId: string }
  | { name: "designMd"; projectId: string }
  | { name: "page"; pageId: string; artboard?: string; play?: string; rendu?: string };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.split("?", 2);
  const [, section, id, sub, subId] = path.split("/").map(decodeURIComponent);
  if (section === "agents") return { name: "agents" };
  if (section === "sessions") return { name: "sessions" };
  if (section === "projects" && !id) return { name: "projects" };
  if (section === "design-systems") return { name: "designSystems" };
  if (section === "projects" && id && sub === "design-md") return { name: "designMd", projectId: id };
  if (section === "projects" && id) return { name: "project", projectId: id };
  if (section === "pages" && id && sub === "artboards" && subId) return { name: "page", pageId: id, artboard: subId };
  if (section === "pages" && id && sub === "play" && subId) {
    const rendu = new URLSearchParams(query).get("rendu");
    return { name: "page", pageId: id, play: subId, ...(rendu === null ? {} : { rendu }) };
  }
  if (section === "pages" && id) return { name: "page", pageId: id };
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
    case "project":
      return `#/projects/${encodeURIComponent(route.projectId)}`;
    case "designMd":
      return `#/projects/${encodeURIComponent(route.projectId)}/design-md`;
    case "page": {
      if (route.play !== undefined) return `${playHash(route.pageId, route.play)}${route.rendu === undefined ? "" : `?rendu=${encodeURIComponent(route.rendu)}`}`;
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
