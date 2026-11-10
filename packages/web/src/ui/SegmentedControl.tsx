import type { ReactNode } from "react";
import { cx } from "./cx.js";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: ReactNode;
}

export interface SegmentedControlProps<Value extends string> {
  options: SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  ariaLabel: string;
  /** sm: the compact 26px track of toolbars (default); md: the 30px segments of a dialog section. */
  size?: "sm" | "md";
  /** Dimmed and inert, for a setting the viewer may read but not change. */
  disabled?: boolean;
}

/** Small radio group drawn as a grey track with a white selected segment (e.g. the effort low / medium / high). */
export function SegmentedControl<Value extends string>({ options, value, onChange, ariaLabel, size = "sm", disabled }: SegmentedControlProps<Value>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx(styles.track, size === "md" && styles.trackMd, disabled && styles.disabled)}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            className={cx(styles.segment, size === "md" && styles.segmentMd, checked && styles.checked)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
