import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Project, type ProjectDesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#111111"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const followingManifest = (designSystem: string) => JSON.stringify({ designSystem, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }] });
const json = { "content-type": "application/json" };

describe("changing a project's design system and promoting its style", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const createDesignSystem = async (title = "Acme DS") =>
    (await (await server.post("/api/design-systems", { title, files: { "tokens.css": tokensCss("#111111"), "index.html": html } })).json()) as DesignSystem;
  const createProject = async (designSystem?: string) => (await (await server.post("/api/projects", { title: "Halloween", designSystem })).json()) as Project;
  const createPage = async (project: Project, files: Record<string, string> = { "a.html": html }) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Stories", files })).json()) as Page;
  const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;
  const change = (projectId: string, designSystem: string | null) =>
    fetch(`${server.url}/api/projects/${projectId}/design-system`, { method: "PUT", headers: json, body: JSON.stringify({ designSystem }) });
  const promote = (projectId: string, body: object) => server.post(`/api/projects/${projectId}/design-system/promote`, body);
  const artboard = async (page: Page) => (await fetch(`${server.artboardOrigin}/pages/${page.id}/a.html`)).text();
  const styleCss = async (project: Project) => (await fetch(`${server.artboardOrigin}/project-styles/${project.id}/tokens.css`)).text();

  it("switches a project to another shared design system, its pages included", async () => {
    const first = await createDesignSystem("First");
    const second = await createDesignSystem("Second");
    const project = await createProject(first.id);
    const page = await createPage(project, { "a.html": html, "manifest.json": followingManifest(first.id) });
    expect(await artboard(page)).toContain(`/design-systems/${first.id}/`);
    const res = await change(project.id, second.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectDesignSystem).designSystem).toEqual({ id: second.id, title: "Second" });
    const markup = await artboard(page);
    expect(markup).toContain(`/design-systems/${second.id}/`);
    expect(markup).not.toContain(`/design-systems/${first.id}/`);
  });

  it("choosing none copies nothing: the project style stops being overrides and becomes the whole style", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await createPage(project, { "a.html": html, "manifest.json": followingManifest(ds.id) });
    await fetch(`${server.url}/api/projects/${project.id}/project-style/tokens/--color-primary`, { method: "PUT", headers: json, body: JSON.stringify({ value: "#7c3aed" }) });
    const after = (await (await change(project.id, null)).json()) as ProjectDesignSystem;
    expect(after.designSystem).toBeNull();
    expect(after.tokens.map((t) => [t.name, t.status])).toEqual([["--color-primary", "own"]]);
    expect(await styleCss(project)).toContain("#7c3aed");
    expect(await styleCss(project)).not.toContain("#111111");
    expect(await artboard(page)).not.toContain(`/design-systems/${ds.id}/`);
  });

  it("refuses an unknown design system, an unknown project and a design system's own project", async () => {
    const ds = await createDesignSystem();
    const project = await createProject();
    expect((await change(project.id, "nope")).status).toBe(400);
    expect((await change("nope", null)).status).toBe(404);
    expect((await change(ds.id, null)).status).toBe(404);
  });

  it("promotes a project's own style: a shared design system with diffusion 1, tokens and component copies, the project renders unchanged", async () => {
    const project = await createProject();
    const page = await createPage(project, {
      "a.html": html,
      "manifest.json": manifestOf(["components/sticker.html"]),
      "components/sticker.html": component(".s{color:red}"),
    });
    await fetch(`${server.url}/api/projects/${project.id}/project-style`, { method: "PUT", headers: json, body: JSON.stringify({ content: tokensCss("#7c3aed") }) });
    const valuesBefore = (await detail(project)).tokens.map((t) => [t.name, t.value]);

    const res = await promote(project.id, { title: "Halloween DS" });
    expect(res.status).toBe(201);
    const ds = (await res.json()) as DesignSystem;
    expect(ds.title).toBe("Halloween DS");

    const diffusions = (await (await server.get(`/api/design-systems/${ds.id}/diffusions`)).json()) as { number: number }[];
    expect(diffusions.map((d) => d.number)).toEqual([1]);
    const diffused = (file: string) => fetch(`${server.artboardOrigin}/design-systems/${ds.id}/diffusions/1/${file}`).then((r) => r.text());
    expect(await diffused("tokens.css")).toContain("--color-primary: #7c3aed");
    expect(await diffused("components.css")).toContain(".s{color:red}");

    const after = await detail(project);
    expect(after.designSystem).toEqual({ id: ds.id, title: "Halloween DS" });
    expect(after.diffusion?.number).toBe(1);
    expect(after.overrideCount).toBe(0);
    expect(await styleCss(project)).toBe("");
    expect(after.tokens.map((t) => [t.name, t.value])).toEqual(valuesBefore);
    expect(await artboard(page)).toContain(`/design-systems/${ds.id}/diffusions/1/tokens.css`);
  });

  it("promotes a component with its manifest entry, group title, variants and assets", async () => {
    const project = await createProject();
    const withAsset = `<!doctype html><html><head><style data-component>.s{background:url(assets/dot.png)}</style></head><body><img src="assets/logo.svg"></body></html>`;
    const manifest = {
      artboards: [
        { file: "a.html", x: 0, y: 0, width: 200, height: 100 },
        { file: "components/sticker.html", title: "Sticker", x: 40, y: 500, width: 320, height: 240 },
      ],
      elements: [
        { kind: "title", text: "Stickers", x: 40, y: 440, width: 600 },
        { kind: "title", text: "Unrelated", x: 40, y: 900, width: 600 },
      ],
      tweaks: [
        { id: "tone", type: "choice", label: "Tone", options: ["warm", "cold"], artboard: "components/sticker.html" },
        { id: "other", type: "toggle", label: "Other", artboard: "a.html" },
      ],
    };
    await createPage(project, { "a.html": html, "components/sticker.html": withAsset, "manifest.json": JSON.stringify(manifest) });
    for (const name of ["dot.png", "logo.svg", "unused.png"]) await fetch(`${server.url}/api/projects/${project.id}/assets/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: name });

    const ds = (await (await promote(project.id, { title: "Halloween DS" })).json()) as DesignSystem;

    const files = async (path: string) => await (await server.get(`/api/pages/${ds.pageId}/files/${path}`)).text();
    const copied = JSON.parse(await files("manifest.json")) as { artboards: { file: string; title?: string; width: number; height: number }[]; elements: { text: string }[]; tweaks: { id: string }[] };
    expect(copied.artboards.find((a) => a.file === "components/sticker.html")).toMatchObject({ title: "Sticker", width: 320, height: 240 });
    expect(copied.artboards.some((a) => a.file === "a.html")).toBe(false);
    expect(copied.elements.map((e) => e.text)).toEqual(["Stickers"]);
    expect(copied.tweaks.map((t) => t.id)).toEqual(["tone"]);
    const assets = (await (await server.get(`/api/projects/${ds.id}/assets`)).json()) as { name: string }[];
    expect(assets.map((a) => a.name).sort()).toEqual(["dot.png", "logo.svg"]);
  });

  it("refuses to promote a project that follows a shared design system, a missing title, or an unknown project", async () => {
    const ds = await createDesignSystem();
    const following = await createProject(ds.id);
    const own = await createProject();
    expect((await promote(following.id, { title: "X" })).status).toBe(400);
    expect((await promote(own.id, {})).status).toBe(400);
    expect((await promote(own.id, { title: "x".repeat(300) })).status).toBe(400);
    expect((await promote("nope", { title: "X" })).status).toBe(404);
  });
});
