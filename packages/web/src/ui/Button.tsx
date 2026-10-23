import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx.js";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: dark fill; accent: red fill (main call to action of a screen); secondary: white with border; ghost: no border; danger: warm outline for destructive actions. */
  variant?: ButtonVariant;
  /** sm: 30px (toolbars), md: 36px (rows, cards), lg: 40px (dialogs and screen actions). */
  size?: ButtonSize;
}

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx(styles.button, styles[variant], styles[size], className)} {...rest} />;
}
