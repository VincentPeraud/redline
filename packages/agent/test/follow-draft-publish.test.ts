import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

async function connectTerminal(folder: string): Promise<(name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>> {
  const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam!.server.url, token), folder });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  return async (name, args) => {
    const result = await client!.callTool({ name, arguments: args });
    return { text: ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n"), isError: result.isError === true };
  };
}

const put = (path: string, body: unknown) => fetch(seam!.server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("publishing after the design system setting changed", () => {
  it("is refused when the project stopped following the draft since the checkout, and works after a new checkout", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const designSystemId = await seam.createDesignSystem();
    await put(`/api/projects/${seam.project.id}/design-system`, { designSystem: designSystemId });
    await put(`/api/projects/${seam.project.id}/design-system`, { followsDraft: true });
    const page = await seam.createPage({ "home.html": "<!doctype html><h1>Home</h1>" });
    const call = await connectTerminal(seam.folder);
    await call("checkout_page", { pageId: page.id });
    const copy = join(seam.folder, ".redline", page.id);

    await put(`/api/projects/${seam.project.id}/design-system`, { followsDraft: false, confirm: true });
    writeFileSync(join(copy, "home.html"), "<h1>Changed</h1>");
    const refused = await call("publish_page", { message: "Rework home" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("setting changed since this page was checked out");

    await call("checkout_page", { pageId: page.id });
    writeFileSync(join(copy, "home.html"), "<h1>Changed</h1>");
    expect((await call("publish_page", { message: "Rework home" })).text).toMatch(/Published/);
  });
});
