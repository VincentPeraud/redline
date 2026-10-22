import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse, PageVersionSummary } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const MANIFEST = JSON.stringify({
  artboards: [{ file: "home.html" }, { file: "about.html" }],
  tweaks: [{ id: "accent", type: "color", label: "Accent", default: "#e5484d" }],
});
const PAGE_FILES = { "home.html": "<h1>Home</h1>", "about.html": "<h1>About</h1>", "manifest.json": MANIFEST };

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

/** A run that waits for the test to release it, so the test can change the page while the session works. */
function gatedEngine(edit: { path: string; content: string }) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const engine = new FakeEngine(async () => {
    await gate;
    return [{ edit }, { type: "result", summary: "Session change" }];
  });
  return { engine, release: () => release() };
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await condition()).toBe(true);
}

describe("a run publishing while the page changed meanwhile", () => {
  it("keeps a tweak made during the run", async () => {
    const { engine, release } = gatedEngine({ path: "home.html", content: "<h1>Home by Claude</h1>" });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Change the title");
    await until(async () => engine.runs.length === 1);

    expect((await seam.server.post(`/api/pages/${page.id}/tweaks`, { id: "accent", value: "#0f766e" })).status).toBe(201);
    release();
    await seam.waitForWorkEnd();

    expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Home by Claude</h1>");
    expect(JSON.parse(await seam.readFile(page.id, "tweaks.json"))).toEqual({ accent: "#0f766e" });
  });

  it("keeps the files a restore brought back during the run", async () => {
    const { engine, release } = gatedEngine({ path: "home.html", content: "<h1>Home by Claude</h1>" });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.server.post(`/api/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "about.html": "<h1>About v2</h1>" }, message: "About v2", origin: "tweak" });
    const first = (await seam.versions(page.id)).at(-1)!;

    await seam.pinThread(page.id, "home.html", "Change the title");
    await until(async () => engine.runs.length === 1);
    expect((await seam.server.post(`/api/pages/${page.id}/versions/${first.id}/restore`, {})).status).toBe(201);
    release();
    await seam.waitForWorkEnd();

    expect(await seam.readFile(page.id, "about.html")).toBe("<h1>About</h1>");
    expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Home by Claude</h1>");
  });

  it("fails the run, publishing nothing, when the session and the page changed the same file", async () => {
    const { engine, release } = gatedEngine({ path: "home.html", content: "<h1>Home by Claude</h1>" });
    seam = await startSeam2(engine, { retryDelaysMs: [] });
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Change the title");
    await until(async () => engine.runs.length === 1);
    await seam.server.post(`/api/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": "<h1>Home by hand</h1>" }, message: "By hand", origin: "tweak" });
    release();
    await seam.waitForWorkEnd();

    const failed = seam.workMessages().find((m) => m.type === "work-failed");
    expect(failed).toMatchObject({ message: expect.stringContaining("home.html") });
    expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Home by hand</h1>");
  });
});

describe("terminal mode publishing after a session published", () => {
  async function connectTerminal(folder: string): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
    const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
    const server = createTerminalMcpServer({ api: new ServerApi(seam!.server.url, token), folder });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "terminal-claude", version: "0.0.0" });
    await client.connect(clientSide);
    return async (name, args) => {
      const result = await client!.callTool({ name, arguments: args });
      return ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
    };
  }

  it("never deletes or overwrites what was published after the checkout", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminalFolder = mkdtempSync(join(tmpdir(), "redline-terminal-"));
    try {
      const call = await connectTerminal(terminalFolder);
      await call("checkout_page", { pageId: page.id });

      await seam.server.post(`/api/pages/${page.id}/versions`, {
        files: { ...PAGE_FILES, "about.html": "<h1>About by a session</h1>", "extra.html": "<h1>Extra</h1>" },
        message: "Session",
        origin: "thread",
      });

      writeFileSync(join(terminalFolder, ".redline", page.id, "home.html"), "<h1>Home by terminal</h1>");
      expect(await call("publish_page", { message: "Terminal work" })).toMatch(/merged/);

      expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Home by terminal</h1>");
      expect(await seam.readFile(page.id, "about.html")).toBe("<h1>About by a session</h1>");
      expect(await seam.readFile(page.id, "extra.html")).toBe("<h1>Extra</h1>");

      // The working copy was refreshed, so a second publish does not undo anything either.
      writeFileSync(join(terminalFolder, ".redline", page.id, "home.html"), "<h1>Home again</h1>");
      expect(await call("publish_page", { message: "More" })).toMatch(/Published/);
      expect(await seam.readFile(page.id, "about.html")).toBe("<h1>About by a session</h1>");
      expect(((await seam.versions(page.id)) as PageVersionSummary[]).map((v) => v.origin).slice(0, 2)).toEqual(["terminal", "terminal"]);
    } finally {
      rmSync(terminalFolder, { recursive: true, force: true });
    }
  });

  it("refuses to publish a file that was changed by someone else since the checkout", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const terminalFolder = mkdtempSync(join(tmpdir(), "redline-terminal-"));
    try {
      const call = await connectTerminal(terminalFolder);
      await call("checkout_page", { pageId: page.id });
      await seam.server.post(`/api/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": "<h1>Home by a session</h1>" }, message: "Session", origin: "thread" });

      writeFileSync(join(terminalFolder, ".redline", page.id, "home.html"), "<h1>Home by terminal</h1>");
      expect(await call("publish_page", { message: "Terminal work" })).toMatch(/home\.html/);
      expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Home by a session</h1>");
    } finally {
      rmSync(terminalFolder, { recursive: true, force: true });
    }
  });
});
