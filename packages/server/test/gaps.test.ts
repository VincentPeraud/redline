import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type PageGaps, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111111;`).join("\n")}\n  --color-primary: #ff5a1f;\n${extra}}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem ? { designSystem } : {}), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const story = `<!doctype html><html><body><button style="background: #FF6B00; font-family: Arial">Go</button><p style="color: var(--old)">x</p></body></html>`;

describe("design system gaps of a page over the server HTTP API", () => {
  let server: TestServer;
  let ds: DesignSystem;

  beforeEach(async () => {
    server = await startTestServer();
    ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss("  --brand: #ff0000;\n  --old: var(--brand); /* deprecated: renamed to --brand */\n"),
        "manifest.json": manifestOf(["components/post-cta.html"]),
        "components/post-cta.html": component(".post-cta{color:red}"),
      },
    })).json()) as DesignSystem;
  });
  afterEach(async () => {
    await server.stop();
  });

  const createProject = async (designSystem?: string) => (await (await server.post("/api/projects", { title: "Halloween", designSystem })).json()) as Project;
  const createPage = async (project: Project, files: Record<string, string>) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Stories", files })).json()) as Page;
  const gapsOf = async (page: Page) => ((await (await server.get(`/api/pages/${page.id}/gaps`)).json()) as PageGaps).gaps;

  it("lists the gaps of every artboard against the design system's tokens and components, with stable keys", async () => {
    const page = await createPage(await createProject(ds.id), { "story-2.html": story, "manifest.json": manifestOf(["story-2.html"], ds.id) });
    const gaps = await gapsOf(page);
    expect(gaps.map((g) => [g.file, g.kind, g.value])).toEqual([
      ["story-2.html", "color", "#FF6B00"],
      ["story-2.html", "font", "Arial"],
      ["story-2.html", "control", "<button>"],
      ["story-2.html", "deprecated", "--old"],
    ]);
    expect(gaps[0].suggestion).toEqual({ token: "--color-primary", component: "post-cta" });
    expect(gaps[3].suggestion).toEqual({ token: "--brand" });
    expect(new Set(gaps.map((g) => g.key)).size).toBe(4);
    expect((await gapsOf(page)).map((g) => g.key)).toEqual(gaps.map((g) => g.key));
  });

  it("follows the latest version and the project style", async () => {
    const project = await createProject(ds.id);
    const page = await createPage(project, { "a.html": `<p style="color: #ff5a20">x</p>`, "manifest.json": manifestOf(["a.html"], ds.id) });
    expect((await gapsOf(page)).map((g) => g.suggestion?.token)).toEqual(["--color-primary"]);
    await fetch(`${server.url}/api/projects/${project.id}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: ":root { --color-go: #ff5a20; }\n" }) });
    expect((await gapsOf(page)).map((g) => g.suggestion?.token)).toEqual(["--color-go"]);
    await server.post(`/api/pages/${page.id}/versions`, { files: { "a.html": "<p>clean</p>", "manifest.json": manifestOf(["a.html"], ds.id) }, message: "Fix", origin: "user" });
    expect(await gapsOf(page)).toEqual([]);
  });

  it("uses the current diffusion, not the draft", async () => {
    const project = await createProject(ds.id);
    const page = await createPage(project, { "a.html": `<p style="color: #ff0000">x</p>`, "manifest.json": manifestOf(["a.html"], ds.id) });
    const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
    await server.post(`/api/pages/${dsPage.id}/versions`, { files: { "tokens.css": tokensCss("  --draft-red: #ff0001;\n") }, message: "Draft", origin: "thread", confirmRemovals: true });
    expect((await gapsOf(page)).map((g) => g.suggestion?.token)).not.toContain("--draft-red");
  });

  it("names the design system the gaps are measured against", async () => {
    const page = await createPage(await createProject(ds.id), { "a.html": "<p>x</p>", "manifest.json": manifestOf(["a.html"], ds.id) });
    expect(((await (await server.get(`/api/pages/${page.id}/gaps`)).json()) as PageGaps).designSystemTitle).toBe("Acme DS");
  });

  it("has no gaps on a design system's own pages and answers 404 for an unknown page", async () => {
    const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
    expect(await gapsOf(dsPage)).toEqual([]);
    expect((await server.get("/api/pages/nope/gaps")).status).toBe(404);
  });
});
