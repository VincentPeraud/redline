import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  SANDBOX_STATE_LABELS,
  replaySandboxTrial,
  sameSandboxTrial,
  sandboxSettings,
  sandboxSlots,
  sandboxStart,
  sandboxStates,
  type ManifestTweak,
  type SandboxFrameInfo,
  type SandboxTrial,
  type Thread,
} from "@redline/shared";
import { ArtboardErrorsContext } from "./ArtboardErrors.js";
import { ArtboardFrame, type Pick } from "./ArtboardFrame.js";
import { TweaksPanel } from "./TweaksPanel.js";
import { Tooltip, cx } from "./ui/index.js";
import tweakStyles from "./TweaksPanel.module.css";
import styles from "./SandboxCard.module.css";

/** Narrowest card; a component cell narrower than this still gets room for its settings. */
export const SANDBOX_MIN_WIDTH = 340;
/** From this width the settings and the content sit side by side under the preview. */
const WIDE_FROM = 560;
const PREVIEW_MIN_HEIGHT = 120;
/** A long text grows the preview up to here, then it scrolls. */
const PREVIEW_MAX_HEIGHT = 480;

export function FlaskIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6" />
      <path d="M10 3v6.5L4.6 18.4A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.4-2.6L14 9.5V3" />
      <path d="M7.5 15h9" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5M12 16h.01" />
    </svg>
  );
}

function RichIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
    </svg>
  );
}

export interface SandboxReplay {
  trial: SandboxTrial;
  nonce: number;
}

interface Props {
  /** Component name, for the title. */
  name: string;
  file: string;
  /** The sandbox document (`…/components/<name>.html?sandbox=1`). */
  src: string;
  /** Width of one cell of the component's artboard: the preview's width at 100 %. */
  cellWidth: number;
  /** Width the card gets on screen (narrower than the cell when the canvas lacks room: the preview then scrolls). */
  width: number;
  style: CSSProperties;
  /** Every tweak of the component's artboard. */
  tweaks: ManifestTweak[];
  /** The sandbox threads of this artboard that show a pin; only those written on the current trial do. */
  threads: Thread[];
  picking: boolean;
  selecting: boolean;
  /** Numbered marks of the message's chips taken in the sandbox, with the trial they were taken on. */
  marks: { number: number; selector: string; trial: SandboxTrial }[];
  /** A thread clicked in the list: the sandbox shows its trial again. */
  replay: SandboxReplay | null;
  onTrial: (trial: SandboxTrial | null, slotLabels: Record<string, string>) => void;
  onPick: (pick: Pick, trial: SandboxTrial) => void;
  onEscape: () => void;
  onClose: () => void;
}

/**
 * The component sandbox: one live instance of the component at 100 %, next to its artboard, with its settings, states and
 * slot texts set locally (never saved: the grid does not change). Comments pinned in the preview keep the trial.
 */
export function SandboxCard({ name, file, src, cellWidth, width, style, tweaks, threads, picking, selecting, marks, replay, onTrial, onPick, onEscape, onClose }: Props) {
  const [info, setInfo] = useState<SandboxFrameInfo | null>(null);
  const [trial, setTrial] = useState<SandboxTrial | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [docHeight, setDocHeight] = useState(PREVIEW_MIN_HEIGHT);
  /** Bumped by "Valeurs par défaut": a fresh document forgets the errors of the earlier trials. */
  const [frameKey, setFrameKey] = useState(0);

  const settings = useMemo(() => sandboxSettings(tweaks), [tweaks]);
  const states = useMemo(() => (info ? sandboxStates(tweaks, info.sources) : []), [tweaks, info]);
  const slots = useMemo(() => (info ? sandboxSlots(info.slots, info.firstFills) : []), [info]);
  const slotLabels = useMemo(() => Object.fromEntries(slots.map((slot) => [slot.name, slot.label])), [slots]);

  // Once the document says what the component has: start from the defaults, or bring the current trial (or the one to
  // replay) to the component as it is now, saying what no longer exists.
  useEffect(() => {
    if (!info) return;
    setTrial((current) => {
      if (current === null && !replay) return sandboxStart(settings, states, slots);
      const replayed = replaySandboxTrial(current ?? replay!.trial, settings, states, slots);
      setNotice(replayed.notice);
      return replayed.trial;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `replay` is handled below once the trial exists
  }, [info, settings, states, slots]);

  useEffect(() => {
    if (!replay || !info) return;
    const replayed = replaySandboxTrial(replay.trial, settings, states, slots);
    setTrial(replayed.trial);
    setNotice(replayed.notice);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new nonce replays, nothing else
  }, [replay?.nonce]);

  useEffect(() => {
    onTrial(trial, slotLabels);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report changes of the trial only
  }, [trial, slotLabels]);
  useEffect(() => () => onTrial(null, {}), [onTrial]);

  const reportErrors = useCallback((_frameId: string, reported: string[]) => setErrors(reported), []);
  const sandboxProp = useMemo(() => ({ trial, onInfo: setInfo }), [trial]);

  const textSlots = slots.filter((slot) => !slot.rich);
  const nothingToSet = info !== null && settings.length === 0 && states.length === 0 && slots.length === 0;
  const wide = width >= WIDE_FROM;
  const pinned = trial ? threads.filter((t) => t.sandbox && sameSandboxTrial(t.sandbox, trial)) : [];
  const shownMarks = trial ? marks.filter((mark) => sameSandboxTrial(mark.trial, trial)).map(({ number, selector }) => ({ number, selector })) : [];
  const previewHeight = Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, docHeight));
  const gone = info !== null && !info.defined;

  const setValue = (id: string, value: SandboxTrial["values"][string]) => setTrial((current) => current && { ...current, values: { ...current.values, [id]: value } });
  const reset = () => {
    setTrial(info ? sandboxStart(settings, states, slots) : null);
    setNotice(null);
    setErrors([]);
    setFrameKey((key) => key + 1);
  };

  return (
    <div data-no-pan data-sandbox={file} role="dialog" aria-label={`Bac à sable de ${name}`} className={cx(styles.card, wide && styles.wide)} style={{ ...style, width }}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <span className={styles.title}>Bac à sable · {name}</span>
          <span className={styles.sub}>
            <FlaskIcon size={12} />
            Essai local : toi seul le vois · taille réelle (100 %)
          </span>
        </div>
        <Tooltip label="Fermer le bac à sable">
          <button type="button" aria-label="Fermer le bac à sable" className={styles.close} onClick={onClose}>
            <CloseIcon />
          </button>
        </Tooltip>
      </div>

      <div className={cx(styles.preview, picking && styles.previewCommenting)}>
        {(info === null || gone || errors.length > 0) && (
          <div className={styles.previewOver}>
            {info === null ? (
              <div className={styles.loading}>
                <span className={styles.spinner} />
                Rendu du composant
              </div>
            ) : (
              <div className={cx(styles.notice, styles.error)} role="alert">
                <span className={styles.noticeIcon}>
                  <AlertIcon />
                </span>
                <span>
                  {gone ? (
                    <>
                      Ce composant n'a plus de <span className={styles.mono}>&lt;template data-component&gt;</span> : rien à essayer.
                    </>
                  ) : (
                    <>
                      Le composant ne se rend pas : <span className={styles.mono}>{errors[0]}</span>
                    </>
                  )}
                </span>
              </div>
            )}
          </div>
        )}
        <div className={cx(styles.frameScroll, (info === null || gone || errors.length > 0) && styles.frameHidden)} style={{ height: previewHeight }}>
          <ArtboardErrorsContext.Provider value={reportErrors}>
            <ArtboardFrame
              key={frameKey}
              title={`Bac à sable · ${name}`}
              src={src}
              width={cellWidth}
              height={previewHeight}
              zoom={1}
              bare
              threads={pinned}
              picking={picking && trial !== null}
              selecting={selecting && trial !== null}
              marks={shownMarks}
              tweaks={EMPTY_TWEAKS}
              sandbox={sandboxProp}
              onPick={(pick) => trial && onPick(pick, trial)}
              onEscape={onEscape}
              onDocHeight={setDocHeight}
            />
          </ArtboardErrorsContext.Provider>
        </div>
      </div>

      {!gone && (
        <div className={styles.body}>
          {notice && (
            <div className={cx(styles.notice, styles.warn)} role="status">
              <span className={styles.noticeIcon}>
                <AlertIcon />
              </span>
              <span>{notice}</span>
            </div>
          )}
          {nothingToSet && (
            <div className={cx(styles.notice, styles.info)}>
              <span>Rien à régler sur ce composant.</span>
            </div>
          )}
          {(settings.length > 0 || states.length > 0) && (
            <div className={styles.group} data-sandbox-settings>
              <span className={styles.groupTitle}>Réglages</span>
              {settings.length > 0 && (
                <TweaksPanel tweaks={settings} values={trial?.values ?? sandboxStart(settings, [], []).values} onChange={setValue} showDefaults />
              )}
              {trial &&
                states.map((state) => (
                  <label key={state} className={styles.stateRow}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={SANDBOX_STATE_LABELS[state]}
                      checked={trial.states?.[state] === true}
                      onChange={(e) => setTrial((current) => current && { ...current, states: { ...current.states, [state]: e.target.checked } })}
                      className={tweakStyles.switch}
                    />
                    <span className={tweakStyles.toggleLabel}>{SANDBOX_STATE_LABELS[state]}</span>
                    <span className={styles.hint}>état {state}</span>
                  </label>
                ))}
            </div>
          )}
          {trial && slots.length > 0 && (
            <div className={styles.group} data-sandbox-content>
              <span className={styles.groupTitle}>Contenu</span>
              {slots.map((slot) => (
                <div key={slot.name} className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {slot.label}
                    <span className={styles.hint}>{slot.hint}</span>
                  </span>
                  {slot.rich ? (
                    <div className={styles.rich}>
                      <RichIcon />
                      <span>Contenu riche : pas de champ</span>
                    </div>
                  ) : (
                    <textarea
                      aria-label={slot.label}
                      rows={1}
                      className={styles.slotInput}
                      value={trial.slots?.[slot.name] ?? ""}
                      placeholder={slot.fallback ? `Vide : contenu de secours « ${slot.fallback} »` : "Vide"}
                      onChange={(e) => setTrial((current) => current && { ...current, slots: { ...current.slots, [slot.name]: e.target.value } })}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {trial && !nothingToSet && !gone && (settings.length > 0 || states.length > 0 || textSlots.length > 0) && (
        <div className={styles.foot}>
          <span className={styles.footHint}>La grille ne change pas.</span>
          <button type="button" className={styles.reset} onClick={reset}>
            Valeurs par défaut
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_TWEAKS = {};
