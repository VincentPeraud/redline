import { expect, it } from "vitest";
import type { DiffusionDiff } from "@redline/shared";
import { diffusionToastMessage, pendingCardLabel, pendingChangesLabel, pendingScopeLabel, projectCountLabel } from "../src/diffusionLabels";

it("counts projects in French", () => {
  expect(projectCountLabel(0)).toBe("0 projet");
  expect(projectCountLabel(1)).toBe("1 projet");
  expect(projectCountLabel(3)).toBe("3 projets");
});

it("words the toast after a diffusion", () => {
  expect(diffusionToastMessage(13, 3)).toBe("Diffusion 13 envoyée à 3 projets");
  expect(diffusionToastMessage(2, 1)).toBe("Diffusion 2 envoyée à 1 projet");
});

const diff = (parts: { tokens?: number; components?: number; designMd?: boolean }): DiffusionDiff => {
  const tokens = Array.from({ length: parts.tokens ?? 0 }, (_, i) => ({ name: `--t${i}`, from: "1", to: "2" }));
  const components = Array.from({ length: parts.components ?? 0 }, (_, i) => `c${i}`);
  return {
    tokens: { changed: tokens, added: [], removed: [] },
    components: { added: components, changed: [], removed: [] },
    designMdChanged: parts.designMd ?? false,
    count: tokens.length + components.length + (parts.designMd ? 1 : 0),
  };
};

it("words what is pending in French", () => {
  expect(pendingChangesLabel(diff({ tokens: 1 }))).toBe("1 token modifié");
  expect(pendingChangesLabel(diff({ tokens: 1, components: 2 }))).toBe("1 token et 2 composants modifiés");
  expect(pendingChangesLabel(diff({ tokens: 3, components: 1, designMd: true }))).toBe("3 tokens, 1 composant et DESIGN.md modifiés");
  expect(pendingChangesLabel(diff({ designMd: true }))).toBe("DESIGN.md modifié");
  expect(pendingChangesLabel(diff({ components: 1 }))).toBe("1 composant modifié");
});

it("words the card under Claude's answer", () => {
  expect(pendingCardLabel(diff({ tokens: 1, components: 2 }), 3)).toBe("1 token et 2 composants modifiés · 3 projets concernés");
  expect(pendingCardLabel(diff({ tokens: 1 }), 1)).toBe("1 token modifié · 1 projet concerné");
  expect(pendingCardLabel(diff({ tokens: 1 }), 0)).toBe("1 token modifié · aucun projet concerné");
});

it("sums up the pending changes for the preview banner", () => {
  expect(pendingScopeLabel(diff({ tokens: 1, components: 2 }))).toBe("1 token, 2 composants");
  expect(pendingScopeLabel(diff({ components: 1, designMd: true }))).toBe("1 composant, DESIGN.md");
  expect(pendingScopeLabel(diff({}))).toBe("");
});
