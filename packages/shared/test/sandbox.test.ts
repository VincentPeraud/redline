import { describe, expect, it } from "vitest";
import { replaySandboxTrial, sameSandboxTrial, sandboxSettings, sandboxSlots, sandboxStart, sandboxStates, sandboxTrialError, sandboxTrialText, type ManifestTweak } from "@redline/shared";

const tweaks: ManifestTweak[] = [
  { id: "variant", type: "choice", label: "Variante", options: ["primary", "secondary", "ghost"] },
  { id: "size", type: "choice", label: "Taille", options: ["sm", "md", "lg"], default: "md" },
  { id: "fullWidth", type: "toggle", label: "Pleine largeur" },
  { id: "open", type: "toggle", label: "Ouvert", default: false },
];
const settings = sandboxSettings(tweaks);
const text = (value: string) => ({ text: value, rich: false });

describe("sandbox settings and states", () => {
  it("takes every tweak of the artboard as a setting, open and selected aside", () => {
    expect(settings.map((t) => t.id)).toEqual(["variant", "size", "fullWidth"]);
  });

  it("finds the states a component uses in its tweaks, style or script", () => {
    expect(sandboxStates(tweaks, [])).toEqual(["open"]);
    expect(sandboxStates([], ["ui-tab[selected] { color: red }"])).toEqual(["selected"]);
    expect(sandboxStates([], [`host.hasAttribute("open")`, "if (x) host.toggleAttribute('selected')"])).toEqual(["open", "selected"]);
    expect(sandboxStates([], ["opened selectedItem"])).toEqual([]);
  });
});

describe("sandbox slots", () => {
  it("labels a slot by its data-label, else Contenu for the default slot, else its name", () => {
    const slots = sandboxSlots([{ name: "title", label: "Titre", fallback: text("") }, { name: "", fallback: text("") }, { name: "footer", fallback: text("") }], {});
    expect(slots.map((s) => [s.label, s.hint])).toEqual([
      ["Titre", "slot title"],
      ["Contenu", "slot par défaut"],
      ["footer", "slot footer"],
    ]);
  });

  it("prefills a field with the fallback, else with the first instance's text", () => {
    const [own, fromInstance] = sandboxSlots([{ name: "", fallback: text(" Contenu de la fenêtre. ") }, { name: "title", fallback: text("") }], { "": text("Autre"), title: text("Supprimer ?") });
    expect([own!.prefill, own!.fallback]).toEqual(["Contenu de la fenêtre.", "Contenu de la fenêtre."]);
    expect([fromInstance!.prefill, fromInstance!.fallback]).toEqual(["Supprimer ?", ""]);
  });

  it("makes a slot rich when its fallback or its first fill holds an element, naming the element", () => {
    const [icon, footer] = sandboxSlots(
      [{ name: "icon", fallback: { text: "", rich: true, tag: "ui-icon" } }, { name: "footer", fallback: text("") }],
      { footer: { text: "Annuler Confirmer", rich: true, tag: "ui-button" } },
    );
    expect([icon!.rich, icon!.hint, icon!.prefill]).toEqual([true, "slot icon · <ui-icon>", ""]);
    expect([footer!.rich, footer!.hint]).toEqual([true, "slot footer · <ui-button>"]);
  });
});

describe("sandbox trial", () => {
  const slots = sandboxSlots([{ name: "", fallback: text("") }, { name: "icon", fallback: { text: "", rich: true } }], { "": text("Publier l'annonce") });

  it("starts from the declared defaults, Ouvert on, text fields prefilled and rich slots left out", () => {
    expect(sandboxStart(settings, ["open", "selected"], slots)).toEqual({
      values: { variant: "primary", size: "md", fullWidth: false },
      states: { open: true, selected: false },
      slots: { "": "Publier l'annonce" },
    });
    expect(sandboxStart([], [], [])).toEqual({ values: {} });
  });

  it("reads every setting, the states and the typed texts, for the user and for the agent", () => {
    const trial = { values: { variant: "secondary", size: "lg", fullWidth: false }, states: { open: true }, slots: { "": "Enregistrer", title: " " } };
    expect(sandboxTrialText(trial, tweaks, { "": "Contenu" })).toBe("secondary · lg · Pleine largeur : non · Ouvert : oui · Contenu « Enregistrer »");
    expect(sandboxTrialText(trial)).toBe("secondary · lg · fullWidth off · open on, slot default « Enregistrer »");
  });

  it("replays a recorded trial as it was when the component did not change", () => {
    const recorded = { values: { variant: "ghost", size: "sm", fullWidth: true }, states: { open: false }, slots: { "": "Voir" } };
    expect(replaySandboxTrial(recorded, settings, ["open"], slots)).toEqual({ trial: recorded, notice: null });
  });

  it("brings back to default what no longer exists, and says so", () => {
    const recorded = { values: { variant: "primary", size: "xl", gone: 3 }, states: { selected: true }, slots: { "": "Voir", footer: "Pied" } };
    const { trial, notice } = replaySandboxTrial(recorded, settings, ["open"], slots);
    expect(trial).toEqual({ values: { variant: "primary", size: "md", fullWidth: false }, states: { open: true }, slots: { "": "Voir" } });
    expect(notice).toBe("Le composant a changé : Taille « xl » n'existe plus, retour à md ; le réglage gone n'existe plus ; l'état Sélectionné n'existe plus ; le slot footer n'existe plus.");
  });

  it("compares trials whatever the key order, a blank text counting as absent", () => {
    expect(sameSandboxTrial({ values: { a: 1, b: "x" }, slots: { "": " Hi ", t: " " } }, { values: { b: "x", a: 1 }, slots: { "": "Hi" } })).toBe(true);
    expect(sameSandboxTrial({ values: { a: 1 }, states: { open: true } }, { values: { a: 1 }, states: { open: false } })).toBe(false);
  });

  it("refuses a malformed trial", () => {
    expect(sandboxTrialError({ values: { a: 1 }, states: { open: true }, slots: { "": "x" } })).toBeNull();
    expect(sandboxTrialError({})).toMatch(/values/);
    expect(sandboxTrialError({ values: {}, states: { hover: true } })).toMatch(/states/);
    expect(sandboxTrialError({ values: {}, other: 1 })).toMatch(/unknown/);
  });
});
