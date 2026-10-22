import type { ReactNode } from "react";
import { cx } from "./cx.js";
import styles from "./SidePanel.module.css";

export interface SidePanelProps {
  /** Accessible name of the panel (e.g. "Session sélectionnée"). */
  label: string;
  /** Width in px; 420 for session and thread panels, 360 for the Agents setup panel. */
  width?: number;
  children: ReactNode;
}

/**
 * Right-hand column (white, 1px left border) that stays in view while the page scrolls.
 * Render it as a sibling of `PageContent` inside the screen; compose it from the parts below.
 */
export function SidePanel({ label, width = 420, children }: SidePanelProps) {
  return (
    <aside aria-label={label} className={styles.panel} style={{ width }}>
      {children}
    </aside>
  );
}

/** Top section: padding 20/22 and a divider underneath. */
export function SidePanelHeader({ children }: { children: ReactNode }) {
  return <div className={styles.header}>{children}</div>;
}

/** Scrolling middle section that takes the remaining height. */
export function SidePanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.body, className)}>{children}</div>;
}

/** Bottom section: padding 14/22/20 and a divider above (composer). */
export function SidePanelFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}
