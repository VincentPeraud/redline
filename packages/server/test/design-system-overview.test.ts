import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DesignSystemDetail, type DiffusionListItem, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("design system overview data", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const detailOf = async (id: string) => (await (await server.get(`/api/design-systems/${id}`)).json()) as DesignSystemDetail;
  const putStyle = (id: string, content: string) =>
    fetch(`${server.url}/api/projects/${id}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });

  async function seed() {
    const ds = (await (await server.post("/api/design-systems", {
      title: "Lumora",
      files: {
        "tokens.css": tokensCss("#f25c2a"),
        "manifest.json": manifestOf(["components/btn.html"]),
        "components/btn.html": component(".btn{color:red}"),
      },
    })).json()) as DesignSystem;
    const first = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
    const social = (await (await server.post(`/api/projects/${ds.id}/pages`, {
      title: "Réseaux sociaux",
      files: {
        "manifest.json": manifestOf(["components/story-frame.html", "components/post-cta.html"]),
        "components/story-frame.html": component(".s{}"),
        "components/post-cta.html": component(".p{}"),
      },
    })).json()) as Page;
    return { ds, first, social };
  }

  it("counts pages, components and tokens, and tells which components are not diffused yet", async () => {
    const { ds, first, social } = await seed();
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    await server.post(`/api/pages/${social.id}/versions`, {
      files: {
        "manifest.json": manifestOf(["components/story-frame.html", "components/post-cta.html"]),
        "components/story-frame.html": component(".s{color:blue}"),
        "components/post-cta.html": component(".p{}"),
      },
      message: "Edit",
      origin: "thread",
    });

    const detail = await detailOf(ds.id);
    expect(detail.componentCount).toBe(3);
    expect(detail.tokenCount).toBe(CORE_TOKENS.length);
    expect(detail.palette[0]).toBe("#f25c2a");
    expect(detail.pages).toEqual([
      { id: first.id, title: "Lumora", componentCount: 1, componentNames: ["btn"], pendingCount: 0 },
      { id: social.id, title: "Réseaux sociaux", componentCount: 2, componentNames: ["post-cta", "story-frame"], pendingCount: 1 },
    ]);
  });

  it("gives each project using it its override and project component counts", async () => {
    const { ds } = await seed();
    const halloween = (await (await server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as Project;
    const plain = (await (await server.post("/api/projects", { title: "Plain", designSystem: ds.id })).json()) as Project;
    await putStyle(halloween.id, ":root { --color-primary: #ff6600; --font-heading: Creepster; --color-extra: #123456; }");
    await server.post(`/api/projects/${halloween.id}/pages`, {
      title: "Stories",
      files: { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".x{}") },
    });

    const usedBy = (await detailOf(ds.id)).usedBy;
    expect(usedBy.find((p) => p.id === halloween.id)).toEqual({ id: halloween.id, title: "Halloween", overrideCount: 2, componentCount: 1 });
    expect(usedBy.find((p) => p.id === plain.id)).toEqual({ id: plain.id, title: "Plain", overrideCount: 0, componentCount: 0 });
  });

  it("lists each diffusion with what it changed since the previous one", async () => {
    const { ds, first } = await seed();
    await server.post(`/api/pages/${first.id}/versions`, {
      files: { "manifest.json": manifestOf(["components/btn.html", "components/field.html"]), "components/btn.html": component(".btn{color:red}"), "components/field.html": component(".f{}") },
      message: "Edit",
      origin: "thread",
    });
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});

    const list = (await (await server.get(`/api/design-systems/${ds.id}/diffusions`)).json()) as DiffusionListItem[];
    expect(list.map((d) => d.number)).toEqual([2, 1]);
    expect([...list[0]!.changes.components.added].sort()).toEqual(["field", "post-cta", "story-frame"]);
    expect(list[0]!.changes.count).toBe(3);
    expect(list[1]!.changes.components.added).toEqual(["btn"]);
  });
});
