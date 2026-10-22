import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, starterPageFiles } from "@redline/shared";

describe("starter page files", () => {
  it("gives a prototype one artboard and a manifest naming title and type", () => {
    const files = starterPageFiles("Checkout", "prototype");
    const manifest = parseManifest(files[MANIFEST_PATH]);
    expect(manifest).toMatchObject({ title: "Checkout", type: "prototype" });
    expect(manifest.artboards.map((a) => a.file)).toEqual(["screen-1.html"]);
    expect(files["screen-1.html"]).toContain("Checkout");
  });

  it("gives a comparison two variants side by side", () => {
    const files = starterPageFiles("Hero", "comparison");
    const manifest = parseManifest(files[MANIFEST_PATH]);
    expect(manifest.type).toBe("comparison");
    expect(manifest.artboards.map((a) => a.file)).toEqual(["variant-a.html", "variant-b.html"]);
    expect(Object.keys(files).sort()).toEqual([MANIFEST_PATH, "variant-a.html", "variant-b.html"].sort());
  });

  it("escapes the title in the HTML", () => {
    expect(starterPageFiles("<b>&", "prototype")["screen-1.html"]).toContain("&lt;b&gt;&amp;");
  });
});
