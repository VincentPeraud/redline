import styles from "./HomeThumbnails.module.css";

/** Decorative stand-ins for a project's pages, cycled by position (the app has no page screenshots). */
export function ProjectThumbnail({ variant }: { variant: number }) {
  const kind = variant % 3;
  return (
    <div aria-hidden="true" className={styles.projectThumb}>
      {kind === 0 && (
        <>
          <div className={styles.phone}>
            <div className={styles.bar} />
            <div className={styles.grow} />
            <div className={styles.buttonAccent} />
          </div>
          <div className={styles.phone}>
            <div className={styles.bar} />
            <div className={styles.fieldAccent} />
            <div className={styles.field} />
            <div className={styles.grow} />
            <div className={styles.buttonDark} />
          </div>
          <div className={styles.desktop}>
            <div className={styles.desktopColumn}>
              <div className={styles.bar} />
              <div className={styles.accentLine} />
            </div>
            <div className={styles.desktopImage} />
          </div>
        </>
      )}
      {kind === 1 && (
        <div className={styles.article}>
          <div className={styles.articleHero} />
          <div className={styles.articleTitle} />
          <div className={styles.articleLineLong} />
          <div className={styles.articleLineShort} />
        </div>
      )}
      {kind === 2 && (
        <>
          <div className={styles.reel} style={{ background: "var(--thumb-dark-1)" }} />
          <div className={styles.reel} style={{ background: "var(--thumb-dark-2)" }} />
          <div className={styles.reel} style={{ background: "var(--thumb-dark-3)" }} />
        </>
      )}
    </div>
  );
}

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
