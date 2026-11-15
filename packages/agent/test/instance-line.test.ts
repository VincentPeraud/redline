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
});

async function connect(instance?: { name: string; address: string; version: string }) {
  seam = await startSeam2(new FakeEngine([]));
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam.server.url, token), folder: seam.folder, instance });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "claude", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const answer = async (name: string, args: Record<string, unknown> = {}) =>
  (((await client!.callTool({ name, arguments: args })).content as { text: string }[]) ?? []).map((c) => c.text).join("\n");

describe("the instance in the terminal MCP", () => {
  it("starts every answer with the instance line, errors included, and puts it in the instructions", async () => {
    await connect({ name: "Lumora", address: "redline.lumora.com", version: "0.2.0" });
    expect(await answer("list_projects")).toMatch(/^Instance: Lumora \(redline\.lumora\.com, v0\.2\.0\)\n/);
    expect(await answer("publish_page", { message: "x" })).toMatch(/^Instance: Lumora \(redline\.lumora\.com, v0\.2\.0\)\nNo page checked out/);
    expect(client!.getInstructions()).toContain("Instance: Lumora (redline.lumora.com, v0.2.0)");
  });

  it("keeps the tool names of a session without instance", async () => {
    await connect({ name: "Lumora", address: "redline.lumora.com", version: "0.2.0" });
    const withInstance = (await client!.listTools()).tools.map((tool) => tool.name);
    await client!.close();
    await seam!.stop();
    await connect();
    expect((await client!.listTools()).tools.map((tool) => tool.name)).toEqual(withInstance);
    expect(await answer("list_projects")).not.toMatch(/^Instance:/);
  });
});
