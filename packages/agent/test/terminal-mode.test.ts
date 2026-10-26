import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse, DesignMdInfo, Page, PageVersionSummary, Project } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = { "home.html": "<!doctype html><h1>Home</h1>" };

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

/** The user's own Claude Code: an MCP client on `redline mcp`, working in `folder`. */
async function connectTerminal(folder: string): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
  const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam!.server.url, token), folder });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  return async (name, args) => {
    const result = await client!.callTool({ name, arguments: args });
    return ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
  };
}

const origins = async (pageId: string) =>
  ((await (await seam!.server.get(`/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[]).map((v) => v.origin);

describe("terminal mode (redline mcp)", () => {
  it("checks a page out into .redline/<page>/ of the folder and publishes it as a terminal version", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);

    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);
    expect(readFileSync(join(copy, "home.html"), "utf8")).toBe(PAGE_FILES["home.html"]);

    writeFileSync(join(copy, "home.html"), "<h1>Changed</h1>");
    expect(await call("publish_page", { message: "Rework home" })).toMatch(/Published/);

    expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Changed</h1>");
    const versions = (await (await seam.server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[];
    expect(versions[0]).toMatchObject({ origin: "terminal", message: "Rework home" });
    expect(await origins(page.id)).toHaveLength(2);
  });

  it("lists the artboards of a checked-out page in canvas reading order, with their canvas and play addresses", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const manifest = {
      artboards: [
        { file: "paiement.html", title: "Paiement", x: 900, y: 0 },
        { file: "accueil é.html", title: "Accueil", x: 0, y: 0 },
        { file: "merci.html", x: 0, y: 900 },
      ],
    };
    const page = await seam.createPage({
      "manifest.json": JSON.stringify(manifest),
      "paiement.html": "<p>p</p>",
      "accueil é.html": "<p>a</p>",
      "merci.html": "<p>m</p>",
    });
    const call = await connectTerminal(seam.folder);
    const base = `${seam.server.url}/#/pages/${page.id}`;

    const answer = await call("checkout_page", { pageId: page.id });

    expect(answer).toContain(base);
    expect(answer.split("\n").filter((line) => /^\d\. /.test(line))).toEqual([
      `1. Accueil · canvas ${base}/artboards/accueil%20%C3%A9.html · play ${base}/play/accueil%20%C3%A9.html`,
      `2. Paiement · canvas ${base}/artboards/paiement.html · play ${base}/play/paiement.html`,
      `3. merci.html · canvas ${base}/artboards/merci.html · play ${base}/play/merci.html`,
    ]);
  });

  it("returns the page address after the version id when publishing", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(seam.folder, ".redline", page.id, "home.html"), "<h1>Changed</h1>");

    const answer = await call("publish_page", { message: "Rework" });

    expect(answer).toMatch(/Published version [0-9a-f-]{36}: /);
    expect(answer).toContain(`${seam.server.url}/#/pages/${page.id}`);
  });

  it("lists the design system gaps and the layout of the published version after its address", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(seam.folder, ".redline", page.id, "home.html"), '<h1 style="color: #2563eb">Changed</h1>');

    const answer = await call("publish_page", { message: "Blue" });

    expect(answer).toContain("1 design system gap");
    expect(answer).toContain("- colour #2563eb ×1 (home.html)");
    expect(answer).toContain("Layout: nothing overlaps.");
  });

  it("uploads the assets added or changed in the working copy, with or without a page change", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);
    const asset = async (name: string) => Buffer.from(await (await fetch(`${seam!.server.artboardOrigin}/pages/${page.id}/assets/${name}`)).arrayBuffer());

    mkdirSync(join(copy, "assets"), { recursive: true });
    writeFileSync(join(copy, "assets", "hero.jpg"), Buffer.from([1, 2, 3]));
    expect(await call("publish_page", { message: "Hero only" })).toMatch(/assets\/hero\.jpg.*no version/);
    expect((await asset("hero.jpg")).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(await origins(page.id)).toHaveLength(1);

    writeFileSync(join(copy, "assets", "hero.jpg"), Buffer.from([4, 5]));
    writeFileSync(join(copy, "home.html"), '<img src="assets/hero.jpg">');
    expect(await call("publish_page", { message: "Use the hero" })).toMatch(/Published/);
    expect((await asset("hero.jpg")).equals(Buffer.from([4, 5]))).toBe(true);
    expect(await origins(page.id)).toHaveLength(2);

    expect(await call("publish_page", { message: "Again" })).toMatch(/Nothing changed/);
  });

  it("never uploads what a symlink in assets/ points to, and refuses an invalid asset name", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);
    const secret = join(seam.folder, "secret.txt");
    writeFileSync(secret, "do not upload");
    mkdirSync(join(copy, "assets"), { recursive: true });
    symlinkSync(secret, join(copy, "assets", "leak.png"));
    symlinkSync(secret, join(copy, "page-leak.html"));

    expect(await call("publish_page", { message: "Links" })).toMatch(/Nothing changed/);
    const assets = (await (await seam.server.get(`/api/projects/${seam.project.id}/assets`)).json()) as unknown[];
    expect(assets).toEqual([]);

    writeFileSync(join(copy, "assets", "a:b.png"), "x");
    expect(await call("publish_page", { message: "Bad name" })).toMatch(/assets\/a:b\.png is not a valid asset name/);
  });

  it("publishes nothing when the working copy did not change", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    expect(await call("publish_page", { message: "Nothing" })).toMatch(/Nothing changed/);
    expect(await origins(page.id)).toHaveLength(1);
  });

  it("asks to check a page out before publishing, and reports an unknown page", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);

    expect(await call("publish_page", { message: "x" })).toMatch(/checkout_page/);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(await call("checkout_page", { pageId: unknown })).toMatch(/page not found/);
    expect(existsSync(join(seam.folder, ".redline", unknown))).toBe(false);
  });

  it("refuses a page id that is not a UUID before touching the disk", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    mkdirSync(join(seam.folder, "keep"));
    writeFileSync(join(seam.folder, "keep", "file.txt"), "precious");

    expect(await call("checkout_page", { pageId: "../keep" })).toMatch(/Invalid page id/);
    expect(await call("checkout_page", { pageId: "..\\..\\keep" })).toMatch(/Invalid page id/);
    expect(readFileSync(join(seam.folder, "keep", "file.txt"), "utf8")).toBe("precious");
  });

  it("creates no conversation or thread", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(seam.folder, ".redline", page.id, "home.html"), "<h1>Changed</h1>");
    await call("publish_page", { message: "Rework" });

    expect(await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()).toEqual([]);
    expect(seam.workMessages()).toEqual([]);
  });

  it("add_artboard works on the checked-out page and is published with publish_page", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    await call("add_artboard", { file: "checkout.html", html: "<h1>Checkout</h1>" });
    await call("publish_page", { message: "Add checkout" });

    expect(await seam.readFile(page.id, "checkout.html")).toBe("<h1>Checkout</h1>");
  });

  it("publishes a DESIGN.md edited in the working copy as a terminal DESIGN.md version", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    writeFileSync(join(seam.folder, ".redline", page.id, "DESIGN.md"), "- Rounded buttons\n");
    expect(await call("publish_page", { message: "Rounded buttons" })).toMatch(/Published/);

    const designMd = (await (await seam.server.get(`/api/projects/${seam.project.id}/design-md`)).json()) as { content: string };
    expect(designMd.content).toBe("- Rounded buttons\n");
    const info = (await (await seam.server.get(`/api/projects/${seam.project.id}/design-md/info`)).json()) as DesignMdInfo;
    expect(info.lastModified).toMatchObject({ origin: "terminal" });
    expect(await call("publish_page", { message: "Again" })).toMatch(/Nothing changed/);
  });

  it("publishes a project style (tokens.css) edited in the working copy as a terminal version", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    writeFileSync(join(seam.folder, ".redline", page.id, "tokens.css"), ":root { --color-primary: #7c3aed; }\n");
    expect(await call("publish_page", { message: "Purple" })).toMatch(/Published/);

    const style = (await (await seam.server.get(`/api/projects/${seam.project.id}/project-style`)).json()) as { content: string };
    expect(style.content).toBe(":root { --color-primary: #7c3aed; }\n");
    const versions = (await (await seam.server.get(`/api/projects/${seam.project.id}/project-style/versions`)).json()) as { origin: string }[];
    expect(versions[0]).toMatchObject({ origin: "terminal" });
    expect((await seam.server.get(`/api/pages/${page.id}/files/tokens.css`)).status).toBe(404);
    expect(await call("publish_page", { message: "Again" })).toMatch(/Nothing changed/);
  });

  it("publish waits for the page lock while a session runs on the page", async () => {
    let finishSession!: () => void;
    const sessionMayEnd = new Promise<void>((resolve) => (finishSession = resolve));
    const engine = new FakeEngine(async () => {
      await sessionMayEnd;
      return [{ edit: { path: "home.html", content: "<h1>From session</h1>" } }, { type: "result", summary: "Session edit" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminalFolder = mkdtempSync(join(tmpdir(), "redline-terminal-folder-"));
    const call = await connectTerminal(terminalFolder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(terminalFolder, ".redline", page.id, "extra.html"), "<h1>Extra</h1>");

    await seam.pinThread(page.id, "home.html", "Do it");
    while (engine.runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const published = call("publish_page", { message: "From terminal" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await origins(page.id)).toHaveLength(1);

    finishSession();
    await published;
    await seam.waitForWorkEnd();
    expect(await origins(page.id)).toEqual(["terminal", "thread", "creation"]);
    rmSync(terminalFolder, { recursive: true, force: true });
  });
});

describe("terminal mode: projects and pages", () => {
  it("creates a project, lists it, and lists its pages, with links into Redline", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);

    const created = await call("create_project", { title: "Halloween" });
    const projectId = /id ([0-9a-f-]{36})/.exec(created)![1];
    expect(created).toContain(`${seam.server.url}/#/projects/${projectId}`);
    const project = (await (await seam.server.get(`/api/projects/${projectId}`)).json()) as Project;
    expect(project.title).toBe("Halloween");

    const projects = await call("list_projects", {});
    expect(projects).toContain("Halloween");
    expect(projects).toContain(projectId);

    expect(await call("list_pages", { projectId })).toMatch(/no page/i);
    const page = await seam.createPage(PAGE_FILES, "Stories");
    expect((await seam.server.get(`/api/projects/${seam.project.id}/pages`)).status).toBe(200);
    const pages = await call("list_pages", { projectId: seam.project.id });
    expect(pages).toContain("Stories");
    expect(pages).toContain(`${seam.server.url}/#/pages/${page.id}`);
  });

  it("creates an empty page in the given project without any checkout, ready to be checked out", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);

    const answer = await call("create_page", { title: "Stories", projectId: seam.project.id });
    const pages = (await (await seam.server.get(`/api/projects/${seam.project.id}/pages`)).json()) as Page[];
    const stories = pages.find((p) => p.title === "Stories")!;
    expect(Object.keys(stories.version.files)).toEqual(["manifest.json"]);
    expect(answer).toContain(`${seam.server.url}/#/pages/${stories.id}`);
    expect(answer).toMatch(/checkout_page/);

    await call("checkout_page", { pageId: stories.id });
    await call("add_artboard", { file: "story-1.html", html: "<h1>1</h1>" });
    expect(await call("publish_page", { message: "First story" })).toMatch(/Published/);
    expect(await seam.readFile(stories.id, "story-1.html")).toBe("<h1>1</h1>");
  });

  it("creates the page in the checked-out page's project, else in the folder's linked project, else explains", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const listTitles = async () =>
      ((await (await seam!.server.get(`/api/projects/${seam!.project.id}/pages`)).json()) as Page[]).map((p) => p.title);

    const bare = mkdtempSync(join(tmpdir(), "redline-terminal-"));
    let call = await connectTerminal(bare);
    expect(await call("create_page", { title: "Nowhere" })).toMatch(/projectId.*list_projects/);

    const page = await seam.createPage(PAGE_FILES);
    await call("checkout_page", { pageId: page.id });
    await call("create_page", { title: "Beside" });
    expect(await listTitles()).toContain("Beside");
    await client!.close();

    const linked = mkdtempSync(join(tmpdir(), "redline-terminal-"));
    mkdirSync(join(linked, ".redline"));
    writeFileSync(join(linked, ".redline", "project.json"), JSON.stringify({ projectId: seam.project.id }));
    call = await connectTerminal(linked);
    await call("create_page", { title: "Linked" });
    await call("create_page", { title: "Blank id", projectId: "" });
    expect(await listTitles()).toEqual(expect.arrayContaining(["Linked", "Blank id"]));

    rmSync(bare, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  });
  it("moves an artboard of the checked-out page to another page, refreshes the working copy and explains refusals", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const manifest = JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }, { file: "btn.html", x: 900, y: 0 }] });
    const web = await seam.createPage({ "manifest.json": manifest, "home.html": "<p>h</p>", "btn.html": "<button>Ok</button>" }, "Web");
    const buttons = await seam.createPage({ "manifest.json": JSON.stringify({ artboards: [] }) }, "Boutons");
    const call = await connectTerminal(seam.folder);

    expect(await call("move_artboard", { file: "btn.html", pageId: buttons.id })).toMatch(/No page checked out/);
    await call("checkout_page", { pageId: web.id });
    expect(await call("move_artboard", { file: "btn.html", pageId: buttons.id })).toMatch(/Boutons/);

    expect(await seam.readFile(buttons.id, "btn.html")).toBe("<button>Ok</button>");
    expect(existsSync(join(seam.folder, ".redline", web.id, "btn.html"))).toBe(false);
    expect(await call("publish_page", { message: "Nothing to publish" })).toMatch(/Nothing changed/);

    expect(await call("move_artboard", { file: "ghost.html", pageId: buttons.id })).toMatch(/not an artboard/);
  });
});
