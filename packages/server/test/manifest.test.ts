import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("page manifest over the server HTTP API", () => {
  let server: TestServer;
  let project: Project;

  beforeEach(async () => {
    server = await startTestServer();
    project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  });
  afterEach(async () => {
    await server.stop();
  });

  const html = "<!doctype html><h1>Hi</h1>";

  it("stores the manifest with the page files so a session can move an artboard in a new version", async () => {
    const manifest = JSON.stringify({ artboards: [{ file: "a.html", x: 0, y: 0 }] });
    const res = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: { "a.html": html, "manifest.json": manifest },
    });
    expect(res.status).toBe(201);
    const page = (await res.json()) as Page;

    const moved = JSON.stringify({ artboards: [{ file: "a.html", x: 500, y: 20 }] });
    const version = await server.post(`/api/pages/${page.id}/versions`, {
      files: { "a.html": html, "manifest.json": moved },
      message: "Move artboard",
      origin: "thread",
    });
    expect(version.status).toBe(201);
    const read = await server.get(`/api/pages/${page.id}/files/manifest.json`);
    expect(await read.text()).toBe(moved);
  });

  it("refuses a page or a version whose manifest is invalid", async () => {
    const bad = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: { "a.html": html, "manifest.json": "{nope" },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/manifest\.json/);

    const created = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: { "a.html": html },
    });
    const page = (await created.json()) as Page;
    const version = await server.post(`/api/pages/${page.id}/versions`, {
      files: { "a.html": html, "manifest.json": JSON.stringify({ artboards: [{ x: 1 }] }) },
      message: "Break it",
      origin: "thread",
    });
    expect(version.status).toBe(400);
  });
});
