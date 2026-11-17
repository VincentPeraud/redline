import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommentMode, Page, ShareLink, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const idle = () => new FakeEngine([{ type: "result", summary: "Done" }]);
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

/** A page in `mode` and a client of its Commentaire link, who leaves a comment: it waits "À relire". */
async function pageWithReviewComment(mode: CommentMode, engine = idle()): Promise<{ page: Page; thread: Thread }> {
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES, "Partager", mode);
  const link = (await (await seam.server.post(`/api/pages/${page.id}/links`, { kind: "generic", name: "Client HAIDF", level: "comment" })).json()) as ShareLink;
  const posted = await fetch(`${seam.server.url}/s/${link.token}/api/pages/${page.id}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { kind: "artboard", artboard: "home.html" }, body: "Send the link by e-mail?", visitorName: "Marc" }),
  });
  const thread = (await posted.json()) as Thread;
  expect(thread.status).toBe("review");
  return { page, thread };
}

/** A comment through a link made "sans relecture": it skips À relire and follows the page's mode at once. */
async function directLinkComment(pageId: string): Promise<Thread> {
  const link = (await (await seam!.server.post(`/api/pages/${pageId}/links`, { kind: "generic", name: "Client direct", level: "comment", direct: true })).json()) as ShareLink;
  const posted = await fetch(`${seam!.server.url}/s/${link.token}/api/pages/${pageId}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { kind: "artboard", artboard: "home.html" }, body: "Straight to Claude", visitorName: "Marc" }),
  });
  return (await posted.json()) as Thread;
}

async function conversationTerminal() {
  const folder = mkdtempSync(join(tmpdir(), "redline-conversation-"));
  mkdirSync(join(folder, ".redline"), { recursive: true });
  writeFileSync(join(folder, ".redline", "project.json"), JSON.stringify({ projectIds: [seam!.project.id] }));
  return openTerminal({ ...seam!, folder }, stops, "MacBook-Pro");
}

describe("À relire follows the page's mode only after Envoyer à Claude", () => {
  it("in Conversation mode: never listed nor taken before, to take after", async () => {
    const { page, thread } = await pageWithReviewComment("conversation");
    const terminal = await conversationTerminal();

    expect(await terminal.call("pending_comments", {})).toMatch(/No comment to take/);
    expect(await terminal.call("pending_comments", { pageId: page.id })).not.toContain(thread.id);
    expect(await terminal.call("pending_comments", { threadIds: [thread.id] })).toMatch(/not open/);
    expect((await threadsOf(page.id))[0]).toMatchObject({ status: "review" });
    expect((await threadsOf(page.id))[0].toTake).toBeUndefined();

    await seam!.server.post(`/api/pages/${page.id}/send-review`, {});

    expect((await threadsOf(page.id))[0]).toMatchObject({ status: "open", toTake: true });
    expect(await terminal.call("pending_comments", { pageId: page.id })).toContain(thread.id);
  });

  it("in Agent mode: the agent receives nothing before, then the comment", async () => {
    const engine = idle();
    const { page, thread } = await pageWithReviewComment("agent", engine);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(engine.runs).toHaveLength(0);

    await seam!.server.post(`/api/pages/${page.id}/send-review`, {});
    await seam!.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].message).toContain(thread.id);
  });

  it("a link made sans relecture: directly to take in Conversation mode, directly to the agent in Agent mode", async () => {
    seam = await startSeam2(idle());
    const conversation = await seam.createPage(PAGE_FILES, "Partager", "conversation");
    const taken = await directLinkComment(conversation.id);
    expect(taken.status).toBe("open");
    expect((await threadsOf(conversation.id))[0]).toMatchObject({ status: "open", toTake: true });

    const agent = await seam.createPage(PAGE_FILES, "Vue visiteur", "agent");
    const sent = await directLinkComment(agent.id);
    await seam.waitForWorkEnd(1);
    expect(sent.status).toBe("open");
  });
});
