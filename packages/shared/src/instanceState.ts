/** A component instance a thread was written with in a state of its own (an open modal, a selected tab): its anchor selector and the attributes it had. */
export interface InstanceState {
  selector: string;
  attributes: Record<string, string>;
}

const STATE_WORDS: Record<string, string> = { open: "ouverte", selected: "sélectionnée" };

/** "confirm ouverte": the instance's id (else its tag), then each attribute as a word (open, selected) or `name value`. */
export function instanceStateText(state: InstanceState): string {
  const host = (state.selector.split(/\s*(?:>>>|>)\s*/).pop() ?? "").replace(/:nth-of-type\(\d+\)$/, "");
  const [tag, id] = host.split("#");
  const what = Object.entries(state.attributes).map(([name, value]) => STATE_WORDS[name] ?? `${name} ${value}`);
  return `${id || tag} ${what.join(", ")}`;
}

/** "confirm ouverte, menu ouverte": what the instances were doing when the thread was written. */
export function instanceStateLabel(states: readonly InstanceState[]): string {
  return states.map(instanceStateText).join(", ");
}
