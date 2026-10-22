import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx.js";
import styles from "./FilterPill.module.css";

export interface FilterPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  /** Shown after the label as "Label · count". */
  count?: number;
}

export function FilterPill({ active, count, className, children, type = "button", ...rest }: FilterPillProps) {
  return (
    <button type={type} aria-pressed={active} className={cx(styles.pill, active && styles.active, className)} {...rest}>
      {children}
      {count === undefined ? null : ` · ${count}`}
    </button>
  );
}
