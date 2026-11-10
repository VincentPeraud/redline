import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, publishManifestError, type MoveArtboardResponse, type Page, type PageVersionSummary, type Project, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const manifest = (...artboards: { file: string; x: number; width?: number }[]) =>
  JSON.stringify({ artboards: artboards.map((a) => ({ file: a.file, x: a.x, y: 20, width: a.width ?? 300, height: 200, title: a.file })) });

describe("moving an artboard to another page over the server HTTP API", () => {
  let server: TestServer;
  let project: Project;
  let web: Page;
  let buttons: Page;

  beforeEach(async () => {
    server = await startTestServer();
    project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    web = await createPage(project, "Web", {
      [MANIFEST_PATH]: manifest({ file: "btn.html", x: 0, width: 360 }, { file: "home.html", x: 500 }),
      "btn.html": "<button>Ok</button>",
      "home.html": "<h1>Home</h1>",
    });
    buttons = await createPage(project, "Boutons", {
      [MANIFEST_PATH]: manifest({ file: "link.html", x: 0 }, { file: "chip.html", x: 400, width: 100 }),
      "link.html": "<a>x</a>",
      "chip.html": "<i>chip</i>",
    });
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createPage(owner: Project, title: string, files: Record<string, string>): Promise<Page> {
    return (await (await server.post(`/api/projects/${owner.id}/pages`, { title, files })).json()) as Page;
  }
  const move = (from: Page, body: object) => server.post(`/api/pages/${from.id}/move-artboard`, body);
  const reload = async (page: Page) => (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
  const manifestOf = async (page: Page) => parseManifest(await (await server.get(`/api/pages/${page.id}/files/${MANIFEST_PATH}`)).text());
  const versions = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[];
  const threadsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  async function pin(page: Page, artboard: string, body: string): Promise<Thread> {
    return (await (await server.post(`/api/pages/${page.id}/threads`, { artboard, selector: "body", xPct: 10, yPct: 10, body })).json()) as Thread;
  }

  it("moves the file and its manifest entry to the right of the target's artboards, same size, with one version on each page", async () => {
    const res = await move(web, { file: "btn.html", targetPageId: buttons.id });
    expect(res.status).toBe(200);
    const result = (await res.json()) as MoveArtboardResponse;
    expect(result.targetPage.id).toBe(buttons.id);

    const source = await reload(web);
    expect(Object.keys(source.version.files).sort()).toEqual(["home.html", MANIFEST_PATH]);
    expect((await manifestOf(web)).artboards.map((a) => a.file)).toEqual(["home.html"]);

    const target = await reload(buttons);
    expect(Object.keys(target.version.files).sort()).toEqual(["btn.html", "chip.html", "link.html", MANIFEST_PATH]);
    const moved = (await manifestOf(buttons)).artboards.find((a) => a.file === "btn.html")!;
    expect(moved).toMatchObject({ width: 360, height: 200, y: 20, x: 400 + 100 + 80 });
    expect(await (await server.get(`/api/pages/${buttons.id}/files/btn.html`)).text()).toBe("<button>Ok</button>");

    expect((await versions(web))[0].message).toBe("btn.html déplacé vers Boutons");
    expect((await versions(buttons))[0].message).toBe("btn.html reçu de Web");
    expect((await versions(web))[0].origin).toBe("user");
    expect((await versions(buttons))[0].origin).toBe("user");
    expect(result.sourceVersion.id).toBe((await versions(web))[0].id);
    expect(result.targetVersion.id).toBe((await versions(buttons))[0].id);
  });

  it("pins the elements anchored to the moved artboard where they were and drops the arrows aiming at it, so the page stays publishable", async () => {
    const page = await createPage(project, "Notes", {
      [MANIFEST_PATH]: JSON.stringify({
        artboards: [{ file: "btn.html", x: 100, y: 20, width: 300, height: 200 }, { file: "home.html", x: 900, y: 20, width: 300, height: 200 }],
        elements: [
          { kind: "text", id: "note", text: "n", rightOf: "btn.html", gap: 60 },
          { kind: "sticky", id: "ask", text: "s", below: "note" },
          { kind: "sticky", id: "under", text: "u", below: "btn.html" },
          { kind: "arrow", id: "to-btn", from: "home.html", to: "btn.html" },
          { kind: "arrow", id: "to-note", from: "home.html", to: "note" },
        ],
      }),
      "btn.html": "<button>Ok</button>",
      "home.html": "<h1>Home</h1>",
    });
    expect((await move(page, { file: "btn.html", targetPageId: buttons.id })).status).toBe(200);

    const raw = JSON.parse(await (await server.get(`/api/pages/${page.id}/files/${MANIFEST_PATH}`)).text()) as { elements: Record<string, unknown>[] };
    expect(raw.elements).toEqual([
      { kind: "text", id: "note", text: "n", x: 460, y: 20 },
      { kind: "sticky", id: "ask", text: "s", below: "note" },
      { kind: "sticky", id: "under", text: "u", x: 100, y: 260 },
      { kind: "arrow", id: "to-note", from: "home.html", to: "note" },
    ]);
    expect(publishManifestError(JSON.stringify(raw))).toBeNull();
  });

  it("moves the threads of the artboard with it and leaves the others", async () => {
    const onBtn = await pin(web, "btn.html", "Too small");
    await pin(web, "home.html", "Stays");
    await pin(buttons, "link.html", "Already there");
    await move(web, { file: "btn.html", targetPageId: buttons.id });

    expect((await threadsOf(web)).map((t) => t.body)).toEqual(["Stays"]);
    const landed = (await threadsOf(buttons)).find((t) => t.id === onBtn.id)!;
    expect(landed).toMatchObject({ pageId: buttons.id, artboard: "btn.html", body: "Too small" });
    expect(landed.number).toBe(2);
  });

  it("moves to a new page created in the same call", async () => {
    const res = await move(web, { file: "btn.html", newPageTitle: "Formulaires" });
    expect(res.status).toBe(200);
    const { targetPage, targetVersion } = (await res.json()) as MoveArtboardResponse;
    expect(targetPage.title).toBe("Formulaires");
    expect(targetPage.projectId).toBe(project.id);
    const created = await reload(targetPage);
    expect(Object.keys(created.version.files).sort()).toEqual(["btn.html", MANIFEST_PATH]);
    expect((await manifestOf(created)).artboards).toMatchObject([{ file: "btn.html", x: 0, width: 360 }]);
    expect((await versions(created))[0]).toMatchObject({ id: targetVersion.id, message: "btn.html reçu de Web" });
  });

  it("refuses when a session works on the source page or on the target page, and changes nothing", async () => {
    const agent = await server.connectAgent({ projectId: project.id });
    await agent.hello;
    await pin(web, "home.html", "Busy");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fromBusy = await move(web, { file: "btn.html", targetPageId: buttons.id });
    expect(fromBusy.status).toBe(409);
    expect(((await fromBusy.json()) as { error: string }).error).toMatch(/Web/);
    const toBusy = await move(buttons, { file: "link.html", targetPageId: web.id });
    expect(toBusy.status).toBe(409);
    expect((await manifestOf(web)).artboards.map((a) => a.file)).toEqual(["btn.html", "home.html"]);
    expect(Object.keys((await reload(buttons)).version.files)).toContain("link.html");
  });

  it("refuses when the target already has a file of that name", async () => {
    const clash = await createPage(project, "Clash", { [MANIFEST_PATH]: manifest({ file: "btn.html", x: 0 }), "btn.html": "<b>other</b>" });
    const res = await move(web, { file: "btn.html", targetPageId: clash.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/btn\.html/);
    expect(await (await server.get(`/api/pages/${clash.id}/files/btn.html`)).text()).toBe("<b>other</b>");
    expect(Object.keys((await reload(web)).version.files)).toContain("btn.html");
  });

  it("refuses to move to a page of another project", async () => {
    const other = (await (await server.post("/api/projects", { title: "Other" })).json()) as Project;
    const foreign = await createPage(other, "Elsewhere", { [MANIFEST_PATH]: manifest() });
    const res = await move(web, { file: "btn.html", targetPageId: foreign.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/project/);
    expect(Object.keys((await reload(web)).version.files)).toContain("btn.html");
  });

  it("refuses an unknown artboard, an unknown page, the same page and a missing target", async () => {
    expect((await move(web, { file: "nope.html", targetPageId: buttons.id })).status).toBe(404);
    expect((await move(web, { file: "btn.html", targetPageId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await move(web, { file: "btn.html", targetPageId: web.id })).status).toBe(400);
    expect((await move(web, { file: "btn.html" })).status).toBe(400);
    expect((await move(web, { file: "btn.html", newPageTitle: "  " })).status).toBe(400);
  });
});
