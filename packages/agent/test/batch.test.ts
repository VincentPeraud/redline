import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1><button>Go</button>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const idsIn = (message: string) => [...message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => m[1]);

describe("sending held comments", () => {
  it("answers every thread of the batch separately and publishes one version, then a reply resumes the shared session", async () => {
    const engine = new FakeEngine((run) =>
      run.message.includes("Reply from the user")
        ? [{ replyInThread: { threadId: idsIn(run.message)[0], text: "Darker now." } }, { type: "result" as const, summary: "Darker" }]
        : [
            { edit: { path: "home.html", content: "<!doctype html><h1>New title</h1><button>Go!</button>" } },
            ...idsIn(run.message).map((threadId, i) => ({ replyInThread: { threadId, text: `Done ${i + 1}` } })),
            { type: "result" as const, summary: "Title and button" },
          ],
    );
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const held = async (body: string) =>
      (await (await seam!.server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 5, yPct: 5, body, held: true })).json()) as Thread;
    const first = await held("New title");
    const second = await held("Exclaim the button");
    expect(engine.runs).toHaveLength(0);

    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForVersions(page.id, 2);
    await seam.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
    expect(idsIn(engine.runs[0].message)).toEqual([first.id, second.id]);
    const threads = (await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(threads.map((t) => t.replies.map((r) => r.body))).toEqual([["Done 1"], ["Done 2"]]);

    await seam.server.post(`/api/threads/${second.id}/messages`, { body: "Make it darker" });
    await seam.waitForWorkEnd(2);
    expect(engine.runs.map((r) => r.resume)).toEqual([false, true]);
    expect(engine.runs[1].sessionId).toBe(engine.runs[0].sessionId);
    const after = (await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(after.map((t) => t.replies.map((r) => r.body))).toEqual([["Done 1"], ["Done 2", "Make it darker", "Darker now."]]);
  });
});
