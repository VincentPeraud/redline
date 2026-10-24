/** An artboard as laid out on the canvas (a responsive artboard is one box with its laid-out size). */
export interface ReadingOrderArtboard {
  file: string;
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A group title on the canvas; only its position and width matter here. */
export interface ReadingOrderTitle {
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface OrderedArtboard {
  file: string;
  title?: string;
  /** 1-based position in the reading order. */
  number: number;
  /** Text of the group title the artboard falls under; null outside any group. */
  groupTitle: string | null;
}

/**
 * The canvas reading order: artboards whose vertical extents overlap form a row, rows go top to bottom and artboards
 * of a row left to right, whatever the manifest order. An artboard belongs to the nearest title above its row whose
 * horizontal span covers the artboard's centre.
 */
export function readingOrder(artboards: ReadingOrderArtboard[], titles: ReadingOrderTitle[]): OrderedArtboard[] {
  const byTop = [...artboards].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { top: number; bottom: number; members: ReadingOrderArtboard[] }[] = [];
  for (const artboard of byTop) {
    const row = rows[rows.length - 1];
    if (row && artboard.y < row.bottom) {
      row.members.push(artboard);
      row.bottom = Math.max(row.bottom, artboard.y + artboard.height);
    } else {
      rows.push({ top: artboard.y, bottom: artboard.y + artboard.height, members: [artboard] });
    }
  }
  return rows
    .flatMap((row) => [...row.members].sort((a, b) => a.x - b.x).map((artboard) => ({ artboard, rowTop: row.top })))
    .map(({ artboard, rowTop }, index) => {
      const centre = artboard.x + artboard.width / 2;
      const group = titles
        .filter((title) => title.y <= rowTop && centre >= title.x && centre <= title.x + title.width)
        .reduce<ReadingOrderTitle | null>((nearest, title) => (nearest === null || title.y > nearest.y ? title : nearest), null);
      return { file: artboard.file, ...(artboard.title !== undefined && { title: artboard.title }), number: index + 1, groupTitle: group?.text ?? null };
    });
}
