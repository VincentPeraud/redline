import type { ManifestTweak, TweakValue, TweakValues } from "./index.js";

/** A tweak grid declaration: which tweak varies along each dimension. */
export interface TweakGridDeclaration {
  rows?: string;
  columns?: string;
  blocks?: string;
}

export const MAX_TWEAK_GRID_CELLS = 60;
const DIMENSIONS = ["rows", "columns", "blocks"] as const;

/** Tweaks shown on an artboard: its own, plus page-level ones (no `artboard`) on the first artboard. */
export const tweakAppliesTo = (tweak: ManifestTweak, file: string, firstFile: string | undefined) => (tweak.artboard ? tweak.artboard === file : file === firstFile);

interface Entry {
  value: TweakValue;
  label: string;
}

/** Values of a grid dimension in declared order: a choice's options, or off then on for a toggle. */
function entriesOf(tweak: ManifestTweak): Entry[] {
  if (tweak.type === "toggle") {
    return [
      { value: false, label: `${tweak.label} : non` },
      { value: true, label: `${tweak.label} : oui` },
    ];
  }
  return (tweak.options ?? []).map((option) => ({ value: option, label: option }));
}

/** Error message when `matrix` cannot be drawn for this artboard, else null. `tweaks` are all the page's tweaks. */
export function tweakGridError(matrix: Record<string, unknown>, tweaks: readonly ManifestTweak[], file: string, firstFile: string | undefined): string | null {
  const extra = Object.keys(matrix).filter((key) => !(DIMENSIONS as readonly string[]).includes(key));
  if (extra.length > 0) return `matrix has at most three dimensions (rows, columns, blocks), not ${extra.join(", ")}`;
  const used: ManifestTweak[] = [];
  for (const dimension of DIMENSIONS) {
    const id = matrix[dimension];
    if (id === undefined) continue;
    if (typeof id !== "string") return `matrix.${dimension} must be a tweak id`;
    const tweak = tweaks.find((t) => t.id === id && tweakAppliesTo(t, file, firstFile));
    if (!tweak) return `matrix.${dimension} refers to "${id}", which is not a tweak of this artboard`;
    if (tweak.type !== "choice" && tweak.type !== "toggle") return `matrix.${dimension} "${id}" must be a choice or toggle tweak, not ${tweak.type}`;
    if (used.includes(tweak)) return `matrix uses tweak "${id}" twice`;
    if (entriesOf(tweak).length === 0) return `matrix.${dimension} "${id}" has no options`;
    used.push(tweak);
  }
  if (used.length === 0) return "matrix needs at least one dimension (rows, columns, blocks)";
  const cells = used.reduce((count, tweak) => count * entriesOf(tweak).length, 1);
  return cells > MAX_TWEAK_GRID_CELLS ? `matrix has ${cells} cells, at most ${MAX_TWEAK_GRID_CELLS}` : null;
}

export interface TweakGridCell {
  /** Identity of the cell within its artboard. */
  key: string;
  /** The cell's combination: tweak id to value, for the declared dimensions only. */
  values: TweakValues;
}

export interface TweakGrid {
  columns: { label?: string }[];
  blocks: { label?: string; rows: { label?: string; cells: TweakGridCell[] }[] }[];
}

interface Axis {
  tweakId?: string;
  entries: { value?: TweakValue; label?: string }[];
}

/** The cells of a valid declaration, block by block then row by row. A dimension that is not declared is a single unlabelled entry. */
export function tweakGrid(matrix: TweakGridDeclaration, tweaks: readonly ManifestTweak[]): TweakGrid {
  const axis = (id: string | undefined): Axis => {
    const tweak = tweaks.find((t) => t.id === id);
    return tweak ? { tweakId: tweak.id, entries: entriesOf(tweak) } : { entries: [{}] };
  };
  const rows = axis(matrix.rows);
  const columns = axis(matrix.columns);
  const blocks = axis(matrix.blocks);
  const combination = (parts: [Axis, { value?: TweakValue }][]): TweakValues =>
    Object.fromEntries(parts.flatMap(([a, entry]) => (a.tweakId === undefined ? [] : [[a.tweakId, entry.value as TweakValue]])));
  const labelled = (label: string | undefined) => (label === undefined ? {} : { label });
  return {
    columns: columns.entries.map((c) => labelled(c.label)),
    blocks: blocks.entries.map((block, b) => ({
      ...labelled(block.label),
      rows: rows.entries.map((row, r) => ({
        ...labelled(row.label),
        cells: columns.entries.map((column, c) => ({
          key: `${b}-${r}-${c}`,
          values: combination([
            [rows, row],
            [columns, column],
            [blocks, block],
          ]),
        })),
      })),
    })),
  };
}

/** Frame metrics of the grid in canvas pixels, taken from the board at zoom 1: border, padding, label column, text heights, gaps. */
export const TWEAK_GRID_METRICS = { border: 1, paddingX: 24, paddingY: 20, labelColumn: 96, blockTitle: 15, columnHeader: 13, gap: 6, blockGap: 22 } as const;

export interface TweakGridLayout {
  width: number;
  height: number;
  blockTitles: { label: string; x: number; y: number }[];
  columnHeaders: { label: string; x: number; y: number }[];
  rowLabels: { label: string; x: number; y: number; height: number }[];
  cells: (TweakGridCell & { x: number; y: number; width: number; height: number })[];
}

/** Positions inside the frame (its top-left corner is 0,0) of a grid whose cells have the artboard's declared size. */
export function tweakGridLayout(grid: TweakGrid, cell: { width: number; height: number }): TweakGridLayout {
  const { border, paddingX, paddingY, labelColumn, blockTitle, columnHeader, gap, blockGap } = TWEAK_GRID_METRICS;
  const hasRowLabels = grid.blocks.some((b) => b.rows.some((r) => r.label !== undefined));
  const hasColumnLabels = grid.columns.some((c) => c.label !== undefined);
  const left = border + paddingX;
  const cellsLeft = left + (hasRowLabels ? labelColumn : 0);
  const layout: TweakGridLayout = { width: 0, height: 0, blockTitles: [], columnHeaders: [], rowLabels: [], cells: [] };
  let y = border + paddingY;
  grid.blocks.forEach((block, b) => {
    if (b > 0) y += blockGap;
    if (block.label !== undefined) {
      layout.blockTitles.push({ label: block.label, x: left, y });
      y += blockTitle + gap;
    }
    if (hasColumnLabels) {
      grid.columns.forEach((column, c) => layout.columnHeaders.push({ label: column.label ?? "", x: cellsLeft + c * cell.width, y }));
      y += columnHeader + gap;
    }
    block.rows.forEach((row, r) => {
      if (r > 0) y += gap;
      if (row.label !== undefined) layout.rowLabels.push({ label: row.label, x: left, y, height: cell.height });
      row.cells.forEach((c, i) => layout.cells.push({ ...c, x: cellsLeft + i * cell.width, y, width: cell.width, height: cell.height }));
      y += cell.height;
    });
  });
  layout.width = cellsLeft + grid.columns.length * cell.width + paddingX + border;
  layout.height = y + paddingY + border;
  return layout;
}
