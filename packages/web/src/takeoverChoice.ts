/** The three answers of the per-project takeover setting (override `null` / `false` / `true`). */
export type TakeoverChoice = "general" | "wait" | "relay";

export const TAKEOVER_CHOICES: readonly TakeoverChoice[] = ["general", "wait", "relay"];

export function choiceOfOverride(override: boolean | null): TakeoverChoice {
  return override === null ? "general" : override ? "relay" : "wait";
}

export function overrideOfChoice(choice: TakeoverChoice): boolean | null {
  return choice === "general" ? null : choice === "relay";
}

/** What the general setting does, in the words of the Agents screen (lower case, to sit in a sentence). */
export function takeoverSentence(globalTakeover: boolean): string {
  return globalTakeover ? "l'agent global prend le relais" : "le fil attend son retour";
}
