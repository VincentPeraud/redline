import { describe, expect, it } from "vitest";
import { threadTargetLabel } from "@redline/shared";

describe("thread target label", () => {
  it("names an element target by its artboard and readable name", () => {
    expect(threadTargetLabel({ kind: "element", artboard: "accueil.html", selector: "#cta", elementName: "bouton « Réserver ma place »", xPct: 1, yPct: 2 })).toBe(
      "accueil.html · bouton « Réserver ma place »",
    );
  });

  it("falls back to the selector for an element without a name", () => {
    expect(threadTargetLabel({ kind: "element", artboard: "accueil.html", selector: "#cta", elementName: null, xPct: 1, yPct: 2 })).toBe("accueil.html · #cta");
  });

  it("names a whole-artboard target", () => {
    expect(threadTargetLabel({ kind: "artboard", artboard: "accueil.html" })).toBe("accueil.html · Artboard entier");
  });

  it.each([
    ["title", "Titre"],
    ["text", "Texte"],
    ["sticky", "Post-it"],
    ["link", "Lien"],
    ["image", "Image"],
    ["shape", "Forme"],
    ["arrow", "Flèche"],
  ] as const)("names a canvas element target of kind %s", (elementKind, french) => {
    expect(threadTargetLabel({ kind: "canvas-element", elementId: "note-parcours", elementKind })).toBe(`${french} · note-parcours`);
  });
});
