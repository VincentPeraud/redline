import type { ProjectVisibility } from "@redline/shared";
import { StatusBadge } from "./ui/index.js";
import styles from "./VisibilityBadge.module.css";

export const VISIBILITY_LABEL: Record<ProjectVisibility, string> = { team: "Équipe", private: "Privé" };

/** "Équipe" or "Privé" (with a padlock): the same chip on the project list and the project page. */
export function VisibilityBadge({ visibility }: { visibility: ProjectVisibility }) {
  return (
    <StatusBadge tone="neutral" size="sm" className={styles.badge} data-testid="visibility-badge">
      {visibility === "private" && (
        <svg className={styles.lock} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      )}
      {VISIBILITY_LABEL[visibility]}
    </StatusBadge>
  );
}
