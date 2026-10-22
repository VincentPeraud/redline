import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";
import styles from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** none: the content brings its own padding (tables, headed lists); md: 20px; lg: 18px 20px (agent rows). */
  padding?: "none" | "md" | "lg";
  as?: "div" | "section" | "article";
}

/** White surface with a 1px border and 12px radius. */
export function Card({ padding = "none", as: Tag = "div", className, ...rest }: CardProps) {
  return <Tag className={cx(styles.card, styles[padding], className)} {...rest} />;
}

/** Title row of a card, with an optional action (a link) on the right. */
export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      {action}
    </div>
  );
}
