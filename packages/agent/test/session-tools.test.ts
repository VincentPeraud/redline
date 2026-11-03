import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, PALETTE_COLORS, parseManifest, type Page } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

async function runOnce(engine: FakeEngine) {
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES);
  await seam.pinThread(page.id, "home.html", "Do it");
  await engine.finished(1);
  await seam.waitForWorkEnd();
  return page;
}

describe("session MCP tools", () => {
  it("offers add_artboard, create_page, check_page and read_guide", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing" }]);
    await runOnce(engine);
    expect(engine.runs[0].mcpTools).toEqual(expect.arrayContaining(["add_artboard", "create_page", "move_artboard", "rename_page", "archive_page", "send_request", "check_page", "read_guide"]));
    expect(engine.runs[0].mcpTools).not.toContain("rename_project");
    expect(engine.runs[0].mcpTools).not.toContain("archive_project");
  });

  it("add_artboard writes the HTML and its manifest entry, published with the run", async () => {
    const engine = new FakeEngine([
      { callTool: { name: "add_artboard", arguments: { file: "checkout.html", html: "<h1>Checkout</h1>", title: "Checkout" } } },
      { type: "result", summary: "Add checkout" },
    ]);
    const page = await runOnce(engine);

    expect(await seam!.readFile(page.id, "checkout.html")).toBe("<h1>Checkout</h1>");
    const manifest = parseManifest(await seam!.readFile(page.id, "manifest.json"));
    expect(manifest.artboards.map((a) => [a.file, a.title, a.width, a.height, a.x])).toEqual([
      ["home.html", undefined, 400, 300, 0],
      ["checkout.html", "Checkout", 800, 500, 480],
    ]);
    expect(await seam!.versions(page.id)).toHaveLength(2);
  });

  it("add_artboard keeps the elements as written, so anchored ones stay publishable", async () => {
    const engine = new FakeEngine(async (run) => {
      await run.callTool("add_artboard", { file: "extra.html", html: "<h1>Extra</h1>" });
      return [{ type: "result", summary: "Added" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage({
      ...PAGE_FILES,
      "manifest.json": JSON.stringify({
        artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }],
        elements: [
          { kind: "text", id: "note", text: "n", rightOf: "home.html" },
          { kind: "sticky", id: "ask", text: "s", below: "note" },
        ],
      }),
    });
    await seam.pinThread(page.id, "home.html", "Do it");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    const manifest = JSON.parse(await (await seam.server.get(`/api/pages/${page.id}/files/manifest.json`)).text()) as { artboards: { file: string }[]; elements: object[] };
    expect(manifest.artboards.map((a) => a.file)).toEqual(["home.html", "extra.html"]);
    expect(manifest.elements).toEqual([
      { kind: "text", id: "note", text: "n", rightOf: "home.html" },
      { kind: "sticky", id: "ask", text: "s", below: "note" },
    ]);
  });

  it("add_artboard records the frame and url in the manifest entry", async () => {
    const engine = new FakeEngine([
      { callTool: { name: "add_artboard", arguments: { file: "site.html", html: "<h1>Site</h1>", frame: "browser", url: "lumora.fr" } } },
      { type: "result", summary: "Add site" },
    ]);
    const page = await runOnce(engine);
    const manifest = parseManifest(await seam!.readFile(page.id, "manifest.json"));
    expect(manifest.artboards.find((a) => a.file === "site.html")).toMatchObject({ frame: "browser", url: "lumora.fr" });
  });

  it("add_artboard keeps a responsive artboard publishable", async () => {
    const engine = new FakeEngine([
      { callTool: { name: "add_artboard", arguments: { file: "extra.html", html: "<h1>Extra</h1>" } } },
      { type: "result", summary: "Add extra" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage({
      "site.html": "<!doctype html><h1>Site</h1>",
      "manifest.json": JSON.stringify({ artboards: [{ file: "site.html", responsive: ["desktop", { format: "mobile", width: 400, height: 800 }] }] }),
    });
    await seam.pinThread(page.id, "site.html", "Do it");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    expect(await seam.versions(page.id)).toHaveLength(2);
    const manifest = parseManifest(await seam.readFile(page.id, "manifest.json"));
    expect(manifest.artboards[0].responsive?.map((r) => [r.format, r.width, r.height])).toEqual([
      ["desktop", 1440, 900],
      ["mobile", 400, 800],
    ]);
    expect(manifest.artboards.map((a) => a.file)).toEqual(["site.html", "extra.html"]);
  });

  it("add_artboard refuses a path outside the page", async () => {
    let answer = "";
    const engine = new FakeEngine(async (run) => {
      answer = await run.callTool("add_artboard", { file: "../evil.html", html: "x" });
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(answer).toMatch(/relative path/);
  });

  it.each(["..\\..\\.mcp.json.html", "C:/evil.html", "a/./b.html", "/abs.html", "a//b.html"])("add_artboard refuses %j", async (file) => {
    let answer = "";
    const engine = new FakeEngine(async (run) => {
      answer = await run.callTool("add_artboard", { file, html: "x" });
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(answer).toMatch(/relative path/);
  });

  it("check_page lists the gaps and the layout problems of the working copy as it is now, before the run publishes", async () => {
    const answers: string[] = [];
    const engine = new FakeEngine(async (run) => {
      answers.push(await run.callTool("check_page", {}));
      await run.callTool("add_artboard", { file: "pilot.html", html: '<span style="color: #2563eb">Julie</span><b data-ds-libre style="color: #5865f2">Discord</b>', x: 200, y: 0 });
      answers.push(await run.callTool("check_page", {}));
      return [{ type: "result", summary: "Nothing" }];
    });
    seam = await startSeam2(engine);
    const designSystem = await seam.createDesignSystem();
    const page = await seam.createPage({ ...PAGE_FILES, "manifest.json": JSON.stringify({ designSystem, artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }] }) });
    await seam.pinThread(page.id, "home.html", "Do it");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    expect(answers[0]).toBe("No design system gaps.\nLayout: nothing overlaps.");
    expect(answers[1]).toContain("- colour #2563eb ×1 (pilot.html)");
    expect(answers[1]).not.toContain("#5865f2");
    expect(answers[1]).toContain('Layout: 1 probable problem on the canvas:\n- The artboards "pilot.html" and "home.html" overlap: move one of them.');
  });

  it("check_page reports no gaps for a project without a design system, whatever colours and fonts the artboards hard-code", async () => {
    const answers: string[] = [];
    const engine = new FakeEngine(async (run) => {
      await run.callTool("add_artboard", { file: "pilot.html", html: '<span style="color: #2563eb; font-family: Arial">Julie</span>', x: 500, y: 0 });
      answers.push(await run.callTool("check_page", {}));
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);

    expect(answers[0]).toBe("No design system gaps.\nLayout: nothing overlaps.");
  });

  it("create_page creates an empty page (manifest only) in the same project, marked as created by Claude", async () => {
    let answer = "";
    const engine = new FakeEngine(async (run) => {
      answer = await run.callTool("create_page", { title: "Pricing" });
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);

    const pages = (await (await seam!.server.get(`/api/projects/${seam!.project.id}/pages`)).json()) as Page[];
    const created = pages.find((p) => p.title === "Pricing");
    expect(created?.createdBy).toBe("claude");
    expect(Object.keys(created!.version.files).sort()).toEqual(["manifest.json"]);
    expect(answer).toContain(created!.id);
  });

  describe("move_artboard", () => {
    const TWO_ARTBOARDS = {
      "home.html": "<!doctype html><h1>Home</h1>",
      "btn.html": "<button>Ok</button>",
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "home.html", width: 400, height: 300, x: 0, y: 0 },
          { file: "btn.html", width: 200, height: 100, x: 500, y: 0 },
        ],
      }),
    };
    async function runOn(engine: FakeEngine) {
      seam = await startSeam2(engine);
      const page = await seam.createPage(TWO_ARTBOARDS);
      await seam.pinThread(page.id, "home.html", "Split the page");
      await engine.finished(1);
      await seam.waitForWorkEnd();
      return page;
    }
    const pagesOf = async () => (await (await seam!.server.get(`/api/projects/${seam!.project.id}/pages`)).json()) as Page[];

    it("moves an artboard to a new page from inside a run, and answers with the page id", async () => {
      let answer = "";
      const engine = new FakeEngine(async (run) => {
        answer = await run.callTool("move_artboard", { file: "btn.html", newPageTitle: "Boutons" });
        return [{ type: "result", summary: "Moved" }];
      });
      const page = await runOn(engine);
      const boutons = (await pagesOf()).find((p) => p.title === "Boutons")!;

      expect(answer).toContain(boutons.id);
      expect(Object.keys(boutons.version.files).sort()).toEqual(["btn.html", "manifest.json"]);
      const source = (await pagesOf()).find((p) => p.id === page.id)!;
      expect(Object.keys(source.version.files).sort()).toEqual(["home.html", "manifest.json"]);
      const sourceVersions = await seam!.versions(page.id);
      expect(sourceVersions.map((v) => v.message)).toEqual(["btn.html déplacé vers Boutons", "Page created"]);
    });

    it("tells Claude why a move is refused", async () => {
      let answer = "";
      const engine = new FakeEngine(async (run) => {
        answer = await run.callTool("move_artboard", { file: "nope.html", newPageTitle: "Boutons" });
        return [{ type: "result", summary: "Nothing" }];
      });
      await runOn(engine);
      expect(answer).toMatch(/not an artboard/);
    });

    it("does not make the run's own publish bring the artboard back", async () => {
      const engine = new FakeEngine(async (run) => {
        await run.callTool("move_artboard", { file: "btn.html", newPageTitle: "Boutons" });
        await run.callTool("add_artboard", { file: "extra.html", html: "<p>extra</p>" });
        return [{ type: "result", summary: "Moved and added" }];
      });
      const page = await runOn(engine);
      const source = (await pagesOf()).find((p) => p.id === page.id)!;
      expect(Object.keys(source.version.files).sort()).toEqual(["extra.html", "home.html", "manifest.json"]);
      expect(parseManifest(await seam!.readFile(page.id, "manifest.json")).artboards.map((a) => a.file).sort()).toEqual(["extra.html", "home.html"]);
    });
  });

  it("rename_page renames a page of the project, the run's own by default, and refuses another project's", async () => {
    const answers: string[] = [];
    let others: { mine: string; foreign: string } | undefined;
    const engine = new FakeEngine(async (run) => {
      answers.push(await run.callTool("rename_page", { title: "Archive · Home" }));
      answers.push(await run.callTool("rename_page", { pageId: others!.mine, title: "Archive · Brouillon" }));
      answers.push(await run.callTool("rename_page", { pageId: others!.foreign, title: "Hijacked" }));
      return [{ type: "result", summary: "Renamed" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const mine = await seam.createPage(PAGE_FILES, "Brouillon");
    const otherProject = (await (await seam.server.post("/api/projects", { title: "Other" })).json()) as { id: string };
    const foreign = (await (await seam.server.post(`/api/projects/${otherProject.id}/pages`, { title: "Theirs", files: PAGE_FILES })).json()) as Page;
    others = { mine: mine.id, foreign: foreign.id };
    await seam.pinThread(page.id, "home.html", "Archive this page");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    const titleOf = async (pageId: string) => ((await (await seam!.server.get(`/api/pages/${pageId}`)).json()) as Page).title;
    expect(await titleOf(page.id)).toBe("Archive · Home");
    expect(await titleOf(mine.id)).toBe("Archive · Brouillon");
    expect(await titleOf(foreign.id)).toBe("Theirs");
    expect(answers[2]).toMatch(/cannot rename/);
    // An open canvas hears of the new title.
    expect(seam.events()).toEqual(expect.arrayContaining([{ type: "page-renamed", pageId: page.id }]));
  });

  it("archive_page archives another page of the project, but neither the run's own page nor another project's", async () => {
    const answers: string[] = [];
    let others: { own: string; mine: string; foreign: string } | undefined;
    const engine = new FakeEngine(async (run) => {
      answers.push(await run.callTool("archive_page", { pageId: others!.mine }));
      answers.push(await run.callTool("archive_page", { pageId: others!.own }));
      answers.push(await run.callTool("archive_page", { pageId: others!.foreign }));
      return [{ type: "result", summary: "Archived" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const mine = await seam.createPage(PAGE_FILES, "Brouillon");
    const otherProject = (await (await seam.server.post("/api/projects", { title: "Other" })).json()) as { id: string };
    const foreign = (await (await seam.server.post(`/api/projects/${otherProject.id}/pages`, { title: "Theirs", files: PAGE_FILES })).json()) as Page;
    others = { own: page.id, mine: mine.id, foreign: foreign.id };
    await seam.pinThread(page.id, "home.html", "Archive the draft");
    await engine.finished(1);
    await seam.waitForWorkEnd();

    const archivedAt = async (pageId: string) => ((await (await seam!.server.get(`/api/pages/${pageId}`)).json()) as Page).archivedAt;
    expect(answers[0]).toMatch(/archived "Brouillon"/);
    expect(await archivedAt(mine.id)).toEqual(expect.any(String));
    expect(answers[1]).toMatch(/working on this page/);
    expect(await archivedAt(page.id)).toBeUndefined();
    expect(answers[2]).toMatch(/cannot archive/);
    expect(await archivedAt(foreign.id)).toBeUndefined();
  });

  describe("send_request", () => {
    const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div><slot></slot></div></template></body></html>`;
    const designSystemFiles = {
      "tokens.css": `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`,
      "manifest.json": JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }] }),
      "components/modal.html": MODAL,
    };

    /** The seam's project follows a design system with a modal. The request is also work for that design system, which the same agent then runs: only the first run acts. */
    async function followingProject(engine: FakeEngine) {
      seam = await startSeam2(engine);
      const ds = (await (await seam.server.post("/api/design-systems", { title: "Lumora", files: designSystemFiles })).json()) as { id: string; pageId: string };
      await fetch(`${seam.server.url}/api/projects/${seam.project.id}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ designSystem: ds.id }) });
      const page = await seam.createPage({ ...PAGE_FILES, "manifest.json": JSON.stringify({ designSystem: ds.id, artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }] }) }, "Planning");
      return { ds, page };
    }

    it("sends a request to the design system, naming the component, what is missing and the instance, and tells who it went to", async () => {
      const answers: string[] = [];
      let ran = false;
      const engine = new FakeEngine(async (run) => {
        if (ran) return [{ type: "result", summary: "Done" }];
        ran = true;
        answers.push(await run.callTool("send_request", { component: "ui-modal", missing: "A 720 px size", artboard: "home.html", selector: "#edit" }));
        return [{ type: "result", summary: "Asked" }];
      });
      const { ds, page } = await followingProject(engine);
      await seam!.pinThread(page.id, "home.html", "The edit modal is too narrow");
      await engine.finished(1);
      await seam!.waitForWorkEnd();

      const threads = (await (await seam!.server.get(`/api/pages/${ds.pageId}/threads`)).json()) as { body: string; request: { origins: { selector: string; threadId?: string }[] } }[];
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ body: "A 720 px size", request: { origins: [{ selector: "#edit" }] } });
      expect(answers[0]).toMatch(/Request sent to the design system "Lumora"/);
    });

    it("links the request to the user's comment when it is given, and only for a thread of the run", async () => {
      const answers: string[] = [];
      let thread = "";
      let ran = false;
      const engine = new FakeEngine(async (run) => {
        if (ran) return [{ type: "result", summary: "Done" }];
        ran = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        answers.push(await run.callTool("send_request", { component: "modal", missing: "Round cross", artboard: "home.html", threadId: thread }));
        answers.push(await run.callTool("send_request", { component: "modal", missing: "Round cross", artboard: "home.html", threadId: "someone-elses" }));
        return [{ type: "result", summary: "Asked" }];
      });
      const { ds, page } = await followingProject(engine);
      thread = (await seam!.pinThread(page.id, "home.html", "The cross must be round")).id;
      await engine.finished(1);
      await seam!.waitForWorkEnd();

      const threads = (await (await seam!.server.get(`/api/pages/${ds.pageId}/threads`)).json()) as { request: { origins: { threadId?: string }[] } }[];
      expect(threads.map((t) => t.request.origins[0]!.threadId)).toEqual([thread]);
      expect(answers[1]).toMatch(/not part of this run/);
    });

    it("sends a request for a component the design system lacks", async () => {
      const answers: string[] = [];
      const engine = new FakeEngine(async (run) => {
        answers.push(await run.callTool("send_request", { component: "ui-carousel", missing: "A carousel", artboard: "home.html" }));
        return [{ type: "result", summary: "Asked" }];
      });
      const { page } = await followingProject(engine);
      await seam!.pinThread(page.id, "home.html", "Add a carousel");
      await engine.finished(1);
      await seam!.waitForWorkEnd();
      expect(answers[0]).toMatch(/Request sent to the design system/);
    });
  });

  it("read_guide returns the manifest, tweaks, assets and design system rules", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toContain("manifest.json");
    expect(guide).toContain("tweaks.json");
    expect(guide).toMatch(/"frame"[^\n]*phone[^\n]*tablet[^\n]*browser[^\n]*paper/);
    expect(guide).toMatch(/"paper" for anything printed \(business card/);
    expect(guide).toMatch(/without a frame is shown as is, never guessed from its size/);
    expect(guide).toMatch(/"expand"[^\n]*"fill"/);
    expect(guide).toContain('src="assets/hero.jpg"');
    for (const token of CORE_TOKENS) expect(guide).toContain(token);
  });

  it("read_guide documents text and sticky notes with the palette and sizes", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toMatch(/- text:/);
    expect(guide).toMatch(/- sticky:/);
    for (const color of PALETTE_COLORS) expect(guide).toContain(color);
    expect(guide).toMatch(/"size"[^\n]*"s"[^\n]*"m"[^\n]*"l"/);
    expect(guide).toContain("360");
    expect(guide).toContain("240");
  });

  it("read_guide documents responsive artboards: formats, overrides, when to use them, asking the user", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toMatch(/"responsive"[^\n]*"desktop"[^\n]*"tablet-landscape"[^\n]*"tablet"[^\n]*"mobile"/);
    for (const size of ["1440x900", "1024x768", "768x1024", "390x844"]) expect(guide).toContain(size);
    expect(guide).toMatch(/\{ "format", "width", "height" \}/);
    expect(guide).toMatch(/ignores "frame"/);
    expect(guide).toMatch(/separate (desktop and mobile )?artboards/i);
    expect(guide).toMatch(/ask the user/i);
  });

  it("read_guide documents the tweak grid: matrix dimensions, limits, refusals and data-state", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toMatch(/"matrix"[^\n]*"rows"[^\n]*"columns"[^\n]*"blocks"/);
    expect(guide).toMatch(/choice or toggle/);
    expect(guide).toMatch(/60 cells/);
    expect(guide).toMatch(/not with "responsive"/);
    expect(guide).toMatch(/data-state/);
  });

  it("read_guide documents element ids and arrows", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toMatch(/- arrow:/);
    expect(guide).toMatch(/"id"/);
    expect(guide).toContain("dashed");
    expect(guide).toMatch(/unknown id|duplicate id/);
  });

  it("read_guide documents shapes with their drawing order", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toMatch(/- shape:/);
    expect(guide).toMatch(/"rect"[^\n]*"ellipse"/);
    expect(guide).toMatch(/"outline"[^\n]*"fill"/);
    expect(guide).toMatch(/under the artboards/i);
  });

  it("the server relay rejects calls without the agent token", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing" }]);
    const page = await runOnce(engine);
    const res = await fetch(`${seam!.server.url}/agent-api/pages/${page.id}/siblings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(401);
  });
});
