import { useEffect, useRef } from "react";
import { TocList } from "./TocList.js";
import type { TocItem } from "./tocItems.js";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import { cx } from "./ui/index.js";
import styles from "./PlayMode.module.css";

type Variant = "header" | "phone";

interface Props {
  /** The desktop header and the phone bar share the behaviour; only the markup details differ. */
  variant: Variant;
  tocItems: TocItem[];
  current: string;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  goBy: (step: -1 | 1) => void;
  onChoose: (file: string) => void;
}

const VARIANTS = {
  header: {
    previousLabel: "Artboard précédent (←)",
    previousTitle: "Artboard précédent (←)",
    nextLabel: "Artboard suivant (→)",
    nextTitle: "Artboard suivant (→)",
    counterTitle: "Sommaire",
    step: styles.step,
    counterWrap: styles.counterWrap,
    menu: styles.menu,
    chevron: true,
    counterClass: (menuOpen: boolean) => cx(styles.counter, menuOpen && styles.counterOpen),
    counterLabel: (_position: number, _total: number): string | undefined => undefined,
  },
  phone: {
    previousLabel: "Artboard précédent",
    previousTitle: undefined,
    nextLabel: "Artboard suivant",
    nextTitle: undefined,
    counterTitle: undefined,
    step: styles.mobileStep,
    counterWrap: styles.mobileCounterWrap,
    menu: cx(styles.menu, styles.mobileMenu),
    chevron: false,
    counterClass: (_menuOpen: boolean) => styles.mobileCounter,
    counterLabel: (position: number, total: number): string | undefined => `Sommaire, artboard ${position + 1} sur ${total}`,
  },
} satisfies Record<Variant, object>;

/** "‹ n / N ›" with the contents menu under the counter: previous, counter, next. */
export function PlayStepper({ variant, tocItems, current, menuOpen, onMenuOpenChange, goBy, onChoose }: Props) {
  const menuRoot = useRef<HTMLSpanElement>(null);
  const v = VARIANTS[variant];
  const position = tocItems.findIndex((item) => item.file === current);

  useCloseOnOutsidePointer(menuRoot, menuOpen, () => onMenuOpenChange(false));
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => onMenuOpenChange(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [menuOpen, onMenuOpenChange]);

  return (
    <>
      <button type="button" aria-label={v.previousLabel} title={v.previousTitle} disabled={position <= 0} onClick={() => goBy(-1)} className={v.step}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <span ref={menuRoot} className={v.counterWrap}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={v.counterLabel(position, tocItems.length)}
          title={v.counterTitle}
          onClick={() => onMenuOpenChange(!menuOpen)}
          className={v.counterClass(menuOpen)}
        >
          {position < 0 ? tocItems.length : `${position + 1} / ${tocItems.length}`}
          {v.chevron && (
            <>
              {" "}
              <span aria-hidden="true" className={styles.counterChevron}>▼</span>
            </>
          )}
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Sommaire de la page" className={v.menu}>
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
      <button type="button" aria-label={v.nextLabel} title={v.nextTitle} disabled={position < 0 || position >= tocItems.length - 1} onClick={() => goBy(1)} className={v.step}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </>
  );
}
