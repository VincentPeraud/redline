import { useEffect, useRef } from "react";
import { Tooltip, cx } from "./ui/index.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import styles from "./ArtboardMoreMenu.module.css";

function PlayLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M10 8.5l5 3.5-5 3.5z" />
    </svg>
  );
}

interface Props {
  file: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyPlayLink: () => void;
}

/** "⋯" button of an artboard's strip and its menu of the less frequent actions. */
export function ArtboardMoreMenu({ file, open, onOpenChange, onCopyPlayLink }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const label = `Autres actions pour ${file}`;

  useCloseOnOutsidePointer(root, open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <div ref={root} className={styles.root}>
      <Tooltip label="Autres actions">
        <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} className={cx(styles.button, open && styles.buttonOpen)} onClick={() => onOpenChange(!open)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label={label} className={styles.menu}>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              onOpenChange(false);
              onCopyPlayLink();
            }}
          >
            <PlayLinkIcon />
            Copier le lien plein écran
          </button>
        </div>
      )}
    </div>
  );
}
