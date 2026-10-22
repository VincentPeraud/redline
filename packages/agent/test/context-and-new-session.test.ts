import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

async function threadOf(s: Seam2, pageId: string): Promise<Thread> {
  return ((await (await s.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[])[0];
}

const usage = (inputTokens: number, cacheTokens: number, outputTokens: number) =>
  ({ type: "usage" as const, model: "claude-test", inputTokens, cacheTokens, outputTokens });

describe("context %", () => {
  it("uses the last usage event over the default window when the engine reports none", async () => {
    const engine = new FakeEngine([usage(1, 10_000, 100), usage(2, 100_000, 398), { type: "result", summary: "Done" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Look");
    await seam.waitForWorkEnd(1);

    // 100_400 tokens of the last call, default 200k window -> 50 %
    expect((await threadOf(seam, page.id)).context).toMatchObject({ model: "claude-test", tokens: 100_400, window: 200_000, percent: 50 });
  });

  it("shows the window reported by the engine and keeps the value after the run", async () => {
    const engine = new FakeEngine([usage(0, 100_000, 0), { type: "result", summary: "Done", contextWindow: 1_000_000 }]);
    seam = await startSeam2(engine, { agent: { effort: "high" } });
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Look");
    await seam.waitForWorkEnd(1);

    expect((await threadOf(seam, page.id)).context).toEqual({ model: "claude-test", effort: "high", tokens: 100_000, window: 1_000_000, percent: 10 });
  });
});

describe("Nouvelle session", () => {
  it("asks the old session for a summary, then runs the next reply in a new session seeded with it", async () => {
    const engine = new FakeEngine((run) =>
      run.message.includes("Write a summary")
        ? [{ type: "result", summary: "SUMMARY: title is blue, header kept." }]
        : [usage(0, 150_000, 0), { type: "result", summary: "ok" }],
    );
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Make it blue");
    await seam.waitForWorkEnd(1);
    expect((await threadOf(seam, page.id)).context?.percent).toBe(75);

    expect((await seam.server.post(`/api/threads/${thread.id}/new-session`, {})).status).toBe(202);
    await engine.finished(2);
    await seam.waitForWorkEnd(2);
    const ready = await threadOf(seam, page.id);
    expect(ready.newSession).toBe("ready");
    expect(ready.context).toBeUndefined();
    expect(engine.runs[1].resume).toBe(true);
    expect(engine.runs[1].sessionId).toBe(engine.runs[0].sessionId);

    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "Now green" });
    await engine.finished(3);
    await seam.waitForWorkEnd(3);
    expect(engine.runs[2].resume).toBe(false);
    expect(engine.runs[2].sessionId).not.toBe(engine.runs[0].sessionId);
    expect(engine.runs[2].message).toContain("SUMMARY: title is blue, header kept.");
    expect(engine.runs[2].message).toContain("Now green");
    expect((await threadOf(seam, page.id)).newSession).toBeUndefined();

    // the thread then resumes the new session
    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "And bigger" });
    await engine.finished(4);
    expect(engine.runs[3].resume).toBe(true);
    expect(engine.runs[3].sessionId).toBe(engine.runs[2].sessionId);
  });

  it("refuses an unknown thread", async () => {
    seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]));
    expect((await seam.server.post(`/api/threads/nope/new-session`, {})).status).toBe(404);
  });
});
