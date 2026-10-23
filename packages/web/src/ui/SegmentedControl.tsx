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
}

/** Small radio group drawn as a grey track with a white selected segment (e.g. the effort low / medium / high). */
export function SegmentedControl<Value extends string>({ options, value, onChange, ariaLabel }: SegmentedControlProps<Value>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.track}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className={cx(styles.segment, checked && styles.checked)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
