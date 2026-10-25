import { expect, it } from "vitest";
import type { DiffusionDiff } from "@redline/shared";
import { diffusionToastMessage, pendingScopeLabel, projectCountLabel } from "../src/diffusionLabels";

it("counts projects in French", () => {
  expect(projectCountLabel(0)).toBe("0 projet");
  expect(projectCountLabel(1)).toBe("1 projet");
  expect(projectCountLabel(3)).toBe("3 projets");
});

it("words the toast after a diffusion", () => {
  expect(diffusionToastMessage(13, 3)).toBe("Diffusion 13 envoyée à 3 projets");
  expect(diffusionToastMessage(2, 1)).toBe("Diffusion 2 envoyée à 1 projet");
});

it("sums up the pending changes for the preview banner", () => {
  const diff = (tokens: number, components: number, designMdChanged: boolean): DiffusionDiff => ({
    tokens: { changed: Array(tokens).fill({ name: "--a", from: "1", to: "2" }), added: [], removed: [] },
    components: { added: Array(components).fill("x"), changed: [], removed: [] },
    designMdChanged,
    count: tokens + components + (designMdChanged ? 1 : 0),
  });
  expect(pendingScopeLabel(diff(1, 2, false))).toBe("1 token, 2 composants");
  expect(pendingScopeLabel(diff(0, 1, true))).toBe("1 composant, DESIGN.md");
  expect(pendingScopeLabel(diff(0, 0, false))).toBe("");
});
