import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTokenResponse } from "@redline/shared";
import { ServerApi } from "../../src/server-api.js";
import { createTerminalMcpServer, startPresence } from "../../src/terminal-mcp.js";
import type { Seam2 } from "./seam2.js";

export interface Terminal {
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Edits the checked-out page and publishes it. */
  publish(pageId: string, message: string): Promise<string>;
  /** Closes the session cleanly (Claude Code quit): says bye. */
  quit(): Promise<void>;
}

/** A terminal session: `redline mcp` in its own folder, present on the server. */
export async function openTerminal(seam: Seam2, stops: (() => Promise<void>)[], machine: string, options: { heartbeatMs?: number } = {}): Promise<Terminal> {
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const api = new ServerApi(seam.server.url, token);
  const sessionId = `terminal-${Math.random().toString(36).slice(2)}`;
  const folder = `/work/${machine}`;
  const server = createTerminalMcpServer({ api, folder: seam.folder, sessionId });
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
      writeFileSync(join(seam.folder, ".redline", pageId, "home.html"), `<h1>${message}</h1>`);
      return call("publish_page", { message });
    },
    quit,
  };
}

