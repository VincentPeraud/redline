import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS } from "@redline/shared";
import { brokenPagesOnFollowChange } from "../src/broken-pages.js";
import { Store } from "../src/store.js";

const tokensCss = (extra: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const BADGE = componentFile(`<span><slot></slot></span>`);
const MODAL = componentFile(`<div><h2><slot name="title"></slot></h2><slot></slot></div>`);
const MODAL_NO_TITLE = componentFile(`<div><slot></slot></div>`);
const sizeTweak = (options: string[]) => ({ id: "size", type: "choice", label: "Size", options, default: options[0], artboard: "components/modal.html" });
const manifestOf = (files: string[], tweaks: object[] = [], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: file.replace(".html", "").toUpperCase(), x: i * 300, y: 0, width: 200, height: 100 })), tweaks });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("the pages a switch between the diffusion and the draft breaks", () => {
  let dataDir: string;
  let store: Store;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-broken-"));
    store = new Store(dataDir);
  });
  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Diffusion 1 has ui-badge, ui-modal (size sm/lg, title slot) and --accent-soft; `edit` turns the draft into something else. */
  function setup(draft: { tokens?: string; files?: Record<string, string>; manifest?: string }) {
    const ds = store.createDesignSystem("Acme", {
      "tokens.css": tokensCss("  --accent-soft: #eee;\n  --keep: #111;\n"),
      "manifest.json": manifestOf(["components/badge.html", "components/modal.html"], [sizeTweak(["sm", "lg"])]),
      "components/badge.html": BADGE,
      "components/modal.html": MODAL,
    });
    const page = store.listPages(ds.id)[0];
    store.addVersion(page.id, { ...store.readPageFiles(page.id)!.files, ...(draft.tokens && { "tokens.css": draft.tokens }), ...(draft.manifest && { "manifest.json": draft.manifest }), ...draft.files }, "Draft", "user");
    const project = store.createProject("App", undefined, "", ds.id);
    return { ds, project };
  }
  const pageWith = (projectId: string, title: string, body: string) =>
    store.createPage(projectId, title, { "manifest.json": manifestOf(["a.html", "b.html"]), "a.html": mockup(body), "b.html": mockup("<p>nothing</p>") });

  it("lists nothing when the draft removes nothing a page uses", () => {
    const { project } = setup({ tokens: tokensCss("  --accent-soft: #eee;\n  --keep: #111;\n  --extra: #222;\n") });
    pageWith(project.id, "Login", `<ui-badge>x</ui-badge><div style="color:var(--accent-soft)"></div>`);
    expect(brokenPagesOnFollowChange(store, project.id, true)).toEqual([]);
  });

  it("lists, per page and artboard, a removed component, setting, value and slot as blocking and a missing token as not blocking", () => {
    const { project } = setup({
      tokens: tokensCss("  --keep: #111;\n"),
      manifest: manifestOf(["components/modal.html"], [sizeTweak(["sm"])]),
      files: { "components/badge.html": "" },
    });
    const login = pageWith(project.id, "Login", `<ui-badge>a</ui-badge><ui-badge>b</ui-badge><ui-modal size="lg"><span slot="title">T</span></ui-modal><i style="color:var(--accent-soft)"></i>`);
    pageWith(project.id, "Other", `<p style="color:var(--keep)">fine</p>`);
    const broken = brokenPagesOnFollowChange(store, project.id, true);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ pageId: login.id, title: "Login", artboard: "a.html" });
    const byName = Object.fromEntries(broken[0].elements.map((e) => [`${e.kind}:${e.name}`, e]));
    expect(byName["component:ui-badge"]).toMatchObject({ blocksPublishing: true, places: [{ artboard: "A", instances: 2 }] });
    expect(byName["value:ui-modal"]).toMatchObject({ setting: "size", value: "lg", blocksPublishing: true });
    expect(byName["token:--accent-soft"]).toMatchObject({ blocksPublishing: false, places: [{ artboard: "A" }] });
    expect(broken[0].elements).toHaveLength(3);
  });

  it("names the token a missing one was renamed to, when the draft has one new token of the same value", () => {
    const { project } = setup({ tokens: tokensCss("  --accent-subtle: #eee;\n  --keep: #111;\n") });
    pageWith(project.id, "Login", `<i style="color:var(--accent-soft)"></i>`);
    expect(brokenPagesOnFollowChange(store, project.id, true)[0].elements).toMatchObject([{ kind: "token", name: "--accent-soft", renamedTo: "--accent-subtle" }]);
  });

  it("does not count a token the project style defines itself, nor a component the project defines", () => {
    const { project } = setup({ tokens: tokensCss("  --keep: #111;\n"), files: { "components/badge.html": "" }, manifest: manifestOf(["components/modal.html"], [sizeTweak(["sm", "lg"])]) });
    store.saveDesignMd(project.id, "tokens.css", Buffer.from(":root { --accent-soft: #fff; }\n"));
    store.createPage(project.id, "Own", {
      "manifest.json": manifestOf(["components/badge.html", "a.html"]),
      "components/badge.html": BADGE,
      "a.html": mockup(`<ui-badge>x</ui-badge><i style="color:var(--accent-soft)"></i>`),
    });
    expect(brokenPagesOnFollowChange(store, project.id, true)).toEqual([]);
  });

  it("goes the other way: what the draft has and the diffusion lacks, used by a page of a project on the draft", () => {
    const { project } = setup({
      tokens: tokensCss("  --accent-soft: #eee;\n  --keep: #111;\n  --brand: #123;\n"),
      manifest: manifestOf(["components/badge.html", "components/modal.html", "components/card.html"], [sizeTweak(["sm", "lg", "xl"])]),
      files: { "components/card.html": componentFile(`<section><slot></slot></section>`), "components/modal.html": MODAL },
    });
    store.setProjectFollowsDraft(project.id, true);
    pageWith(project.id, "Home", `<ui-card>c</ui-card><ui-modal size="xl"></ui-modal><i style="color:var(--brand)"></i>`);
    const broken = brokenPagesOnFollowChange(store, project.id, false);
    expect(broken.map((p) => p.title)).toEqual(["Home"]);
    expect(broken[0].elements.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(["component:ui-card", "token:--brand", "value:ui-modal"]);
  });
});
