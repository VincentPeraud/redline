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
          <div aria-hidden="true" className={styles.statusBar}>
            <span className={styles.statusTime}>9:41</span>
            <span className={styles.camera} />
            <span className={styles.statusIcons}>
              <svg width="18" height="12" viewBox="0 0 18 12">
                <rect x="0" y="8" width="3" height="4" rx="1" />
                <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="0" width="3" height="12" rx="1" />
              </svg>
              <svg width="16" height="12" viewBox="0 0 16 12">
                <path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.3-1.4A10.6 10.6 0 0 0 8 .3 10.6 10.6 0 0 0 .7 3.2L2 4.6a8.7 8.7 0 0 1 6-2.4Z" />
                <path d="M8 5.9c1.3 0 2.5.5 3.4 1.3l1.3-1.4A6.8 6.8 0 0 0 8 4a6.8 6.8 0 0 0-4.7 1.8l1.3 1.4C5.5 6.4 6.7 5.9 8 5.9Z" />
                <path d="M8 9.6 10 7.6a3 3 0 0 0-4 0Z" transform="translate(0 1.8)" />
              </svg>
              <svg width="26" height="12" viewBox="0 0 26 12">
                <rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.4" />
                <rect x="2" y="2" width="19" height="8" rx="1.8" />
                <path d="M24 4v4a2 2 0 0 0 0-4Z" fillOpacity="0.4" />
              </svg>
            </span>
          </div>
          {children}
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
