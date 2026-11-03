import { cx } from "./ui/index.js";
import { counted } from "./plural.js";
import styles from "./DesignSystemAlerts.module.css";

/** "non diffusé · 8 changements": the lines of the review before diffusing. */
export function PendingPill({ changes }: { changes: number }) {
  return (
    <span data-testid="pending-pill" className={cx(styles.pill, styles.pending)}>
      <span aria-hidden="true" className={styles.dot} />
      non diffusé · {counted(changes, "changement", "changements")}
    </span>
  );
}

/** "3 demandes" (home) or "3 demandes des projets" (design systems list). */
export function RequestsPill({ count, suffix = "" }: { count: number; suffix?: string }) {
  return (
    <span data-testid="requests-pill" className={cx(styles.pill, styles.requests)}>
      {counted(count, "demande", "demandes")}
      {suffix}
    </span>
  );
}
