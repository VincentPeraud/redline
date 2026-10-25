import { createContext, useCallback, useRef, useState } from "react";
import type { Gap, PageGaps } from "@redline/shared";
import { gapCountLabel, gapSuggestion, gapSummary, type Piece } from "./gapLabels.js";
import { Button, Tooltip, cx } from "./ui/index.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import styles from "./GapsReport.module.css";

/** The gap "Voir" points at: the artboard whose iframe outlines `selector`, `nonce` making a second "Voir" on the same gap act again. */
export interface SeenGap {
  src: string;
  selector: string;
  nonce: number;
}

export interface SeenGapContextValue {
  seen: SeenGap | null;
  /** The outlined element's box in page pixels, reported by the artboard bridge. */
  onRect: (rect: { x: number; y: number; width: number; height: number }) => void;
}

export const SeenGapContext = createContext<SeenGapContextValue>({ seen: null, onRect: () => undefined });

function Pieces({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((piece, index) =>
        typeof piece === "string" ? piece : (
          <code key={index} className={cx(styles.code, piece.large && styles.codeLarge)}>
            {piece.code}
          </code>
        ),
      )}
    </>
  );
}

function GapRow({ gap, onSee }: { gap: Gap; onSee: (gap: Gap) => void }) {
  const suggestion = gapSuggestion(gap);
  return (
    <li data-gap={gap.key} data-gap-kind={gap.kind} className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.file}>{gap.file}</span>
        {gap.kind === "deprecated" && <span className={styles.deprecated}>déprécié</span>}
        <span className={styles.spacer} />
        {gap.selector !== null && (
          <Button size="sm" className={styles.rowButton} onClick={() => onSee(gap)}>
            Voir
          </Button>
        )}
      </div>
      <div className={styles.summary}>
        <Pieces pieces={gapSummary(gap)} />
      </div>
      {suggestion && (
        <div className={styles.suggestion}>
          <Pieces pieces={suggestion} />
        </div>
      )}
    </li>
  );
}

/** "◆ N écarts" next to the page menu and its list; nothing while the page has no gap. */
export function GapsButton({ report, onSee }: { report: PageGaps | null; onSee: (gap: Gap) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsidePointer(root, open, close);
  if (!report || report.gaps.length === 0) return null;
  const label = gapCountLabel(report.gaps.length);
  const trigger = (
    <button type="button" data-testid="gaps-button" aria-haspopup="dialog" aria-expanded={open} className={styles.button} onClick={() => setOpen(!open)}>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className={styles.diamond}>
        <path d="M12 2l10 10-10 10L2 12z" fill="currentColor" />
      </svg>
      {label}
    </button>
  );
  return (
    <div ref={root} className={styles.root}>
      {open ? trigger : <Tooltip label={`Écarts au design system ${report.designSystemTitle}`}>{trigger}</Tooltip>}
      {open && (
        <div role="dialog" aria-label="Écarts au design system" className={styles.popover} onKeyDown={(event) => event.key === "Escape" && close()}>
          <div className={styles.head}>
            <div className={styles.title}>{label} au design system</div>
            <div className={styles.lead}>
              Ce qui n'utilise ni les tokens ni les composants de {report.designSystemTitle} et du style du projet. Rien n'est bloqué.
            </div>
          </div>
          <ul className={styles.list}>
            {report.gaps.map((gap) => (
              <GapRow key={gap.key} gap={gap} onSee={(seen) => {
                close();
                onSee(seen);
              }} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
