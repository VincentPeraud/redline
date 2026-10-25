import { cloneElement, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.js";
import { placeTooltip, type TooltipPlacement, type TriggerBox } from "./tooltipPlacement.js";
import styles from "./Tooltip.module.css";

interface TriggerProps {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}

export interface TooltipProps {
  label: string;
  /** The single element that triggers the tooltip (an icon-only button). It is not wrapped, so layout is untouched. */
  children: ReactElement<TriggerProps>;
}

/** Dark bubble with a rotated-square arrow, shown on hover and keyboard focus of its child. Replaces the native `title` of icon-only buttons. */
export function Tooltip({ label, children }: TooltipProps) {
  const [trigger, setTrigger] = useState<TriggerBox | null>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!trigger || !bubble.current) {
      setPlacement(null);
      return;
    }
    const { width, height } = bubble.current.getBoundingClientRect();
    setPlacement(placeTooltip(trigger, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [trigger, label]);

  const show = (element: HTMLElement) => setTrigger(element.getBoundingClientRect());
  const hide = () => setTrigger(null);

  const child = children;
  return (
    <>
      {cloneElement(child, {
        onMouseEnter: (event) => {
          child.props.onMouseEnter?.(event);
          show(event.currentTarget);
        },
        onMouseLeave: (event) => {
          child.props.onMouseLeave?.(event);
          hide();
        },
        onFocus: (event) => {
          child.props.onFocus?.(event);
          if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
        },
        onBlur: (event) => {
          child.props.onBlur?.(event);
          hide();
        },
      })}
      {trigger &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            className={cx(styles.bubble, placement && styles[placement.side])}
            style={placement ? { left: placement.left, top: placement.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {label}
            <span aria-hidden="true" className={styles.arrow} style={{ left: placement?.arrowLeft ?? 0 }} />
          </div>,
          document.body,
        )}
    </>
  );
}
