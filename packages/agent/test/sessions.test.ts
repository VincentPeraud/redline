import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, Page, Project, SessionDetail, SessionRow } from "@redline/shared";
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

const sessions = async (s: Seam2) => (await (await s.server.get("/api/sessions")).json()) as SessionRow[];
const byName = (rows: SessionRow[], name: string) => rows.find((r) => r.name === name)!;

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out");
}

describe("sessions list", () => {
  it("lists threads and conversations with project, page, status, agent, session, model, effort, context and activity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = new FakeEngine(async (run) => {
      if (run.message.includes("first comment")) await gate;
      return [
        { type: "usage", model: "opus-x", effort: "high", inputTokens: 0, cacheTokens: 50_000, outputTokens: 0 },
        { type: "result", summary: "Done it" },
      ];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES, "Onboarding");
    const first = await seam.pinThread(page.id, "home.html", "first comment");
    await until(async () => byName(await sessions(seam!), "first comment").status === "running");
    await seam.pinThread(page.id, "home.html", "second comment");

    let rows = await sessions(seam);
    expect(byName(rows, "second comment")).toMatchObject({ status: "queued", waitingReason: "page-busy", kind: "thread" });
    expect(byName(rows, "first comment")).toMatchObject({
      id: first.id,
      kind: "thread",
      projectTitle: "Acme",
      pageTitle: "Onboarding",
      pageId: page.id,
      status: "running",
      agent: { machine: "test-machine", kind: "project" },
    });
    expect(byName(rows, "first comment").sessionId).toBeTruthy();

    release();
    await seam.waitForWorkEnd(2);
    rows = await sessions(seam);
    expect(byName(rows, "first comment")).toMatchObject({
      status: "answered",
      model: "opus-x",
      effort: "high",
      context: { percent: 25 },
    });
    expect(byName(rows, "second comment").status).toBe("answered");
    expect(byName(rows, "first comment").activityAt).toBeTruthy();

    await seam.server.post(`/api/threads/${first.id}/resolve`, {});
    expect(byName(await sessions(seam), "first comment").status).toBe("resolved");

    const conversation = (await (await seam.server.post(`/api/pages/${page.id}/conversations`, { title: "Errors" })).json()) as ConversationDetail;
    expect(byName(await sessions(seam), "Errors")).toMatchObject({ kind: "conversation", status: "idle" });
    await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add an error screen", model: "sonnet", effort: "low" });
    await seam.waitForWorkEnd(3);
    expect(byName(await sessions(seam), "Errors")).toMatchObject({ status: "answered", model: "opus-x", pageTitle: "Onboarding" });

    await seam.server.post(`/api/conversations/${conversation.id}/archive`, {});
    expect(byName(await sessions(seam), "Errors").status).toBe("archived");
  });

  it("shows a thread whose project has no agent as waiting for the agent", async () => {
    seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]));
    const other = (await (await seam.server.post("/api/projects", { title: "Lonely" })).json()) as Project;
    const page = (await (await seam.server.post(`/api/projects/${other.id}/pages`, { title: "P", type: "prototype", files: PAGE_FILES })).json()) as Page;
    await seam.pinThread(page.id, "home.html", "nobody listens");
    expect(byName(await sessions(seam), "nobody listens")).toMatchObject({
      status: "waiting-agent",
      waitingReason: "agent-offline",
      projectTitle: "Lonely",
    });
  });

  it("returns the messages of one session", async () => {
    const engine = new FakeEngine(async (run) => {
      const threadId = /thread id: ([0-9a-f-]{36})/.exec(run.message)![1];
      return [{ replyInThread: { threadId, text: "Fixed." } }, { type: "result", summary: "Fix" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Make it red");
    await seam.waitForWorkEnd(1);

    const detail = (await (await seam.server.get(`/api/sessions/${thread.id}`)).json()) as SessionDetail;
    expect(detail.messages.map((m) => [m.author, m.body])).toEqual([
      ["user", "Make it red"],
      ["claude", "Fixed."],
    ]);
    expect((await seam.server.get("/api/sessions/nope")).status).toBe(404);
  });
});
