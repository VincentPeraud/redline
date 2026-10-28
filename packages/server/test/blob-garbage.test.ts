import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_MD_PATH } from "@redline/shared";
import { Store } from "../src/store.js";

describe("collecting the blobs nothing refers to any more", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-blobs-"));
    store = new Store(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const blobs = () => new Set(readdirSync(join(dir, "blobs")));

  it("removes a deleted project's own blobs and keeps every blob another project, page version or design system still uses", () => {
    const shared = "<h1>Same in both</h1>";
    const logo = Buffer.from("<svg>logo</svg>");
    const ds = store.createDesignSystem("Brand", { "tokens.css": ":root { --color-primary: #d92d20; }", "index.html": "<h1>Brand</h1>" });
    store.createDiffusion(ds.id, "user");

    const kept = store.createProject("Kept", undefined, "", ds.id);
    const keptPage = store.createPage(kept.id, "Home", { "home.html": shared, "about.html": "<h1>About v1</h1>" });
    store.addVersion(keptPage.id, { "home.html": shared, "about.html": "<h1>About v2</h1>" }, "edit", "terminal");
    store.setProjectFile(kept.id, "assets/logo.svg", logo);
    store.saveDesignMd(kept.id, DESIGN_MD_PATH, Buffer.from("# Kept rules"));

    const gone = store.createProject("Gone");
    store.createPage(gone.id, "Home", { "home.html": shared, "only.html": "<h1>Only in Gone</h1>" });
    store.setProjectFile(gone.id, "assets/logo.svg", logo);
    store.setProjectFile(gone.id, "assets/photo.jpg", Buffer.from("photo of Gone"));

    const before = blobs();
    store.deleteProject(gone.id);
    const removed = store.collectGarbage(0);
    const after = blobs();

    expect(removed).toBe(2); // only.html and photo.jpg: home.html and the logo are shared with Kept
    expect(after.size).toBe(before.size - removed);
    const keptVersion = store.listVersions(keptPage.id).at(-1)!;
    expect(store.readVersionFiles(keptPage.id, keptVersion.id)).toMatchObject({ "about.html": "<h1>About v1</h1>", "home.html": shared });
    expect(store.readPageFiles(keptPage.id)!.files).toMatchObject({ "home.html": shared, "about.html": "<h1>About v2</h1>" });
    expect(store.readProjectFile(kept.id, "assets/logo.svg")?.toString()).toBe("<svg>logo</svg>");
    expect(store.readProjectText(kept.id, DESIGN_MD_PATH)).toBe("# Kept rules");
    expect(store.readDiffusionFile(ds.id, 1, "tokens.css")).toContain("--color-primary");
    expect(store.readDiffusionFile(ds.id, 1, "components.json")).toBeDefined();
    for (const page of store.listPages(ds.id)) expect(store.readPageFiles(page.id)!.files["index.html"]).toBe("<h1>Brand</h1>");
  });

  it("leaves blobs younger than the given age, which a request may be about to refer to", () => {
    const project = store.createProject("Gone");
    store.createPage(project.id, "Home", { "home.html": "<h1>Fresh</h1>" });
    store.deleteProject(project.id);
    expect(store.collectGarbage(60_000)).toBe(0);
  });
});
