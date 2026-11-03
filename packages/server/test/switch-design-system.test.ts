import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem, type DesignSystemSwitchPreview, type Page, type ProjectDesignSystem, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const componentFile = (name: string, template = `<div class="${name}"><slot></slot></div>`) =>
  `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component>${template}</template></body></html>`;

const choice = (name: string, options: string[]) => ({ id: "variant", type: "choice", label: "Variant", options, default: options[0], artboard: `components/${name}.html` });

/** A design system whose components are `{ name: variant options }`. */
function designSystemFiles(components: Record<string, string[]>, slotted: string[] = []) {
  const names = Object.keys(components);
  const files: Record<string, string> = { "tokens.css": tokensCss };
  for (const name of names) files[`components/${name}.html`] = componentFile(name, slotted.includes(name) ? `<div class="${name}"><slot></slot><slot name="footer"></slot></div>` : undefined);
  files["manifest.json"] = JSON.stringify({
    artboards: names.map((name, i) => ({ file: `components/${name}.html`, x: i * 300, y: 0, width: 200, height: 100 })),
    tweaks: names.map((name) => choice(name, components[name])),
  });
  return files;
}

const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("switching a project's design system", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const createDesignSystem = async (title: string, components: Record<string, string[]>, slotted: string[] = []) =>
    (await (await server.post("/api/design-systems", { title, files: designSystemFiles(components, slotted) })).json()) as DesignSystem;

  const BODY = `<ui-button variant="solid">a</ui-button><ui-button>b</ui-button><ui-card variant="flat">c</ui-card><ui-tabs variant="pills">d</ui-tabs><ui-modal>e</ui-modal>`;

  /** Project "App" on `from`, whose page "Flow" uses button x2, card, tabs and modal. */
  async function project(from: DesignSystem) {
    const projectId = ((await (await server.post("/api/projects", { title: "App", designSystem: from.id })).json()) as { id: string }).id;
    const page = (await (
      await server.post(`/api/projects/${projectId}/pages`, {
        title: "Flow",
        files: { "manifest.json": JSON.stringify({ designSystem: from.id, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }] }), "a.html": mockup(BODY) },
      })
    ).json()) as Page;
    return { projectId, page };
  }

  const FROM = { button: ["solid", "ghost"], card: ["flat", "raised"], tabs: ["line", "pills"], modal: ["sm", "md"] };
  const TO = { button: ["solid", "ghost"], card: ["flat"], tabs: ["line"], grid: ["a"] };

  async function scenario() {
    const from = await createDesignSystem("Lumora", FROM);
    const to = await createDesignSystem("Réseaux sociaux", TO);
    return { from, to, ...(await project(from)) };
  }

  const previewOf = async (projectId: string, to: string) => (await (await server.get(`/api/projects/${projectId}/design-system/switch?to=${to}`)).json()) as DesignSystemSwitchPreview;
  const detailOf = async (projectId: string) => (await (await server.get(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem;

  it("lists the design system components the pages use, compared with the target's current diffusion", async () => {
    const { projectId, to } = await scenario();
    const preview = await previewOf(projectId, to.id);
    expect(preview.to).toEqual({ id: to.id, title: "Réseaux sociaux" });
    expect(preview.components.map((c) => [c.tag, c.instances, c.pages, c.match, c.label])).toEqual([
      ["ui-button", 2, 1, "same", "même nom, mêmes réglages"],
      ["ui-card", 1, 1, "different", "même nom, réglages différents"],
      ["ui-tabs", 1, 1, "different", "même nom, variante pills absente"],
      ["ui-modal", 1, 1, "absent", "absent de Réseaux sociaux"],
    ]);
    expect(preview.components.map((c) => c.page)).toEqual(["Flow", "Flow", "Flow", "Flow"]);
  });

  it("does not list the project's own components", async () => {
    const { projectId, page, to } = await scenario();
    const ownFile = componentFile("mission-card");
    await server.post(`/api/pages/${page.id}/versions`, {
      files: {
        "manifest.json": JSON.stringify({ designSystem: (await detailOf(projectId)).designSystem!.id, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }, { file: "components/mission-card.html", x: 300, y: 0, width: 200, height: 100 }] }),
        "a.html": mockup(`${BODY}<ui-mission-card>x</ui-mission-card>`),
        "components/mission-card.html": ownFile,
      },
      message: "Own component",
      origin: "user",
    });
    const preview = await previewOf(projectId, to.id);
    expect(preview.components.map((c) => c.tag)).not.toContain("ui-mission-card");
    expect(preview.own).toEqual(["ui-mission-card"]);
  });

  it("takes the ticked components and remembers the others, opening no thread and keeping the pages", async () => {
    const { projectId, page, from, to } = await scenario();
    const res = await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id, ticked: ["ui-button", "ui-modal"] });
    expect(res.ok).toBe(true);
    const detail = (await res.json()) as ProjectDesignSystem;
    expect(detail.designSystem!.id).toBe(to.id);
    // Absent components cannot be ticked: ui-modal stays left out.
    expect(detail.excluded.map((e) => [e.tag, e.from, e.available])).toEqual([
      ["ui-card", "Réseaux sociaux", true],
      ["ui-tabs", "Réseaux sociaux", true],
      ["ui-modal", "Réseaux sociaux", false],
    ]);
    const threads = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(threads).toEqual([]);
    expect(from.id).not.toBe(to.id);
  });

  it("pre-ticks the same-named, same-settings components when the request gives no choice", async () => {
    const { projectId, to } = await scenario();
    const detail = (await (await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id })).json()) as ProjectDesignSystem;
    expect(detail.excluded.map((e) => e.tag)).toEqual(["ui-card", "ui-tabs", "ui-modal"]);
  });

  it("renders unticked and absent tags broken and reports them, even when the new design system has the name", async () => {
    const { projectId, page, to } = await scenario();
    await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id, ticked: ["ui-button"] });
    const window = await openReporting(`/pages/${page.id}/a.html`);
    const document = window.window.document;
    // ticked: rendered from the new design system
    expect(document.querySelector("ui-button .ui-button, ui-button .button")).not.toBeNull();
    // unticked, named in the new design system: broken all the same
    expect(document.querySelector("ui-card .card")).toBeNull();
    expect(document.querySelector("ui-card [data-redline-missing]")!.textContent).toContain("ui-card non repris de Réseaux sociaux");
    expect(document.querySelector("ui-modal [data-redline-missing]")!.textContent).toContain("ui-modal non repris de Réseaux sociaux");
    expect(window.errors().sort()).toEqual(["ui-card non repris de Réseaux sociaux", "ui-modal non repris de Réseaux sociaux", "ui-tabs non repris de Réseaux sociaux"]);
  });

  it("clears the broken state when the user takes the component from the project's Design system page", async () => {
    const { projectId, page, to } = await scenario();
    await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id, ticked: ["ui-button"] });
    const taken = await server.post(`/api/projects/${projectId}/design-system/components/card/take`, {});
    expect(taken.ok).toBe(true);
    expect(((await taken.json()) as ProjectDesignSystem).excluded.map((e) => e.tag)).toEqual(["ui-tabs", "ui-modal"]);
    const window = await openReporting(`/pages/${page.id}/a.html`);
    expect(window.window.document.querySelector("ui-card .card")).not.toBeNull();
    expect(window.errors().sort()).toEqual(["ui-modal non repris de Réseaux sociaux", "ui-tabs non repris de Réseaux sociaux"]);
  });

  it("refuses to take a component the design system does not have", async () => {
    const { projectId, to } = await scenario();
    await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id, ticked: [] });
    expect((await server.post(`/api/projects/${projectId}/design-system/components/modal/take`, {})).status).toBe(400);
  });

  it("forgets what was left out when the project stops following a design system", async () => {
    const { projectId, to } = await scenario();
    await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id, ticked: [] });
    const detail = (await (await put(`/api/projects/${projectId}/design-system`, { designSystem: null })).json()) as ProjectDesignSystem;
    expect(detail.excluded).toEqual([]);
  });

  it("flags a project component that the design system has a component of the same name for", async () => {
    const { projectId, page, to } = await scenario();
    await server.post(`/api/pages/${page.id}/versions`, {
      files: {
        "manifest.json": JSON.stringify({ designSystem: (await detailOf(projectId)).designSystem!.id, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }, { file: "components/grid.html", x: 300, y: 0, width: 200, height: 100 }] }),
        "a.html": mockup("<ui-grid>x</ui-grid>"),
        "components/grid.html": componentFile("grid"),
      },
      message: "Own grid",
      origin: "user",
    });
    const before = await detailOf(projectId);
    expect(before.components.map((c) => [c.name, c.inDesignSystem])).toEqual([["grid", false]]);
    const after = (await (await put(`/api/projects/${projectId}/design-system`, { designSystem: to.id })).json()) as ProjectDesignSystem;
    expect(after.components.map((c) => [c.name, c.inDesignSystem])).toEqual([["grid", true]]);
    // The project's component is untouched and still wins in its pages.
    expect(after.components[0].file).toBe("components/grid.html");
  });

  async function openReporting(path: string) {
    let reported: string[] = [];
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}${path}`, {
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.type === "redline:errors") reported = event.data.errors;
        });
      },
    });
    windows.push(dom.window);
    await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { window: dom.window, errors: () => reported };
  }
});
