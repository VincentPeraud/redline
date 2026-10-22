import { EFFORTS, MODEL_CHOICES, type Effort } from "@redline/shared";

const AGENT_DEFAULT = "défaut de l'agent";

export interface ModelEffortChoice {
  model?: string;
  effort?: Effort;
}

/** A model list and a separate segmented effort control; each reads "défaut de l'agent" until changed. */
export function ModelEffortControls({ value, onChange }: { value: ModelEffortChoice; onChange: (value: ModelEffortChoice) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
      <select
        aria-label="Modèle"
        value={value.model ?? ""}
        onChange={(e) => onChange({ ...value, model: e.target.value || undefined })}
      >
        <option value="">Modèle : {AGENT_DEFAULT}</option>
        {MODEL_CHOICES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <div role="radiogroup" aria-label="Effort" style={{ display: "inline-flex" }}>
        {EFFORTS.map((effort) => (
          <button
            key={effort}
            type="button"
            role="radio"
            aria-checked={value.effort === effort}
            onClick={() => onChange({ ...value, effort: value.effort === effort ? undefined : effort })}
            style={{ fontWeight: value.effort === effort ? 700 : 400 }}
          >
            {effort}
          </button>
        ))}
      </div>
      {value.effort === undefined && <span data-testid="effort-default">Effort : {AGENT_DEFAULT}</span>}
    </div>
  );
}
