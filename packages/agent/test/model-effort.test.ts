import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo, Thread } from "@redline/shared";
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

async function openThread(s: Seam2): Promise<Thread> {
  const page = await s.createPage(PAGE_FILES);
  return s.pinThread(page.id, "home.html", "Change the title");
}

describe("model and effort", () => {
  it("passes the agent's defaults to its runs and reports them", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Done" }]);
    seam = await startSeam2(engine, { agent: { model: "opus", effort: "high" } });
    const thread = await openThread(seam);
    await engine.finished(1);
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].model).toBe("opus");
    expect(engine.runs[0].effort).toBe("high");
    const agents = (await (await seam.server.get("/api/agents")).json()) as AgentInfo[];
    expect(agents[0]).toMatchObject({ model: "opus", effort: "high" });

    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "again" });
    await engine.finished(2);
    expect(engine.runs[1].model).toBe("opus");
    expect(engine.runs[1].effort).toBe("high");
  });

  it("passes no model or effort without flags", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Done" }]);
    seam = await startSeam2(engine);
    await openThread(seam);
    await engine.finished(1);

    expect(engine.runs[0].model).toBeUndefined();
    expect(engine.runs[0].effort).toBeUndefined();
    const agents = (await (await seam.server.get("/api/agents")).json()) as AgentInfo[];
    expect(agents[0].model).toBeUndefined();
    expect(agents[0].effort).toBeUndefined();
  });

  it("uses a model or effort chosen with a reply for that message only, independently of each other", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Done" }]);
    seam = await startSeam2(engine, { agent: { model: "sonnet", effort: "low" } });
    const thread = await openThread(seam);
    await engine.finished(1);
    await seam.waitForWorkEnd(1);

    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "harder", model: "opus" });
    await engine.finished(2);
    await seam.waitForWorkEnd(2);
    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "harder still", effort: "max" });
    await engine.finished(3);

    expect(engine.runs.map((r) => [r.model, r.effort])).toEqual([
      ["sonnet", "low"],
      ["opus", "low"],
      ["sonnet", "max"],
    ]);
  });

  it("rejects an unknown effort", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Done" }]);
    seam = await startSeam2(engine);
    const thread = await openThread(seam);
    const res = await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "x", effort: "ultra" });
    expect(res.status).toBe(400);
  });
});
