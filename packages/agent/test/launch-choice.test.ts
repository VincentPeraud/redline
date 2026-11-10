import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseModelEffort } from "../src/launch-choice.js";

const dir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A machine whose Claude settings hold `settings`, with a fresh Redline config dir and project folder. */
function machine(settings?: object) {
  const claudeDir = dir("redline-claude-");
  const claudeSettingsFile = join(claudeDir, "settings.json");
  if (settings) writeFileSync(claudeSettingsFile, JSON.stringify(settings));
  return { configDir: dir("redline-config-"), folder: dir("redline-folder-"), claudeSettingsFile };
}

/** Answers questions in order, recording what was asked. */
function answers(...replies: string[]) {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected question: ${question}`);
    return reply;
  };
  return { ask, asked };
}

describe("choosing the model and effort at launch", () => {
  it("offers opus and the machine's effort the first time, kept on Enter", async () => {
    const m = machine({ effortLevel: "medium" });
    const { ask, asked } = answers("", "");
    expect(await chooseModelEffort({ ...m, flags: {}, ask })).toEqual({ model: "opus", effort: "medium" });
    expect(asked).toEqual(["Model (opus, sonnet, haiku) [opus]: ", "Effort (low, medium, high, xhigh, max) [medium]: "]);
  });

  it("offers the folder's last choice at the next launch, and nothing of it in another folder", async () => {
    const m = machine({ effortLevel: "medium" });
    await chooseModelEffort({ ...m, flags: {}, ask: answers("sonnet", "high").ask });

    const next = answers("", "");
    expect(await chooseModelEffort({ ...m, flags: {}, ask: next.ask })).toEqual({ model: "sonnet", effort: "high" });
    expect(next.asked).toEqual(["Model (opus, sonnet, haiku) [sonnet]: ", "Effort (low, medium, high, xhigh, max) [high]: "]);

    const elsewhere = answers("", "");
    expect(await chooseModelEffort({ ...m, folder: dir("redline-folder-"), flags: {}, ask: elsewhere.ask })).toEqual({ model: "opus", effort: "medium" });
  });

  it("asks again, saying why, until the model and the effort are known ones", async () => {
    const { ask, asked } = answers("sonet", "Sonnet", "hard", "MAX");
    const warnings: string[] = [];
    expect(await chooseModelEffort({ ...machine({ effortLevel: "medium" }), flags: {}, ask, warn: (m) => warnings.push(m) })).toEqual({ model: "sonnet", effort: "max" });
    expect(asked).toEqual([
      "Model (opus, sonnet, haiku) [opus]: ",
      "Model (opus, sonnet, haiku) [opus]: ",
      "Effort (low, medium, high, xhigh, max) [medium]: ",
      "Effort (low, medium, high, xhigh, max) [medium]: ",
    ]);
    expect(warnings).toEqual(["Unknown model: use opus, sonnet, haiku or a full model id (claude-…).", "Unknown effort: use low, medium, high, xhigh, max."]);
  });

  it("accepts a full model id", async () => {
    expect(await chooseModelEffort({ ...machine(), flags: {}, ask: answers("claude-sonnet-5-5", "").ask })).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("ignores a remembered choice that is no longer valid", async () => {
    const m = machine({ effortLevel: "low" });
    writeFileSync(join(m.configDir, "launch-choices.json"), JSON.stringify({ [m.folder]: { model: "gpt", effort: "ultra" } }));
    expect(await chooseModelEffort({ ...m, flags: {} })).toEqual({ model: "opus", effort: "low" });
  });

  it("leaves the effort to Claude when the machine sets none and Enter is pressed", async () => {
    const { ask, asked } = answers("", "");
    expect(await chooseModelEffort({ ...machine(), flags: {}, ask })).toEqual({ model: "opus", effort: undefined });
    expect(asked[1]).toBe("Effort (low, medium, high, xhigh, max) [Claude's default]: ");
  });

  it("skips the question a flag answers, and remembers the flag as the last choice", async () => {
    const m = machine({ effortLevel: "medium" });
    const first = answers("");
    expect(await chooseModelEffort({ ...m, flags: { model: "haiku" }, ask: first.ask })).toEqual({ model: "haiku", effort: "medium" });
    expect(first.asked).toEqual(["Effort (low, medium, high, xhigh, max) [medium]: "]);

    const next = answers("", "");
    await chooseModelEffort({ ...m, flags: {}, ask: next.ask });
    expect(next.asked[0]).toBe("Model (opus, sonnet, haiku) [haiku]: ");
  });

  it("asks nothing outside a terminal and uses the folder's last choice", async () => {
    const m = machine({ effortLevel: "medium" });
    await chooseModelEffort({ ...m, flags: {}, ask: answers("sonnet", "high").ask });
    expect(await chooseModelEffort({ ...m, flags: {} })).toEqual({ model: "sonnet", effort: "high" });
    expect(await chooseModelEffort({ ...machine({ effortLevel: "low" }), flags: {} })).toEqual({ model: "opus", effort: "low" });
  });
});
