import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORTS, MODEL_CHOICES, type Effort, type ModelChoice } from "@redline/shared";

export interface LaunchChoiceOptions {
  /** The folder the agent serves: the last choice is remembered per folder. */
  folder: string;
  configDir: string;
  /** The machine's Claude Code settings (`~/.claude/settings.json`), read for its `effortLevel`. */
  claudeSettingsFile: string;
  /** Given on the command line: the matching question is skipped. */
  flags: ModelChoice;
  /** Asks one question in the terminal; absent outside a terminal, where the defaults are taken as is. */
  ask?(question: string): Promise<string>;
  /** Tells the user why an answer was refused, or that the choice could not be saved. */
  warn?(message: string): void;
}

/** What the agent's runs use: the model is always named, the effort may be left to Claude. */
export type LaunchChoice = { model: string; effort?: Effort };

const CHOICES_FILE = "launch-choices.json";
const FIRST_MODEL = "opus";

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const asEffort = (value: unknown): Effort | undefined => ((EFFORTS as readonly unknown[]).includes(value) ? (value as Effort) : undefined);

/** A Claude Code alias (`opus`) or a full model id (`claude-opus-5-5`). */
const isModel = (value: unknown): value is string =>
  typeof value === "string" && (MODEL_CHOICES.some((m) => m.id === value) || /^claude-[a-z0-9.-]+$/.test(value));

/** Asks until the answer is valid; Enter keeps the default. */
async function askUntilValid<T>(ask: (question: string) => Promise<string>, question: string, fallback: T, parse: (answer: string) => T | undefined, warn: (message: string) => void, refused: string): Promise<T> {
  for (;;) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "") return fallback;
    const parsed = parse(answer);
    if (parsed !== undefined) return parsed;
    warn(refused);
  }
}

/** What the folder's agent proposes: its last choice, else Opus and the effort level of the machine's Claude Code settings. */
export function lastLaunchChoice({ folder, configDir, claudeSettingsFile }: Pick<LaunchChoiceOptions, "folder" | "configDir" | "claudeSettingsFile">): { model: string; effort?: Effort } {
  const stored = readJson(join(configDir, CHOICES_FILE));
  const choices = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const last = (choices[folder] ?? {}) as Record<string, unknown>;
  return {
    model: isModel(last.model) ? last.model : FIRST_MODEL,
    effort: asEffort(last.effort) ?? asEffort((readJson(claudeSettingsFile) as { effortLevel?: unknown } | undefined)?.effortLevel),
  };
}

/** Asks the model, then the effort, each offering the folder's last choice (kept on Enter), and remembers the answer. */
export async function chooseModelEffort({ folder, configDir, claudeSettingsFile, flags, ask, warn = () => {} }: LaunchChoiceOptions): Promise<LaunchChoice> {
  const { model: modelDefault, effort: effortDefault } = lastLaunchChoice({ folder, configDir, claudeSettingsFile });

  const modelNames = MODEL_CHOICES.map((m) => m.id).join(", ");
  const model =
    flags.model ??
    (ask
      ? await askUntilValid(ask, `Model (${modelNames}) [${modelDefault}]: `, modelDefault, (a) => (isModel(a) ? a : undefined), warn, `Unknown model: use ${modelNames} or a full model id (claude-…).`)
      : modelDefault);
  const effort =
    flags.effort ??
    (ask
      ? await askUntilValid(ask, `Effort (${EFFORTS.join(", ")}) [${effortDefault ?? "Claude's default"}]: `, effortDefault, asEffort, warn, `Unknown effort: use ${EFFORTS.join(", ")}.`)
      : effortDefault);

  try {
    rememberChoice({ folder, configDir, choice: { model, effort } });
  } catch (error) {
    warn(`Could not remember this choice (${(error as Error).message}).`);
  }
  return { model, effort };
}

/** Saves the folder's last choice: what the next `redline agent` in that folder proposes. */
export function rememberChoice({ folder, configDir, choice }: { folder: string; configDir: string; choice: LaunchChoice }): void {
  const stored = readJson(join(configDir, CHOICES_FILE));
  const choices = stored !== null && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, CHOICES_FILE), JSON.stringify({ ...choices, [folder]: choice }, null, 2));
}
