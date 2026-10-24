import type { ReactNode } from "react";
import type { ArtboardDevice } from "@redline/shared";
import { cx } from "./ui/index.js";
import styles from "./PlayDevice.module.css";

interface Props {
  device: ArtboardDevice;
  /** Address bar text of the desktop presentation. */
  url?: string;
  children: ReactNode;
}

/** The decorative shell around the artboard iframe, at its natural size (the caller scales it). */
export function PlayDevice({ device, url, children }: Props) {
  switch (device) {
    case "phone":
      return (
        <div className={cx(styles.shell, styles.phone)} data-device="phone">
          {children}
          <span aria-hidden="true" className={styles.camera} />
          <span aria-hidden="true" className={styles.phoneIndicator} />
        </div>
      );
    case "tablet":
      return (
        <div className={cx(styles.shell, styles.tablet)} data-device="tablet">
          <span aria-hidden="true" className={styles.tabletCamera} />
          {children}
          <div className={styles.tabletStrip}>
            <span aria-hidden="true" className={styles.tabletIndicator} />
          </div>
        </div>
      );
    case "desktop":
      return (
        <div className={cx(styles.shell, styles.desktop)} data-device="desktop">
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
        <div className={cx(styles.shell, styles.paper)} data-device="paper">
          {children}
        </div>
      );
    case "none":
      return (
        <div className={cx(styles.shell, styles.none)} data-device="none">
          {children}
        </div>
      );
  }
}
