import { DEFAULT_TWEAK_MAX, DEFAULT_TWEAK_MIN, type ManifestTweak, type TweakValue, type TweakValues } from "@redline/shared";

interface Props {
  tweaks: ManifestTweak[];
  values: TweakValues;
  onChange: (id: string, value: TweakValue) => void;
}

function Control({ tweak, value, onChange }: { tweak: ManifestTweak; value: TweakValue; onChange: (value: TweakValue) => void }) {
  const min = tweak.min ?? DEFAULT_TWEAK_MIN;
  const max = tweak.max ?? DEFAULT_TWEAK_MAX;
  switch (tweak.type) {
    case "color":
      return <input type="color" aria-label={tweak.label} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
    case "choice":
      return (
        <span role="group" aria-label={tweak.label} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(tweak.options ?? []).map((option) => (
            <button key={option} aria-pressed={option === value} onClick={() => onChange(option)} style={{ fontWeight: option === value ? 700 : 400 }}>
              {option}
            </button>
          ))}
        </span>
      );
    case "toggle":
      return <input type="checkbox" aria-label={tweak.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "range":
      return (
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="range" aria-label={tweak.label} min={min} max={max} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
          <output>{String(value)}</output>
        </span>
      );
    case "count":
      return (
        <span role="group" aria-label={tweak.label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button aria-label={`Diminuer ${tweak.label}`} disabled={Number(value) <= min} onClick={() => onChange(Number(value) - 1)}>
            -
          </button>
          <output>{String(value)}</output>
          <button aria-label={`Augmenter ${tweak.label}`} disabled={Number(value) >= max} onClick={() => onChange(Number(value) + 1)}>
            +
          </button>
        </span>
      );
    case "text":
      return <input type="text" aria-label={tweak.label} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** One control per declared tweak; shared by the canvas sidebar and play mode. */
export function TweaksPanel({ tweaks, values, onChange }: Props) {
  if (tweaks.length === 0) return null;
  return (
    <div data-testid="tweaks">
      <h4>Tweaks</h4>
      {tweaks.map((tweak) => (
        <div key={tweak.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "4px 0" }}>
          <span>{tweak.label}</span>
          <Control tweak={tweak} value={values[tweak.id]!} onChange={(value) => onChange(tweak.id, value)} />
        </div>
      ))}
    </div>
  );
}
