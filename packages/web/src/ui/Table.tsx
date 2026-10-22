import type { ReactNode } from "react";
import { cx } from "./cx.js";
import styles from "./Table.module.css";

export interface TableColumn<Row> {
  key: string;
  /** Header text, drawn uppercase. */
  header: ReactNode;
  /** CSS grid track of the column, e.g. "1.7fr", "90px", "auto". */
  width: string;
  render: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Makes rows buttons; the selected one gets the accent mark on its left edge. */
  onRowClick?: (row: Row) => void;
  selectedKey?: string | null;
  /** Shown instead of the rows when there are none. */
  empty?: ReactNode;
  ariaLabel?: string;
}

/** Card-style table drawn with a CSS grid: uppercase header row, one row per item. */
export function Table<Row>({ columns, rows, rowKey, onRowClick, selectedKey, empty, ariaLabel }: TableProps<Row>) {
  const template = columns.map((column) => column.width).join(" ");
  return (
    <div className={styles.table} aria-label={ariaLabel}>
      <div className={styles.header} style={{ gridTemplateColumns: template }}>
        {columns.map((column) => (
          <div key={column.key}>{column.header}</div>
        ))}
      </div>
      {rows.map((row) => {
        const key = rowKey(row);
        const cells = columns.map((column) => <span key={column.key}>{column.render(row)}</span>);
        if (!onRowClick) {
          return (
            <div key={key} className={styles.row} style={{ gridTemplateColumns: template }}>
              {cells}
            </div>
          );
        }
        const selected = key === selectedKey;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            className={cx(styles.row, styles.clickable, selected && styles.selected)}
            style={{ gridTemplateColumns: template }}
            onClick={() => onRowClick(row)}
          >
            {cells}
          </button>
        );
      })}
      {rows.length === 0 && empty !== undefined ? <div className={styles.empty}>{empty}</div> : null}
    </div>
  );
}
