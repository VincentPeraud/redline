import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, starterPageFiles } from "@redline/shared";

describe("starter page files", () => {
  it("gives a page ONE artboard and a manifest naming the title", () => {
    const files = starterPageFiles("Checkout");
    const manifest = parseManifest(files[MANIFEST_PATH]);
    expect(manifest.title).toBe("Checkout");
    expect(manifest.artboards.map((a) => a.file)).toEqual(["artboard-1.html"]);
    expect(Object.keys(files).sort()).toEqual(["artboard-1.html", MANIFEST_PATH]);
    expect(files["artboard-1.html"]).toContain("Checkout");
  });

  it("names the project's design system in the manifest", () => {
    const files = starterPageFiles("Home", "acme");
    expect(parseManifest(files[MANIFEST_PATH]).designSystem).toBe("acme");
  });

  it("escapes the title in the HTML", () => {
    expect(starterPageFiles("<b>&")["artboard-1.html"]).toContain("&lt;b&gt;&amp;");
  });

  it("still parses an old manifest that carries a page type, and ignores it", () => {
    const manifest = parseManifest(JSON.stringify({ title: "Old", type: "comparison", artboards: [{ file: "a.html" }] }));
    expect(manifest).not.toHaveProperty("type");
    expect(manifest.artboards).toHaveLength(1);
  });
});
