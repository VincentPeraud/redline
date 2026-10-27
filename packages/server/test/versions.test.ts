import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, PageVersionSummary } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("version history and restore over the server HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createPage(): Promise<Page> {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    const res = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: { "home.html": "<h1>one</h1>" },
    });
    return (await res.json()) as Page;
  }

  async function publish(pageId: string, html: string, message: string, origin: string) {
    const res = await server.post(`/api/pages/${pageId}/versions`, { files: { "home.html": html }, message, origin });
    expect(res.status).toBe(201);
    return (await res.json()) as PageVersionSummary;
  }

  async function versions(pageId: string): Promise<PageVersionSummary[]> {
    return (await (await server.get(`/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[];
  }

  it("lists versions newest first with message and origin", async () => {
    const page = await createPage();
    await publish(page.id, "<h1>two</h1>", "Bigger title", "thread");
    await publish(page.id, "<h1>three</h1>", "Blue button", "tweak");

    const list = await versions(page.id);
    expect(list.map((v) => [v.message, v.origin])).toEqual([
      ["Blue button", "tweak"],
      ["Bigger title", "thread"],
      ["Page created", "creation"],
    ]);
  });

  it("words the restore message in the caller's time zone, and refuses an unknown one", async () => {
    const page = await createPage();
    await publish(page.id, "<h1>two</h1>", "Bigger title", "thread");
    const first = (await versions(page.id))[1]!;
    const bad = await server.post(`/api/pages/${page.id}/versions/${first.id}/restore`, { timeZone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    const res = await server.post(`/api/pages/${page.id}/versions/${first.id}/restore`, { timeZone: "Pacific/Auckland" });
    expect(((await res.json()) as PageVersionSummary).message).toMatch(/^Version du .+ restaurée$/);
  });

  it("restoring creates a new restore version with the restored files and keeps history", async () => {
    const page = await createPage();
    await publish(page.id, "<h1>two</h1>", "Bigger title", "thread");
    const first = (await versions(page.id))[1]!;

    const res = await server.post(`/api/pages/${page.id}/versions/${first.id}/restore`, {});
    expect(res.status).toBe(201);
    const restored = (await res.json()) as PageVersionSummary;
    expect(restored.origin).toBe("restore");
    expect(restored.message).toMatch(/^Version du \d{1,2} \S+ à \d{2}:\d{2} restaurée$/);
    expect(restored.id).not.toBe(first.id);

    const current = (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
    expect(current.version.id).toBe(restored.id);
    expect(await (await server.get(`/api/pages/${page.id}/files/home.html`)).text()).toBe("<h1>one</h1>");

    const list = await versions(page.id);
    expect(list).toHaveLength(3);
    expect(list[0]!.id).toBe(restored.id);
    expect(list.map((v) => v.id)).toContain(first.id);
  });

  it("refuses to restore an unknown version or one from another page", async () => {
    const page = await createPage();
    const other = await createPage();
    const foreign = (await versions(other.id))[0]!;
    expect((await server.post(`/api/pages/${page.id}/versions/nope/restore`, {})).status).toBe(404);
    expect((await server.post(`/api/pages/${page.id}/versions/${foreign.id}/restore`, {})).status).toBe(404);
    expect((await server.get(`/api/pages/missing/versions`)).status).toBe(404);
  });

  it("rejects a version with an invalid origin", async () => {
    const page = await createPage();
    const res = await server.post(`/api/pages/${page.id}/versions`, {
      files: { "a.html": "x" },
      message: "m",
      origin: "bogus",
    });
    expect(res.status).toBe(400);
  });
});
