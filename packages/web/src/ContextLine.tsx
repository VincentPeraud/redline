import { CONTEXT_WARNING_PERCENT, newSessionPath, type Thread } from "@redline/shared";
import { cx } from "./ui/index.js";
import styles from "./Thread.module.css";

/** "model · effort · context %" of a thread; orange from 70 % with the "Nouvelle session" button. */
export function ContextLine({ thread }: { thread: Thread }) {
  const { context, newSession } = thread;
  if (!context) {
    return newSession === "ready" ? (
      <div data-testid="context" className={styles.contextText}>
        Nouvelle session prête
      </div>
    ) : null;
  }
  const warn = context.percent >= CONTEXT_WARNING_PERCENT;
  const parts = [context.model, context.effort].filter(Boolean).join(" · ");
  return (
    <div data-testid="context" data-warn={warn} className={styles.context}>
      <span className={styles.contextText}>
        {parts ? `${parts} · ` : ""}
        <span className={cx(warn && styles.contextWarn)}>{context.percent} %</span>
      </span>
      <span className={styles.spacer} />
      {warn && newSession !== "ready" && (
        <button
          type="button"
          className={styles.newSession}
          disabled={newSession === "summarizing"}
          title="Ferme cette session et en ouvre une nouvelle sur ce fil, à partir d'un résumé"
          onClick={() => void fetch(newSessionPath(thread.id), { method: "POST" })}
        >
          {newSession === "summarizing" ? "Résumé en cours…" : "Nouvelle session"}
        </button>
      )}
    </div>
  );
}
