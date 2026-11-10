import { describe, expect, it } from "vitest";
import { parseManifest, tweakGrid, tweakGridLayout, type ManifestTweak } from "@redline/shared";

const tweaks: ManifestTweak[] = [
  { id: "state", type: "choice", label: "État", options: ["Default", "Hover", "Disabled"] },
  { id: "variant", type: "choice", label: "Variante", options: ["Contained", "Outlined"] },
  { id: "icon", type: "toggle", label: "Icône" },
  { id: "label", type: "text", label: "Texte" },
];

describe("tweak grid cells", () => {
  it("lists blocks, rows and columns in declared order, each cell carrying its combination", () => {
    const grid = tweakGrid({ rows: "state", columns: "variant", blocks: "icon" }, tweaks);
    expect(grid.blocks.map((b) => b.label)).toEqual(["Icône : non", "Icône : oui"]);
    expect(grid.columns.map((c) => c.label)).toEqual(["Contained", "Outlined"]);
    expect(grid.blocks[0]!.rows.map((r) => r.label)).toEqual(["Default", "Hover", "Disabled"]);
    expect(grid.blocks[1]!.rows[1]!.cells.map((c) => c.values)).toEqual([
      { state: "Hover", variant: "Contained", icon: true },
      { state: "Hover", variant: "Outlined", icon: true },
    ]);
  });

  it("gives every cell a distinct key", () => {
    const grid = tweakGrid({ rows: "state", columns: "variant", blocks: "icon" }, tweaks);
    const keys = grid.blocks.flatMap((b) => b.rows.flatMap((r) => r.cells.map((c) => c.key)));
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
  });

  it("draws a single unlabelled row and block for a dimension that is not declared", () => {
    const grid = tweakGrid({ columns: "variant" }, tweaks);
    expect(grid.blocks).toHaveLength(1);
    expect(grid.blocks[0]!.label).toBeUndefined();
    expect(grid.blocks[0]!.rows).toHaveLength(1);
    expect(grid.blocks[0]!.rows[0]!.label).toBeUndefined();
    expect(grid.blocks[0]!.rows[0]!.cells.map((c) => c.values)).toEqual([{ variant: "Contained" }, { variant: "Outlined" }]);
  });
});

describe("tweak grid declarations in a manifest", () => {
  const manifest = (artboard: object, extra: object[] = []) =>
    JSON.stringify({
      artboards: [{ file: "a.html" }, { file: "btn.html", ...artboard }],
      tweaks: [...tweaks.map((t) => ({ ...t, artboard: "btn.html" })), ...extra],
    });

  it("keeps a valid matrix on the artboard", () => {
    const parsed = parseManifest(manifest({ matrix: { rows: "state", columns: "variant" } }));
    expect(parsed.artboards[1]!.matrix).toEqual({ rows: "state", columns: "variant" });
  });

  it.each([
    ["an unknown tweak", { rows: "nope" }, /btn\.html.*nope/],
    ["a tweak shown on another artboard", { rows: "elsewhere" }, /btn\.html.*elsewhere/],
    ["a tweak that is not a choice or a toggle", { rows: "label" }, /btn\.html.*label.*choice or toggle/],
    ["a fourth dimension", { rows: "state", columns: "variant", blocks: "icon", extra: "icon" }, /btn\.html.*three dimensions/],
    ["no dimension at all", {}, /btn\.html.*at least one/],
    ["a tweak on two dimensions", { rows: "state", columns: "state" }, /btn\.html.*state.*twice/],
  ])("refuses %s, naming the artboard", (_name, matrix, message) => {
    const extra = [{ id: "elsewhere", type: "toggle", label: "Elsewhere", artboard: "a.html" }];
    expect(() => parseManifest(manifest({ matrix }, extra))).toThrow(message);
  });

  it("refuses a grid of more than 60 cells and accepts exactly 60", () => {
    const many = (id: string, count: number) => ({ id, type: "choice", label: id, options: Array.from({ length: count }, (_, i) => `v${i}`) });
    const build = (rows: number, columns: number) =>
      JSON.stringify({ artboards: [{ file: "a.html", matrix: { rows: "r", columns: "c" } }], tweaks: [many("r", rows), many("c", columns)] });
    expect(() => parseManifest(build(6, 11))).toThrow(/a\.html.*66 cells.*60/);
    expect(parseManifest(build(6, 10)).artboards[0]!.matrix).toEqual({ rows: "r", columns: "c" });
  });

  it("refuses a matrix on a responsive artboard", () => {
    expect(() => parseManifest(manifest({ matrix: { rows: "state" }, responsive: ["desktop"] }))).toThrow(/btn\.html.*responsive/);
  });

  it("applies page-level tweaks (no artboard) to the first artboard only", () => {
    const first = JSON.stringify({ artboards: [{ file: "a.html", matrix: { rows: "t" } }, { file: "b.html" }], tweaks: [{ id: "t", type: "toggle", label: "T" }] });
    expect(parseManifest(first).artboards[0]!.matrix).toEqual({ rows: "t" });
    const other = JSON.stringify({ artboards: [{ file: "a.html" }, { file: "b.html", matrix: { rows: "t" } }], tweaks: [{ id: "t", type: "toggle", label: "T" }] });
    expect(() => parseManifest(other)).toThrow(/b\.html/);
  });
});

describe("tweak grid layout", () => {
  it("places labels and cells like the board: label column, header row, block titles, 6px between rows, 22px between blocks", () => {
    const grid = tweakGrid({ rows: "state", columns: "variant", blocks: "icon" }, tweaks);
    const layout = tweakGridLayout(grid, { width: 160, height: 50 });
    // 1px border + 24px padding + 96px label column + 2 columns of 160
    expect(layout.width).toBe(2 + 48 + 96 + 320);
    // 1px border + 20px padding; per block 15 title + 6 + 13 header + 6 + 3 rows of 50 with 6 between; 22 between blocks
    expect(layout.height).toBe(2 + 40 + 2 * (15 + 6 + 13 + 6 + 3 * 50 + 2 * 6) + 22);
    expect(layout.blockTitles.map((t) => [t.label, t.y])).toEqual([
      ["Icône : non", 21],
      ["Icône : oui", 21 + 202 + 22],
    ]);
    expect(layout.columnHeaders.slice(0, 2).map((h) => [h.label, h.x, h.y])).toEqual([
      ["Contained", 1 + 24 + 96, 21 + 15 + 6],
      ["Outlined", 1 + 24 + 96 + 160, 21 + 15 + 6],
    ]);
    expect(layout.rowLabels.slice(0, 2).map((r) => [r.label, r.x, r.y, r.height])).toEqual([
      ["Default", 25, 21 + 15 + 6 + 13 + 6, 50],
      ["Hover", 25, 21 + 15 + 6 + 13 + 6 + 56, 50],
    ]);
    expect(layout.cells[0]).toMatchObject({ x: 121, y: 61, width: 160, height: 50 });
    expect(layout.cells).toHaveLength(12);
  });

  it("leaves out the label column, header row and block titles of dimensions that are not declared", () => {
    const layout = tweakGridLayout(tweakGrid({ columns: "variant" }, tweaks), { width: 100, height: 40 });
    expect(layout.rowLabels).toEqual([]);
    expect(layout.blockTitles).toEqual([]);
    expect(layout.width).toBe(2 + 48 + 200);
    expect(layout.height).toBe(2 + 40 + 13 + 6 + 40);
    expect(layout.cells[0]).toMatchObject({ x: 25, y: 21 + 13 + 6 });
  });
});
