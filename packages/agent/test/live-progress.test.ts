import { afterEach, describe, expect, it } from "vitest";
import { pageRunsPath, type EngineEvent, type ThreadRun } from "@redline/shared";
import { startSeam2, type Seam2 } from "./support/seam2.js";
import type { Engine } from "../src/engine.js";

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

/** An engine that emits `first`, waits for `release()`, then emits `rest`. */
function gatedEngine(first: EngineEvent[], rest: EngineEvent[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = async function* () {
    yield* first;
    await gate;
    yield* rest;
  };
  const engine: Engine = { start: stream, resume: stream };
  return { engine, release };
}

const runsOf = async (s: Seam2, pageId: string) => (await (await s.server.get(pageRunsPath(pageId))).json()) as ThreadRun[];

describe("following a running thread live", () => {
  it("goes from sent to running to answered, with steps and streamed text, visible mid-run", async () => {
    const { engine, release } = gatedEngine(
      [
        { type: "step", tool: "Read", summary: "home.html" },
        { type: "text", text: "Looking at " },
        { type: "text", text: "the title." },
      ],
      [{ type: "step", tool: "Edit", summary: "home.html" }, { type: "result", summary: "Done" }],
    );
    seam = await startSeam2(engine);
    const page = await seam.createPage({ "home.html": "<h1>Hi</h1>" });
    await seam.pinThread(page.id, "home.html", "Change the title");

    const midRun = async () => (await runsOf(seam!, page.id))[0];
    await expectEventually(async () => (await midRun())?.text === "Looking at the title.");
    const during = await midRun();
    expect(during.status).toBe("running");
    expect(during.steps).toEqual([{ tool: "Read", summary: "home.html" }]);

    release();
    await seam.waitForWorkEnd();
    const [after] = await runsOf(seam, page.id);
    expect(after.status).toBe("answered");
    expect(after.steps.map((s) => s.tool)).toEqual(["Read", "Edit"]);

    const statuses = seam.events().flatMap((e) => (e.type === "run-updated" ? [e.run.status] : []));
    expect(statuses[0]).toBe("sent");
    expect([...new Set(statuses)]).toEqual(["sent", "running", "answered"]);
  });

  it("marks the run failed with the engine's message", async () => {
    const { engine, release } = gatedEngine([], [{ type: "error", message: "Engine crashed" }]);
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const page = await seam.createPage({ "home.html": "<h1>Hi</h1>" });
    await seam.pinThread(page.id, "home.html", "Change the title");
    release();
    await seam.waitForWorkEnd();
    const [run] = await runsOf(seam, page.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Engine crashed");
  });
});

async function expectEventually(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
