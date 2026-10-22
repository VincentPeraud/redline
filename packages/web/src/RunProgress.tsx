import { retryRunPath, type RunStep, type ThreadRun } from "@redline/shared";
import { Button, cx } from "./ui/index.js";
import styles from "./Thread.module.css";

const TOOL_VERB: Record<string, string> = {
  Read: "Lit",
  Edit: "Modifie",
  MultiEdit: "Modifie",
  Write: "Écrit",
  Bash: "Exécute",
  Glob: "Cherche",
  Grep: "Cherche",
};

function stepLabel(step: RunStep): string {
  return `${TOOL_VERB[step.tool] ?? step.tool} ${step.summary}`;
}

function retryLabel(run: ThreadRun): string {
  const at = run.retryAt ? new Date(run.retryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
  return run.limit ? `Limite d'abonnement atteinte, reprise vers ${at}` : `Nouvelle tentative vers ${at}`;
}

function Steps({ run, current }: { run: ThreadRun; current: boolean }) {
  if (run.steps.length === 0) return null;
  return (
    <ol data-testid="run-steps" className={styles.steps}>
      {run.steps.map((step, i) => (
        <li key={i} className={current && i === run.steps.length - 1 ? styles.stepCurrent : undefined}>
          {stepLabel(step)}
        </li>
      ))}
    </ol>
  );
}

function StreamedText({ run, live }: { run: ThreadRun; live: boolean }) {
  if (run.text === "") return null;
  return (
    <details className={styles.details}>
      <summary>{live ? "Texte de Claude en direct" : "Texte de Claude"}</summary>
      <div data-testid="run-text" className={styles.liveText}>
        {run.text}
      </div>
    </details>
  );
}

/** Live state of the run that answers a thread or a conversation message; a finished run folds into a "Étapes de Claude" detail. */
export function RunProgress({ run, label = "Claude travaille sur ce fil…" }: { run: ThreadRun; label?: string }) {
  if (run.status === "failed") {
    const retry = () => void fetch(retryRunPath(run.pageId, run.workId), { method: "POST" });
    const error = run.error ? `${run.error}${/[.!?]$/.test(run.error) ? " " : ". "}` : "";
    return (
      <div data-testid="run" className={styles.failedBox}>
        <div data-testid="run-failed" className={styles.failedMessage}>
          {error}Rien n'a été publié, la page est restée comme avant.
        </div>
        <Button size="sm" onClick={retry}>
          Relancer
        </Button>
      </div>
    );
  }

  if (run.status === "answered") {
    if (run.steps.length === 0 && run.text === "") return <span data-testid="run-status" data-status="answered" hidden />;
    return (
      <details data-testid="run" className={styles.details}>
        <summary>Étapes de Claude</summary>
        <div className={styles.progress}>
          <span data-testid="run-status" data-status="answered" className={styles.pastStatus}>
            Répondu
          </span>
          <Steps run={run} current={false} />
          <StreamedText run={run} live={false} />
        </div>
      </details>
    );
  }

  const retrying = run.status === "retrying";
  return (
    <div data-testid="run" className={styles.progress}>
      <div data-testid="run-status" data-status={run.status} className={cx(styles.working, retrying && styles.workingRetry)}>
        <span aria-hidden="true" className={styles.dots}>
          <span />
          <span />
          <span />
        </span>
        {retrying ? retryLabel(run) : label}
      </div>
      <Steps run={run} current />
      <StreamedText run={run} live />
    </div>
  );
}
