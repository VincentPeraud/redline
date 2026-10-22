import { DEFAULT_TWEAK_MAX, DEFAULT_TWEAK_MIN, TWEAK_SCOPES, type ManifestTweak, type TweakValue, type TweakValues } from "@redline/shared";
import { cx } from "./ui/index.js";
import { TweakPreview, type PreviewSource } from "./TweakPreview.js";
import styles from "./TweaksPanel.module.css";

interface Props {
  tweaks: ManifestTweak[];
  values: TweakValues;
  onChange: (id: string, value: TweakValue) => void;
  /** "dark" is the play-mode side panel; "light" the canvas. */
  theme?: "light" | "dark";
  heading?: string;
  /** Needed by `choice` tweaks with display "previews"; without it they fall back to buttons. */
  previews?: PreviewSource;
}

interface ControlProps {
  tweak: ManifestTweak;
  value: TweakValue;
  values: TweakValues;
  onChange: (value: TweakValue) => void;
  previews?: PreviewSource;
}

function scopeRank(tweak: ManifestTweak): number {
  return TWEAK_SCOPES.indexOf(tweak.scope ?? "page");
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.chevron}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ColorControl({ tweak, value, onChange }: ControlProps) {
  const options = tweak.options ?? [];
  const current = String(value);
  if (options.length === 0) {
    return <input type="color" aria-label={tweak.label} value={current} onChange={(e) => onChange(e.target.value)} className={styles.colorInput} />;
  }
  const custom = !options.some((option) => option.toLowerCase() === current.toLowerCase());
  return (
    <div role="group" aria-label={tweak.label} className={styles.swatches}>
      {options.map((option) => {
        const selected = option.toLowerCase() === current.toLowerCase();
        return (
          <button
            key={option}
            type="button"
            aria-label={option}
            aria-pressed={selected}
            className={cx(styles.swatch, selected && styles.swatchSelected)}
            style={{ background: option }}
            onClick={() => onChange(option)}
          />
        );
      })}
      {tweak.allowCustom && (
        <label title="Couleur personnalisée" className={cx(styles.swatch, styles.swatchCustom, custom && styles.swatchSelected)}>
          <input type="color" aria-label="Couleur personnalisée" value={current} onChange={(e) => onChange(e.target.value)} className={styles.customInput} />
        </label>
      )}
    </div>
  );
}

function ChoiceControl({ tweak, value, values, onChange, previews }: ControlProps) {
  const options = tweak.options ?? [];
  if (tweak.display === "dropdown") {
    return (
      <span className={styles.selectWrap}>
        <select aria-label={tweak.label} value={String(value)} onChange={(e) => onChange(e.target.value)} className={styles.select}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <Chevron />
      </span>
    );
  }
  if (tweak.display === "previews" && previews) {
    return (
      <div role="group" aria-label={tweak.label} className={styles.previews}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={option}
            title={option}
            aria-pressed={option === value}
            className={cx(styles.preview, option === value && styles.previewSelected)}
            onClick={() => onChange(option)}
          >
            <TweakPreview source={previews} values={{ ...values, [tweak.id]: option }} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="group" aria-label={tweak.label} className={styles.segmented}>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={option === value} className={cx(styles.segment, option === value && styles.segmentSelected)} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

function RangeControl({ tweak, value, onChange }: ControlProps) {
  return (
    <input
      type="range"
      aria-label={tweak.label}
      min={tweak.min ?? DEFAULT_TWEAK_MIN}
      max={tweak.max ?? DEFAULT_TWEAK_MAX}
      value={Number(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      className={styles.range}
    />
  );
}

function CountControl({ tweak, value, onChange }: ControlProps) {
  const min = tweak.min ?? DEFAULT_TWEAK_MIN;
  const max = tweak.max ?? DEFAULT_TWEAK_MAX;
  return (
    <div role="group" aria-label={tweak.label} className={styles.stepper}>
      <button type="button" aria-label={`Diminuer ${tweak.label}`} disabled={Number(value) <= min} onClick={() => onChange(Number(value) - 1)} className={styles.stepButton}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </button>
      <output className={styles.count}>{String(value)}</output>
      <button type="button" aria-label={`Augmenter ${tweak.label}`} disabled={Number(value) >= max} onClick={() => onChange(Number(value) + 1)} className={styles.stepButton}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </button>
      {tweak.unit && <span className={styles.unit}>{tweak.unit}</span>}
    </div>
  );
}

function TextControl({ tweak, value, onChange }: ControlProps) {
  const options = tweak.options ?? [];
  return (
    <>
      <input type="text" aria-label={tweak.label} value={String(value)} onChange={(e) => onChange(e.target.value)} className={styles.textInput} />
      {options.length > 0 && (
        <div className={styles.chips}>
          {options.map((option) => (
            <button key={option} type="button" aria-pressed={option === value} className={cx(styles.chip, option === value && styles.chipSelected)} onClick={() => onChange(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Tweak(props: ControlProps) {
  const { tweak, value, onChange } = props;
  if (tweak.type === "toggle") {
    return (
      <div className={cx(styles.tweak, styles.toggleRow)}>
        <input type="checkbox" role="switch" aria-label={tweak.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} className={styles.switch} />
        <span className={styles.toggleLabel}>{tweak.label}</span>
      </div>
    );
  }
  const control = {
    color: <ColorControl {...props} />,
    choice: <ChoiceControl {...props} />,
    range: <RangeControl {...props} />,
    count: <CountControl {...props} />,
    text: <TextControl {...props} />,
  }[tweak.type];
  return (
    <div className={styles.tweak}>
      <div className={styles.labelRow}>
        <span className={styles.label}>{tweak.label}</span>
        {tweak.type === "range" && (
          <output className={styles.value}>
            {String(value)}
            {tweak.unit ? ` ${tweak.unit}` : ""}
          </output>
        )}
      </div>
      {control}
    </div>
  );
}

/** One control per declared tweak, listed element, artboard, then page scope; shared by the canvas sidebar and play mode. */
export function TweaksPanel({ tweaks, values, onChange, theme = "light", heading, previews }: Props) {
  if (tweaks.length === 0) return null;
  const ordered = [...tweaks].sort((a, b) => scopeRank(a) - scopeRank(b));
  return (
    <div data-testid="tweaks" className={cx(styles.panel, theme === "dark" && styles.dark)}>
      {heading && <h4 className={styles.heading}>{heading}</h4>}
      {ordered.map((tweak) => (
        <Tweak key={tweak.id} tweak={tweak} value={values[tweak.id]!} values={values} previews={previews} onChange={(next) => onChange(tweak.id, next)} />
      ))}
    </div>
  );
}
