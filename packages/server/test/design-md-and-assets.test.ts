import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignMdVersion, Page, Project, ProjectAsset, ProjectContext } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);

describe("DESIGN.md and project assets over the server HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createProject(): Promise<Project> {
    return (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  }
  async function createPage(project: Project): Promise<Page> {
    const res = await server.post(`/api/projects/${project.id}/pages`, { title: "Flow", files: { "a.html": html } });
    return (await res.json()) as Page;
  }
  const putDesignMd = (project: Project, content: string) =>
    fetch(`${server.url}/api/projects/${project.id}/design-md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  const putAsset = (project: Project, name: string, bytes: Buffer) =>
    fetch(`${server.url}/api/projects/${project.id}/assets/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
  const workingCopy = async (page: Page) =>
    (await (await server.get(`/api/pages/${page.id}/working-copy`)).json()) as { files: Record<string, string> } & ProjectContext;

  it("saves and returns the project's DESIGN.md, empty until written", async () => {
    const project = await createProject();
    expect(await (await server.get(`/api/projects/${project.id}/design-md`)).json()).toEqual({ content: "" });
    expect((await putDesignMd(project, "# Rules\n- One action per screen")).status).toBe(200);
    expect(await (await server.get(`/api/projects/${project.id}/design-md`)).json()).toEqual({
      content: "# Rules\n- One action per screen",
    });
  });

  it("keeps a version of DESIGN.md at each change, newest first, and skips an unchanged save", async () => {
    const project = await createProject();
    const versions = async () =>
      (await (await server.get(`/api/projects/${project.id}/design-md/versions`)).json()) as DesignMdVersion[];
    expect(await versions()).toEqual([]);
    await putDesignMd(project, "# v1");
    await putDesignMd(project, "# v1");
    await putDesignMd(project, "# v2");
    const list = await versions();
    expect(list.map((v) => v.content)).toEqual(["# v2", "# v1"]);
    expect(Date.parse(list[0]!.createdAt)).not.toBeNaN();
    expect(list[0]!.id).not.toBe(list[1]!.id);
    expect((await server.get("/api/projects/missing/design-md/versions")).status).toBe(404);
  });

  it("rejects DESIGN.md without content and unknown projects", async () => {
    const project = await createProject();
    expect((await putDesignMd({ ...project, id: "missing" }, "x")).status).toBe(404);
    const res = await fetch(`${server.url}/api/projects/${project.id}/design-md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("puts the current DESIGN.md in the working copy of every page of the project", async () => {
    const project = await createProject();
    const page = await createPage(project);
    expect((await workingCopy(page)).designMd).toBe("");
    await putDesignMd(project, "# v1");
    await putDesignMd(project, "# v2");
    expect((await workingCopy(page)).designMd).toBe("# v2");
    expect((await workingCopy(await createPage(project))).designMd).toBe("# v2");
  });

  it("carries the design system files in the working copy", async () => {
    const page = await createPage(await createProject());
    const copy = await workingCopy(page);
    expect(copy.designSystem.id).toBe("neutral");
    expect(Object.keys(copy.designSystem.files)).toContain("tokens.css");
  });

  it("stores an asset byte for byte under its content hash and lists it", async () => {
    const project = await createProject();
    const res = await putAsset(project, "images/logo.png", pngBytes);
    expect(res.status).toBe(201);
    const hash = createHash("sha256").update(pngBytes).digest("hex");
    expect(await res.json()).toEqual({ name: "images/logo.png", hash, size: pngBytes.length });
    expect(existsSync(join(server.dataDir, "blobs", hash))).toBe(true);
    expect((await (await server.get(`/api/projects/${project.id}/assets`)).json()) as ProjectAsset[]).toEqual([
      { name: "images/logo.png", hash, size: pngBytes.length },
    ]);

    const blobs = server.blobCount();
    await putAsset(project, "copy.png", pngBytes);
    expect(server.blobCount()).toBe(blobs);
  });

  it("rejects unsafe asset names", async () => {
    const project = await createProject();
    expect((await putAsset(project, "", pngBytes)).status).toBe(400);
  });

  it("serves an asset to every artboard of the project, as assets/<name>, and to no other project", async () => {
    const project = await createProject();
    const [first, second] = [await createPage(project), await createPage(project)];
    const other = await createPage(await createProject());
    await putAsset(project, "logo.png", pngBytes);

    for (const page of [first, second]) {
      const res = await fetch(`${server.artboardOrigin}/pages/${page.id}/assets/logo.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(Buffer.from(await res.arrayBuffer()).equals(pngBytes)).toBe(true);
    }
    expect((await fetch(`${server.artboardOrigin}/pages/${other.id}/assets/logo.png`)).status).toBe(404);
  });

  it("accepts an asset of up to 20 MB and refuses a bigger one, while other bodies stay under 10 MB, saying why", async () => {
    const project = await createProject();
    expect((await putAsset(project, "photo.jpg", Buffer.alloc(5 * 1024 * 1024, 1))).status).toBe(201);
    const huge = await putAsset(project, "huge.jpg", Buffer.alloc(21 * 1024 * 1024, 1));
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: string }).error).toMatch(/Asset too large: 20 MB/);
    const heavy = await putDesignMd(project, "x".repeat(11 * 1024 * 1024));
    expect(heavy.status).toBe(413);
    expect(((await heavy.json()) as { error: string }).error).toMatch(/10 MB/);

    expect(((await (await server.get(`/api/projects/${project.id}/assets`)).json()) as ProjectAsset[]).map((a) => a.name)).toEqual(["photo.jpg"]);
    expect(((await (await server.get(`/api/projects/${project.id}/design-md`)).json()) as { content: string }).content).toBe("");
  });

  it("decodes percent-encoded asset names, for upload and for artboards", async () => {
    const project = await createProject();
    const page = await createPage(project);
    await putAsset(project, "my%20logo.png", pngBytes);
    expect(((await (await server.get(`/api/projects/${project.id}/assets`)).json()) as ProjectAsset[]).map((a) => a.name)).toEqual(["my logo.png"]);
    expect((await fetch(`${server.artboardOrigin}/pages/${page.id}/assets/my%20logo.png`)).status).toBe(200);
  });

  it("decodes asset names once, so a name with % or an encoded-looking sequence keeps its spelling", async () => {
    const project = await createProject();
    const page = await createPage(project);
    for (const name of ["50%.png", "a%20b.png"]) expect((await putAsset(project, encodeURIComponent(name), pngBytes)).status).toBe(201);
    expect(((await (await server.get(`/api/projects/${project.id}/assets`)).json()) as ProjectAsset[]).map((a) => a.name).sort()).toEqual(["50%.png", "a%20b.png"]);
    expect((await fetch(`${server.artboardOrigin}/pages/${page.id}/assets/50%25.png`)).status).toBe(200);
    expect((await fetch(`${server.artboardOrigin}/pages/${page.id}/assets/a%2520b.png`)).status).toBe(200);
  });

  it("puts the assets in the working copy as base64", async () => {
    const project = await createProject();
    const page = await createPage(project);
    await putAsset(project, "fonts/inter.woff2", pngBytes);
    expect((await workingCopy(page)).assets).toEqual({ "fonts/inter.woff2": pngBytes.toString("base64") });
  });
});
