import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const HOME_HTML = "<!doctype html><title>Home</title><script>window.x = 1</script>";

describe("pages over the server HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createPage(projectId: string, files: Record<string, string>) {
    const res = await server.post(`/api/projects/${projectId}/pages`, {
      title: "Landing",
      files,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Page;
  }

  async function createProject() {
    const res = await server.post("/api/projects", { title: "Acme" });
    expect(res.status).toBe(201);
    return (await res.json()) as Project;
  }

  it("creates a project with a page holding one artboard and reads the files back unchanged", async () => {
    const project = await createProject();
    const page = await createPage(project.id, { "home.html": HOME_HTML });

    const read = await server.get(`/api/pages/${page.id}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as Page;
    expect(body.title).toBe("Landing");
    expect(Object.keys(body.version.files)).toEqual(["home.html"]);

    const file = await server.get(`/api/pages/${page.id}/files/home.html`);
    expect(await file.text()).toBe(HOME_HTML);
  });

  it("maps each path to a content hash and stores identical content once", async () => {
    const seededBlobs = server.blobCount();
    const project = await createProject();
    const a = await createPage(project.id, { "home.html": HOME_HTML, "copy.html": HOME_HTML });
    const b = await createPage(project.id, { "home.html": HOME_HTML });

    expect(a.version.files["home.html"]).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version.files["copy.html"]).toBe(a.version.files["home.html"]);
    expect(b.version.files["home.html"]).toBe(a.version.files["home.html"]);
    expect(server.blobCount() - seededBlobs).toBe(1);
  });

  it("serves artboards from a separate origin, sandboxed", async () => {
    const project = await createProject();
    const page = await createPage(project.id, { "home.html": HOME_HTML });

    expect(new URL(server.artboardOrigin).origin).not.toBe(new URL(server.url).origin);

    const res = await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`);
    expect(res.status).toBe(200);
    const served = await res.text();
    // Redline's tags go after the doctype, never before it (that would switch the page to quirks mode).
    expect(served.startsWith("<!doctype html><")).toBe(true);
    expect(served).toContain("<title>Home</title><script>window.x = 1</script>");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

    const apiOnArtboardOrigin = await fetch(`${server.artboardOrigin}/api/projects`);
    expect(apiOnArtboardOrigin.status).toBe(404);
  });

  it("tells the web UI which origin serves artboards", async () => {
    const res = await server.get("/api/config");
    expect(await res.json()).toEqual({ artboardOrigin: server.artboardOrigin });
  });
});
