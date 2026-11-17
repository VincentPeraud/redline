import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, Thread } from "@redline/shared";
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

const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

/** Answers a conversation message by calling the tool, and every thread it is then given with an answer. */
function chatEngine(answers: { tool?: string }) {
  return new FakeEngine(async (run) => {
    if (run.message.includes("thread id:")) {
      return [
        ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
        { type: "result" as const, summary: "Threads done" },
      ];
    }
    answers.tool = await run.callTool("hand_over_comments", {});
    return [{ type: "result" as const, summary: "Handed over" }];
  });
}

async function chat(engine: FakeEngine) {
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
  const conversation = (await (await seam.server.post(`/api/pages/${page.id}/conversations`, {})).json()) as ConversationDetail;
  const say = async (body: string) => {
    expect((await seam!.server.post(`/api/conversations/${conversation.id}/messages`, { body })).status).toBe(201);
  };
  return { page, say };
}

describe("web chat: traite les commentaires", () => {
  it("is offered to sessions that handle a page conversation", async () => {
    const answers: { tool?: string } = {};
    const engine = chatEngine(answers);
    const { say } = await chat(engine);

    await say("traite les commentaires");
    await seam!.waitForWorkEnd(1);

    expect(engine.runs[0].mcpTools).toContain("hand_over_comments");
  });

  it("hands every thread to take to the agent and lists the threads taken by a conversation", async () => {
    const answers: { tool?: string } = {};
    const engine = chatEngine(answers);
    const { page, say } = await chat(engine);
    const first = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const second = await seam!.pinThread(page.id, "home.html", "Bigger title");
    const kept = await seam!.pinThread(page.id, "home.html", "Move the logo");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    await terminal.call("pending_comments", { threadIds: [kept.id] });

    await say("traite les commentaires");
    await seam!.waitForWorkEnd(3);

    expect(answers.tool).toContain(`#${first.number}`);
    expect(answers.tool).toContain(`#${second.number}`);
    expect(answers.tool).toMatch(new RegExp(`Left alone[^]*#${kept.number}[^]*MacBook-Pro`));
    const after = await threadsOf(page.id);
    for (const id of [first.id, second.id]) {
      const thread = after.find((t) => t.id === id)!;
      expect(thread).not.toHaveProperty("toTake");
      expect(thread.replies.map((r) => r.body)).toContain("Agent answer");
    }
    expect(after.find((t) => t.id === kept.id)).toMatchObject({ take: { machine: "MacBook-Pro" } });
    expect(after.find((t) => t.id === kept.id)!.replies).toHaveLength(0);
  });

  it("says so when nothing waits to be taken", async () => {
    const answers: { tool?: string } = {};
    const { say } = await chat(chatEngine(answers));

    await say("traite les commentaires");
    await seam!.waitForWorkEnd(1);

    expect(answers.tool).toContain("No thread to take");
  });
});
