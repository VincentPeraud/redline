import { describe, expect, it } from "vitest";
import { TAKEOVER_CHOICES, choiceOfOverride, overrideOfChoice, takeoverSentence } from "../src/takeoverChoice.js";

describe("per-project takeover choice", () => {
  it("maps the project override to one of the three choices and back", () => {
    expect(choiceOfOverride(null)).toBe("general");
    expect(choiceOfOverride(false)).toBe("wait");
    expect(choiceOfOverride(true)).toBe("relay");
    for (const choice of TAKEOVER_CHOICES) expect(choiceOfOverride(overrideOfChoice(choice))).toBe(choice);
  });

  it("sends null for 'like the general setting', false to always wait, true to always take over", () => {
    expect(overrideOfChoice("general")).toBeNull();
    expect(overrideOfChoice("wait")).toBe(false);
    expect(overrideOfChoice("relay")).toBe(true);
  });

  it("words the general setting in the first choice's label", () => {
    expect(takeoverSentence(false)).toBe("le fil attend son retour");
    expect(takeoverSentence(true)).toBe("l'agent global prend le relais");
  });
});
