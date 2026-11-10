import { RESPONSIVE_FORMATS, renderingKey, type ArtboardRendering, type ResponsiveFormat } from "@redline/shared";
import { cx } from "./ui/index.js";
import styles from "./RenderingControls.module.css";

interface ChipsProps {
  renderings: readonly ArtboardRendering[];
  hidden: ReadonlySet<string>;
  /** Threads pinned in each hidden rendering, by rendering key. */
  hiddenThreadCounts: Readonly<Record<string, number>>;
  onToggle: (key: string) => void;
}

/** One chip per rendering of a responsive frame, in its strip: pressed = shown on the canvas. */
export function RenderingChips({ renderings, hidden, hiddenThreadCounts, onToggle }: ChipsProps) {
  return (
    <div role="group" aria-label="Rendus affichés sur le canvas" className={styles.chips}>
      {renderings.map((rendering) => {
        const key = renderingKey(rendering);
        const on = !hidden.has(key);
        const threads = on ? 0 : (hiddenThreadCounts[key] ?? 0);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            title="Afficher ou masquer ce rendu sur le canvas"
            className={cx(styles.chip, on && styles.chipOn)}
            onClick={() => onToggle(key)}
          >
            <span aria-hidden="true" className={styles.dot} />
            {RESPONSIVE_FORMATS[rendering.format].label}
            {threads > 0 && ` · ${threads} ${threads > 1 ? "fils masqués" : "fil masqué"}`}
          </button>
        );
      })}
    </div>
  );
}

interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Formats present on the page, with the number of responsive frames that have them. */
  formats: readonly { format: ResponsiveFormat; frames: number }[];
  hiddenFormats: readonly ResponsiveFormat[];
  onToggle: (format: ResponsiveFormat, shown: boolean) => void;
}

function RenderingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="13" height="10" rx="1.5" />
      <rect x="17" y="8" width="5" height="11" rx="1" />
      <path d="M6 19h5" />
    </svg>
  );
}

/** "Rendus" in the canvas bottom bar: shows or hides a format in every responsive frame of the page. */
export function RenderingsMenu({ open, onOpenChange, formats, hiddenFormats, onToggle }: MenuProps) {
  const hiddenCount = formats.filter(({ format }) => hiddenFormats.includes(format)).length;
  const shownCount = formats.length - hiddenCount;
  return (
    <div data-no-pan className={styles.menuWrap}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        title="Rendus responsive affichés sur la page"
        className={cx(styles.menuButton, open && styles.menuButtonOpen)}
        onClick={() => onOpenChange(!open)}
      >
        <RenderingsIcon />
        Rendus{hiddenCount > 0 && ` · ${hiddenCount} ${hiddenCount > 1 ? "masqués" : "masqué"}`}
      </button>
      {open && (
        <div role="group" aria-label="Rendus affichés sur toute la page" className={styles.menu}>
          <div className={styles.menuTitle}>Rendus sur la page</div>
          {formats.map(({ format, frames }) => {
            const on = !hiddenFormats.includes(format);
            return (
              <label key={format} className={styles.row}>
                <input type="checkbox" checked={on} disabled={on && shownCount === 1} className={styles.checkbox} onChange={() => onToggle(format, !on)} />
                {RESPONSIVE_FORMATS[format].label}
                <span className={styles.spacer} />
                <span className={styles.count}>
                  {frames} {frames > 1 ? "cadres" : "cadre"}
                </span>
              </label>
            );
          })}
          <div className={styles.menuHint}>S'applique à tous les cadres responsive. Les puces d'un cadre gardent leurs exceptions.</div>
        </div>
      )}
    </div>
  );
}
