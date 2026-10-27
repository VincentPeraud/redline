import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  parseManifest,
  versionPreviewPath,
  type ArtboardVersion,
  type DeletedArtboard,
  type Page,
  type RestoreArtboardResponse,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const manifest = (...artboards: { file: string; x: number }[]) =>
  JSON.stringify({ artboards: artboards.map((a) => ({ file: a.file, x: a.x, y: 10, width: 300, height: 200 })) });
const BOTH = manifest({ file: "a.html", x: 0 }, { file: "b.html", x: 500 });
const ONLY_A = manifest({ file: "a.html", x: 0 });

describe("per-artboard history, deleted artboards and artboard restore over the server HTTP API", () => {
  let server: TestServer;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    page = (await (
      await server.post(`/api/projects/${project.id}/pages`, {
        title: "Flow",
        files: { [MANIFEST_PATH]: BOTH, "a.html": "<h1>a1</h1>", "b.html": "<h1>b1</h1>" },
      })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  async function publish(files: Record<string, string>, message: string, origin: string): Promise<void> {
    const res = await server.post(`/api/pages/${page.id}/versions`, { files, message, origin });
    expect(res.status).toBe(201);
  }
  const current = async () => {
    const files = ["a.html", "b.html", MANIFEST_PATH];
    const out: Record<string, string> = {};
    for (const file of files) {
      const res = await server.get(`/api/pages/${page.id}/files/${file}`);
      if (res.status === 200) out[file] = await res.text();
    }
    return out;
  };
  const history = async (file: string) => (await (await server.get(`/api/pages/${page.id}/artboard-versions?file=${file}`)).json()) as ArtboardVersion[];
  const deleted = async () => (await (await server.get(`/api/pages/${page.id}/deleted-artboards`)).json()) as DeletedArtboard[];
  const restore = (file: string, versionId: string) => server.post(`/api/pages/${page.id}/artboards/restore`, { file, versionId });

  it("lists the versions of one artboard newest first, only those that changed it, without tweaks", async () => {
    const files = await current();
    await publish({ ...files, "a.html": "<h1>a2</h1>" }, "Bigger title", "thread");
    await publish({ ...files, "a.html": "<h1>a2</h1>", "b.html": "<h1>b2</h1>" }, "Edit B", "terminal");
    await publish({ ...files, "a.html": "<h1>a2</h1>", "b.html": "<h1>b2</h1>", "tweaks.json": "{}" }, "Tweak: x = 1", "tweak");

    const a = await history("a.html");
    expect(a.map((v) => [v.title, v.origin, v.current])).toEqual([
      ["Bigger title", "thread", true],
      ["Artboard créé", "creation", false],
    ]);
    expect((await history("b.html")).map((v) => [v.title, v.current])).toEqual([
      ["Edit B", true],
      ["Artboard créé", false],
    ]);
    expect(await history("nope.html")).toEqual([]);
  });

  it("serves an artboard as it was in a version, on the artboard origin, sandboxed, with the bridge", async () => {
    await publish({ ...(await current()), "a.html": "<h1>a2</h1>" }, "Bigger title", "thread");
    const [, first] = await history("a.html");

    const res = await fetch(server.artboardOrigin + versionPreviewPath(page.id, first.versionId, "a.html"));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(body).toContain("<h1>a1</h1>");
    expect(body).not.toContain("<h1>a2</h1>");
    expect(body).toContain("/__redline/bridge.js");
    expect((await fetch(server.artboardOrigin + versionPreviewPath(page.id, "nope", "a.html"))).status).toBe(404);
  });

  it("restores one artboard to a version: a new page version where only that file changes", async () => {
    const files = await current();
    await publish({ ...files, "a.html": "<h1>a2</h1>" }, "Bigger title", "thread");
    await publish({ ...files, "a.html": "<h1>a2</h1>", "b.html": "<h1>b2</h1>" }, "Edit B", "thread");
    const [, first] = await history("a.html");
    const before = await current();

    const res = await restore("a.html", first.versionId);
    expect(res.status).toBe(201);
    const { version } = (await res.json()) as RestoreArtboardResponse;
    expect(version.origin).toBe("restore");
    expect(version.message).toMatch(/^Version du .+ restaurée$/);
    expect(await current()).toEqual({ ...before, "a.html": "<h1>a1</h1>" });

    const list = await history("a.html");
    expect(list[0]).toMatchObject({ versionId: version.id, origin: "restore", current: true });
    expect(list.filter((v) => v.current)).toHaveLength(1);
  });

  it("undoes a restore with the same endpoint, and refuses a no-op", async () => {
    await publish({ ...(await current()), "a.html": "<h1>a2</h1>" }, "Bigger title", "thread");
    const [newest, first] = await history("a.html");

    expect((await restore("a.html", newest.versionId)).status).toBe(409);
    const done = (await (await restore("a.html", first.versionId)).json()) as RestoreArtboardResponse;
    expect((await current())["a.html"]).toBe("<h1>a1</h1>");

    expect((await restore("a.html", done.previousVersionId)).status).toBe(201);
    expect((await current())["a.html"]).toBe("<h1>a2</h1>");
  });

  it("lists deleted artboards and puts one back at its former place in its last state; undo removes it again", async () => {
    await publish({ ...(await current()), "b.html": "<h1>b2</h1>" }, "Edit B", "thread");
    const { "b.html": _removed, ...rest } = await current();
    await publish({ ...rest, [MANIFEST_PATH]: ONLY_A }, "Remove B", "conversation");

    const [gone] = await deleted();
    expect(gone).toMatchObject({ file: "b.html", deletedBy: "claude", origin: "conversation", width: 300, height: 200 });
    expect((await deleted()).length).toBe(1);
    expect(await (await fetch(server.artboardOrigin + versionPreviewPath(page.id, gone.lastVersionId, "b.html"))).text()).toContain("b2");

    const put = (await (await restore("b.html", gone.lastVersionId)).json()) as RestoreArtboardResponse;
    expect(put.version.message).toBe("Remis depuis les artboards supprimés");
    const files = await current();
    expect(files["b.html"]).toBe("<h1>b2</h1>");
    expect(parseManifest(files[MANIFEST_PATH]).artboards.find((a) => a.file === "b.html")).toMatchObject({ x: 500, y: 10, width: 300 });
    expect(await deleted()).toEqual([]);

    expect((await restore("b.html", put.previousVersionId)).status).toBe(201);
    expect((await current())["b.html"]).toBeUndefined();
    expect((await deleted()).map((d) => [d.file, d.deletedBy])).toEqual([["b.html", "user"]]);
  });

  it("keeps a whole-artboard thread through the artboard's deletion and restore", async () => {
    const created = await server.post(`/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "b.html" }, body: "Too busy" });
    expect(created.status).toBe(201);
    const { "b.html": _removed, ...rest } = await current();
    await publish({ ...rest, [MANIFEST_PATH]: ONLY_A }, "Remove B", "conversation");
    const threads = async () => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as { target: unknown; status: string }[];
    expect(await threads()).toMatchObject([{ target: { kind: "artboard", artboard: "b.html" }, status: "open" }]);
    expect((await server.post(`/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "b.html" }, body: "Gone" })).status).toBe(400);

    const [gone] = await deleted();
    expect((await restore("b.html", gone.lastVersionId)).status).toBe(201);
    expect(await threads()).toMatchObject([{ target: { kind: "artboard", artboard: "b.html" }, status: "open" }]);
  });

  it("validates the request", async () => {
    expect((await server.post(`/api/pages/${page.id}/artboards/restore`, { file: "../x", versionId: "v" })).status).toBe(400);
    expect((await server.post(`/api/pages/${page.id}/artboards/restore`, { file: "a.html" })).status).toBe(400);
    expect((await restore("a.html", "nope")).status).toBe(404);
    expect((await server.post(`/api/pages/${page.id}/artboards/restore`, { file: "a.html", versionId: "x", timeZone: "Mars/Base" })).status).toBe(400);
    expect((await server.get(`/api/pages/nope/artboard-versions?file=a.html`)).status).toBe(404);
    expect((await server.get(`/api/pages/${page.id}/artboard-versions`)).status).toBe(400);
  });
});
