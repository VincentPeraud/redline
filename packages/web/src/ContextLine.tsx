import { CONTEXT_WARNING_PERCENT, newSessionPath, type Thread } from "@redline/shared";

/** "model · effort · context %" of a thread; orange from 70 % with the "Nouvelle session" button. */
export function ContextLine({ thread }: { thread: Thread }) {
  const { context, newSession } = thread;
  if (!context) return newSession === "ready" ? <div data-testid="context">Nouvelle session prête</div> : null;
  const warn = context.percent >= CONTEXT_WARNING_PERCENT;
  return (
    <div data-testid="context" data-warn={warn} style={{ font: "12px system-ui", color: warn ? "#d9730d" : "#555" }}>
      {[context.model, context.effort, `${context.percent} %`].filter(Boolean).join(" · ")}
      {warn && newSession !== "ready" && (
        <button
          disabled={newSession === "summarizing"}
          style={{ marginLeft: 8 }}
          onClick={() => void fetch(newSessionPath(thread.id), { method: "POST" })}
        >
          {newSession === "summarizing" ? "Résumé en cours…" : "Nouvelle session"}
        </button>
      )}
    </div>
  );
}
