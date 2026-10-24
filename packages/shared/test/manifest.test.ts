import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, defaultManifest, parseManifest } from "@redline/shared";

describe("page manifest", () => {
  it("reads title, type, design system, artboards, notes, links and tweaks", () => {
    const manifest = parseManifest(
      JSON.stringify({
        title: "Checkout",
        designSystem: "acme",
        artboards: [{ file: "cart.html", title: "Cart", width: 390, height: 844, x: 100, y: 40 }],
        elements: [{ kind: "title", text: "Happy path", subtitle: "Three screens", width: 900, x: 100, y: -60 }],
        links: [{ from: "cart.html", selector: "#pay", to: "pay.html" }],
        tweaks: [{ id: "accent", type: "color", label: "Accent", default: "#e5484d" }],
      }),
    );
    expect(manifest.title).toBe("Checkout");
    expect(manifest.designSystem).toBe("acme");
    expect(manifest.artboards).toEqual([{ file: "cart.html", title: "Cart", width: 390, height: 844, x: 100, y: 40 }]);
    expect(manifest.elements).toEqual([{ kind: "title", text: "Happy path", subtitle: "Three screens", width: 900, x: 100, y: -60 }]);
    expect(manifest.links).toHaveLength(1);
    expect(manifest.tweaks[0]?.id).toBe("accent");
  });

  it("fills missing optional sections with empty lists and artboard defaults", () => {
    const manifest = parseManifest(JSON.stringify({ artboards: [{ file: "a.html" }, { file: "b.html" }] }));
    expect(manifest.elements).toEqual([]);
    expect(manifest.links).toEqual([]);
    expect(manifest.tweaks).toEqual([]);
    expect(manifest.artboards[0]).toMatchObject({ file: "a.html", width: 800, height: 500, x: 0, y: 0 });
    expect(manifest.artboards[1]?.x).toBeGreaterThan(800);
  });

  it("treats an element without kind as a title with a 1200 px width", () => {
    const manifest = parseManifest(JSON.stringify({ elements: [{ text: "Signup" }] }));
    expect(manifest.elements).toEqual([{ kind: "title", text: "Signup", width: 1200, x: 0, y: 0 }]);
  });

  it("reads a legacy notes list as title elements", () => {
    const manifest = parseManifest(JSON.stringify({ notes: [{ text: "Checkout", x: 10, y: -80 }] }));
    expect(manifest.elements).toEqual([{ kind: "title", text: "Checkout", width: 1200, x: 10, y: -80 }]);
  });

  it("refuses notes and elements together, naming both fields", () => {
    expect(() => parseManifest(JSON.stringify({ notes: [], elements: [] }))).toThrow(/notes.*elements|elements.*notes/);
  });

  it("refuses an unknown element kind, naming the field", () => {
    expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "sticker", x: 0, y: 0 }] }))).toThrow(/elements\[0\]\.kind/);
    expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "title", x: 0, y: 0 }] }))).toThrow(/elements\[0\]\.text/);
    expect(() => parseManifest(JSON.stringify({ elements: [{ text: "a", width: 0 }] }))).toThrow(/elements\[0\]\.width/);
  });

  it("rejects malformed manifests with a readable message", () => {
    expect(() => parseManifest("{nope")).toThrow(/not valid JSON/);
    expect(() => parseManifest(JSON.stringify({ artboards: [{ width: 10 }] }))).toThrow(/artboards\[0\]\.file/);
    expect(() => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", width: -1 }] }))).toThrow(/width/);
    expect(() => parseManifest(JSON.stringify({ artboards: "x" }))).toThrow(/artboards/);
  });

  it("derives a side-by-side layout from the html files when a page has no manifest", () => {
    const manifest = defaultManifest(["home.html", "style.css", "about.html"]);
    expect(manifest.artboards.map((a) => a.file)).toEqual(["home.html", "about.html"]);
    expect(manifest.artboards[1]!.x).toBeGreaterThan(manifest.artboards[0]!.x + manifest.artboards[0]!.width);
    expect(MANIFEST_PATH).toBe("manifest.json");
  });
});
