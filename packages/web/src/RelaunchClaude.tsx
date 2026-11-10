import { useState } from "react";
import styles from "./RelaunchClaude.module.css";

/** "Relancer Claude" next to "annulation en cours": the design system's session is asked again to undo the refused change. */
export function RelaunchClaude({ changeId }: { changeId: string }) {
  const [sent, setSent] = useState(false);
  return (
    <button
      type="button"
      className={styles.link}
      disabled={sent}
      data-testid="relaunch-claude"
      onClick={() => {
        setSent(true);
        void fetch(`/api/changes/${changeId}/relaunch`, { method: "POST" }).finally(() => setTimeout(() => setSent(false), 4000));
      }}
    >
      {sent ? "Claude relancé" : "Relancer Claude"}
    </button>
  );
}
