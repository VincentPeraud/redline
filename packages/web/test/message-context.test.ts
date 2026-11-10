import { describe, expect, it } from "vitest";
import type { Manifest } from "@redline/shared";
import { contextChips, messageContext } from "../src/messageContext.js";

const boxes = new Map([
  ["accueil.html", { x: 60, y: 100, width: 360, height: 420 }],
  ["paiement.html", { x: 500, y: 100, width: 360, height: 420 }],
  ["confirmation.html", { x: 940, y: 100, width: 360, height: 420 }],
]);
const viewport = { width: 1060, height: 840 };

describe("message context", () => {
  it("counts an artboard cut by the viewport edge as visible and leaves out one fully off screen", () => {
    const at = (x: number, zoom = 1) => messageContext({ view: { x, y: 0, zoom }, viewport, boxes, tweaks: [] }).visibleArtboards.map((a) => a.file);
    expect(at(0)).toEqual(["accueil.html", "paiement.html", "confirmation.html"]);
    expect(at(-1200)).toEqual(["confirmation.html"]);
    expect(at(-421)).toEqual(["paiement.html", "confirmation.html"]);
    expect(at(0, 0.5)).toEqual(["accueil.html", "paiement.html", "confirmation.html"]);
    expect(at(0, 2)).toEqual(["accueil.html", "paiement.html"]);
  });

  it("sends only the shown artboard, with its rendering, in play mode", () => {
    const context = messageContext({ view: { x: 0, y: 0, zoom: 1 }, viewport, boxes, tweaks: [], play: { file: "paiement.html", rendering: { format: "mobile", width: 390 } } });
    expect(context.visibleArtboards).toEqual([{ file: "paiement.html", rendering: { format: "mobile", width: 390 } }]);
    expect(messageContext({ view: { x: 0, y: 0, zoom: 1 }, viewport, boxes, tweaks: [], play: { file: "accueil.html" } }).visibleArtboards).toEqual([{ file: "accueil.html" }]);
  });

  it("labels each tweak with its current value", () => {
    const manifest = {
      tweaks: [
        { id: "theme", type: "choice", label: "Thème", options: ["clair", "sombre"] },
        { id: "gap", type: "range", label: "Espacement", unit: "px" },
        { id: "badge", type: "toggle", label: "Badge" },
      ],
    } as unknown as Manifest;
    const context = messageContext({ view: { x: 0, y: 0, zoom: 1 }, viewport, boxes, manifest, tweakValues: { theme: "sombre", gap: 12, badge: true } });
    expect(context.tweaks).toEqual([
      { label: "Thème", value: "sombre" },
      { label: "Espacement", value: "12 px" },
      { label: "Badge", value: "oui" },
    ]);
  });

  it("describes the page, the visible artboards and the tweaks as chips, hiding the tweaks chip without tweaks", () => {
    const context = { visibleArtboards: [{ file: "accueil.html" }, { file: "paiement.html" }], tweaks: [{ label: "Thème", value: "sombre" }, { label: "Densité", value: "compacte" }] };
    expect(contextChips("Parcours billet", 3, context)).toEqual(["Parcours billet · 3 artboards", "Visibles : accueil, paiement", "Tweaks : thème sombre, densité compacte"]);
    expect(contextChips("Parcours billet", 1, { visibleArtboards: [{ file: "a.html" }], tweaks: [] })).toEqual(["Parcours billet · 1 artboard", "Visibles : a"]);
    expect(contextChips("Vide", 0, { visibleArtboards: [], tweaks: [] })).toEqual(["Vide · 0 artboard", "Visibles : aucun"]);
  });
});
