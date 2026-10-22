import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, type Route } from "../src/router";

describe("hash router", () => {
  it("parses each screen", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/")).toEqual({ name: "projects" });
    expect(parseRoute("#/agents")).toEqual({ name: "agents" });
    expect(parseRoute("#/sessions")).toEqual({ name: "sessions" });
    expect(parseRoute("#/projects/p1")).toEqual({ name: "project", projectId: "p1" });
    expect(parseRoute("#/projects/p1/design-md")).toEqual({ name: "designMd", projectId: "p1" });
    expect(parseRoute("#/pages/g1")).toEqual({ name: "page", pageId: "g1" });
  });

  it("falls back to the projects list on unknown hashes", () => {
    expect(parseRoute("#/nope/1")).toEqual({ name: "projects" });
  });

  it("builds hrefs that parse back", () => {
    const routes: Route[] = [
      { name: "projects" },
      { name: "agents" },
      { name: "sessions" },
      { name: "project", projectId: "a b" },
      { name: "designMd", projectId: "a b" },
      { name: "page", pageId: "g1" },
    ];
    for (const route of routes) expect(parseRoute(routeHref(route))).toEqual(route);
  });
});
