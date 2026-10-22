import { EFFORTS, MODEL_CHOICES, type Effort, type ModelChoice } from "@redline/shared";
import { SegmentedControl } from "./ui/index.js";
import styles from "./ModelEffortControls.module.css";

const AGENT_DEFAULT = "défaut de l'agent";

export type ModelEffortChoice = ModelChoice;

/** What the serving agent uses when nothing is chosen: shown as the selected model and effort. */
export type AgentDefaults = ModelChoice;

/** A model list and a separate segmented effort control; each reads "défaut de l'agent" until changed. */
export function ModelEffortControls({ value, onChange, defaults }: { value: ModelEffortChoice; onChange: (value: ModelEffortChoice) => void; defaults?: AgentDefaults }) {
  const defaultModel = MODEL_CHOICES.find((m) => m.id === defaults?.model)?.label;
  return (
    <div className={styles.row}>
      <span className={styles.selectWrap}>
        <select
          aria-label="Modèle"
          className={styles.select}
          value={value.model ?? ""}
          onChange={(e) => onChange({ ...value, model: e.target.value || undefined })}
        >
          <option value="">{defaultModel ?? "Modèle par défaut"}</option>
          {MODEL_CHOICES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className={styles.chevron}>
          ▼
        </span>
      </span>
      <SegmentedControl<string>
        ariaLabel="Effort"
        options={EFFORTS.map((effort) => ({ value: effort, label: effort }))}
        value={value.effort ?? defaults?.effort ?? ""}
        onChange={(effort) => onChange({ ...value, effort: effort === value.effort ? undefined : (effort as Effort) })}
      />
      {value.effort === undefined && (
        <span data-testid="effort-default" className={styles.default}>
          {AGENT_DEFAULT}
        </span>
      )}
    </div>
  );
}
