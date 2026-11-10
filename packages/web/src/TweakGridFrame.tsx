import { useMemo } from "react";
import { cellKey, type ArtboardGuides, type Thread, type TweakGridLayout, type TweakValues } from "@redline/shared";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";
import { cx } from "./ui/index.js";
import styles from "./TweakGridFrame.module.css";

interface Props {
  title: string;
  src: string;
  layout: TweakGridLayout;
  zoom: number;
  guides?: ArtboardGuides;
  /** Threads of this artboard; each cell shows the ones pinned in it, the first cell also the ones from before cells were recorded. */
  threads: Thread[];
  picking: boolean;
  selecting: boolean;
  /** Numbered marks of the message's chips in one cell, by the cell's values. */
  marksOf: (cell: TweakValues) => { number: number; selector: string }[];
  /** Tweak values of the page; each cell overrides the ones of its combination. */
  tweaks: TweakValues;
  onPick: (pick: Pick, cell: TweakValues) => void;
  onEscape: () => void;
}

interface CellProps extends Omit<Props, "layout"> {
  cell: TweakGridLayout["cells"][number];
  first: boolean;
}

function Cell({ cell, first, title, tweaks, threads, marksOf, onPick, ...props }: CellProps) {
  const values = useMemo(() => ({ ...tweaks, ...cell.values }), [tweaks, cell.values]);
  const cellThreads = threads.filter((t) => (t.cell ? cellKey(t.cell) === cellKey(cell.values) : first));
  const marks = marksOf(cell.values);
  return (
    <div data-grid-cell={cell.key} className={cx(styles.cell, (cellThreads.length > 0 || marks.length > 0) && styles.cellWithPins)} style={{ left: cell.x, top: cell.y }}>
      <ArtboardFrame
        {...props}
        title={`${title} · ${cell.key}`}
        bare
        width={cell.width}
        height={cell.height}
        threads={cellThreads}
        marks={marks}
        tweaks={values}
        onPick={(pick) => onPick(pick, cell.values)}
      />
    </div>
  );
}

/**
 * The frame of a tweak grid artboard: the same file once per combination of its grid tweaks, with the
 * block titles, column headers and row labels around the cells. Labels keep their screen size whatever the zoom.
 */
export function TweakGridFrame({ layout, zoom, ...props }: Props) {
  const labelStyle = (x: number, y: number) => ({ left: x, top: y, transform: `scale(${1 / zoom})` });
  return (
    <div data-tweak-grid className={styles.frame} style={{ width: layout.width, height: layout.height, ["--unit" as string]: 1 / zoom }}>
      {layout.blockTitles.map((t) => (
        <span key={`block-${t.y}`} data-grid-block className={styles.blockTitle} style={labelStyle(t.x, t.y)}>
          {t.label}
        </span>
      ))}
      {layout.columnHeaders.map((h) => (
        <span key={`column-${h.x}-${h.y}`} data-grid-column className={styles.columnHeader} style={labelStyle(h.x, h.y)}>
          {h.label}
        </span>
      ))}
      {layout.rowLabels.map((r) => (
        <span key={`row-${r.y}`} data-grid-row className={styles.rowLabel} style={{ ...labelStyle(r.x, r.y), height: r.height * zoom }}>
          {r.label}
        </span>
      ))}
      {layout.cells.map((cell, index) => (
        <Cell key={cell.key} cell={cell} first={index === 0} zoom={zoom} {...props} />
      ))}
    </div>
  );
}
