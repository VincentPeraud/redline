import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, Thread } from "@redline/shared";
import { startAgent } from "../src/agent.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function reply(s: Seam2, threadId: string, body: string): Promise<Response> {
  return s.server.post(`/api/threads/${threadId}/messages`, { body });
}

async function threadOf(s: Seam2, pageId: string): Promise<Thread> {
  return ((await (await s.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[])[0];
}

describe("replying in a thread", () => {
  it("resumes the same engine session, answers in the same thread and publishes one new version", async () => {
    let threadId = "";
    let calls = 0;
    const engine = new FakeEngine(() => [
      ...(calls++ > 0
        ? [
            { edit: { path: "home.html", content: "<!doctype html><h1>Bigger title</h1>" } },
            { replyInThread: { threadId, text: "Made it bigger." } },
            { type: "result" as const, summary: "Bigger title" },
          ]
        : [
            { edit: { path: "home.html", content: "<!doctype html><h1>New title</h1>" } },
            { replyInThread: { threadId, text: "Title updated." } },
            { type: "result" as const, summary: "Update the title" },
          ]),
    ]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    threadId = (await seam.pinThread(page.id, "home.html", "Change the title")).id;
    await seam.waitForVersions(page.id, 2);
    await seam.waitForWorkEnd(1);

    expect((await reply(seam, threadId, "Make it bigger")).status).toBe(201);
    await seam.waitForVersions(page.id, 3);
    await seam.waitForWorkEnd(2);

    expect(engine.runs.map((r) => r.resume)).toEqual([false, true]);
    expect(engine.runs[1].sessionId).toBe(engine.runs[0].sessionId);
    expect(engine.runs[1].message).toContain("Make it bigger");
    expect(engine.runs[1].filesAtStart["home.html"]).toContain("New title");
    expect((await seam.versions(page.id)).map((v) => [v.origin, v.message])).toEqual([
      ["thread", "Bigger title"],
      ["thread", "Update the title"],
      ["terminal", "Page created"],
    ]);
    expect(await seam.readFile(page.id, "home.html")).toContain("Bigger title");
    expect((await threadOf(seam, page.id)).replies.map((r) => [r.author, r.body])).toEqual([
      ["claude", "Title updated."],
      ["user", "Make it bigger"],
      ["claude", "Made it bigger."],
    ]);
  });

  it("answers on the project's new agent, in a new session, when the agent that opened the session was replaced", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Look");
    await engine.finished(1);
    await seam.waitForWorkEnd(1);

    // The opening agent leaves; another agent takes over the project.
    seam.agent.close();
    const otherEngine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);
    const otherFolder = mkdtempSync(join(tmpdir(), "redline-other-agent-"));
    cleanups.push(() => rmSync(otherFolder, { recursive: true, force: true }));
    const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
    await waitUntilOffline(seam);
    const other = await startAgent({
      serverUrl: seam.server.url,
      token,
      machine: "other-machine",
      folder: otherFolder,
      kind: "project",
      projectId: seam.project.id,
      engine: otherEngine,
    });
    cleanups.push(() => other.close());

    expect((await reply(seam, thread.id, "Are you there?")).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await otherEngine.finished(1);
    expect(engine.runs).toHaveLength(1);
    expect(otherEngine.runs[0].resume).toBe(false);
    expect(otherEngine.runs[0].message).toContain("Look");
    expect(otherEngine.runs[0].message).toContain("Are you there?");
  });
});

async function waitUntilOffline(s: Seam2): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const agents = (await (await s.server.get("/api/agents")).json()) as { status: string }[];
    if (agents.every((a) => a.status === "offline")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("agent still online");
}
