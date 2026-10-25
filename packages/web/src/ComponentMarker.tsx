import styles from "./PageCanvas.module.css";

/** The ◆ that marks a component artboard on its strip. */
export function ComponentMarker() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="Composant" className={styles.componentMarker}>
      <title>Composant</title>
      <path d="M12 2l10 10-10 10L2 12z" fill="currentColor" />
    </svg>
  );
}
