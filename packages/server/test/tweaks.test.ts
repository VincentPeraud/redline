import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, PageVersionSummary } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const HTML = "<!doctype html><h1>Hello</h1>";
const MANIFEST = JSON.stringify({
  artboards: [{ file: "home.html" }],
  tweaks: [
    { id: "accent", type: "color", label: "Accent", default: "#e5484d" },
    { id: "layout", type: "choice", label: "Layout", options: ["list", "grid"] },
    { id: "gap", type: "range", label: "Gap", min: 4, max: 24 },
  ],
});

describe("tweaks over the server HTTP API", () => {
  let server: TestServer;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    page = (await (
      await server.post(`/api/projects/${project.id}/pages`, {
        title: "Landing",
        type: "prototype",
        files: { "home.html": HTML, "manifest.json": MANIFEST },
      })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const versions = async () => (await (await server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[];
  const currentPage = async () => (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
  const setTweak = (id: string, value: unknown) => server.post(`/api/pages/${page.id}/tweaks`, { id, value });

  it("stores the value in the tweaks file and records a tweak version, leaving the HTML untouched", async () => {
    const before = await currentPage();
    const res = await setTweak("accent", "#0f766e");
    expect(res.status).toBe(201);
    expect(((await res.json()) as PageVersionSummary).origin).toBe("tweak");

    const file = await server.get(`/api/pages/${page.id}/files/tweaks.json`);
    expect(JSON.parse(await file.text())).toEqual({ accent: "#0f766e" });

    const after = await currentPage();
    expect(after.version.files["home.html"]).toBe(before.version.files["home.html"]);
    expect(after.version.files["manifest.json"]).toBe(before.version.files["manifest.json"]);
    expect((await versions())[0]).toMatchObject({ origin: "tweak", message: "Tweak: Accent = #0f766e" });
  });

  it("keeps the other values when one changes", async () => {
    await setTweak("accent", "#0f766e");
    await setTweak("gap", 12);
    const file = await server.get(`/api/pages/${page.id}/files/tweaks.json`);
    expect(JSON.parse(await file.text())).toEqual({ accent: "#0f766e", gap: 12 });
  });

  it("refuses unknown tweaks and values that do not fit the declaration", async () => {
    expect((await setTweak("ghost", 1)).status).toBe(400);
    expect((await setTweak("accent", "red")).status).toBe(400);
    expect((await setTweak("layout", "carousel")).status).toBe(400);
    expect((await setTweak("gap", 99)).status).toBe(400);
    expect((await versions()).length).toBe(1);
    expect((await server.post("/api/pages/nope/tweaks", { id: "accent", value: "#fff" })).status).toBe(404);
  });

  it("refuses a version whose tweaks file is not valid", async () => {
    const res = await server.post(`/api/pages/${page.id}/versions`, {
      files: { "home.html": HTML, "tweaks.json": "[1]" },
      message: "Bad tweaks",
      origin: "terminal",
    });
    expect(res.status).toBe(400);
  });

  it("restoring an earlier version brings back its tweak values", async () => {
    await setTweak("accent", "#0f766e");
    await setTweak("accent", "#7c3aed");
    const list = await versions();
    const first = list.find((v) => v.message === "Tweak: Accent = #0f766e")!;

    const res = await server.post(`/api/pages/${page.id}/versions/${first.id}/restore`, {});
    expect(res.status).toBe(201);
    const file = await server.get(`/api/pages/${page.id}/files/tweaks.json`);
    expect(JSON.parse(await file.text())).toEqual({ accent: "#0f766e" });
  });
});
