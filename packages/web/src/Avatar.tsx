import styles from "./Avatar.module.css";

/** Class of the 32 px dark circle holding a person's initials: on a span (`Avatar`) or on a button. */
export const avatarClassName = styles.avatar;

export function Avatar({ initials }: { initials: string }) {
  return (
    <span aria-hidden="true" className={styles.avatar}>
      {initials}
    </span>
  );
}
