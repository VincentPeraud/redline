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

  it("reads link cards to a page or to an external URL", () => {
    const manifest = parseManifest(
      JSON.stringify({
        elements: [
          { kind: "link", page: "pg_7f3a", x: 1640, y: 1300 },
          { kind: "link", url: "https://linear.app/loc/issue/LOC-142", title: "Ticket LOC-142", x: 1640, y: 1436 },
        ],
      }),
    );
    expect(manifest.elements).toEqual([
      { kind: "link", page: "pg_7f3a", x: 1640, y: 1300 },
      { kind: "link", url: "https://linear.app/loc/issue/LOC-142", title: "Ticket LOC-142", x: 1640, y: 1436 },
    ]);
  });

  it("refuses a link card without a page or without a url and title, naming the field", () => {
    const refuse = (element: object) => () => parseManifest(JSON.stringify({ elements: [{ kind: "link", x: 0, y: 0, ...element }] }));
    expect(refuse({})).toThrow(/elements\[0\]\.page/);
    expect(refuse({ url: "https://linear.app" })).toThrow(/elements\[0\]\.title/);
    expect(refuse({ title: "Ticket" })).toThrow(/elements\[0\]\.(page|url)/);
    expect(refuse({ page: "pg_1", url: "https://linear.app", title: "T" })).toThrow(/elements\[0\]\.(page|url)/);
    expect(refuse({ url: "javascript:alert(1)", title: "T" })).toThrow(/elements\[0\]\.url/);
    expect(refuse({ url: "not a url", title: "T" })).toThrow(/elements\[0\]\.url/);
  });

  it("rejects malformed manifests with a readable message", () => {
    expect(() => parseManifest("{nope")).toThrow(/not valid JSON/);
    expect(() => parseManifest(JSON.stringify({ artboards: [{ width: 10 }] }))).toThrow(/artboards\[0\]\.file/);
    expect(() => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", width: -1 }] }))).toThrow(/width/);
    expect(() => parseManifest(JSON.stringify({ artboards: "x" }))).toThrow(/artboards/);
  });

  it("reads an artboard's device and url, and refuses an unknown device naming the field", () => {
    const manifest = parseManifest(
      JSON.stringify({
        artboards: [
          { file: "home.html", device: "desktop", url: "lumora.fr" },
          { file: "cv.html", device: "paper" },
          { file: "plain.html" },
        ],
      }),
    );
    expect(manifest.artboards[0]).toMatchObject({ device: "desktop", url: "lumora.fr" });
    expect(manifest.artboards[1]?.device).toBe("paper");
    expect(manifest.artboards[2]).not.toHaveProperty("device");
    expect(manifest.artboards[2]).not.toHaveProperty("url");
    for (const device of ["phone", "tablet", "desktop", "paper", "none"]) {
      expect(() => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", device }] }))).not.toThrow();
    }
    expect(() => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", device: "watch" }] }))).toThrow(/artboards\[0\]\.device/);
  });

  it("derives a side-by-side layout from the html files when a page has no manifest", () => {
    const manifest = defaultManifest(["home.html", "style.css", "about.html"]);
    expect(manifest.artboards.map((a) => a.file)).toEqual(["home.html", "about.html"]);
    expect(manifest.artboards[1]!.x).toBeGreaterThan(manifest.artboards[0]!.x + manifest.artboards[0]!.width);
    expect(MANIFEST_PATH).toBe("manifest.json");
  });

  it("reads layout guides on an artboard and refuses a malformed value naming the field", () => {
    const guides = { columns: 4, gutter: 8, margin: 16, baseline: 8 };
    const manifest = parseManifest(JSON.stringify({ artboards: [{ file: "a.html" }, { file: "b.html", guides: { columns: 12, gutter: 0, margin: 24 } }] }));
    expect(manifest.artboards[0]!.guides).toBeUndefined();
    expect(manifest.artboards[1]!.guides).toEqual({ columns: 12, gutter: 0, margin: 24 });
    expect(parseManifest(JSON.stringify({ artboards: [{ file: "a.html", guides }] })).artboards[0]!.guides).toEqual(guides);
    const bad = (value: unknown) => () => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", guides: value }] }));
    expect(bad("grid")).toThrow(/artboards\[0\]\.guides/);
    expect(bad({ columns: 0, gutter: 8, margin: 16 })).toThrow(/artboards\[0\]\.guides\.columns/);
    expect(bad({ columns: 2.5, gutter: 8, margin: 16 })).toThrow(/guides\.columns/);
    expect(bad({ columns: 4, margin: 16 })).toThrow(/guides\.gutter/);
    expect(bad({ columns: 4, gutter: -1, margin: 16 })).toThrow(/guides\.gutter/);
    expect(bad({ columns: 4, gutter: 8, margin: "x" })).toThrow(/guides\.margin/);
    expect(bad({ columns: 4, gutter: 8, margin: 16, baseline: 0 })).toThrow(/guides\.baseline/);
  });
});
