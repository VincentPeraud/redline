import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const modalFile = (template: string) =>
  `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body>` +
  `<template data-component>${template}</template></body></html>`;
const MODAL = modalFile(`<div class="modal"><h2><slot name="title"></slot></h2><div class="body"><slot></slot></div></div>`);

const SIZE_TWEAK = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };
const CLOSABLE_TWEAK = { id: "closable", type: "toggle", label: "Closable", default: false, artboard: "components/modal.html" };

const manifestOf = (files: string[], tweaks: object[] = [], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks });
const modalManifest = (tweaks: object[] = [SIZE_TWEAK]) => manifestOf(["components/modal.html"], tweaks);

const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("instances displayed from their component's definition", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  const createDesignSystem = async (files: Record<string, string>) => (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, ...files } })).json()) as DesignSystem;
  const createProject = async () => ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
  const addPage = async (projectId: string, title: string, files: Record<string, string>) => (await (await server.post(`/api/projects/${projectId}/pages`, { title, files })).json()) as Page;
  const publishOnDesignSystem = (ds: DesignSystem, files: Record<string, string>) => server.post(`/api/pages/${ds.pageId}/versions`, { files, message: "Edit", origin: "thread" });

  /** Loads a served artboard in jsdom like a browser would, scripts included, and resolves once it has loaded. */
  async function open(path: string) {
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}${path}`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    windows.push(dom.window);
    await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
    return dom.window;
  }

  const designSystemWithModal = (modal = MODAL, tweaks: object[] = [SIZE_TWEAK]) => createDesignSystem({ "manifest.json": modalManifest(tweaks), "components/modal.html": modal });

  const followingProject = async (ds: DesignSystem, body: string) => {
    const project = await createProject();
    const page = await addPage(project, "Flow", { "manifest.json": manifestOf(["a.html"], [], ds.id), "a.html": mockup(body) });
    return { project, page };
  };

  it("renders the component's template with the authored children in the default and named slots", async () => {
    const ds = await designSystemWithModal();
    const { page } = await followingProject(ds, `<ui-modal size="sm"><span slot="title">Delete?</span><p>Really</p></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    const modal = window.document.querySelector("ui-modal")!;
    expect(modal.querySelector(".modal h2")!.innerHTML).toBe(`<span slot="title">Delete?</span>`);
    expect(modal.querySelector(".modal .body")!.innerHTML).toBe("<p>Really</p>");
    expect(modal.querySelector("slot")).toBeNull();
  });

  it("applies the default of a setting left out, and keeps a toggle as a boolean attribute", async () => {
    const ds = await designSystemWithModal(MODAL, [SIZE_TWEAK, CLOSABLE_TWEAK]);
    const { page } = await followingProject(ds, `<ui-modal id="a"><p>x</p></ui-modal><ui-modal id="b" size="sm" closable><p>y</p></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    const [a, b] = [window.document.getElementById("a")!, window.document.getElementById("b")!];
    expect(a.getAttribute("size")).toBe("md");
    expect(a.hasAttribute("closable")).toBe(false);
    expect(b.getAttribute("size")).toBe("sm");
    expect(b.hasAttribute("closable")).toBe(true);
  });

  it("renders again when an attribute of the instance changes, without losing its content", async () => {
    const ds = await designSystemWithModal(modalFile(`<div class="modal"><slot></slot></div>`));
    const { page } = await followingProject(ds, `<ui-modal size="sm"><p>Body</p></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    const modal = window.document.querySelector("ui-modal")!;
    const body = modal.querySelector("p");
    modal.setAttribute("size", "md");
    expect(modal.querySelectorAll(".modal")).toHaveLength(1);
    expect(modal.querySelector(".modal p")).toBe(body);
  });

  it("keeps the template's fallback content in a slot the instance leaves empty", async () => {
    const ds = await designSystemWithModal(modalFile(`<div class="modal"><slot name="title">Untitled</slot><slot></slot></div>`));
    const { page } = await followingProject(ds, `<ui-modal><p>Body</p></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelector("ui-modal .modal")!.textContent).toBe("UntitledBody");
  });

  it("shows a project page the current diffusion, until the next diffusion", async () => {
    const ds = await designSystemWithModal();
    const { page } = await followingProject(ds, `<ui-modal><p>Body</p></ui-modal>`);
    await publishOnDesignSystem(ds, { "manifest.json": modalManifest(), "components/modal.html": modalFile(`<div class="modal v2"><slot></slot><footer>Footer</footer></div>`) });

    let window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelector("ui-modal .v2")).toBeNull();
    expect(window.document.querySelector("ui-modal .modal")).not.toBeNull();

    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelector("ui-modal .v2 footer")!.textContent).toBe("Footer");
  });

  it("shows the definitions of the diffusion a rollback goes back to", async () => {
    const ds = await designSystemWithModal();
    const { page } = await followingProject(ds, `<ui-modal><p>Body</p></ui-modal>`);
    await publishOnDesignSystem(ds, { "manifest.json": modalManifest(), "components/modal.html": modalFile(`<div class="modal v2"><slot></slot></div>`) });
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    expect((await open(`/pages/${page.id}/a.html`)).document.querySelector("ui-modal .v2")).not.toBeNull();

    await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {});
    expect((await open(`/pages/${page.id}/a.html`)).document.querySelector("ui-modal .v2")).toBeNull();
    expect((await open(`/pages/${page.id}/a.html`)).document.querySelector("ui-modal .modal")).not.toBeNull();
  });

  it("renders an instance placed inside another instance's slot once, with its own content", async () => {
    const ds = await createDesignSystem({
      "manifest.json": manifestOf(["components/modal.html", "components/button.html"]),
      "components/modal.html": MODAL,
      "components/button.html": `<!doctype html><html><body><template data-component><button class="btn"><slot></slot></button></template></body></html>`,
    });
    const { page } = await followingProject(ds, `<ui-modal><ui-button>Yes</ui-button></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelectorAll("ui-modal .body ui-button .btn")).toHaveLength(1);
    expect(window.document.querySelector("ui-modal .body ui-button .btn")!.textContent).toBe("Yes");
  });

  const componentFile = (template: string) => `<!doctype html><html><body><template data-component>${template}</template></body></html>`;
  const BUTTON = componentFile(`<button class="btn"><slot></slot></button>`);

  it("renders a nested instance in a template with its own settings and slots", async () => {
    const ds = await createDesignSystem({
      "manifest.json": manifestOf(["components/modal.html", "components/button.html"], [{ id: "tone", type: "choice", label: "Tone", options: ["plain", "danger"], default: "plain", artboard: "components/button.html" }]),
      "components/modal.html": modalFile(`<div class="modal"><div class="body"><slot></slot></div><footer><ui-button tone="danger">Delete</ui-button><ui-button>Cancel</ui-button></footer></div>`),
      "components/button.html": BUTTON,
    });
    const { page } = await followingProject(ds, `<ui-modal><p>Really</p></ui-modal>`);
    const window = await open(`/pages/${page.id}/a.html`);
    const buttons = [...window.document.querySelectorAll("ui-modal footer ui-button")];
    expect(buttons.map((b) => b.querySelector(".btn")!.textContent)).toEqual(["Delete", "Cancel"]);
    expect(buttons.map((b) => b.getAttribute("tone"))).toEqual(["danger", "plain"]);
    expect(window.document.querySelector("ui-modal .body")!.innerHTML).toBe("<p>Really</p>");
  });

  it("resolves tags of a design system template to the design system, and tags of the project's pages to the project", async () => {
    // The project's component is older than the design system's of the same name (a clash created by the design system is tolerated).
    const modalWithButton = modalFile(`<div class="modal"><ui-button>Ok</ui-button></div>`);
    const ds = await createDesignSystem({ "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": modalWithButton });
    const project = await createProject();
    await addPage(project, "Components", { "manifest.json": manifestOf(["components/button.html"], [], ds.id), "components/button.html": componentFile(`<a class="own-btn"><slot></slot></a>`) });
    await publishOnDesignSystem(ds, { "manifest.json": manifestOf(["components/modal.html", "components/button.html"]), "components/modal.html": modalWithButton, "components/button.html": BUTTON });
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    const page = await addPage(project, "Flow", { "manifest.json": manifestOf(["a.html"], [], ds.id), "a.html": mockup(`<ui-modal></ui-modal><ui-button id="own">Go</ui-button>`) });
    const window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelector("ui-modal .btn")!.textContent).toBe("Ok");
    expect(window.document.querySelector("ui-modal .own-btn")).toBeNull();
    expect(window.document.querySelector("#own .own-btn")!.textContent).toBe("Go");
  });

  it("stops a runaway nesting at the depth limit instead of looping", async () => {
    // Design system creation does not run the publish check, so a self-containing component can exist here.
    const ds = await createDesignSystem({
      "manifest.json": manifestOf(["components/loop.html"]),
      "components/loop.html": componentFile(`<div class="loop"><ui-loop></ui-loop></div>`),
    });
    const { page } = await followingProject(ds, `<ui-loop></ui-loop>`);
    const window = await open(`/pages/${page.id}/a.html`);
    const depth = window.document.querySelectorAll("ui-loop").length;
    expect(depth).toBeGreaterThan(1);
    expect(depth).toBeLessThanOrEqual(12);
  });

  it("shows the draft on a design system page and on the preview of a pending diffusion", async () => {
    const ds = await designSystemWithModal();
    const dsPage = await addPage(ds.id, "Mock", { "manifest.json": manifestOf(["demo.html"]), "demo.html": mockup(`<ui-modal><p>Body</p></ui-modal>`) });
    const { page } = await followingProject(ds, `<ui-modal><p>Body</p></ui-modal>`);
    await publishOnDesignSystem(ds, { "manifest.json": modalManifest(), "components/modal.html": modalFile(`<div class="modal v2"><slot></slot></div>`) });

    expect((await open(`/pages/${dsPage.id}/demo.html`)).document.querySelector("ui-modal .v2")).not.toBeNull();
    expect((await open(`/pages/${page.id}/a.html`)).document.querySelector("ui-modal .v2")).toBeNull();
    expect((await open(`/pages/${page.id}/a.html?preview=draft`)).document.querySelector("ui-modal .v2")).not.toBeNull();
  });

  it("serves a project's own components to its pages", async () => {
    const project = await createProject();
    await addPage(project, "Components", {
      "manifest.json": manifestOf(["components/sticker.html"]),
      "components/sticker.html": `<!doctype html><html><body><template data-component><em class="sticker"><slot></slot></em></template></body></html>`,
    });
    const page = await addPage(project, "Flow", { "manifest.json": manifestOf(["a.html"]), "a.html": mockup(`<ui-sticker>Hi</ui-sticker>`) });
    const window = await open(`/pages/${page.id}/a.html`);
    expect(window.document.querySelector("ui-sticker .sticker")!.textContent).toBe("Hi");
  });

  it("leaves the stored page file with the instance tags only", async () => {
    const ds = await designSystemWithModal();
    const body = `<ui-modal size="sm"><p>Body</p></ui-modal>`;
    const { page } = await followingProject(ds, body);
    await open(`/pages/${page.id}/a.html`);
    const stored = await (await server.get(`/api/pages/${page.id}/files/a.html`)).text();
    expect(stored).toBe(mockup(body));
  });
  describe("broken instances", () => {
    /** Opens an artboard and returns what its errors catcher reported to the parent (the "Erreurs des artboards" list). */
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

    /** Publishing refuses a broken instance, so a page breaks only when a later diffusion changes the component under it. */
    async function brokenByDiffusion(body: string, designSystemFiles: Record<string, string>, tweaks: object[] = [SIZE_TWEAK]) {
      const ds = await designSystemWithModal(MODAL, tweaks);
      const project = await followingProject(ds, body);
      expect((await publishOnDesignSystem(ds, designSystemFiles)).ok).toBe(true);
      expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).ok).toBe(true);
      return project;
    }

    it("renders an unknown setting value with the default and reports it", async () => {
      const { page } = await brokenByDiffusion(`<ui-modal size="xl"><p>Body</p></ui-modal>`, { "manifest.json": modalManifest(), "components/modal.html": MODAL.replace(`class="modal"`, `class="modal v2"`) }, [{ ...SIZE_TWEAK, options: ["sm", "md", "xl"] }]);
      const { window, errors } = await openReporting(`/pages/${page.id}/a.html`);
      const modal = window.document.querySelector("ui-modal")!;
      expect(modal.getAttribute("size")).toBe("md");
      expect(modal.querySelector(".body")!.textContent).toBe("Body");
      expect(errors()).toEqual(["ui-modal : la valeur xl du r\u00e9glage size n'existe plus, affich\u00e9e en md"]);
    });

    it("drops the content of a slot the component no longer has and reports it", async () => {
      const withFooter = modalFile(`<div class="modal"><h2><slot name="title"></slot></h2><div class="body"><slot></slot></div><footer><slot name="footer"></slot></footer></div>`);
      const ds = await designSystemWithModal(withFooter);
      const { page } = await followingProject(ds, `<ui-modal><span slot="footer">Bye</span><p>Body</p></ui-modal>`);
      expect((await publishOnDesignSystem(ds, { "manifest.json": modalManifest(), "components/modal.html": MODAL })).ok).toBe(true);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      const { window, errors } = await openReporting(`/pages/${page.id}/a.html`);
      const modal = window.document.querySelector("ui-modal")!;
      expect(modal.textContent).toBe("Body");
      expect(errors()).toEqual(["ui-modal : l'emplacement footer n'existe plus"]);
    });

    it("shows a placeholder for an unknown tag and reports it", async () => {
      const ghost = modalFile(`<div class="ghost"><slot></slot></div>`).replace("ui-modal", "ui-ghost");
      const ds = await createDesignSystem({ "manifest.json": manifestOf(["components/modal.html", "components/ghost.html"], [SIZE_TWEAK]), "components/modal.html": MODAL, "components/ghost.html": ghost });
      const { page } = await followingProject(ds, `<ui-ghost><p>Body</p></ui-ghost>`);
      expect((await publishOnDesignSystem(ds, { "manifest.json": modalManifest(), "components/modal.html": MODAL })).ok).toBe(true);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      const { window, errors } = await openReporting(`/pages/${page.id}/a.html`);
      const placeholder = window.document.querySelector("ui-ghost [data-redline-missing]")!;
      expect(placeholder.textContent).toContain("ui-ghost");
      expect(errors()).toEqual(["ui-ghost : composant introuvable"]);
    });

    it("reports nothing for a healthy instance", async () => {
      const ds = await designSystemWithModal();
      const { page } = await followingProject(ds, `<ui-modal size="sm"><span slot="title">T</span><p>Body</p></ui-modal>`);
      const { errors } = await openReporting(`/pages/${page.id}/a.html`);
      expect(errors()).toEqual([]);
    });
  });
});

describe("interactive instances", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  const OPEN_TWEAK = { id: "open", type: "toggle", label: "Open", default: false, artboard: "components/modal.html" };
  const SCRIPT = `
    function sync() {
      var panel = host.querySelector(".panel");
      panel.hidden = !host.hasAttribute("open");
      host.dispatchEvent(new CustomEvent("modal-state", { bubbles: true, detail: { open: host.hasAttribute("open") } }));
    }
    new MutationObserver(sync).observe(host, { attributes: true, attributeFilter: ["open"] });
    host.querySelector(".close").addEventListener("click", function () { host.removeAttribute("open"); });
    sync();`;
  const modalWithScript = `<!doctype html><html><head></head><body><template data-component><div class="panel"><slot></slot><button class="close">x</button></div></template><script data-component>${SCRIPT}</script></body></html>`;

  async function pageWith(body: string, component = modalWithScript) {
    const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": modalManifest([OPEN_TWEAK]), "components/modal.html": component } })).json()) as DesignSystem;
    const project = ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
    const page = (await (await server.post(`/api/projects/${project}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], [], ds.id), "a.html": mockup(body) } })).json()) as Page;
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}/pages/${page.id}/a.html`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    windows.push(dom.window);
    await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
    const window = dom.window;
    const click = (id: string | Element) => (typeof id === "string" ? window.document.getElementById(id)! : id).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { window, click, settle };
  }

  const page = `<button id="o" opens="m"><span id="inner">Open</span></button><button id="c" closes="m">Close</button><button id="t" toggles="m">Toggle</button><ui-modal id="m"><p>Hi</p></ui-modal>`;

  it("lets a component's script react to its open attribute and close itself", async () => {
    const { window, click, settle } = await pageWith(page);
    const modal = window.document.getElementById("m")!;
    const panel = modal.querySelector<HTMLElement>(".panel")!;
    expect(panel.hidden).toBe(true);
    modal.setAttribute("open", "");
    await settle();
    expect(panel.hidden).toBe(false);
    click(modal.querySelector(".close")!);
    await settle();
    expect(modal.hasAttribute("open")).toBe(false);
    expect(panel.hidden).toBe(true);
  });

  it("opens, closes and toggles an instance from any element pointing at its id", async () => {
    const { window, click } = await pageWith(page);
    const modal = window.document.getElementById("m")!;
    click("inner");
    expect(modal.hasAttribute("open")).toBe(true);
    click("c");
    expect(modal.hasAttribute("open")).toBe(false);
    click("t");
    expect(modal.hasAttribute("open")).toBe(true);
    click("t");
    expect(modal.hasAttribute("open")).toBe(false);
  });

  it("ignores wiring that points at no element", async () => {
    const { window, click } = await pageWith(`<button id="o" opens="nope">Open</button><ui-modal id="m"></ui-modal>`);
    click("o");
    expect(window.document.getElementById("m")!.hasAttribute("open")).toBe(false);
  });

  it("lets a page script set an instance attribute and listen to the event the component dispatches", async () => {
    const { window, settle } = await pageWith(`<ui-modal id="m"><p>Hi</p></ui-modal><script>var states = []; document.addEventListener("modal-state", function (e) { states.push(e.detail.open); }); window.addEventListener("load", function () { document.getElementById("m").setAttribute("open", ""); });</script>`);
    await settle();
    expect((window as unknown as { states: boolean[] }).states).toEqual([false, true]);
  });

  it("wires clicks in play mode, where only links are reported", async () => {
    const { window, click } = await pageWith(page);
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "redline:set-links", selectors: ["#o"] }, source: window }));
    click("t");
    expect(window.document.getElementById("m")!.hasAttribute("open")).toBe(true);
  });

  it("runs component scripts in the artboard sandbox only", async () => {
    const response = await fetch(`${server.artboardOrigin}/__redline/instances.js`);
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    const { window } = await pageWith(`<ui-modal id="m"></ui-modal>`);
    expect(window.location.origin).toBe(server.artboardOrigin);
    expect(window.location.origin).not.toBe(server.origin);
  });
});
