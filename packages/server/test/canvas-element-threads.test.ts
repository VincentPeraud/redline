import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const MANIFEST = {
  artboards: [{ file: "home.html" }],
  elements: [
    { id: "note-parcours", kind: "sticky", text: "Parcours", width: 240, size: "m", color: "yellow", x: 0, y: 0 },
    { kind: "text", text: "No id", width: 300, size: "m", x: 0, y: 200 },
  ],
};

describe("threads on canvas elements over the server HTTP API", () => {
  let server: TestServer;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    page = (await (
      await server.post(`/api/projects/${project.id}/pages`, {
        title: "Landing",
        files: { "home.html": "<h1>Hi</h1>", "manifest.json": JSON.stringify(MANIFEST) },
      })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const create = (target: object, extra: object = {}) =>
    server.post(`/api/pages/${page.id}/threads`, { target, body: "Fix this", held: true, ...extra });

  it("stores a thread on a canvas element, labelled with its kind and id, and lists it back", async () => {
    const res = await create({ kind: "canvas-element", elementId: "note-parcours" });
    expect(res.status).toBe(201);
    const thread = (await res.json()) as Thread;
    expect(thread.target).toMatchObject({ kind: "canvas-element", elementId: "note-parcours", elementKind: "sticky" });
    expect(thread).toMatchObject({ artboard: "", selector: "", number: 1 });
    const [listed] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(listed.target).toMatchObject({ kind: "canvas-element", elementId: "note-parcours", elementKind: "sticky" });
    const [held] = (await (await server.get(`/api/pages/${page.id}/held`)).json()) as Thread[];
    expect(held.target).toMatchObject({ kind: "canvas-element", elementId: "note-parcours" });
  });

  it("refuses an id that is not an element of the current manifest", async () => {
    const res = await create({ kind: "canvas-element", elementId: "note-tarifs" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "element is not on the page's canvas" });
  });

  it("refuses an artboard file used as an element id, and a missing id", async () => {
    expect((await create({ kind: "canvas-element", elementId: "home.html" })).status).toBe(400);
    expect((await create({ kind: "canvas-element" })).status).toBe(400);
  });

  it("refuses an id on a page without a manifest", async () => {
    const project = (await (await server.post("/api/projects", { title: "Bare" })).json()) as Project;
    const bare = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Bare", files: { "a.html": "<p>a</p>" } })).json()) as Page;
    const res = await server.post(`/api/pages/${bare.id}/threads`, { target: { kind: "canvas-element", elementId: "x" }, body: "x" });
    expect(res.status).toBe(400);
  });

  it("reports a thread as removed while its element is absent from the current manifest, and restores it when the id returns", async () => {
    await create({ kind: "canvas-element", elementId: "note-parcours" });
    const removedFlags = async () =>
      ((await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[]).map((t) => t.removed ?? false);
    const publish = (elements: object[]) =>
      server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": JSON.stringify({ ...MANIFEST, elements }) }, message: "Edit", origin: "thread" });

    expect(await removedFlags()).toEqual([false]);
    await publish([{ id: "other", kind: "text", text: "Other", width: 300, size: "m", x: 0, y: 0 }]);
    expect(await removedFlags()).toEqual([true]);
    await publish(MANIFEST.elements);
    expect(await removedFlags()).toEqual([false]);
  });
});
