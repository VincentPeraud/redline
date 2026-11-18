import type { ReactNode } from "react";
import { cx } from "./ui/index.js";
import styles from "./ReviewScreen.module.css";

/** Below this stage width the centred shortcuts reminder would reach the zoom bar on its line. */
export const ZOOM_BAR_ROOM = 860;

/**
 * The zoom bar of a review step (canvas or artboard), bottom right of the stage: − / % / +, then the step's own
 * buttons. `onValue` makes the % a button (back to how the step opened).
 */
export function ReviewZoomBar({
  label,
  testId,
  percent,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onValue,
  raised,
  children,
}: {
  label: string;
  testId: string;
  percent: number;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onValue?: () => void;
  /** On a narrow stage the bar sits just above the shortcuts reminder. */
  raised: boolean;
  children: ReactNode;
}) {
  const value = `${Math.round(percent * 100)} %`;
  return (
    <div className={cx(styles.canvasZoom, raised && styles.canvasZoomRaised)} role="group" aria-label={label} data-testid={testId}>
      <button type="button" className={styles.canvasZoomSign} aria-label="Dézoomer" title="Dézoomer" disabled={!canZoomOut} onClick={onZoomOut}>
        −
      </button>
      {onValue ? (
        <button type="button" className={styles.canvasZoomValue} title="Revenir au cadrage de l'étape" onClick={onValue}>
          {value}
        </button>
      ) : (
        <span className={styles.canvasZoomValue}>{value}</span>
      )}
      <button type="button" className={styles.canvasZoomSign} aria-label="Zoomer" title="Zoomer" disabled={!canZoomIn} onClick={onZoomIn}>
        +
      </button>
      <span aria-hidden="true" className={styles.canvasZoomSeparator} />
      {children}
    </div>
  );
}
