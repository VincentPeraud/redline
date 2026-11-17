import styles from "./ToTakeBadge.module.css";

/** "N à prendre": the threads a Claude Code conversation can take now. Nothing when there are none. */
export function ToTakeBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span data-testid="to-take-badge" className={styles.badge}>
      {count} à prendre
    </span>
  );
}
