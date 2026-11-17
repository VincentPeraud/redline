import { afterEach, describe, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";
import { ServerApi } from "../src/server-api.js";
import type { AgentTokenResponse } from "@redline/shared";

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

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("terminalComments (the Comments tab data)", () => {
  it("lists the threads to take of a page without taking them", async () => {
    seam = await startSeam2(new FakeEngine(() => []));
    const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
    const terminal = await openTerminal(seam, stops, "MacBook-Pro", { folder: "/work/site" });
    await seam.pinThread(page.id, "home.html", "Make it blue");
    const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
    const api = new ServerApi(seam.server.url, token);
    await until(async () => (await api.terminalComments()).length === 1, "the thread to be to take");

    const [first] = await api.terminalComments();
    expect(first).toMatchObject({ pageId: page.id, title: "Accueil" });
    expect(first.comments).toMatchObject([{ text: "Make it blue", target: "home.html, h1" }]);

    expect(await api.terminalComments()).toEqual([first]);
    expect(await terminal.call("pending_comments", { pageId: page.id })).toContain("Make it blue");
    expect(await api.terminalComments()).toEqual([]);
  });
});

describe("loadComments", () => {
  it("reads every installation and reports the ones it cannot read", async () => {
    const { loadComments } = await import("../src/comments-source.js");
    const installation = (name: string) => ({ id: name.toLowerCase(), name, serverUrl: `https://${name.toLowerCase()}.test`, token: "t" }) as never;
    const page = { pageId: "p1", title: "Accueil", projectTitle: "Site", comments: [] };
    const result = await loadComments([installation("Lumora"), installation("Acme")], async (i) => {
      if ((i as { name: string }).name === "Acme") throw new Error("connect ECONNREFUSED");
      return [page];
    });
    expect(result.entries).toEqual([{ instanceId: "lumora", instance: "Lumora", serverUrl: "https://lumora.test", page }]);
    expect(result.failures).toEqual([{ instance: "Acme", message: "unreachable" }]);
  });
});
