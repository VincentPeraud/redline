import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, starterPageFiles } from "@redline/shared";

describe("starter page files", () => {
  it("gives a page a manifest naming the title and no artboard", () => {
    const files = starterPageFiles("Checkout");
    const manifest = parseManifest(files[MANIFEST_PATH]);
    expect(manifest.title).toBe("Checkout");
    expect(manifest.artboards).toEqual([]);
    expect(Object.keys(files)).toEqual([MANIFEST_PATH]);
  });

  it("names the project's design system in the manifest", () => {
    const files = starterPageFiles("Home", "acme");
    expect(parseManifest(files[MANIFEST_PATH]).designSystem).toBe("acme");
  });

  it("still parses an old manifest that carries a page type, and ignores it", () => {
    const manifest = parseManifest(JSON.stringify({ title: "Old", type: "comparison", artboards: [{ file: "a.html" }] }));
    expect(manifest).not.toHaveProperty("type");
    expect(manifest.artboards).toHaveLength(1);
  });
});
