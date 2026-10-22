import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "agents" }
  | { name: "project"; projectId: string }
  | { name: "designMd"; projectId: string }
  | { name: "page"; pageId: string };

export function parseRoute(hash: string): Route {
  const [, section, id, sub] = hash.split("/").map(decodeURIComponent);
  if (section === "agents") return { name: "agents" };
  if (section === "projects" && !id) return { name: "projects" };
  if (section === "projects" && id && sub === "design-md") return { name: "designMd", projectId: id };
  if (section === "projects" && id) return { name: "project", projectId: id };
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
    case "project":
      return `#/projects/${encodeURIComponent(route.projectId)}`;
    case "designMd":
      return `#/projects/${encodeURIComponent(route.projectId)}/design-md`;
    case "page":
      return `#/pages/${encodeURIComponent(route.pageId)}`;
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
