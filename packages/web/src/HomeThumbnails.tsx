import styles from "./HomeThumbnails.module.css";

/** Decorative stand-in for a design system card (design systems have no preview yet). */
export function DesignSystemThumbnail({ variant }: { variant: number }) {
  return (
    <div aria-hidden="true" className={styles.dsThumb}>
      {variant % 2 === 0 ? (
        <>
          <div className={styles.dsHeader}>
            <div className={styles.dsDot} />
            <div className={styles.dsTitle} />
          </div>
          <div className={styles.dsBlocks}>
            <div className={styles.dsBlock} style={{ flex: 1 }} />
            <div className={styles.dsBlock} style={{ flex: 1 }} />
          </div>
        </>
      ) : (
        <>
          <div className={styles.dsTitleMuted} />
          <div className={styles.dsBlocks}>
            <div className={styles.dsBlockTall} style={{ flex: 2 }} />
            <div className={styles.dsBlockTall} style={{ flex: 1 }} />
          </div>
        </>
      )}
    </div>
  );
}
