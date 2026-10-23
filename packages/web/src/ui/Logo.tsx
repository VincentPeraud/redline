import styles from "./Logo.module.css";

/** The redline mark: four corner brackets around a red line, and the wordmark. */
export function Logo({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <span className={styles.logo}>
      <svg width="20" height="20" viewBox="0 0 64 64" aria-hidden="true">
        <g fill="none" stroke="#18181B" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 20V6h14" />
          <path d="M44 6h14v14" />
          <path d="M58 44v14H44" />
          <path d="M20 58H6V44" />
        </g>
        <path d="M20 32h24" stroke="#D92D20" strokeWidth="6" strokeLinecap="round" />
      </svg>
      {wordmark ? <span className={styles.wordmark}>redline</span> : null}
    </span>
  );
}
