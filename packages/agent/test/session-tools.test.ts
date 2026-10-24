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
  it("offers add_artboard, create_page and read_guide", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing" }]);
    await runOnce(engine);
    expect(engine.runs[0].mcpTools).toEqual(expect.arrayContaining(["add_artboard", "create_page", "read_guide"]));
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

  it("add_artboard records the device and url in the manifest entry", async () => {
    const engine = new FakeEngine([
      { callTool: { name: "add_artboard", arguments: { file: "site.html", html: "<h1>Site</h1>", device: "desktop", url: "lumora.fr" } } },
      { type: "result", summary: "Add site" },
    ]);
    const page = await runOnce(engine);
    const manifest = parseManifest(await seam!.readFile(page.id, "manifest.json"));
    expect(manifest.artboards.find((a) => a.file === "site.html")).toMatchObject({ device: "desktop", url: "lumora.fr" });
  });

  it("add_artboard keeps a responsive artboard publishable", async () => {
    const engine = new FakeEngine([
      { callTool: { name: "add_artboard", arguments: { file: "extra.html", html: "<h1>Extra</h1>" } } },
      { type: "result", summary: "Add extra" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage({
      "site.html": "<!doctype html><h1>Site</h1>",
      "manifest.json": JSON.stringify({ artboards: [{ file: "site.html", responsive: ["desktop", { device: "mobile", width: 400, height: 800 }] }] }),
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

  it("read_guide returns the manifest, tweaks, assets and design system rules", async () => {
    let guide = "";
    const engine = new FakeEngine(async (run) => {
      guide = await run.callTool("read_guide", {});
      return [{ type: "result", summary: "Nothing" }];
    });
    await runOnce(engine);
    expect(guide).toContain("manifest.json");
    expect(guide).toContain("tweaks.json");
    expect(guide).toMatch(/"device"[^\n]*phone[^\n]*tablet[^\n]*desktop[^\n]*paper[^\n]*none/);
    expect(guide).toMatch(/"paper" for anything printed \(business card/);
    expect(guide).toMatch(/without a device is shown as is, never guessed from its size/);
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
    expect(guide).toMatch(/\{ "device", "width", "height" \}/);
    expect(guide).toMatch(/ignores "device"/);
    expect(guide).toMatch(/separate (desktop and mobile )?artboards/i);
    expect(guide).toMatch(/ask the user/i);
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
