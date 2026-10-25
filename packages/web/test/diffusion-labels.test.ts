import { expect, it } from "vitest";
import {
  componentCountLabel,
  diffusionChangeParts,
  diffusionToastMessage,
  pendingChangesLabel,
  pendingNames,
  projectCountLabel,
  usedByHeading,
  userSummary,
} from "../src/diffusionLabels";

it("counts projects in French", () => {
  expect(projectCountLabel(0)).toBe("0 projet");
  expect(projectCountLabel(1)).toBe("1 projet");
  expect(projectCountLabel(3)).toBe("3 projets");
});

it("words the toast after a diffusion", () => {
  expect(diffusionToastMessage(13, 3)).toBe("Diffusion 13 envoyée à 3 projets");
  expect(diffusionToastMessage(2, 1)).toBe("Diffusion 2 envoyée à 1 projet");
});

const noChange = { tokens: { changed: [], added: [], removed: [] }, components: { added: [], changed: [], removed: [] }, designMdChanged: false, count: 0 };

it("words what a diffusion changed, in French, listing at most two names", () => {
  expect(diffusionChangeParts({ ...noChange, components: { added: [], changed: ["btn", "field"], removed: [] }, count: 2 })).toEqual([
    { label: "2 composants modifiés", names: ["btn", "field"], separator: ":", more: false },
  ]);
  expect(diffusionChangeParts({ ...noChange, components: { added: ["carousel-counter"], changed: [], removed: [] }, count: 1 })).toEqual([
    { label: "1 composant ajouté", names: ["carousel-counter"], separator: ":", more: false },
  ]);
  const tokens = ["--font-heading", "--radius", "--color-primary"].map((name) => ({ name, from: "a", to: "b" }));
  expect(diffusionChangeParts({ ...noChange, tokens: { changed: tokens, added: [], removed: [] }, count: 3 })).toEqual([
    { label: "3 tokens modifiés", names: ["--font-heading", "--radius"], separator: "·", more: true },
  ]);
  expect(diffusionChangeParts({ ...noChange, designMdChanged: true, count: 1 })).toEqual([{ label: "DESIGN.md modifié", names: [], separator: ":", more: false }]);
});

it("words the pending changes banner", () => {
  expect(pendingChangesLabel(1)).toBe("1 modification pas encore diffusée");
  expect(pendingChangesLabel(3)).toBe("3 modifications pas encore diffusées");
});

it("lists the names of pending changes, tokens first, DESIGN.md as itself, at most four", () => {
  const diff = {
    ...noChange,
    tokens: { changed: [{ name: "--color-primary", from: "a", to: "b" }], added: [{ name: "--x", value: "1" }], removed: [] },
    components: { added: ["story-frame"], changed: ["carousel-cover"], removed: ["old"] },
    designMdChanged: true,
    count: 6,
  };
  expect(pendingNames(diff)).toEqual({ names: ["--color-primary", "--x", "carousel-cover", "story-frame"], more: true });
  expect(pendingNames({ ...noChange, designMdChanged: true, count: 1 })).toEqual({ names: ["DESIGN.md"], more: false });
});

it("words the counts of a design system", () => {
  expect(componentCountLabel(0)).toBe("0 composant");
  expect(componentCountLabel(8)).toBe("8 composants");
  expect(usedByHeading(0)).toBe("Utilisé par aucun projet");
  expect(usedByHeading(3)).toBe("Utilisé par 3 projets");
});

it("summarises what a project using the design system holds of its own", () => {
  expect(userSummary({ id: "a", title: "A", overrideCount: 3, componentCount: 2 })).toBe("3 variables surchargées · 2 composants du projet");
  expect(userSummary({ id: "a", title: "A", overrideCount: 1, componentCount: 0 })).toBe("1 variable surchargée");
  expect(userSummary({ id: "a", title: "A", overrideCount: 0, componentCount: 0 })).toBe("Aucune surcharge");
  expect(userSummary({ id: "a", title: "A", overrideCount: 0, componentCount: 4 })).toBe("Aucune surcharge · 4 composants du projet");
  expect(userSummary({ id: "a", title: "A", overrideCount: 0, componentCount: 1 })).toBe("Aucune surcharge · 1 composant du projet");
});
