import styles from "./ProjectThumb.module.css";

const VARIANTS = 3;

/** Decorative wireframe on the project card: the mock-up's three illustrations, cycled by position in the list. */
export function ProjectThumb({ position }: { position: number }) {
  const variant = position % VARIANTS;
  return (
    <div aria-hidden="true" className={styles.thumb} data-variant={variant}>
      {variant === 0 && (
        <>
          <div className={styles.phone}>
            <div className={styles.lineStrong} style={{ width: "80%" }} />
            <div className={styles.lineSoft} style={{ width: "60%" }} />
            <div className={styles.grow} />
            <div className={styles.buttonAccent} />
          </div>
          <div className={styles.phone}>
            <div className={styles.lineStrong} style={{ width: "80%" }} />
            <div className={styles.fieldAccent} />
            <div className={styles.field} />
            <div className={styles.field} />
            <div className={styles.grow} />
            <div className={styles.buttonDark} />
          </div>
          <div className={styles.landing}>
            <div className={styles.lineTiny} />
            <div className={styles.landingBody}>
              <div className={styles.landingText}>
                <div className={styles.lineStrongThick} />
                <div className={styles.lineSoft} style={{ width: "80%" }} />
                <div className={styles.ctaAccent} />
              </div>
              <div className={styles.landingImage} />
            </div>
          </div>
        </>
      )}
      {variant === 1 && (
        <div className={styles.web}>
          <div className={styles.webNav}>
            <div className={styles.navLogo} />
            <div className={styles.grow} />
            <div className={styles.navLink} />
            <div className={styles.navLink} />
          </div>
          <div className={styles.webHero} />
          <div className={styles.webTitle} />
          <div className={styles.lineSoft} style={{ width: "95%" }} />
          <div className={styles.lineSoft} style={{ width: "88%" }} />
          <div className={styles.lineSoft} style={{ width: "70%" }} />
        </div>
      )}
      {variant === 2 &&
        [
          { shade: styles.shade1, bar: "70%" },
          { shade: styles.shade2, bar: "80%" },
          { shade: styles.shade3, bar: "60%" },
        ].map(({ shade, bar }) => (
          <div key={shade} className={`${styles.tile} ${shade}`}>
            <div className={styles.tileBar} style={{ width: bar }} />
          </div>
        ))}
    </div>
  );
}
