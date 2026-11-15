import { describe, expect, it } from "vitest";
import { initialState, onKey, render, type ScreenState } from "../src/agents-view.js";
import { plainText } from "../src/terminal-draw.js";
import { commentsLoaded, type CommentsEntry } from "../src/comments-tab.js";
import type { InstanceEntry } from "../src/instance-list.js";

const NOW = Date.parse("2026-11-11T12:00:00");
const lumora: InstanceEntry = { id: "lumora", name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0", tooOld: false };
const acme: InstanceEntry = { id: "acme", name: "Acme", serverUrl: "https://redline.acme.test", version: "0.2.0", tooOld: false };
const at = (time: string) => new Date(`2026-11-11T${time}`).toISOString();

const entry = (instance: InstanceEntry, id: string, title: string, projectTitle: string, comments: CommentsEntry["page"]["comments"], held = true): CommentsEntry => ({
  instanceId: instance.id,
  instance: instance.name,
  serverUrl: instance.serverUrl,
  page: { pageId: id, title, projectTitle, comments, ...(held ? { holder: { folder: "~/lumora", machine: "Mac", since: at("10:12:00") } } : {}) },
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
    expect(frame[6]).toMatch(/│ {2}waiting for a terminal session {2,}$/);
    expect(frame[7]).toMatch(/│▎ › 2 Accueil {2,}$/);
    expect(frame[8]).toMatch(/│▎ {7}Lumora · Site public {2,}$/);
    expect(frame[10]).toMatch(/│ {4}2 Tarifs/);
    expect(frame[13]).toMatch(/│ {4}1 Fiche produit/);
    expect(frame[14]).toMatch(/│ {8}Acme · Boutique/);
  });

  it("shows who holds the selected page and each comment, with the hint (left pane focused)", () => {
    const frame = text(press(open([accueil, tarifs, fiche]), "left"));
    expect(frame[1]).toMatch(/^ {2}redline {2}Lumora · redline\.lumora\.com/);
    expect(frame[7]).toMatch(/^ {2}Accueil {2}Lumora · Site public on Lumora {2,}│/);
    expect(frame[8]).toMatch(/^ {2}Held by {4}the Claude Code session in ~\/lumora \(published 10:12\) {2,}│/);
    expect(frame[9]).toMatch(/^─+┤/);
    expect(frame[10]).toMatch(/^▎ 2 COMMENTS {2}focused: ↑↓ scroll, → back to the list {2,}│/);
    expect(frame[11]).toMatch(/^ {2}Ariane Martin {2}10:31 · accueil\.html, the hero title/);
    expect(frame[12]).toMatch(/^ {2}« Le titre passe sur deux lignes sur mobile, on peut le raccourcir \? »/);
    expect(frame[14]).toMatch(/^ {2}Vincent Peraud {2}10:40 · accueil\.html, whole artboard/);
    expect(frame[15]).toMatch(/^ {2}« Ajoute une variante sombre de cette section\. »/);
    expect(frame[16]).toMatch(/^─+┤/);
    expect(frame[17]).toMatch(/^ {2}In that session, ask Claude: traite mes commentaires/);
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
    expect(top.join("\n")).toContain("traite mes commentaires");
    const scrolled = text(press(focused, ...Array<string>(100).fill("down")), 24).join("\n");
    expect(scrolled).toContain("ligne39");
    expect(scrolled).not.toContain("ligne0 ");
    expect(scrolled).toContain("traite mes commentaires");
  });

  it("says so when no page waits, while loading, and when an instance cannot be read", () => {
    const empty = text(open([]));
    expect(empty.join("\n")).toContain("No comment is waiting for a terminal session.");
    const loading = text(initialState({ agents: [], now: NOW, home: "/h", folder: "/h/a", instances: [lumora], tab: "comments" }));
    expect(loading.join("\n")).toContain("Loading the comments");
    expect(text(open([accueil], [{ instance: "Acme", message: "unreachable" }])).join("\n")).toContain("Acme: unreachable");
  });

  it("says nobody holds the page when no session is present", () => {
    const orphan = entry(lumora, "p9", "Blog", "Lumora", [{ author: "Ana", at: at("10:00:00"), target: "b.html, whole artboard", text: "Hi" }], false);
    expect(text(press(open([orphan]), "left")).join("\n")).toContain("no terminal session is present");
  });
});
