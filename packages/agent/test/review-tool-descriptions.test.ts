import { afterEach, expect, it } from "vitest";
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

async function toolDescription(name: string): Promise<string> {
  seam = await startSeam2(new FakeEngine([]));
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam.server.url, token), folder: seam.folder });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  return (await client.listTools()).tools.find((t) => t.name === name)?.description ?? "";
}

it("tells Claude when to declare a review, not only what request_review does", async () => {
  const description = await toolDescription("request_review");
  expect(description).toContain("instead of listing the artboards in the chat");
  expect(description).toContain("whenever you finish a series of changes");
});

it("reminds Claude after a publish to declare a review once the series of changes is finished", async () => {
  expect(await toolDescription("publish_page")).toContain("request_review");
});
