import type { CanvasBox } from "./canvasAnchors.js";

export interface ColumnItem {
  id: string;
  /** Box as the manifest declares it (a responsive frame with every rendering at its format height). */
  box: CanvasBox;
  /** Height the item takes on the canvas now (measured renderings, fit height); equal to `box.height` when it did not change. */
  shownHeight: number;
}

/** A point (an arrow end, an element of unknown width) still has a column: the pixel it sits on. */
const right = (box: CanvasBox) => box.x + Math.max(box.width, 1);

/**
 * How far down each item moves so that what sits under an item that grew (or shrank) keeps its gap: an item moves by the
 * growth plus the shift of every item above it in its column (overlapping it horizontally, entirely above it), taking the
 * largest. Items side by side never push each other, nor does an item starting at the same y.
 */
export function columnShifts(items: readonly ColumnItem[]): Map<string, number> {
  const shifts = new Map<string, number>();
  const ordered = [...items].sort((a, b) => a.box.y - b.box.y);
  for (const item of ordered) {
    let shift: number | undefined;
    for (const above of ordered) {
      if (above === item || !shifts.has(above.id)) continue;
      const isAbove = above.box.y + above.box.height <= item.box.y && above.box.y < item.box.y;
      const overlaps = above.box.x < right(item.box) && item.box.x < right(above.box);
      if (!isAbove || !overlaps) continue;
      const push = shifts.get(above.id)! + above.shownHeight - above.box.height;
      shift = shift === undefined ? push : Math.max(shift, push);
    }
    shifts.set(item.id, shift ?? 0);
  }
  return shifts;
}
