import styles from "./Thread.module.css";

/** Tag of a thread whose canvas element left the manifest. */
export function RemovedTag() {
  return (
    <span data-testid="removed-tag" className={styles.removedTag}>
      retiré du canvas
    </span>
  );
}
