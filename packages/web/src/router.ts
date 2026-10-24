import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "agents" }
  | { name: "sessions" }
  | { name: "designSystems" }
  | { name: "project"; projectId: string }
  | { name: "designMd"; projectId: string }
  | { name: "page"; pageId: string; artboard?: string };

export function parseRoute(hash: string): Route {
  const [, section, id, sub, subId] = hash.split("/").map(decodeURIComponent);
  if (section === "agents") return { name: "agents" };
  if (section === "sessions") return { name: "sessions" };
  if (section === "projects" && !id) return { name: "projects" };
  if (section === "design-systems") return { name: "designSystems" };
  if (section === "projects" && id && sub === "design-md") return { name: "designMd", projectId: id };
  if (section === "projects" && id) return { name: "project", projectId: id };
  if (section === "pages" && id && sub === "artboards" && subId) return { name: "page", pageId: id, artboard: subId };
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
    case "page":
      return `#/pages/${encodeURIComponent(route.pageId)}${route.artboard === undefined ? "" : `/artboards/${encodeURIComponent(route.artboard)}`}`;
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
