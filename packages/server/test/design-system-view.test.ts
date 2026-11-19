import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS } from "@redline/shared";
import { designSystemInState, designSystemSeenBy } from "../src/design-system-view.js";
import { Store } from "../src/store.js";

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body><template data-component><div><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("what a project sees of its design system", () => {
  let dataDir: string;
  let store: Store;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-view-"));
    store = new Store(dataDir);
  });
  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function designSystemWithPendingChange() {
    const ds = store.createDesignSystem("Acme", {
      "tokens.css": tokensCss("#111111"),
      "manifest.json": manifestOf(["components/button.html"]),
      "components/button.html": component(".btn{color:red}"),
    });
    const page = store.listPages(ds.id)[0];
    store.addVersion(page.id, { ...store.readPageFiles(page.id)!.files, "manifest.json": manifestOf(["components/button.html", "components/card.html"]), "components/card.html": component(".card{color:blue}") }, "Add card", "user");
    return ds;
  }

  it("is the current diffusion for a project, whatever the draft holds", () => {
    const ds = designSystemWithPendingChange();
    const project = store.createProject("App", undefined, "", ds.id);

    const view = designSystemSeenBy(store, project.id)!;
    expect(view.state).toEqual({ kind: "diffusion", number: 1 });
    expect(view.components().map((c) => c.name)).toEqual(["button"]);
    expect(view.definitions().map((d) => d.name)).toEqual(["button"]);
    expect(Object.keys(view.componentFiles())).toEqual(["components/button.html"]);
    expect(view.tokensCss()).toContain("--color-primary: #111111");
    expect(view.componentsCss()).toContain(".btn");
    expect(view.componentsCss()).not.toContain(".card");
  });

  it("has nothing to answer for a project without a shared design system", () => {
    expect(designSystemSeenBy(store, store.createProject("Alone").id)).toBeUndefined();
  });

  it("can answer the draft after a diffusion with the same reads", () => {
    const ds = designSystemWithPendingChange();

    const view = designSystemInState(store, ds.id, { kind: "draft", afterDiffusion: 1 });
    expect(view.state).toEqual({ kind: "draft", afterDiffusion: 1 });
    expect(view.components().map((c) => c.name).sort()).toEqual(["button", "card"]);
    expect(view.definitions().map((d) => d.name).sort()).toEqual(["button", "card"]);
    expect(Object.keys(view.componentFiles()).sort()).toEqual(["components/button.html", "components/card.html"]);
    expect(view.componentsCss()).toContain(".card");
    expect(Object.keys(view.pageIndexes())).toEqual([store.listPages(ds.id)[0].id]);
  });
});
