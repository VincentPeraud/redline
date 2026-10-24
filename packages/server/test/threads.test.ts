import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("pinned threads over the server HTTP API", () => {
  let server: TestServer;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const res = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: { "home.html": "<h1>Hi</h1>" },
    });
    page = (await res.json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const pin = (body: string, extra: object = {}) => ({
    artboard: "home.html",
    selector: "body > h1",
    xPct: 12.5,
    yPct: 30,
    body,
    ...extra,
  });

  async function createThread(body: string, extra: object = {}) {
    const res = await server.post(`/api/pages/${page.id}/threads`, pin(body, extra));
    expect(res.status).toBe(201);
    return (await res.json()) as Thread;
  }

  it("stores the rendering a thread was pinned in, and keeps it after a reload", async () => {
    const thread = await createThread("Burger menu", { rendering: { format: "mobile", width: 390 } });
    expect(thread.rendering).toEqual({ format: "mobile", width: 390 });
    const [listed] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(listed.rendering).toEqual({ format: "mobile", width: 390 });
    expect((await createThread("No rendering")).rendering).toBeUndefined();
  });

  it("accepts a fractional rendering width, as a manifest declares them", async () => {
    const thread = await createThread("Odd", { rendering: { format: "mobile", width: 390.5 } });
    expect(thread.rendering).toEqual({ format: "mobile", width: 390.5 });
  });

  it("refuses a rendering whose format is a prototype key", async () => {
    const res = await server.post(`/api/pages/${page.id}/threads`, pin("Bad", { rendering: { format: "constructor", width: 390 } }));
    expect(res.status).toBe(400);
  });

  it("keeps the rendering of a held comment", async () => {
    await createThread("Later", { held: true, rendering: { format: "tablet", width: 768 } });
    const [held] = (await (await server.get(`/api/pages/${page.id}/held`)).json()) as Thread[];
    expect(held.rendering).toEqual({ format: "tablet", width: 768 });
  });

  it.each([{ format: "watch", width: 390 }, { format: "mobile", width: 0 }, { format: "mobile" }, "mobile"])("refuses the rendering %j", async (rendering) => {
    const res = await server.post(`/api/pages/${page.id}/threads`, pin("Bad", { rendering }));
    expect(res.status).toBe(400);
  });

  it("stores a thread with its selector and percentage position, numbered from 1", async () => {
    const thread = await createThread("Make the title bigger\nand bolder");
    expect(thread).toMatchObject({
      pageId: page.id,
      number: 1,
      artboard: "home.html",
      selector: "body > h1",
      xPct: 12.5,
      yPct: 30,
      status: "open",
      title: "Make the title bigger",
    });

    const list = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(list).toEqual([thread]);
  });

  it("exposes a created thread as an element target", async () => {
    const thread = await createThread("Bigger", { elementName: "titre « Hi »" });
    expect(thread.target).toEqual({ kind: "element", artboard: "home.html", selector: "body > h1", elementName: "titre « Hi »", xPct: 12.5, yPct: 30 });
  });

  it("reads rows of the other target kinds back as artboard and canvas element targets", async () => {
    const whole = await createThread("Too busy");
    const canvas = await createThread("Fix this note");
    const db = new Database(join(server.dataDir, "redline.db"));
    db.prepare("UPDATE threads SET target_kind = 'artboard', selector = '' WHERE id = ?").run(whole.id);
    db.prepare("UPDATE threads SET target_kind = 'canvas-element', element_id = 'note-parcours', element_kind = 'sticky' WHERE id = ?").run(canvas.id);
    db.close();
    const list = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(list.map((t) => t.target)).toEqual([
      { kind: "artboard", artboard: "home.html" },
      { kind: "canvas-element", elementId: "note-parcours", elementKind: "sticky" },
    ]);
  });

  it("numbers threads in creation order and never reuses a number", async () => {
    const first = await createThread("one");
    const second = await createThread("two");
    expect([first.number, second.number]).toEqual([1, 2]);
    await server.post(`/api/threads/${first.id}/resolve`, {});
    const third = await createThread("three");
    expect(third.number).toBe(3);
  });

  it("rejects invalid pins", async () => {
    const bad = [
      pin(""),
      pin("ok", { selector: "" }),
      pin("ok", { xPct: 120 }),
      pin("ok", { yPct: -1 }),
      pin("ok", { artboard: "../x.html" }),
    ];
    for (const body of bad) {
      expect((await server.post(`/api/pages/${page.id}/threads`, body)).status).toBe(400);
    }
    expect((await server.post(`/api/pages/nope/threads`, pin("ok"))).status).toBe(404);
  });

  it("lets the user resolve a thread, and keeps it listed with its title", async () => {
    const thread = await createThread("Fix the header");
    const res = await server.post(`/api/threads/${thread.id}/resolve`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: thread.id, status: "resolved", title: "Fix the header" });
    const list = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(list.map((t) => t.status)).toEqual(["resolved"]);
    expect((await server.post(`/api/threads/unknown/resolve`, {})).status).toBe(404);
  });

  it("exposes no way to change a thread's status other than the user's resolve route", async () => {
    const thread = await createThread("Fix the header");
    for (const method of ["PATCH", "PUT"]) {
      const res = await fetch(`${server.url}/api/threads/${thread.id}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      // PATCH exists only to edit the text of a held comment; it ignores a status.
      expect(res.status).toBe(method === "PATCH" ? 400 : 404);
    }
    const list = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(list[0].status).toBe("open");
  });
});
