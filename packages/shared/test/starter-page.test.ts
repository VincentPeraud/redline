import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, starterPageFiles } from "@redline/shared";

describe("starter page files", () => {
  it("gives a page a manifest with no artboard and no title (the page title is not in the manifest)", () => {
    const files = starterPageFiles();
    const manifest = parseManifest(files[MANIFEST_PATH]);
    expect(manifest).not.toHaveProperty("title");
    expect(manifest.artboards).toEqual([]);
    expect(Object.keys(files)).toEqual([MANIFEST_PATH]);
  });

  it("names the project's design system in the manifest", () => {
    const files = starterPageFiles("acme");
    expect(parseManifest(files[MANIFEST_PATH]).designSystem).toBe("acme");
  });

  it("still parses an old manifest that carries a page type, and ignores it", () => {
    const manifest = parseManifest(JSON.stringify({ title: "Old", type: "comparison", artboards: [{ file: "a.html" }] }));
    expect(manifest).not.toHaveProperty("type");
    expect(manifest.artboards).toHaveLength(1);
  });
});
