import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, RESPONSIVE_SPACING, defaultManifest, parseManifest, renderingLabel } from "@redline/shared";

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

  it("reads an image element from the project assets, with a default width", () => {
    const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "image", src: "assets/site/now.png", width: 440, x: 468, y: 650 }, { kind: "image", src: "assets/a.jpg" }] }));
    expect(manifest.elements).toEqual([
      { kind: "image", src: "assets/site/now.png", width: 440, x: 468, y: 650 },
      { kind: "image", src: "assets/a.jpg", width: 400, x: 0, y: 0 },
    ]);
  });

  it("refuses an image whose src is not an assets/ path, naming the field", () => {
    for (const src of ["https://example.com/a.png", "//cdn.example.com/a.png", "data:image/png;base64,AAAA", "/assets/a.png", "other/a.png", "assets/", "assets/../secret.png", "assets/a/../../b.png"]) {
      expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "image", src }] })), src).toThrow(/elements\[0\]\.src/);
    }
    expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "image" }] }))).toThrow(/elements\[0\]\.src/);
    expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "image", src: "assets/a.png", width: 0 }] }))).toThrow(/elements\[0\]\.width/);
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

  describe("text and sticky notes", () => {
    it("applies the defaults", () => {
      const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "text", text: "Hello", x: 5, y: 6 }, { kind: "sticky", text: "Ask", x: 1, y: 2 }] }));
      expect(manifest.elements).toEqual([
        { kind: "text", text: "Hello", width: 360, size: "m", x: 5, y: 6 },
        { kind: "sticky", text: "Ask", width: 240, size: "m", color: "yellow", x: 1, y: 2 },
      ]);
    });

    it("keeps declared colour, size and width", () => {
      const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "text", text: "T", color: "blue", size: "l", width: 500 }, { kind: "sticky", text: "S", color: "pink", size: "s", width: 336 }] }));
      expect(manifest.elements).toEqual([
        { kind: "text", text: "T", width: 500, size: "l", color: "blue", x: 0, y: 0 },
        { kind: "sticky", text: "S", width: 336, size: "s", color: "pink", x: 0, y: 0 },
      ]);
    });

    it("refuses an unknown colour or size, naming the field", () => {
      expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "sticky", text: "S", color: "teal" }] }))).toThrow(/elements\[0\]\.color/);
      expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "text", text: "S", color: "teal" }] }))).toThrow(/elements\[0\]\.color/);
      expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "text", text: "S", size: "xl" }] }))).toThrow(/elements\[0\]\.size/);
      expect(() => parseManifest(JSON.stringify({ elements: [{ kind: "sticky", text: "" }] }))).toThrow(/elements\[0\]\.text/);
    });
  });

  describe("element ids and arrows", () => {
    const parse = (manifest: object) => () => parseManifest(JSON.stringify(manifest));

    it("keeps an optional id on every non-arrow element", () => {
      const manifest = parseManifest(
        JSON.stringify({
          elements: [
            { kind: "title", text: "T", id: "heading" },
            { kind: "text", text: "N", id: "note" },
            { kind: "sticky", text: "S", id: "ask" },
            { kind: "image", src: "assets/a.png", id: "shot" },
            { kind: "link", page: "pg_1", id: "next" },
            { kind: "link", url: "https://linear.app", title: "T", id: "ticket" },
            { kind: "text", text: "no id" },
          ],
        }),
      );
      expect(manifest.elements.map((element) => ("id" in element ? element.id : undefined))).toEqual(["heading", "note", "ask", "shot", "next", "ticket", undefined]);
    });

    it("reads an arrow between ids and free points with defaults", () => {
      const manifest = parseManifest(
        JSON.stringify({
          artboards: [{ file: "a.html" }, { file: "b.html" }],
          elements: [
            { kind: "arrow", from: "a.html", to: "b.html" },
            { kind: "arrow", from: "b.html", to: { x: 10, y: 20 }, label: "après choix", color: "blue", line: "dashed" },
          ],
        }),
      );
      expect(manifest.elements).toEqual([
        { kind: "arrow", from: "a.html", to: "b.html", color: "gray", line: "solid" },
        { kind: "arrow", from: "b.html", to: { x: 10, y: 20 }, label: "après choix", color: "blue", line: "dashed" },
      ]);
    });

    it("refuses an arrow naming an unknown id, naming it", () => {
      expect(parse({ artboards: [{ file: "a.html" }], elements: [{ kind: "arrow", from: "a.html", to: "ghost" }] })).toThrow(/elements\[0\]\.to.*ghost/);
      expect(parse({ elements: [{ kind: "arrow", from: "ghost", to: { x: 0, y: 0 } }] })).toThrow(/elements\[0\]\.from.*ghost/);
    });

    it("refuses an arrow without ends, with a malformed point, or with a wrong colour or line", () => {
      expect(parse({ elements: [{ kind: "arrow", to: { x: 0, y: 0 } }] })).toThrow(/elements\[0\]\.from/);
      expect(parse({ elements: [{ kind: "arrow", from: { x: 0 }, to: { x: 0, y: 0 } }] })).toThrow(/elements\[0\]\.from/);
      expect(parse({ elements: [{ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "teal" }] })).toThrow(/elements\[0\]\.color/);
      expect(parse({ elements: [{ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, line: "dotted" }] })).toThrow(/elements\[0\]\.line/);
    });

    it("refuses a duplicate id, including against artboard files", () => {
      expect(parse({ elements: [{ kind: "text", text: "a", id: "n" }, { kind: "text", text: "b", id: "n" }] })).toThrow(/elements\[1\]\.id.*"n"/);
      expect(parse({ artboards: [{ file: "a.html" }], elements: [{ kind: "text", text: "a", id: "a.html" }] })).toThrow(/elements\[0\]\.id.*"a.html"/);
    });

    it("lets an arrow target an element declared after it", () => {
      const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "arrow", from: "late", to: { x: 0, y: 0 } }, { kind: "text", text: "a", id: "late" }] }));
      expect(manifest.elements).toHaveLength(2);
    });
  });

  describe("shapes", () => {
    it("applies the defaults", () => {
      const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "shape", shape: "rect", x: 3, y: 4, width: 300, height: 200 }] }));
      expect(manifest.elements).toEqual([{ kind: "shape", shape: "rect", style: "outline", color: "gray", width: 300, height: 200, x: 3, y: 4 }]);
    });

    it("keeps style, colour and label", () => {
      const manifest = parseManifest(JSON.stringify({ elements: [{ kind: "shape", shape: "ellipse", style: "fill", color: "blue", label: "Variante A", width: 10, height: 20 }] }));
      expect(manifest.elements).toEqual([{ kind: "shape", shape: "ellipse", style: "fill", color: "blue", label: "Variante A", width: 10, height: 20, x: 0, y: 0 }]);
    });

    it("refuses an unknown shape, style or colour and a missing size, naming the field", () => {
      const bad = (shape: object) => () => parseManifest(JSON.stringify({ elements: [{ kind: "shape", shape: "rect", width: 10, height: 10, ...shape }] }));
      expect(bad({ shape: "star" })).toThrow(/elements\[0\]\.shape/);
      expect(bad({ style: "dotted" })).toThrow(/elements\[0\]\.style/);
      expect(bad({ color: "teal" })).toThrow(/elements\[0\]\.color/);
      expect(bad({ width: undefined })).toThrow(/elements\[0\]\.width/);
      expect(bad({ height: 0 })).toThrow(/elements\[0\]\.height/);
    });
  });

  it("accepts expand fill on an artboard and refuses another value naming the field", () => {
    const manifest = parseManifest(JSON.stringify({ artboards: [{ file: "a.html", expand: "fill" }, { file: "b.html" }] }));
    expect(manifest.artboards[0]!.expand).toBe("fill");
    expect(manifest.artboards[1]).not.toHaveProperty("expand");
    expect(() => parseManifest(JSON.stringify({ artboards: [{ file: "a.html" }, { file: "b.html", expand: "stretch" }] }))).toThrow(/artboards\[1\]\.expand/);
  });
  describe("responsive artboards", () => {
    const parse = (responsive: unknown, extra: object = {}) => parseManifest(JSON.stringify({ artboards: [{ file: "landing.html", responsive, ...extra }] }));

    it("reads named formats at their real size, in the order given", () => {
      const [artboard] = parse(["desktop", "tablet", "mobile", "tablet-landscape"]).artboards;
      expect(artboard!.responsive).toEqual([
        { format: "desktop", width: 1440, height: 900 },
        { format: "tablet", width: 768, height: 1024 },
        { format: "mobile", width: 390, height: 844 },
        { format: "tablet-landscape", width: 1024, height: 768 },
      ]);
    });

    it("reads a {device, width, height} override and labels renderings with format and width", () => {
      const [artboard] = parse(["desktop", { device: "desktop", width: 1920, height: 1080 }]).artboards;
      expect(artboard!.responsive!.map(renderingLabel)).toEqual(["Desktop · 1440", "Desktop · 1920"]);
      expect(artboard!.responsive![1]).toEqual({ format: "desktop", width: 1920, height: 1080 });
    });

    it("ignores the device of a responsive artboard and sizes the artboard to its frame", () => {
      const [artboard] = parse(["desktop", "mobile"], { device: "phone" }).artboards;
      expect(artboard).not.toHaveProperty("device");
      expect(artboard!.width).toBe(RESPONSIVE_SPACING * 3 + 1440 + 390);
      expect(artboard!.height).toBe(RESPONSIVE_SPACING * 2 + 900);
    });

    it("refuses an unknown format, naming the field", () => {
      expect(() => parse(["desktop", "watch"])).toThrow(/artboards\[0\]\.responsive\[1\].*desktop/);
      expect(() => parse([{ device: "watch", width: 100, height: 100 }])).toThrow(/artboards\[0\]\.responsive\[0\]\.device/);
      expect(() => parse([{ device: "mobile", width: 0, height: 100 }])).toThrow(/artboards\[0\]\.responsive\[0\]\.width/);
      expect(() => parse([{ device: "mobile", width: 100 }])).toThrow(/artboards\[0\]\.responsive\[0\]\.height/);
      expect(() => parse([])).toThrow(/artboards\[0\]\.responsive/);
      expect(() => parse("desktop")).toThrow(/artboards\[0\]\.responsive/);
    });

    it("refuses two renderings with the same format and width", () => {
      expect(() => parse(["mobile", { device: "mobile", width: 390, height: 600 }])).toThrow(/artboards\[0\]\.responsive\[1\]/);
    });

    it("refuses an unknown device even though a responsive artboard ignores it", () => {
      const bad = () => parseManifest(JSON.stringify({ artboards: [{ file: "a.html", device: "watch", responsive: ["mobile"] }] }));
      expect(bad).toThrow(/artboards\[0\]\.device/);
    });
  });

  describe("optional text fields", () => {
    const refuse = (manifest: object) => () => parseManifest(JSON.stringify(manifest));

    it("refuses a non-string url on an artboard, naming the field", () => {
      expect(refuse({ artboards: [{ file: "a.html", device: "desktop", url: 42 }] })).toThrow(/artboards\[0\]\.url/);
    });

    it("refuses a url on an artboard whose device is not desktop", () => {
      expect(refuse({ artboards: [{ file: "a.html", device: "phone", url: "lumora.fr" }] })).toThrow(/artboards\[0\]\.url/);
      expect(refuse({ artboards: [{ file: "a.html", url: "lumora.fr" }] })).toThrow(/artboards\[0\]\.url/);
    });

    it("refuses a non-string subtitle or label, naming the field", () => {
      expect(refuse({ elements: [{ kind: "title", text: "T", subtitle: 3 }] })).toThrow(/elements\[0\]\.subtitle/);
      expect(refuse({ elements: [{ kind: "shape", shape: "rect", width: 10, height: 10, label: 3 }] })).toThrow(/elements\[0\]\.label/);
      expect(refuse({ elements: [{ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: {} }] })).toThrow(/elements\[0\]\.label/);
    });
  });
});
