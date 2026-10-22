import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentCheckout, type AgentTokenResponse, type Page, type PageVersionSummary } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("publishing from a checkout while the page moved on", () => {
  let server: TestServer;
  let token: string;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    page = (await (
      await server.post(`/api/projects/${project.id}/pages`, {
        title: "Home",
        type: "prototype",
        files: { "home.html": "<h1>Home</h1>", "about.html": "<h1>About</h1>", "old.html": "<h1>Old</h1>" },
      })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(server.url + AGENT_API_PREFIX + path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const checkout = async () => (await (await call(`/pages/${page.id}/files`)).json()) as AgentCheckout;
  const publish = (files: Record<string, string>, baseVersionId: string | undefined) =>
    call(`/pages/${page.id}/versions`, { method: "POST", body: { files, message: "Session work", origin: "thread", baseVersionId } });
  const webPublish = (files: Record<string, string>, origin = "tweak") =>
    server.post(`/api/pages/${page.id}/versions`, { files, message: "Other change", origin });
  const read = async (path: string) => (await server.get(`/api/pages/${page.id}/files/${path}`)).text();
  const versionCount = async () => ((await (await server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[]).length;

  it("requires the version the checkout was taken from", async () => {
    const base = await checkout();
    const res = await publish(base.files, undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/baseVersionId/);
    expect((await publish(base.files, "00000000-0000-4000-8000-000000000000")).status).toBe(400);
  });

  it("keeps the changes another version made to files the session did not touch", async () => {
    const base = await checkout();
    await webPublish({ ...base.files, "about.html": "<h1>About, newer</h1>" });

    const res = await publish({ ...base.files, "home.html": "<h1>Home, by the session</h1>" }, base.versionId);
    expect(res.status).toBe(201);
    expect(((await res.json()) as PageVersionSummary & { merged?: boolean }).merged).toBe(true);
    expect(await read("home.html")).toBe("<h1>Home, by the session</h1>");
    expect(await read("about.html")).toBe("<h1>About, newer</h1>");
  });

  it("applies the session's deletions but does not bring back files the page lost meanwhile", async () => {
    const base = await checkout();
    const { "about.html": _about, ...withoutAbout } = base.files;
    await webPublish(withoutAbout);

    const { "old.html": _old, ...sessionFiles } = base.files;
    expect((await publish(sessionFiles, base.versionId)).status).toBe(201);
    expect((await server.get(`/api/pages/${page.id}/files/about.html`)).status).toBe(404);
    expect((await server.get(`/api/pages/${page.id}/files/old.html`)).status).toBe(404);
    expect(await read("home.html")).toBe("<h1>Home</h1>");
  });

  it("refuses with 409 when the same file changed on both sides, and publishes nothing", async () => {
    const base = await checkout();
    await webPublish({ ...base.files, "home.html": "<h1>Home, by someone else</h1>" });
    const before = await versionCount();

    const res = await publish({ ...base.files, "home.html": "<h1>Home, by the session</h1>" }, base.versionId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/home\.html/);
    expect(await versionCount()).toBe(before);
    expect(await read("home.html")).toBe("<h1>Home, by someone else</h1>");
  });

  it("accepts the same change made on both sides", async () => {
    const base = await checkout();
    await webPublish({ ...base.files, "home.html": "<h1>Same</h1>" });
    expect((await publish({ ...base.files, "home.html": "<h1>Same</h1>" }, base.versionId)).status).toBe(201);
  });

  it("does not undo a tweak or a restore made after the checkout", async () => {
    const manifest = JSON.stringify({ artboards: [{ file: "home.html" }], tweaks: [{ id: "accent", type: "color", label: "Accent", default: "#e5484d" }] });
    await webPublish({ "home.html": "<h1>Home</h1>", "manifest.json": manifest }, "thread");
    const base = await checkout();

    await server.post(`/api/pages/${page.id}/tweaks`, { id: "accent", value: "#0f766e" });
    expect((await publish({ ...base.files, "home.html": "<h1>Home v2</h1>" }, base.versionId)).status).toBe(201);
    expect(JSON.parse(await read("tweaks.json"))).toEqual({ accent: "#0f766e" });
    expect(await read("home.html")).toBe("<h1>Home v2</h1>");
  });
});
