import { useEffect, useRef, useState } from "react";
import { modelLabel, type AgentInfo, type Project, type Settings, type UpdateProjectRequest } from "@redline/shared";
import { TAKEOVER_CHOICES, choiceOfOverride, overrideOfChoice, takeoverSentence, type TakeoverChoice } from "./takeoverChoice.js";
import { cx } from "./ui/index.js";
import styles from "./AgentPill.module.css";

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function pillText(project: Project): { online: boolean; text: string } {
  const { servedBy } = project;
  if (servedBy?.kind === "global") return { online: true, text: `Agent global ${servedBy.machine} connecté` };
  if (servedBy) return { online: true, text: `Agent ${folderName(servedBy.folder)} connecté` };
  return { online: false, text: "Aucun agent connecté" };
}

const CHOICE_LABELS: Record<TakeoverChoice, (general: boolean | null) => string> = {
  general: (general) => (general === null ? "Comme le réglage général" : `Comme le réglage général (${takeoverSentence(general)})`),
  wait: () => "Le fil attend",
  relay: () => "L'agent global le prend",
};

interface Props {
  project: Project;
  onProjectChange: (project: Project) => void;
}

/** The agent pill of the Overview top bar; opens the agent's details and the per-project routing exception. */
export function AgentPill({ project, onProjectChange }: Props) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pill = pillText(project);
  const shown = project.servedBy ?? project.agent ?? null;
  const choice = choiceOfOverride(project.globalTakeoverOverride);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/settings")
      .then((res) => res.json() as Promise<Settings>)
      .then(setSettings);
    void fetch("/api/agents")
      .then((res) => res.json() as Promise<AgentInfo[]>)
      .then((agents) => setAgent(agents.find((a) => a.id === shown?.id) ?? null));
  }, [open, shown?.id]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function choose(next: TakeoverChoice) {
    const body: UpdateProjectRequest = { globalTakeoverOverride: overrideOfChoice(next) };
    const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    onProjectChange((await res.json()) as Project);
  }

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={button}
        type="button"
        data-testid="agent-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(styles.pill, !pill.online && styles.pillOff)}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true" className={cx(styles.dot, pill.online && styles.dotOnline)} />
        {pill.text}
      </button>
      {open && (
        <div role="dialog" aria-label="Agent du projet" className={styles.popover}>
          <div className={styles.details}>
            <div className={styles.name}>{shown ? (project.servedBy?.kind === "global" ? `Agent global ${shown.machine}` : `Agent ${folderName(shown.folder)}`) : "Aucun agent"}</div>
            {shown ? (
              <>
                <div className={styles.folder}>{shown.folder}</div>
                <div className={styles.secondary}>
                  {shown.machine} · {project.servedBy ? "en ligne" : "hors ligne"}
                </div>
                {agent && (
                  <div className={styles.secondary}>
                    {agent.model ? modelLabel(agent.model) : "modèle par défaut"} · {agent.effort ?? "effort par défaut"}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.secondary}>Aucun agent n'est lié à ce projet.</div>
            )}
          </div>
          <div className={styles.divider} />
          <div role="radiogroup" aria-label="Quand aucun agent ne tourne pour ce projet" className={styles.setting}>
            <div className={styles.settingTitle}>Quand aucun agent ne tourne pour ce projet</div>
            {TAKEOVER_CHOICES.map((option) => (
              <label key={option} className={cx(styles.option, option === choice && styles.optionOn)}>
                <input type="radio" className={styles.radio} name="project-takeover" checked={option === choice} onChange={() => void choose(option)} />
                {CHOICE_LABELS[option](settings?.globalTakeover ?? null)}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
