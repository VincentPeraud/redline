import { expect, it } from "vitest";
import { splitMessageLinks } from "../src/messageLinks.js";

const origin = "http://localhost:3000";

it("turns canvas and play addresses of this server into address segments, keeping the text around", () => {
  const body = `Voir ${origin}/#/pages/p1/artboards/panier.html puis ${origin}/#/pages/p2/play/a%20b.html?rendu=mobile.`;
  expect(splitMessageLinks(body, origin)).toEqual([
    { kind: "text", text: "Voir " },
    { kind: "address", url: `${origin}/#/pages/p1/artboards/panier.html`, pageId: "p1", artboard: "panier.html" },
    { kind: "text", text: " puis " },
    { kind: "address", url: `${origin}/#/pages/p2/play/a%20b.html?rendu=mobile`, pageId: "p2", play: "a b.html", rendu: "mobile" },
    { kind: "text", text: "." },
  ]);
});

it("recognises a page address", () => {
  expect(splitMessageLinks(`${origin}/#/pages/p1`, origin)).toEqual([{ kind: "address", url: `${origin}/#/pages/p1`, pageId: "p1" }]);
});

it("leaves other URLs as plain links, including other origins and non-page routes of this server", () => {
  expect(splitMessageLinks(`(https://example.com/x#/pages/p1/artboards/a.html) et ${origin}/#/sessions`, origin)).toEqual([
    { kind: "text", text: "(" },
    { kind: "link", url: "https://example.com/x#/pages/p1/artboards/a.html" },
    { kind: "text", text: ") et " },
    { kind: "link", url: `${origin}/#/sessions` },
  ]);
});

it("returns the body untouched when it has no URL", () => {
  expect(splitMessageLinks("Rien à voir", origin)).toEqual([{ kind: "text", text: "Rien à voir" }]);
});
