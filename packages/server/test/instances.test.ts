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
});
