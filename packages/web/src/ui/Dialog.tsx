import { useEffect, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";
import styles from "./Dialog.module.css";

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Width in px of the panel (580 for creation forms, 520 for short ones). */
  width?: number;
}

/** Modal: dimmed overlay, white 16px-radius panel, title row with a close button. Escape and a click on the overlay close it. */
export function Dialog({ title, onClose, children, width = 580 }: DialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={styles.panel}
        style={{ width }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{title}</h2>
          <Tooltip label="Fermer">
            <button type="button" aria-label="Fermer" className={styles.close} onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          </Tooltip>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Right-aligned row of buttons at the bottom of a dialog (Annuler, then the main action). */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
