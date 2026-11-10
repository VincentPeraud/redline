import { afterEach, describe, expect, it } from "vitest";
import { retryRunPath, type Thread, type ThreadRun } from "@redline/shared";
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

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const runStatuses = (s: Seam2) => s.events().flatMap((e) => (e.type === "run-updated" ? [e.run.status] : []));
const lastRun = (s: Seam2): ThreadRun | undefined => s.events().flatMap((e) => (e.type === "run-updated" ? [e.run] : [])).at(-1);

async function openThread(s: Seam2): Promise<{ pageId: string; thread: Thread }> {
  const page = await s.createPage(PAGE_FILES);
  return { pageId: page.id, thread: await s.pinThread(page.id, "home.html", "Change the title") };
}

describe("retries and failure", () => {
  it("retries a failed run after the delay and publishes once it succeeds", async () => {
    const engine = new FakeEngine(() =>
      engineRuns(engine) < 2
        ? [{ type: "error", message: "Overloaded" }]
        : [{ edit: { path: "home.html", content: "<h1>New</h1>" } }, { type: "result", summary: "Done" }],
    );
    seam = await startSeam2(engine, { retryDelaysMs: [30, 30, 30] });
    const { pageId } = await openThread(seam);
    await seam.waitForVersions(pageId, 2);

    expect(engine.runs).toHaveLength(2);
    expect(runStatuses(seam)).toContain("retrying");
    await until(() => lastRun(seam!)?.status === "answered", "the answered run");
    expect(await seam.versions(pageId)).toHaveLength(2);
  });

  it("posts the answers of the attempt that succeeded only, not those of the failed ones", async () => {
    let threadId = "";
    const engine = new FakeEngine(() =>
      engineRuns(engine) < 3
        ? [{ replyInThread: { threadId, text: "Done!" } }, { type: "error", message: "Overloaded" }]
        : [{ replyInThread: { threadId, text: "Really done." } }, { type: "result", summary: "Done" }],
    );
    seam = await startSeam2(engine, { retryDelaysMs: [20, 20, 20] });
    const page = await seam.createPage(PAGE_FILES);
    threadId = (await seam.pinThread(page.id, "home.html", "Change the title")).id;
    await until(() => lastRun(seam!)?.status === "answered", "the answered run");

    const [thread] = (await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(thread.replies.map((r) => r.body)).toEqual(["Really done."]);
  });

  it("starts a new Claude session on each retry of a run that opened one", async () => {
    const engine = new FakeEngine(() => (engineRuns(engine) < 3 ? [{ type: "error", message: "Overloaded" }] : [{ type: "result", summary: "Done" }]));
    seam = await startSeam2(engine, { retryDelaysMs: [20, 20, 20] });
    await openThread(seam);
    await until(() => lastRun(seam!)?.status === "answered", "the answered run");

    expect(engine.runs.map((r) => r.resume)).toEqual([false, false, false]);
    expect(new Set(engine.runs.map((r) => r.sessionId)).size).toBe(3);
  });

  it("marks the item failed after the last retry, with nothing published", async () => {
    const engine = new FakeEngine([{ edit: { path: "home.html", content: "<h1>Half</h1>" } }, { type: "error", message: "Crashed" }]);
    seam = await startSeam2(engine, { retryDelaysMs: [20, 20, 20] });
    const { pageId } = await openThread(seam);
    await until(() => lastRun(seam!)?.status === "failed", "the final failure");

    expect(engine.runs).toHaveLength(4);
    expect(lastRun(seam)?.error).toBe("Crashed");
    expect(await seam.versions(pageId)).toHaveLength(1);
  });

  it("waits for the reported reset of a subscription limit without using the retry delays", async () => {
    // Taken once the server runs, so a slow start never puts the reset in the past
    let resetAt = 0;
    const engine = new FakeEngine(() =>
      engineRuns(engine) < 2
        ? [{ type: "error", message: `Claude AI usage limit reached|${resetAt}` }]
        : [{ type: "result", summary: "Done" }],
    );
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    resetAt = Math.ceil(Date.now() / 1000) + 2;
    await openThread(seam);
    await until(() => lastRun(seam!)?.status === "answered", "the run after the reset");

    const waiting = seam.events().flatMap((e) => (e.type === "work-retrying" ? [e] : []));
    expect(waiting).toHaveLength(1);
    expect(waiting[0].limit).toBe(true);
    expect(Date.parse(waiting[0].retryAt)).toBe(resetAt * 1000);
    expect(Date.now()).toBeGreaterThanOrEqual(resetAt * 1000 - 50);
  }, 20_000);

  it("puts a failed item back in the queue on Relancer, keeping the message's model and effort", async () => {
    let failing = false;
    const engine = new FakeEngine(() => (failing ? [{ type: "error", message: "Crashed" }] : [{ type: "result", summary: "Done" }]));
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const { pageId, thread } = await openThread(seam);
    await seam.waitForWorkEnd(1);

    failing = true;
    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "again", model: "haiku", effort: "low" });
    await until(() => lastRun(seam!)?.status === "failed", "the failure");
    const failed = lastRun(seam)!;

    failing = false;
    const res = await seam.server.post(retryRunPath(pageId, failed.workId), {});
    expect(res.status).toBe(204);
    await until(() => lastRun(seam!)?.status === "answered", "the retried run");

    expect(engine.runs).toHaveLength(3);
    expect(engine.runs[2]).toMatchObject({ model: "haiku", effort: "low", resume: true });
    expect((await seam.server.post(retryRunPath(pageId, failed.workId), {})).status).toBe(404);
  });
});

const engineRuns = (engine: FakeEngine) => engine.runs.length;
