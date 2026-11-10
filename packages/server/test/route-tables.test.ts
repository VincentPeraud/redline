import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINK_ROUTES, unknownRouteKeys } from "../src/access.js";
import { buildMainApp } from "../src/app.js";
import { Store } from "../src/store.js";

describe("route tables of the access module", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("only name routes that are registered, so renaming a route cannot silently drop it from its rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "redline-routes-"));
    dirs.push(dir);
    const store = new Store(dir);
    const app = await buildMainApp(store, { artboardOrigin: "http://127.0.0.1:1" }, undefined, { authMode: "local" });
    // Becoming ready checks every table against the registered routes; it refuses a stale key.
    await app.ready();
    await app.close();
    store.close();
  });

  it("reports the keys that match no registered route", () => {
    const registered = new Set(Object.keys(LINK_ROUTES));
    expect(unknownRouteKeys(registered)).not.toContain("GET /api/pages/:pageId");
    registered.delete("GET /api/pages/:pageId");
    expect(unknownRouteKeys(registered)).toContain("GET /api/pages/:pageId");
  });
});
