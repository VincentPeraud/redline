import type { RunStatus, ThreadRun } from "@redline/shared";

const STATUS_LABEL: Record<RunStatus, string> = {
  sent: "Sent",
  running: "Running",
  answered: "Answered",
  failed: "Failed",
};

/** Status, steps and streamed text of the run that answers a thread. */
export function RunProgress({ run }: { run: ThreadRun }) {
  return (
    <div data-testid="run" style={{ margin: "6px 0", font: "12px system-ui", color: "#555" }}>
      <div data-testid="run-status" data-status={run.status}>
        {STATUS_LABEL[run.status]}
        {run.error && `: ${run.error}`}
      </div>
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
