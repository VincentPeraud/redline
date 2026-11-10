import { afterEach, describe, expect, it } from "vitest";
import type { ArtboardVersion, ConversationDetail, DesignMdInfo, PageVersionSummary, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const putDesignMd = (path: string, body: { content: string }) =>
  fetch(seam!.server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const json = async <T>(res: Response) => (await res.json()) as T;

describe("what a run records: version origin, DESIGN.md, created pages", () => {
  it("records the thread that made a version, and the artboard history shows it", async () => {
    const engine = new FakeEngine([
      { edit: { path: "home.html", content: "<!doctype html><h1>Bigger</h1>" } },
      { type: "result", summary: "Bigger title" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Make the title bigger");
    await seam.waitForVersions(page.id, 2);

    const [latest] = await json<PageVersionSummary[]>(await seam.server.get(`/api/pages/${page.id}/versions`));
    expect(latest).toMatchObject({ origin: "thread", originId: thread.id, originLabel: "Make the title bigger" });
    const history = await json<ArtboardVersion[]>(await seam.server.get(`/api/pages/${page.id}/artboard-versions?file=home.html`));
    expect(history[0]).toMatchObject({ title: "Bigger title", origin: "thread", originId: thread.id, originLabel: "Make the title bigger", current: true });
  });

  it("saves a DESIGN.md edited by a thread run as a version with its origin, and attributes each rule to the version that added it", async () => {
    const engine = new FakeEngine([
      { edit: { path: "DESIGN.md", content: "# Rules\n- Buttons are full width\n" } },
      { type: "result", summary: "Full width button" },
    ]);
    seam = await startSeam2(engine);
    const project = seam.project;
    await putDesignMd(`/api/projects/${project.id}/design-md`, { content: "# Rules\n" });
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Buttons should be full width");
    await seam.waitForWorkEnd();

    expect((await json<{ content: string }>(await seam.server.get(`/api/projects/${project.id}/design-md`))).content).toBe("# Rules\n- Buttons are full width\n");
    const info = await json<DesignMdInfo>(await seam.server.get(`/api/projects/${project.id}/design-md/info`));
    expect(info.versionCount).toBe(2);
    expect(info.lastModified).toMatchObject({ origin: "thread", originId: thread.id, originLabel: "Buttons should be full width" });
    expect(info.rules.map((r) => [r.line, r.text, r.origin])).toEqual([
      [1, "# Rules", "user"],
      [2, "- Buttons are full width", "thread"],
    ]);
  });

  it("does not touch DESIGN.md when the session leaves it alone, nor blank it when it deletes the file", async () => {
    const engine = new FakeEngine([{ remove: "DESIGN.md" }, { type: "result", summary: "Nothing" }]);
    seam = await startSeam2(engine);
    await putDesignMd(`/api/projects/${seam.project.id}/design-md`, { content: "- keep me\n" });
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Do nothing");
    await seam.waitForWorkEnd();

    expect((await json<DesignMdInfo>(await seam.server.get(`/api/projects/${seam.project.id}/design-md/info`))).versionCount).toBe(1);
    expect((await json<{ content: string }>(await seam.server.get(`/api/projects/${seam.project.id}/design-md`))).content).toBe("- keep me\n");
  });

  it("a conversation run edits DESIGN.md with origin conversation", async () => {
    const engine = new FakeEngine([
      { edit: { path: "DESIGN.md", content: "- Titles in sentence case\n" } },
      { type: "result", summary: "Noted" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const conversation = await json<ConversationDetail>(await seam.server.post(`/api/pages/${page.id}/conversations`, { title: "Tone" }));
    await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Titles in sentence case from now on" });
    await seam.waitForWorkEnd();

    const info = await json<DesignMdInfo>(await seam.server.get(`/api/projects/${seam.project.id}/design-md/info`));
    expect(info.lastModified).toMatchObject({ origin: "conversation", originId: conversation.id, originLabel: "Tone" });
  });

  it("shows the pages a thread run created under its first answer, and a conversation run under its message", async () => {
    const engine = new FakeEngine((run) => [
      { callTool: { name: "create_page", arguments: { title: "Pricing" } } },
      { replyInThread: { threadId: /thread id: ([0-9a-f-]{36})/.exec(run.message)![1], text: "Done, see Pricing" } },
      { type: "result", summary: "Created Pricing" },
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Make a pricing page");
    await seam.waitForWorkEnd();

    const [stored] = await json<Thread[]>(await seam.server.get(`/api/pages/${page.id}/threads`));
    expect(stored.id).toBe(thread.id);
    expect(stored.replies[0].createdPages).toEqual([{ pageId: expect.any(String), name: "Pricing", artboardCount: 0 }]);
    const created = await json<{ createdBy: string }>(await seam.server.get(`/api/pages/${stored.replies[0].createdPages![0].pageId}`));
    expect(created.createdBy).toBe("claude");

    const conversationEngine = new FakeEngine([
      { callTool: { name: "create_page", arguments: { title: "Docs" } } },
      { type: "result", summary: "Created Docs" },
    ]);
    await seam.stop();
    seam = await startSeam2(conversationEngine);
    const other = await seam.createPage(PAGE_FILES);
    const conversation = await json<ConversationDetail>(await seam.server.post(`/api/pages/${other.id}/conversations`, {}));
    await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add a docs page" });
    await seam.waitForWorkEnd();
    const detail = await json<ConversationDetail>(await seam.server.get(`/api/conversations/${conversation.id}`));
    expect(detail.messages.find((m) => m.author === "claude")?.createdPages).toEqual([{ pageId: expect.any(String), name: "Docs", artboardCount: 0 }]);
  });

  it("tells the session the readable element name next to the selector, and stores it with the thread", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "ok" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Rename it", { elementName: "bouton « Continuer »" });
    await engine.finished(1);

    expect(thread.elementName).toBe("bouton « Continuer »");
    expect(engine.runs[0].message).toContain("bouton « Continuer »");
    expect(engine.runs[0].message).toContain("`h1`");
  });
});
