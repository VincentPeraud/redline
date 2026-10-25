import { expect, it } from "vitest";
import { diffusionToastMessage, projectCountLabel } from "../src/diffusionLabels";

it("counts projects in French", () => {
  expect(projectCountLabel(0)).toBe("0 projet");
  expect(projectCountLabel(1)).toBe("1 projet");
  expect(projectCountLabel(3)).toBe("3 projets");
});

it("words the toast after a diffusion", () => {
  expect(diffusionToastMessage(13, 3)).toBe("Diffusion 13 envoyée à 3 projets");
  expect(diffusionToastMessage(2, 1)).toBe("Diffusion 2 envoyée à 1 projet");
});
