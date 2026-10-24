import { afterEach, describe, expect, it } from "vitest";
import type { Conversation, ConversationDetail, Page, Project, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

async function newConversation(s: Seam2, pageId: string): Promise<ConversationDetail> {
  const res = await s.server.post(`/api/pages/${pageId}/conversations`, {});
  expect(res.status).toBe(201);
  return (await res.json()) as ConversationDetail;
}

const send = (s: Seam2, id: string, body: string, extra: object = {}) =>
  s.server.post(`/api/conversations/${id}/messages`, { body, ...extra });

const getConversation = async (s: Seam2, id: string) =>
  (await (await s.server.get(`/api/conversations/${id}`)).json()) as ConversationDetail;

describe("page conversations", () => {
  it("creates, lists and archives conversations of a page", async () => {
    seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]));
    const page = await seam.createPage(PAGE_FILES);
    const first = await newConversation(seam, page.id);
    const second = await newConversation(seam, page.id);

    const archived = (await (await seam.server.post(`/api/conversations/${first.id}/archive`, {})).json()) as Conversation;
    expect(archived.archived).toBe(true);
    const list = (await (await seam.server.get(`/api/pages/${page.id}/conversations`)).json()) as Conversation[];
    expect(list.map((c) => [c.id, c.archived])).toEqual([
      [first.id, true],
      [second.id, false],
    ]);
    expect((await send(seam, first.id, "hello")).status).toBe(409);
    expect((await send(seam, second.id, " ")).status).toBe(400);
    expect((await seam.server.get("/api/conversations/nope")).status).toBe(404);
  });

  it("creates the conversation when the first message is sent on a page without any, and the message reaches the session", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Hello back" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES, "Onboarding");
    expect(await (await seam.server.get(`/api/pages/${page.id}/conversations`)).json()).toEqual([]);

    const created = await newConversation(seam, page.id);
    expect((await send(seam, created.id, "First words", { model: "opus", effort: "low" })).status).toBe(201);
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain("First words");
    const detail = await getConversation(seam, created.id);
    expect(detail).toMatchObject({ model: "opus", effort: "low" });
    expect(detail.messages.map((m) => m.body)).toEqual(["First words", "Hello back"]);
  });

  it("gives the session the page address and each artboard's canvas and play addresses, in reading order", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(
      {
        "home.html": "<!doctype html><h1>Home</h1>",
        "pay now.html": "<!doctype html><h1>Pay</h1>",
        "manifest.json": JSON.stringify({ artboards: [{ file: "pay now.html", title: "Paiement", x: 900, y: 0 }, { file: "home.html", x: 0, y: 0 }] }),
      },
      "Checkout",
    );
    const conversation = await newConversation(seam, page.id);
    expect((await send(seam, conversation.id, "Hello")).status).toBe(201);
    await seam.waitForWorkEnd(1);

    const base = `${seam.server.url}/#/pages/${page.id}`;
    expect(engine.runs[0].message).toContain(
      [
        `Page: ${base}`,
        "Artboards, in reading order:",
        `1. home.html · canvas ${base}/artboards/home.html · play ${base}/play/home.html`,
        `2. Paiement · canvas ${base}/artboards/pay%20now.html · play ${base}/play/pay%20now.html`,
      ].join("\n"),
    );
  });

  it("follows a message with the artboards the user is looking at and the tweak values", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await newConversation(seam, page.id);
    const context = {
      visibleArtboards: [{ file: "home.html" }, { file: "pay.html", rendering: { format: "mobile", width: 390 } }],
      tweaks: [
        { label: "Thème", value: "sombre" },
        { label: "Densité", value: "compacte" },
      ],
    };
    expect((await send(seam, conversation.id, "Change the title", { context })).status).toBe(201);
    await seam.waitForWorkEnd(1);

    const message = engine.runs[0].message;
    expect(message).toContain("Change the title\n\nThe user is looking at: home.html, pay.html (Mobile · 390)\nTweak values: Thème: sombre, Densité: compacte");
    expect((await getConversation(seam, conversation.id)).messages[0].body).toBe("Change the title");
  });

  it("follows a message with its numbered chips and keeps them on the stored message", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await newConversation(seam, page.id);
    const targets = [
      { kind: "element", artboard: "home.html", selector: "h1", elementName: "Titre · Old title", xPct: 10, yPct: 20, rendering: { format: "mobile", width: 390 } },
      { kind: "artboard", artboard: "pay.html" },
      { kind: "canvas-element", elementId: "note-1", elementKind: "sticky", elementSummary: "« Parcours »" },
    ];
    const context = { visibleArtboards: [{ file: "home.html" }], tweaks: [], targets };
    expect((await send(seam, conversation.id, "Give 2 the style of 1", { context })).status).toBe(201);
    await seam.waitForWorkEnd(1);

    const message = engine.runs[0].message;
    expect(message).toContain(
      "Elements the user points at:\n1: element `h1` (named « Titre · Old title ») on artboard home.html (vu en Mobile · 390 px)\n2: the whole artboard pay.html\n3: the canvas element `note-1` (sticky, « Parcours ») of manifest.json",
    );
    expect((await getConversation(seam, conversation.id)).messages[0].targets).toEqual(targets);
  });

  it("refuses malformed chips", async () => {
    seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]));
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await newConversation(seam, page.id);
    const bad = { visibleArtboards: [], tweaks: [], targets: [{ kind: "element", artboard: "home.html" }] };
    expect((await send(seam, conversation.id, "Hi", { context: bad })).status).toBe(400);
    const chip = (target: object) => ({ visibleArtboards: [], tweaks: [], targets: [target] });
    const canvas = { kind: "canvas-element", elementId: "note-1", elementKind: "sticky" };
    const element = { kind: "element", artboard: "home.html", selector: "h1", elementName: null, xPct: 1, yPct: 2 };
    expect((await send(seam, conversation.id, "Hi", { context: chip({ ...canvas, elementKind: "toString" }) })).status).toBe(400);
    expect((await send(seam, conversation.id, "Hi", { context: chip({ ...element, rendering: { format: "toString", width: 390 } }) })).status).toBe(400);
    expect((await send(seam, conversation.id, "Hi", { context: chip({ ...element, rendering: { format: "mobile", width: 0 } }) })).status).toBe(400);
    expect((await send(seam, conversation.id, "Hi", { context: { visibleArtboards: [{ file: "home.html", rendering: { format: "mobile", width: 0 } }], tweaks: [] } })).status).toBe(400);
  });

  it("omits the tweak line when the page has no tweaks and refuses a malformed context", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await newConversation(seam, page.id);
    expect((await send(seam, conversation.id, "Hi", { context: { visibleArtboards: "home.html", tweaks: [] } })).status).toBe(400);
    expect((await send(seam, conversation.id, "Hi", { context: { visibleArtboards: [], tweaks: [] } })).status).toBe(201);
    await seam.waitForWorkEnd(1);
    expect(engine.runs[0].message).toContain("The user is looking at: no artboard on screen");
    expect(engine.runs[0].message).not.toContain("Tweak values");
  });

  it("runs a session told which page is shown, publishes a version with origin conversation and records Claude's answer", async () => {
    const engine = new FakeEngine([
      { edit: { path: "home.html", content: "<!doctype html><h1>New title</h1>" } },
      { type: "result", summary: "Updated the title" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES, "Onboarding");
    const conversation = await newConversation(seam, page.id);
    expect((await send(seam, conversation.id, "Make the title new")).status).toBe(201);
    await seam.waitForVersions(page.id, 2);
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain(`"Onboarding" (page id ${page.id})`);
    expect(engine.runs[0].message).toContain("Make the title new");
    const versions = await seam.versions(page.id);
    expect(versions[0]).toMatchObject({ origin: "conversation", message: "Updated the title" });
    const detail = await getConversation(seam, conversation.id);
    expect(detail.messages.map((m) => [m.author, m.body])).toEqual([
      ["user", "Make the title new"],
      ["claude", "Updated the title"],
    ]);
  });

  it("resumes its own session on the next message and never shares it with a thread", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread: Thread = await seam.pinThread(page.id, "home.html", "A pinned comment");
    await engine.finished(1);
    await seam.waitForWorkEnd(1);

    const conversation = await newConversation(seam, page.id);
    await send(seam, conversation.id, "first");
    await engine.finished(2);
    await seam.waitForWorkEnd(2);
    await send(seam, conversation.id, "second", { model: "opus", effort: "high" });
    await engine.finished(3);
    await seam.waitForWorkEnd(3);

    const [threadRun, first, second] = engine.runs;
    expect(first.resume).toBe(false);
    expect(second.resume).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.sessionId).not.toBe(threadRun.sessionId);
    expect([second.model, second.effort]).toEqual(["opus", "high"]);
    expect(second.message).not.toContain(thread.id);

    const detail = await getConversation(seam, conversation.id);
    expect([detail.model, detail.effort]).toEqual(["opus", "high"]);
  });

  it("takes the page lock like a thread: a conversation message waits while a thread runs", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await newConversation(seam, page.id);
    await send(seam, conversation.id, "one");
    await send(seam, conversation.id, "two");
    await seam.waitForWorkEnd(2);
    const dispatched = seam.events().filter((e) => e.type === "work-dispatched");
    expect(dispatched).toHaveLength(2);
    const ends = seam.workMessages().filter((m) => m.type === "work-done");
    const firstEnd = seam.workMessages().indexOf(ends[0]);
    const secondStart = seam.workMessages().findIndex((m) => m.type === "work-event" && m.workId === (dispatched[1] as { workId: string }).workId);
    expect(secondStart).toBeGreaterThan(firstEnd);
  });

  it("gives a project's instructions as the first message of its first conversation only", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const project = (await (await seam.server.post("/api/projects", { title: "Briefed", instructions: "Use a calm tone." })).json()) as Project;
    const page = (await (
      await seam.server.post(`/api/projects/${project.id}/pages`, { title: "P", files: PAGE_FILES })
    ).json()) as Page;

    const first = await newConversation(seam, page.id);
    expect(first.messages.map((m) => [m.author, m.body])).toEqual([["user", "Use a calm tone."]]);
    const second = await newConversation(seam, page.id);
    expect(second.messages).toEqual([]);
  });
});
