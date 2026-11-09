import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "./cx.js";
import styles from "./fields.module.css";

export interface FieldProps {
  label: ReactNode;
  /** Appends "(facultatif)" in muted text. */
  optional?: boolean;
  /** Muted help line under the control. */
  hint?: ReactNode;
  /** Wraps the control in a label, so clicking the text focuses it. */
  children: ReactNode;
  className?: string;
}

/** Label above a control (13px, medium), with optional marker and hint. */
export function Field({ label, optional, hint, children, className }: FieldProps) {
  return (
    <label className={cx(styles.field, className)}>
      <span>
        {label}
        {optional ? <span className={styles.optional}> (facultatif)</span> : null}
      </span>
      {children}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** md: 36px, 13px text (filters, search); lg: 44px, 15px text (forms and dialogs). */
  size?: "md" | "lg";
}

export function TextInput({ size = "lg", className, ...rest }: TextInputProps) {
  return <input className={cx(styles.control, styles.input, styles[size], className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(styles.control, styles.textarea, className)} {...rest} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  /** sm: 32px, 12px text; md: 36px, 14px text; lg: 44px, 14px text. */
  size?: "sm" | "md" | "lg";
}

/** Native select drawn with the mock-up's chevron; pass `<option>` children. */
export function Select({ size = "md", className, children, ...rest }: SelectProps) {
  return (
    <span className={styles.selectWrap}>
      <select className={cx(styles.control, styles.select, styles[`select-${size}`], className)} {...rest}>
        {children}
      </select>
      <svg className={styles.chevron} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}
