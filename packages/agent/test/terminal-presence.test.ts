import { afterEach, describe, expect, it } from "vitest";
import type { TerminalHolder } from "@redline/shared";
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

const open = (machine: string, options: { heartbeatMs?: number } = {}) => openTerminal(seam!, stops, machine, options);

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function holderOf(pageId: string): Promise<TerminalHolder | null> {
  const res = await seam!.server.get(`/api/pages/${pageId}/terminal-holder`);
  return res.status === 404 ? null : ((await res.json()) as TerminalHolder | null);
}

describe("terminal session presence and held page", () => {
  it("makes the terminal session that publishes a page its holder, with its folder, machine and time", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    expect(await holderOf(page.id)).toBeNull();

    await terminal.publish(page.id, "First");

    expect(await holderOf(page.id)).toMatchObject({ folder: "/work/MacBook-Pro", machine: "MacBook-Pro", since: expect.any(String) });
  });

  it("lets a second terminal session that publishes take the page over", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const first = await open("MacBook-Pro");
    const second = await open("iMac");

    await first.publish(page.id, "First");
    await second.publish(page.id, "Second");

    expect(await holderOf(page.id)).toMatchObject({ machine: "iMac" });
  });

  it("keeps the holder when an agent publishes a version", async () => {
    seam = await startSeam2(
      new FakeEngine((run) => [
        { edit: { path: "home.html", content: `<h1>Agent ${run.sessionId}</h1>` } },
        ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Done" } })),
        { type: "result", summary: "Agent fix" },
      ]),
    );
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Change it");
    await seam.waitForWorkEnd(1);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const before = (await seam.versions(page.id)).length;

    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "Again" });
    await seam.waitForVersions(page.id, before + 1);

    expect((await seam.versions(page.id))[0]).toMatchObject({ origin: "thread" });
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });
  });

  it("stops holding the page when its terminal session says bye", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");

    await terminal.quit();

    expect(await holderOf(page.id)).toBeNull();
  });

  it("stops holding the page when its terminal session goes quiet, and keeps it while the session keeps beating", async () => {
    seam = await startSeam2(new FakeEngine([]), { terminalPresenceTimeoutMs: 400 });
    const page = await seam.createPage(PAGE_FILES);
    const beating = await open("MacBook-Pro", { heartbeatMs: 100 });
    await beating.publish(page.id, "First");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });

    const other = await seam.createPage(PAGE_FILES, "Other");
    const quiet = await open("iMac", { heartbeatMs: 60_000 });
    await quiet.publish(other.id, "Quiet");

    await until(async () => (await holderOf(other.id)) === null, "the quiet session to time out");
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });
  });

  it("announces hold changes to the canvas as server events", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");

    await terminal.publish(page.id, "First");
    await until(() => seam!.events().some((e) => e.type === "terminal-hold-changed" && e.pageId === page.id), "the hold event");
    const before = seam.events().length;
    await terminal.quit();

    await until(() => seam!.events().slice(before).some((e) => e.type === "terminal-hold-changed" && e.pageId === page.id), "the release event");
  });
});
