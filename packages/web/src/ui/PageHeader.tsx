import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons aligned on the right of the title. */
  actions?: ReactNode;
}

/** Screen title (28px, bold) with a muted subtitle line. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}

/** The `main` of a screen: 40px / 48px padding, children stacked with a 24px gap. */
export function PageContent({ children }: { children: ReactNode }) {
  return <main className={styles.content}>{children}</main>;
}
