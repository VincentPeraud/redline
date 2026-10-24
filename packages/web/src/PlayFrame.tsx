import type { ReactNode } from "react";
import { cx } from "./ui/index.js";
import type { PresentationFrame } from "./playFrames.js";
import styles from "./PlayFrame.module.css";

interface Props {
  frame: PresentationFrame;
  /** Address bar text of the browser frame. */
  url?: string;
  children: ReactNode;
}

/** The decorative shell around the artboard iframe, at its natural size (the caller scales it). */
export function PlayFrame({ frame, url, children }: Props) {
  switch (frame) {
    case "phone":
      return (
        <div className={cx(styles.shell, styles.phone)} data-frame="phone">
          {children}
          <span aria-hidden="true" className={styles.camera} />
          <span aria-hidden="true" className={styles.phoneIndicator} />
        </div>
      );
    case "tablet":
      return (
        <div className={cx(styles.shell, styles.tablet)} data-frame="tablet">
          <span aria-hidden="true" className={styles.tabletCamera} />
          {children}
          <div className={styles.tabletStrip}>
            <span aria-hidden="true" className={styles.tabletIndicator} />
          </div>
        </div>
      );
    case "browser":
      return (
        <div className={cx(styles.shell, styles.browser)} data-frame="browser">
          <div aria-hidden="true" className={styles.bar}>
            <span className={styles.lights}>
              <span className={styles.light} />
              <span className={styles.light} />
              <span className={styles.light} />
            </span>
            <span className={styles.address}>{url ?? ""}</span>
            <span className={styles.barSpacer} />
          </div>
          {children}
        </div>
      );
    case "paper":
      return (
        <div className={cx(styles.shell, styles.paper)} data-frame="paper">
          {children}
        </div>
      );
    case "none":
      return (
        <div className={cx(styles.shell, styles.none)} data-frame="none">
          {children}
        </div>
      );
  }
}
