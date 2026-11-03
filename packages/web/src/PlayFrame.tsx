import type { ReactNode } from "react";
import { cx } from "./ui/index.js";
import { statusBarInk, type PresentationFrame } from "./playFrames.js";
import styles from "./PlayFrame.module.css";

interface Props {
  frame: PresentationFrame;
  /** Address bar text of the browser frame. */
  url?: string;
  /** Background at the top of the page: the phone's status bar takes it, as Safari on iOS 26 does. */
  statusColour?: string;
  children: ReactNode;
}

/** The decorative shell around the artboard iframe, at its natural size (the caller scales it). */
export function PlayFrame({ frame, url, statusColour, children }: Props) {
  switch (frame) {
    case "phone":
      return (
        <div className={cx(styles.shell, styles.phone)} data-frame="phone">
          <div aria-hidden="true" className={styles.statusBar} data-ink={statusColour ? statusBarInk(statusColour) : "dark"} style={statusColour ? { background: statusColour } : undefined}>
            <span className={styles.statusTime}>9:41</span>
            <span className={styles.camera} />
            <span className={styles.statusIcons}>
              <svg width="18" height="12" viewBox="0 0 18 12">
                <rect x="0" y="7.5" width="3.2" height="4.5" rx="1" />
                <rect x="4.9" y="5" width="3.2" height="7" rx="1" />
                <rect x="9.8" y="2.5" width="3.2" height="9.5" rx="1" />
                <rect x="14.7" y="0" width="3.2" height="12" rx="1" />
              </svg>
              <svg width="16" height="12" viewBox="0 0 16 12">
                <path d="M8 11.4 5.6 9a3.4 3.4 0 0 1 4.8 0Z" />
                <path d="M3.6 6.9a6.2 6.2 0 0 1 8.8 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M1.2 4.4a9.6 9.6 0 0 1 13.6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <svg width="27" height="13" viewBox="0 0 27 13">
                <rect x="0.5" y="0.5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" strokeOpacity="0.35" />
                <rect x="2" y="2" width="20" height="9" rx="2.5" />
                <path d="M25 4.5v4a2.2 2.2 0 0 0 0-4Z" fillOpacity="0.4" />
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
