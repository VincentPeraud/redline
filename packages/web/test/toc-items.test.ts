import { describe, expect, it } from "vitest";
import { artboardAtCentre, tocGroups, type TocItem } from "../src/tocItems.js";

const item = (number: number, file: string, groupTitle: string | null, title?: string): TocItem => ({ number, file, groupTitle, openThreads: 0, ...(title && { title }) });

const items = [item(1, "bienvenue.html", "Onboarding", "Bienvenue"), item(2, "specialite.html", "Onboarding", "Spécialité"), item(3, "panier.html", "Paiement", "Panier"), item(4, "loose.html", null)];

describe("tocGroups", () => {
  it("groups lines under their group title in order of first appearance, keeping numbers", () => {
    expect(tocGroups(items, "").map((g) => [g.title, g.items.map((i) => i.number)])).toEqual([["Onboarding", [1, 2]], ["Paiement", [3]], [null, [4]]]);
  });

  it("starts a new group whenever the group title changes, so numbers read in order", () => {
    const mixed = [item(1, "a", "A"), item(2, "b", "B"), item(3, "c", "A"), item(4, "d", null), item(5, "e", "B"), item(6, "f", null)];
    expect(tocGroups(mixed, "").map((g) => [g.title, g.items.map((i) => i.number)])).toEqual([["A", [1]], ["B", [2]], ["A", [3]], [null, [4]], ["B", [5]], [null, [6]]]);
  });

  it("filters on title and file name, ignoring case and accents, and drops groups without a match", () => {
    expect(tocGroups(items, "SPECIALITE").map((g) => [g.title, g.items.map((i) => i.number)])).toEqual([["Onboarding", [2]]]);
    expect(tocGroups(items, "spécialité").flatMap((g) => g.items.map((i) => i.number))).toEqual([2]);
    expect(tocGroups(items, "panier.HTML").flatMap((g) => g.items.map((i) => i.number))).toEqual([3]);
    expect(tocGroups(items, "zzz")).toEqual([]);
  });
});

describe("artboardAtCentre", () => {
  const boxes = [
    { file: "a", x: 0, y: 0, width: 100, height: 100 },
    { file: "b", x: 300, y: 0, width: 100, height: 100 },
  ];
  it("returns the artboard containing the centre of the visible area", () => {
    expect(artboardAtCentre(boxes, { x: 0, y: 0, zoom: 1 }, { width: 100, height: 100 })).toBe("a");
    expect(artboardAtCentre(boxes, { x: -300, y: 0, zoom: 1 }, { width: 100, height: 100 })).toBe("b");
  });
  it("falls back to the nearest artboard", () => {
    expect(artboardAtCentre(boxes, { x: -200, y: 0, zoom: 1 }, { width: 100, height: 100 })).toBe("b");
  });
});
