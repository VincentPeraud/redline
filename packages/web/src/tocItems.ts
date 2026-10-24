import type { CanvasView } from "./canvasView.js";

/** One line of the table of contents. */
export interface TocItem {
  number: number;
  file: string;
  title?: string;
  groupTitle: string | null;
  openThreads: number;
}

export interface TocGroup {
  /** Null for the untitled group. */
  title: string | null;
  items: TocItem[];
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Lines in reading order, a new group starting whenever the group title changes, keeping those whose title or file name contains `query`. */
export function tocGroups(items: TocItem[], query: string): TocGroup[] {
  const needle = fold(query.trim());
  const groups: TocGroup[] = [];
  for (const item of items) {
    if (needle !== "" && !fold(`${item.title ?? ""}\n${item.file}`).includes(needle)) continue;
    const group = groups[groups.length - 1];
    if (group && group.title === item.groupTitle) group.items.push(item);
    else groups.push({ title: item.groupTitle, items: [item] });
  }
  return groups;
}

interface Box {
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The artboard whose box contains the centre of the visible canvas area, or else the nearest one. */
export function artboardAtCentre(boxes: Box[], view: CanvasView, viewport: { width: number; height: number }): string | undefined {
  const cx = (viewport.width / 2 - view.x) / view.zoom;
  const cy = (viewport.height / 2 - view.y) / view.zoom;
  let best: { file: string; distance: number } | undefined;
  for (const box of boxes) {
    const dx = Math.max(box.x - cx, 0, cx - (box.x + box.width));
    const dy = Math.max(box.y - cy, 0, cy - (box.y + box.height));
    const distance = Math.hypot(dx, dy);
    if (!best || distance < best.distance) best = { file: box.file, distance };
  }
  return best?.file;
}
