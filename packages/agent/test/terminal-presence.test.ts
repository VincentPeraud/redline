import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse, TerminalHolder } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer, startPresence } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

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

interface Terminal {
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Edits the checked-out page and publishes it. */
  publish(pageId: string, message: string): Promise<string>;
  /** Closes the session cleanly (Claude Code quit): says bye. */
  quit(): Promise<void>;
}

/** A terminal session: `redline mcp` in its own folder, present on the server. */
async function openTerminal(machine: string, options: { heartbeatMs?: number } = {}): Promise<Terminal> {
  const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const api = new ServerApi(seam!.server.url, token);
  const sessionId = `terminal-${Math.random().toString(36).slice(2)}`;
  const folder = `/work/${machine}`;
  const server = createTerminalMcpServer({ api, folder: seam!.folder, sessionId });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  const presence = startPresence({ api, sessionId, folder, machine, intervalMs: options.heartbeatMs ?? 20_000 });
  await presence.firstBeat;
  let closed = false;
  const quit = async () => {
    if (closed) return;
    closed = true;
    await presence.stop();
    await client.close();
  };
  stops.push(quit);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
  };
  return {
    call,
    async publish(pageId, message) {
      await call("checkout_page", { pageId });
      writeFileSync(join(seam!.folder, ".redline", pageId, "home.html"), `<h1>${message}</h1>`);
      return call("publish_page", { message });
    },
    quit,
  };
}

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
    const terminal = await openTerminal("MacBook-Pro");
    expect(await holderOf(page.id)).toBeNull();

    await terminal.publish(page.id, "First");

    expect(await holderOf(page.id)).toMatchObject({ folder: "/work/MacBook-Pro", machine: "MacBook-Pro", since: expect.any(String) });
  });

  it("lets a second terminal session that publishes take the page over", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const first = await openTerminal("MacBook-Pro");
    const second = await openTerminal("iMac");

    await first.publish(page.id, "First");
    await second.publish(page.id, "Second");

    expect(await holderOf(page.id)).toMatchObject({ machine: "iMac" });
  });

  it("keeps the holder when an agent publishes a version", async () => {
    let threadId = "";
    seam = await startSeam2(
      new FakeEngine(() => [
        { edit: { path: "home.html", content: "<h1>Agent</h1>" } },
        { replyInThread: { threadId, text: "Done" } },
        { type: "result", summary: "Agent fix" },
      ]),
    );
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await openTerminal("MacBook-Pro");
    await terminal.publish(page.id, "First");

    threadId = (await seam.pinThread(page.id, "home.html", "Change it")).id;
    await seam.waitForVersions(page.id, 3);

    expect((await seam.versions(page.id))[0]).toMatchObject({ origin: "thread" });
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });
  });

  it("stops holding the page when its terminal session says bye", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await openTerminal("MacBook-Pro");
    await terminal.publish(page.id, "First");

    await terminal.quit();

    expect(await holderOf(page.id)).toBeNull();
  });

  it("stops holding the page when its terminal session goes quiet, and keeps it while the session keeps beating", async () => {
    seam = await startSeam2(new FakeEngine([]), { terminalPresenceTimeoutMs: 400 });
    const page = await seam.createPage(PAGE_FILES);
    const beating = await openTerminal("MacBook-Pro", { heartbeatMs: 100 });
    await beating.publish(page.id, "First");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });

    const other = await seam.createPage(PAGE_FILES, "Other");
    const quiet = await openTerminal("iMac", { heartbeatMs: 60_000 });
    await quiet.publish(other.id, "Quiet");

    await until(async () => (await holderOf(other.id)) === null, "the quiet session to time out");
    expect(await holderOf(page.id)).toMatchObject({ machine: "MacBook-Pro" });
  });

  it("announces hold changes to the canvas as server events", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await openTerminal("MacBook-Pro");

    await terminal.publish(page.id, "First");
    await until(() => seam!.events().some((e) => e.type === "terminal-hold-changed" && e.pageId === page.id), "the hold event");
    const before = seam.events().length;
    await terminal.quit();

    await until(() => seam!.events().slice(before).some((e) => e.type === "terminal-hold-changed" && e.pageId === page.id), "the release event");
  });
});
