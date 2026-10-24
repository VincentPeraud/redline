import { useEffect, useRef } from "react";
import { TocList } from "./TocList.js";
import type { TocItem } from "./tocItems.js";
import { cx } from "./ui/index.js";
import styles from "./PlayMode.module.css";

interface Props {
  /** The desktop header and the phone bar share the behaviour; only the markup details differ. */
  variant: "header" | "phone";
  tocItems: TocItem[];
  current: string;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  goBy: (step: -1 | 1) => void;
  onChoose: (file: string) => void;
}

/** "‹ n / N ›" with the contents menu under the counter: previous, counter, next. */
export function PlayStepper({ variant, tocItems, current, menuOpen, onMenuOpenChange, goBy, onChoose }: Props) {
  const menuRoot = useRef<HTMLSpanElement>(null);
  const phone = variant === "phone";
  const position = tocItems.findIndex((item) => item.file === current);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => onMenuOpenChange(false);
    const onPointer = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen, onMenuOpenChange]);

  return (
    <>
      <button type="button" aria-label={phone ? "Artboard précédent" : "Artboard précédent (←)"} title={phone ? undefined : "Artboard précédent (←)"} disabled={position <= 0} onClick={() => goBy(-1)} className={phone ? styles.mobileStep : styles.step}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <span ref={menuRoot} className={phone ? styles.mobileCounterWrap : styles.counterWrap}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={phone ? `Sommaire, artboard ${position + 1} sur ${tocItems.length}` : undefined}
          title={phone ? undefined : "Sommaire"}
          onClick={() => onMenuOpenChange(!menuOpen)}
          className={phone ? styles.mobileCounter : cx(styles.counter, menuOpen && styles.counterOpen)}
        >
          {position < 0 ? tocItems.length : `${position + 1} / ${tocItems.length}`}
          {!phone && (
            <>
              {" "}
              <span aria-hidden="true" className={styles.counterChevron}>▼</span>
            </>
          )}
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Sommaire de la page" className={cx(styles.menu, phone && styles.mobileMenu)}>
            <TocList
              items={tocItems.map((item) => ({ ...item, openThreads: 0 }))}
              currentFile={current}
              autoFocusFilter
              onSelect={(file) => {
                onMenuOpenChange(false);
                onChoose(file);
              }}
            />
          </div>
        )}
      </span>
      <button type="button" aria-label={phone ? "Artboard suivant" : "Artboard suivant (→)"} title={phone ? undefined : "Artboard suivant (→)"} disabled={position < 0 || position >= tocItems.length - 1} onClick={() => goBy(1)} className={phone ? styles.mobileStep : styles.step}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </>
  );
}
