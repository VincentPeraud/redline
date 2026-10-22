import { retryRunPath, type RunStatus, type ThreadRun } from "@redline/shared";

const STATUS_LABEL: Record<RunStatus, string> = {
  sent: "Sent",
  running: "Running",
  answered: "Answered",
  retrying: "Nouvelle tentative",
  failed: "Échec",
};

function retryLabel(run: ThreadRun): string {
  const at = run.retryAt ? new Date(run.retryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
  return run.limit ? `Limite d'abonnement atteinte, reprise vers ${at}` : `Nouvelle tentative vers ${at}`;
}

/** Status, steps and streamed text of the run that answers a thread. */
export function RunProgress({ run }: { run: ThreadRun }) {
  const retry = () => void fetch(retryRunPath(run.pageId, run.workId), { method: "POST" });
  return (
    <div data-testid="run" style={{ margin: "6px 0", font: "12px system-ui", color: "#555" }}>
      <div data-testid="run-status" data-status={run.status}>
        {run.status === "retrying" ? retryLabel(run) : STATUS_LABEL[run.status]}
        {run.error && `: ${run.error}`}
      </div>
      {run.status === "failed" && (
        <div data-testid="run-failed">
          Rien n'a été publié.{" "}
          <button onClick={retry}>Relancer</button>
        </div>
      )}
      {run.steps.length > 0 && (
        <ul data-testid="run-steps" style={{ margin: "4px 0", paddingLeft: 16 }}>
          {run.steps.map((step, i) => (
            <li key={i}>
              {step.tool} <code>{step.summary}</code>
            </li>
          ))}
        </ul>
      )}
      {run.text !== "" && (
        <details>
          <summary>Claude's text</summary>
          <div data-testid="run-text" style={{ whiteSpace: "pre-wrap" }}>
            {run.text}
          </div>
        </details>
      )}
    </div>
  );
}
