// Component sandbox: one live instance of a component, tried next to its artboard. Its settings (the artboard's tweaks),
// its states (open, selected) and the texts of its slots are set in a card, locally: nothing is saved but the trial a
// comment was written on, which the comment keeps and replays.

import { cellText } from "./tweakGrid.js";
import { resolveDeclaredTweakValues, tweakValueError, type ManifestTweak, type TweakValues } from "./index.js";

/** The instance states a component may use; the sandbox shows a switch for each one it uses. */
export type SandboxState = "open" | "selected";
export const SANDBOX_STATES: readonly SandboxState[] = ["open", "selected"];
export const SANDBOX_STATE_LABELS: Record<SandboxState, string> = { open: "Ouvert", selected: "Sélectionné" };
/** A state switch starts on for `open` (a closed modal shows nothing to try), off for `selected`. */
const STATE_DEFAULTS: Record<SandboxState, boolean> = { open: true, selected: false };

/** What a sandbox shows: the value of every setting, the states and the typed slot texts. Stored on the threads written on it. */
export interface SandboxTrial {
  /** Every setting, in declared order (tweak id to value). */
  values: TweakValues;
  states?: Partial<Record<SandboxState, boolean>>;
  /** Text typed in each text slot, by slot name (`""` is the default slot); an empty or absent text shows the slot's fallback. */
  slots?: Record<string, string>;
}

/** Content of a slot as the sandbox document reads it: its text, whether it holds an element, and the first element's tag. */
export interface SlotContent {
  text: string;
  rich: boolean;
  tag?: string;
}

/** A `<slot>` of the template: its name, its `data-label` and its fallback content. */
export interface SandboxSlotSource {
  name: string;
  label?: string;
  fallback: SlotContent;
}

/** A slot as the card shows it: a text field, or "contenu riche" without a field. */
export interface SandboxSlot {
  name: string;
  label: string;
  /** "slot par défaut", "slot icon · <ui-icon>". */
  hint: string;
  rich: boolean;
  /** Text the field starts with. */
  prefill: string;
  /** Text shown when the field is emptied. */
  fallback: string;
}

/** The sandbox's settings: the artboard's tweaks, the states aside (they get their own switches). */
export const sandboxSettings = (tweaks: readonly ManifestTweak[]): ManifestTweak[] => tweaks.filter((tweak) => !(SANDBOX_STATES as readonly string[]).includes(tweak.id.toLowerCase()));

/** The states of the component: those its artboard declares as tweaks, and those its markup, style or script uses. */
export function sandboxStates(tweaks: readonly ManifestTweak[], sources: readonly string[]): SandboxState[] {
  return SANDBOX_STATES.filter((state) => tweaks.some((tweak) => tweak.id.toLowerCase() === state) || sources.some((source) => usesState(source, state)));
}

/** `[open]` in a selector, or `"open"` as a string (`hasAttribute("open")`, `toggleAttribute('open')`). */
function usesState(source: string, state: SandboxState): boolean {
  return new RegExp(`\\[\\s*${state}\\s*[\\]~|^$*=]|["'\`]${state}["'\`]`).test(source);
}

const slotName = (name: string) => (name === "" ? "par défaut" : name);

/**
 * The slots of the card, in template order. A field starts with the slot's fallback text, else the text the first
 * instance of the artboard puts in that slot (`firstFills`); a slot whose fallback or first fill holds an element is rich.
 */
export function sandboxSlots(sources: readonly SandboxSlotSource[], firstFills: Readonly<Record<string, SlotContent | undefined>>): SandboxSlot[] {
  return sources.map(({ name, label, fallback }) => {
    const fill = firstFills[name];
    const rich = fallback.rich || fill?.rich === true;
    const tag = fallback.rich ? fallback.tag : fill?.tag;
    const fallbackText = fallback.text.trim();
    return {
      name,
      label: label?.trim() || (name === "" ? "Contenu" : name),
      hint: `slot ${slotName(name)}${rich && tag ? ` · <${tag}>` : ""}`,
      rich,
      prefill: rich ? "" : fallbackText || (fill?.text.trim() ?? ""),
      fallback: fallbackText,
    };
  });
}

/** The trial a sandbox opens with: declared defaults, Ouvert on, every text field prefilled. */
export function sandboxStart(settings: readonly ManifestTweak[], states: readonly SandboxState[], slots: readonly SandboxSlot[]): SandboxTrial {
  const trial: SandboxTrial = { values: resolveDeclaredTweakValues(settings, {}) };
  if (states.length > 0) trial.states = Object.fromEntries(states.map((state) => [state, STATE_DEFAULTS[state]]));
  const texts = slots.filter((slot) => !slot.rich);
  if (texts.length > 0) trial.slots = Object.fromEntries(texts.map((slot) => [slot.name, slot.prefill]));
  return trial;
}

/**
 * "secondary · lg · Pleine largeur : non · Ouvert : oui · Contenu « Publier »": every setting, the states, then the
 * typed slot texts. With the page's tweaks and the slot labels it reads like the card; without them (the server) it
 * names ids and slots: "secondary · lg · fullWidth off · open on, slot default « Publier »".
 */
export function sandboxTrialText(trial: SandboxTrial, tweaks?: readonly ManifestTweak[], slotLabels?: Readonly<Record<string, string>>): string {
  const forUser = tweaks !== undefined;
  const states = SANDBOX_STATES.filter((state) => trial.states?.[state] !== undefined).map((state) =>
    forUser ? `${SANDBOX_STATE_LABELS[state]} : ${trial.states![state] ? "oui" : "non"}` : `${state} ${trial.states![state] ? "on" : "off"}`,
  );
  const settings = [cellText(trial.values, tweaks ?? []), ...states].filter((part) => part !== "").join(" · ");
  const texts = Object.entries(trial.slots ?? {})
    .filter(([, text]) => text.trim() !== "")
    .map(([name, text]) => (forUser ? `${slotLabels?.[name] ?? (name === "" ? "Contenu" : name)} « ${text.trim()} »` : `slot ${name === "" ? "default" : name} « ${text.trim()} »`));
  if (forUser) return [settings, ...texts].filter((part) => part !== "").join(" · ");
  return [settings, ...texts].filter((part) => part !== "").join(", ");
}

/**
 * A recorded trial shown again on the component as it is now: a value that no longer fits its setting goes back to the
 * default, a setting, state or text slot that no longer exists is dropped, and `notice` says what changed (null when nothing did).
 */
export function replaySandboxTrial(
  recorded: SandboxTrial,
  settings: readonly ManifestTweak[],
  states: readonly SandboxState[],
  slots: readonly SandboxSlot[],
): { trial: SandboxTrial; notice: string | null } {
  const changes: string[] = [];
  const start = sandboxStart(settings, states, slots);
  const values = resolveDeclaredTweakValues(settings, recorded.values);
  for (const [id, value] of Object.entries(recorded.values)) {
    const setting = settings.find((s) => s.id === id);
    if (!setting) changes.push(`le réglage ${id} n'existe plus`);
    else if (tweakValueError(setting, value) !== null) changes.push(`${setting.label} « ${String(value)} » n'existe plus, retour à ${String(values[id])}`);
  }
  const trial: SandboxTrial = { values };
  if (start.states) {
    trial.states = { ...start.states };
    for (const state of states) if (typeof recorded.states?.[state] === "boolean") trial.states[state] = recorded.states[state];
  }
  for (const state of SANDBOX_STATES) if (recorded.states?.[state] !== undefined && !states.includes(state)) changes.push(`l'état ${SANDBOX_STATE_LABELS[state]} n'existe plus`);
  if (start.slots) {
    trial.slots = { ...start.slots };
    for (const name of Object.keys(trial.slots)) if (typeof recorded.slots?.[name] === "string") trial.slots[name] = recorded.slots[name];
  }
  for (const [name, text] of Object.entries(recorded.slots ?? {})) {
    if (text.trim() !== "" && trial.slots?.[name] === undefined) changes.push(`le slot ${slotName(name)} n'existe plus`);
  }
  return { trial, notice: changes.length === 0 ? null : `Le composant a changé : ${changes.join(" ; ")}.` };
}

/** Error message when a thread's sandbox trial is malformed, else null. */
export function sandboxTrialError(trial: unknown): string | null {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(trial) || !isRecord(trial.values)) return "sandbox must have values";
  if (!Object.values(trial.values).every((v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) return "sandbox.values must map tweak ids to a string, number or boolean";
  if (trial.states !== undefined && (!isRecord(trial.states) || !Object.entries(trial.states).every(([k, v]) => (SANDBOX_STATES as readonly string[]).includes(k) && typeof v === "boolean"))) return "sandbox.states must map open or selected to a boolean";
  if (trial.slots !== undefined && (!isRecord(trial.slots) || !Object.values(trial.slots).every((v) => typeof v === "string" && v.length <= 2000))) return "sandbox.slots must map slot names to a text";
  const extra = Object.keys(trial).filter((key) => !["values", "states", "slots"].includes(key));
  return extra.length > 0 ? `sandbox has unknown fields: ${extra.join(", ")}` : null;
}
