import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ServerApi } from "./server-api.js";

export const REPLY_IN_THREAD_TOOL = "reply_in_thread";

export interface RedlineToolsContext {
  api: ServerApi;
  /** When set, replies are accepted only for these threads (the threads of the running work item). */
  allowedThreadIds?: readonly string[];
}

/** Redline's tools for a session. Add new tools here: the agent's session server and `redline mcp` both use it. */
export function createRedlineMcpServer({ api, allowedThreadIds }: RedlineToolsContext): McpServer {
  const server = new McpServer({ name: "redline", version: "0.0.0" });
  server.registerTool(
    REPLY_IN_THREAD_TOOL,
    {
      description: "Answer the user in a Redline comment thread. Call it once per thread you were asked about.",
      inputSchema: { threadId: z.string().describe("Id of the thread, as given in the message"), text: z.string() },
    },
    async ({ threadId, text }) => {
      if (allowedThreadIds && !allowedThreadIds.includes(threadId)) {
        return { isError: true, content: [{ type: "text", text: `Thread ${threadId} is not part of this run.` }] };
      }
      await api.replyInThread(threadId, text);
      return { content: [{ type: "text", text: "Reply posted." }] };
    },
  );
  return server;
}

export interface SessionMcp {
  /** Streamable HTTP endpoint on 127.0.0.1, to hand to the engine as an MCP server. */
  url: string;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The agent's local MCP server for one run (stateless, loopback only, random port). */
export async function startSessionMcp(context: RedlineToolsContext): Promise<SessionMcp> {
  const http: Server = createServer(async (req, res) => {
    const server = createRedlineMcpServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
