import type { CSSProperties, ReactNode } from "react";
import type { ReviewPin } from "@redline/shared";
import { cx } from "./ui/index.js";
import { personName } from "./ReviewRemark.js";
import { popoverPlacement } from "./reviewPinRules.js";
import styles from "./ReviewScreen.module.css";

/** How far a second pin on the same element is shifted from the first (a pin is 26 px wide). */
export const PIN_SHIFT = 30;
const POPOVER = { width: 300, height: 210 };
const TOOLTIP = { width: 260, height: 90 };
/** Space between a pin and what opens next to it. */
const POPOVER_GAP = 14;

/** Where the panel of a pin (`popover`) or the read-only tooltip of someone else's pin opens: beside the pin, on the side with room, in percent of the layer. */
export function overlayStyle(kind: "popover" | "tooltip", at: { xPct: number; yPct: number }, size: { width: number; height: number }): CSSProperties {
  const box = kind === "popover" ? POPOVER : TOOLTIP;
  const gap = kind === "popover" ? POPOVER_GAP : 8;
  const below = kind === "popover" ? POPOVER_GAP : 24;
  const place = popoverPlacement(at, size, box);
  return {
    width: box.width,
    ...(place.horizontal === "right" ? { left: `calc(${at.xPct}% + ${gap}px)` } : { right: `calc(${100 - at.xPct}% + ${gap}px)` }),
    ...(place.vertical === "below" ? { top: `calc(${at.yPct}% + ${below}px)` } : { bottom: `calc(${100 - at.yPct}% + ${gap}px)` }),
  };
}

export const pinLabel = (pin: ReviewPin | undefined, noun: "Épingle" | "Zone"): string => {
  if (!pin) return noun === "Zone" ? "Nouvelle zone" : "Nouvelle épingle";
  return pin.mine ? `${noun} ${pin.number}` : `${noun} ${pin.number} de ${personName(pin.person)}`;
};

/** The read-only card shown when hovering (or tapping) someone else's pin. */
export function PinTooltip({ pin, style }: { pin: ReviewPin; style: CSSProperties }) {
  return (
    <div role="tooltip" className={styles.pinTip} style={style}>
      <b>
        {personName(pin.person)} · {pin.target.kind === "zone" ? "zone" : "épingle"} {pin.number}
      </b>
      {pin.text}
      <span>Lecture seule : seul {personName(pin.person)} peut la changer.</span>
    </div>
  );
}

/** One numbered pin button: hovering or focusing it names it as `hovered`; a click opens it for its author, and shows another member's on a touch screen. */
export function PinMarker({
  number,
  id,
  pin,
  label,
  className,
  style,
  finished,
  hovered,
  setHovered,
  onEdit,
  tapReads = true,
  markId = true,
  children,
}: {
  number: number;
  /** Written as `data-pin-id`, and what `setHovered` receives. */
  id: string;
  pin: ReviewPin | undefined;
  label: string;
  className?: string;
  style?: CSSProperties;
  finished: boolean;
  hovered?: string;
  setHovered: (id: string | undefined) => void;
  onEdit: (pinId: string) => void;
  /** Whether a tap on someone else's pin reads it (zones read on hover only). */
  tapReads?: boolean;
  /** Writes `data-pin-id` (the stage scrolls to the pin being edited by it; zones are not scrolled to). */
  markId?: boolean;
  children?: ReactNode;
}) {
  const mine = pin?.mine ?? true;
  return (
    <button
      type="button"
      data-pin={number}
      data-pin-id={markId ? id : undefined}
      data-pin-mine={mine}
      aria-label={label}
      className={cx(styles.pin, !mine && styles.pinTheirs, className)}
      style={style}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(undefined)}
      onFocus={() => setHovered(id)}
      onBlur={() => setHovered(undefined)}
      onClick={() => {
        if (pin?.mine && !finished) onEdit(pin.id);
        // A touch has no hover: a tap reads another member's pin.
        else if (tapReads && pin && !pin.mine) setHovered(hovered === id ? undefined : id);
      }}
    >
      {number}
      {children}
    </button>
  );
}
