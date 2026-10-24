import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, PageViewSettings, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("per-page view settings over the server HTTP API", () => {
  let server: TestServer;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "home.html": "<h1>Hi</h1>" } })).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const read = async () => (await (await server.get(`/api/pages/${page.id}`)).json()) as Page & { viewSettings: PageViewSettings };
  const settings: PageViewSettings = { hiddenFormats: ["mobile"], renderingOverrides: { "home.html": { "desktop-1440": false } } };

  it("reads empty settings with the page, then what was written, also after a restart", async () => {
    expect((await read()).viewSettings).toEqual({ hiddenFormats: [], renderingOverrides: {} });
    const res = await server.post(`/api/pages/${page.id}/view-settings`, settings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(settings);
    expect((await read()).viewSettings).toEqual(settings);
    await server.restart();
    expect((await read()).viewSettings).toEqual(settings);
  });

  it("creates no version and is not part of the files a session works on", async () => {
    const versionsBefore = (await (await server.get(`/api/pages/${page.id}/versions`)).json()) as unknown[];
    await server.post(`/api/pages/${page.id}/view-settings`, settings);
    expect(await (await server.get(`/api/pages/${page.id}/versions`)).json()).toEqual(versionsBefore);
    expect((await read()).version.id).toBe(page.version.id);
    const workingCopy = (await (await server.get(`/api/pages/${page.id}/working-copy`)).json()) as { files: Record<string, string> };
    expect(Object.keys(workingCopy.files)).toEqual(["home.html"]);
    expect(JSON.stringify(workingCopy)).not.toContain("hiddenFormats");
  });

  it("does not queue any work for a session", async () => {
    await server.post(`/api/pages/${page.id}/view-settings`, settings);
    expect(await (await server.get(`/api/pages/${page.id}/queue`)).json()).toEqual([]);
  });

  it("refuses malformed settings and an unknown page", async () => {
    for (const body of [
      null,
      {},
      { hiddenFormats: ["watch"], renderingOverrides: {} },
      { hiddenFormats: "mobile", renderingOverrides: {} },
      { hiddenFormats: [], renderingOverrides: { "home.html": { "mobile-390": "no" } } },
      { hiddenFormats: [], renderingOverrides: [] },
    ]) {
      expect((await server.post(`/api/pages/${page.id}/view-settings`, body)).status).toBe(400);
    }
    expect((await server.post("/api/pages/nope/view-settings", settings)).status).toBe(404);
    expect((await read()).viewSettings).toEqual({ hiddenFormats: [], renderingOverrides: {} });
  });
});
