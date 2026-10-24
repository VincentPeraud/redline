import { useEffect, useRef, useState } from "react";
import { TocList } from "./TocList.js";
import type { TocItem } from "./tocItems.js";
import styles from "./TocMenu.module.css";

interface Props {
  items: TocItem[];
  currentFile?: string;
  onSelect: (file: string) => void;
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

/** Header button "<n> artboards ▾" opening the table of contents. */
export function TocMenu({ items, currentFile, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={styles.root}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} className={styles.button} data-open={open} onClick={() => setOpen(!open)}>
        <ListIcon />
        {items.length} {items.length === 1 ? "artboard" : "artboards"}
        <span aria-hidden="true" className={styles.chevron}>
          ▼
        </span>
      </button>
      {open && (
        <div role="menu" aria-label="Sommaire de la page" className={styles.menu}>
          <TocList
            items={items}
            currentFile={currentFile}
            autoFocusFilter
            onSelect={(file) => {
              setOpen(false);
              onSelect(file);
            }}
          />
        </div>
      )}
    </div>
  );
}
