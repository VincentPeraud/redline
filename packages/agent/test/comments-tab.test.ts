import { describe, expect, it } from "vitest";
import { initialState, onKey, render, type ScreenState } from "../src/agents-view.js";
import { plainText } from "../src/terminal-draw.js";
import { commentsLoaded, type CommentsEntry } from "../src/comments-tab.js";
import type { InstanceEntry } from "../src/instance-list.js";

const NOW = Date.parse("2026-11-11T12:00:00");
const lumora: InstanceEntry = { id: "lumora", name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0", tooOld: false };
const acme: InstanceEntry = { id: "acme", name: "Acme", serverUrl: "https://redline.acme.test", version: "0.2.0", tooOld: false };
const at = (time: string) => new Date(`2026-11-11T${time}`).toISOString();

const entry = (instance: InstanceEntry, id: string, title: string, projectTitle: string, comments: CommentsEntry["page"]["comments"]): CommentsEntry => ({
  instanceId: instance.id,
  instance: instance.name,
  serverUrl: instance.serverUrl,
  page: { pageId: id, title, projectTitle, comments },
});

const accueil = entry(lumora, "p1", "Accueil", "Lumora · Site public", [
  { author: "Ariane Martin", at: at("10:31:00"), target: "accueil.html, the hero title", text: "Le titre passe sur deux lignes sur mobile, on peut le raccourcir ?" },
  { author: "Vincent Peraud", at: at("10:40:00"), target: "accueil.html, whole artboard", text: "Ajoute une variante sombre de cette section." },
]);
const tarifs = entry(lumora, "p2", "Tarifs", "Lumora · App", [
  { author: "Ariane Martin", at: at("11:00:00"), target: "tarifs.html, whole artboard", text: "Un." },
  { author: "Ariane Martin", at: at("11:01:00"), target: "tarifs.html, whole artboard", text: "Deux." },
]);
const fiche = entry(acme, "p3", "Fiche produit", "Acme · Boutique", [{ author: "Jo", at: at("09:00:00"), target: "fiche.html, whole artboard", text: "Ok" }]);

const open = (entries: CommentsEntry[], failures: { instance: string; message: string }[] = []): ScreenState =>
  commentsLoaded(initialState({ agents: [], now: NOW, home: "/Users/vincent", folder: "/Users/vincent/agora", instances: [lumora, acme], folderLine: { kind: "linked", instance: "Lumora", project: "Agora" }, tab: "comments" }), { entries, failures });
const text = (state: ScreenState, rows = 40) => plainText(render(state, { columns: 120, rows }));
const press = (state: ScreenState, ...keys: string[]) => keys.reduce((s, k) => onKey(s, k).state, state);

describe("the Comments tab", () => {
  it("counts the comments in the tab bar and lists the pages with their count", () => {
    const frame = text(open([accueil, tarifs, fiche]));
    expect(frame[4]).toMatch(/Comments {2}5 /);
    expect(frame[6]).toMatch(/│ {2}threads to take or taken {2,}$/);
    expect(frame[7]).toMatch(/│▎ › 2 Accueil {2,}$/);
    expect(frame[8]).toMatch(/│▎ {7}Lumora · Site public {2,}$/);
    expect(frame[10]).toMatch(/│ {4}2 Tarifs/);
    expect(frame[13]).toMatch(/│ {4}1 Fiche produit/);
    expect(frame[14]).toMatch(/│ {8}Acme · Boutique/);
  });

  it("shows how many comments the selected page has to take and each comment, with the hint (left pane focused)", () => {
    const frame = text(press(open([accueil, tarifs, fiche]), "left"));
    expect(frame[1]).toMatch(/^ {2}redline {2}Lumora · redline\.lumora\.com/);
    expect(frame[7]).toMatch(/^ {2}Accueil {2}Lumora · Site public on Lumora {2,}│/);
    expect(frame[8]).toMatch(/^ {2}Status {5}2 to take, no conversation has taken them yet {2,}│/);
    expect(frame[9]).toMatch(/^─+┤/);
    expect(frame[10]).toMatch(/^▎ 2 COMMENTS {2}focused: ↑↓ scroll, → back to the list {2,}│/);
    expect(frame[11]).toMatch(/^ {2}Ariane Martin {2}10:31 · accueil\.html, the hero title/);
    expect(frame[12]).toMatch(/^ {2}« Le titre passe sur deux lignes sur mobile, on peut le raccourcir \? »/);
    expect(frame[14]).toMatch(/^ {2}Vincent Peraud {2}10:40 · accueil\.html, whole artboard/);
    expect(frame[15]).toMatch(/^ {2}« Ajoute une variante sombre de cette section\. »/);
    expect(frame[16]).toMatch(/^─+┤/);
    expect(frame[17]).toMatch(/^ {2}Ask a Claude Code conversation: traite les commentaires d'Accueil/);
    expect(frame[18]).toMatch(/^ {2}o opens the page in Redline\./);
  });

  it("moves the selection with ↑↓ in the list and opens the selected page with o", () => {
    const state = press(open([accueil, tarifs, fiche]), "down", "down");
    expect(text(state)[13]).toMatch(/[│┤]▎ › 1 Fiche produit/);
    expect(text(state)[1]).toMatch(/Acme · redline\.acme\.test/);
    expect(onKey(state, "o").commands).toEqual([{ type: "open", url: "https://redline.acme.test/#/pages/p3" }]);
  });

  it("scrolls a long comment with ↑↓ once the left pane is focused, the hint staying at the bottom", () => {
    const long = entry(lumora, "p1", "Accueil", "Lumora", [{ author: "Ana", at: at("10:00:00"), target: "a.html, whole artboard", text: Array.from({ length: 40 }, (_, i) => `ligne${i}`).join("\n") }]);
    const focused = press(open([long]), "left");
    const top = text(focused, 24);
    expect(top.join("\n")).toContain("ligne0");
    expect(top.join("\n")).not.toContain("ligne39");
    expect(top.join("\n")).toContain("traite les commentaires d'Accueil");
    const scrolled = text(press(focused, ...Array<string>(100).fill("down")), 24).join("\n");
    expect(scrolled).toContain("ligne39");
    expect(scrolled).not.toContain("ligne0 ");
    expect(scrolled).toContain("traite les commentaires d'Accueil");
  });

  it("marks each comment to take or taken, sums the page status by taker and says who took what", () => {
    const mixed = entry(lumora, "p1", "Accueil", "Lumora · Site public", [
      { author: "Ariane Martin", at: at("10:31:00"), target: "accueil.html, the hero title", text: "Un." },
      { author: "Vincent Peraud", at: at("10:40:00"), target: "accueil.html, whole artboard", text: "Deux.", taken: { by: "Victor", folder: "~/crm" } },
    ]);
    const frame = text(press(open([mixed]), "left"));
    expect(frame[8]).toMatch(/^ {2}Status {5}1 to take, 1 taken by Victor \(~\/crm\) {2,}│/);
    expect(frame[11]).toMatch(/^ {2}Ariane Martin {2}10:31 · accueil\.html, the hero title · to take {2,}/);
    expect(frame[14]).toMatch(/^ {2}Vincent Peraud {2}10:40 · accueil\.html, whole artboard · taken by Victor +│/);
    const everyone = entry(lumora, "p1", "Tarifs", "Lumora", [
      { author: "A", at: at("10:00:00"), target: "t.html, whole artboard", text: "x", taken: { by: "", folder: "~/c" } },
      { author: "B", at: at("10:01:00"), target: "t.html, whole artboard", text: "y", taken: { by: "Victor", folder: "~/s" } },
      { author: "C", at: at("10:02:00"), target: "t.html, whole artboard", text: "z", taken: { by: "Victor", folder: "~/s" } },
    ]);
    expect(text(press(open([everyone]), "left"))[8]).toMatch(/Status {5}1 taken by a conversation \(~\/c\), 2 taken by Victor \(~\/s\)/);
  });

  it("says so when no page waits, while loading, and when an instance cannot be read", () => {
    const empty = text(open([]));
    expect(empty.join("\n")).toContain("No comment to take.");
    const loading = text(initialState({ agents: [], now: NOW, home: "/h", folder: "/h/a", instances: [lumora], tab: "comments" }));
    expect(loading.join("\n")).toContain("Loading the comments");
    expect(text(open([accueil], [{ instance: "Acme", message: "unreachable" }])).join("\n")).toContain("Acme: unreachable");
  });
});
