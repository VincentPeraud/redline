import { cx } from "./ui/index.js";
import styles from "./Avatar.module.css";

/** Class of the 32 px dark circle holding a person's initials: on a span (`Avatar`) or on a button. */
export const avatarClassName = styles.avatar;

/** `small` is the 20 px circle of a list row; `muted` is the light one of someone other than the viewer. */
export function Avatar({ initials, small, muted }: { initials: string; small?: true; muted?: true }) {
  return (
    <span aria-hidden="true" className={cx(styles.avatar, small && styles.small, muted && styles.muted)}>
      {initials}
    </span>
  );
}
