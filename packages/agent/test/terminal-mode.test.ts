import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse, PageVersionSummary } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = { "home.html": "<!doctype html><h1>Home</h1>" };

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

/** The user's own Claude Code: an MCP client on `redline mcp`, working in `folder`. */
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

const origins = async (pageId: string) =>
  ((await (await seam!.server.get(`/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[]).map((v) => v.origin);

describe("terminal mode (redline mcp)", () => {
  it("checks a page out into .redline/<page>/ of the folder and publishes it as a terminal version", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);

    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);
    expect(readFileSync(join(copy, "home.html"), "utf8")).toBe(PAGE_FILES["home.html"]);

    writeFileSync(join(copy, "home.html"), "<h1>Changed</h1>");
    expect(await call("publish_page", { message: "Rework home" })).toMatch(/Published/);

    expect(await seam.readFile(page.id, "home.html")).toBe("<h1>Changed</h1>");
    const versions = (await (await seam.server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[];
    expect(versions[0]).toMatchObject({ origin: "terminal", message: "Rework home" });
    expect(await origins(page.id)).toHaveLength(2);
  });

  it("publishes nothing when the working copy did not change", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    expect(await call("publish_page", { message: "Nothing" })).toMatch(/Nothing changed/);
    expect(await origins(page.id)).toHaveLength(1);
  });

  it("asks to check a page out before publishing, and reports an unknown page", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);

    expect(await call("publish_page", { message: "x" })).toMatch(/checkout_page/);
    expect(await call("checkout_page", { pageId: "nope" })).toMatch(/page not found/);
    expect(existsSync(join(seam.folder, ".redline", "nope"))).toBe(false);
  });

  it("creates no conversation or thread", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(seam.folder, ".redline", page.id, "home.html"), "<h1>Changed</h1>");
    await call("publish_page", { message: "Rework" });

    expect(await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()).toEqual([]);
    expect(seam.workMessages()).toEqual([]);
  });

  it("add_artboard works on the checked-out page and is published with publish_page", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const page = await seam.createPage(PAGE_FILES);
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });

    await call("add_artboard", { file: "checkout.html", html: "<h1>Checkout</h1>" });
    await call("publish_page", { message: "Add checkout" });

    expect(await seam.readFile(page.id, "checkout.html")).toBe("<h1>Checkout</h1>");
  });

  it("publish waits for the page lock while a session runs on the page", async () => {
    let finishSession!: () => void;
    const sessionMayEnd = new Promise<void>((resolve) => (finishSession = resolve));
    const engine = new FakeEngine(async () => {
      await sessionMayEnd;
      return [{ edit: { path: "home.html", content: "<h1>From session</h1>" } }, { type: "result", summary: "Session edit" }];
    });
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminalFolder = mkdtempSync(join(tmpdir(), "redline-terminal-folder-"));
    const call = await connectTerminal(terminalFolder);
    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(terminalFolder, ".redline", page.id, "extra.html"), "<h1>Extra</h1>");

    await seam.pinThread(page.id, "home.html", "Do it");
    while (engine.runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const published = call("publish_page", { message: "From terminal" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await origins(page.id)).toHaveLength(1);

    finishSession();
    await published;
    await seam.waitForWorkEnd();
    expect(await origins(page.id)).toEqual(["terminal", "thread", "terminal"]);
    rmSync(terminalFolder, { recursive: true, force: true });
  });
});
