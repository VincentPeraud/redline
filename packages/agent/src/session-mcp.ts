import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ARTBOARD_DEVICES, ARTBOARD_GAP, DEFAULT_ARTBOARD_HEIGHT, DEFAULT_ARTBOARD_WIDTH, MANIFEST_PATH, defaultManifest, isSafePath, parseManifest, type ArtboardDevice, type ManifestArtboard } from "@redline/shared";
import { REDLINE_GUIDE } from "./guide.js";
import { pathInside, readWorkingCopy } from "./working-copy.js";
import type { ServerApi } from "./server-api.js";

export const REPLY_IN_THREAD_TOOL = "reply_in_thread";
export const ADD_ARTBOARD_TOOL = "add_artboard";
export const CREATE_PAGE_TOOL = "create_page";
export const READ_GUIDE_TOOL = "read_guide";

export interface RedlineToolsContext {
  api: ServerApi;
  /** When set, replies are accepted only for these threads (the threads of the running work item). */
  allowedThreadIds?: readonly string[];
  /** The page being worked on, and where its working copy is on disk (read when a tool runs, so terminal mode can use getters). */
  pageId: string;
  workingCopyDir: string;
  /** The work item being run, so what the session creates (pages, answers, versions) is tied to it. */
  workId?: string;
  /** Where `reply_in_thread` sends the text; default: the thread right away. A run holds replies back until it succeeds. */
  postReply?: (threadId: string, text: string) => Promise<unknown>;
  /** Terminal mode registers its own `create_page`, which also works with no page checked out. */
  ownCreatePage?: boolean;
}

const text = (message: string, isError = false) => ({ ...(isError ? { isError } : {}), content: [{ type: "text" as const, text: message }] });

function artboardFileError(file: string): string | null {
  if (!file.endsWith(".html")) return "file must end with .html";
  if (!isSafePath(file)) return "file must be a relative path inside the page";
  return null;
}

/** Writes `file` in the working copy and adds (or updates) its entry in the manifest. */
function addArtboardToWorkingCopy(
  dir: string,
  artboard: { file: string; html: string; title?: string; width?: number; height?: number; x?: number; y?: number; device?: ArtboardDevice; url?: string },
): void {
  const manifestPath = join(dir, MANIFEST_PATH);
  const manifest = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf8"))
    : defaultManifest(Object.keys(readWorkingCopy(dir)));
  const { html, ...placement } = artboard;
  const given = Object.fromEntries(Object.entries(placement).filter(([, value]) => value !== undefined));
  const index = manifest.artboards.findIndex((a) => a.file === artboard.file);
  const artboards = [...manifest.artboards];
  if (index >= 0) artboards[index] = { ...artboards[index], ...given };
  else {
    const last = artboards[artboards.length - 1];
    artboards.push({
      width: DEFAULT_ARTBOARD_WIDTH,
      height: DEFAULT_ARTBOARD_HEIGHT,
      x: last ? last.x + last.width + ARTBOARD_GAP : 0,
      y: last?.y ?? 0,
      ...given,
    } as ManifestArtboard);
  }
  const target = pathInside(dir, artboard.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, artboards }, null, 2));
}

/** Redline's tools for a session. Add new tools here: the agent's session server and `redline mcp` both use it. */
export function createRedlineMcpServer(context: RedlineToolsContext): McpServer {
  const { api, allowedThreadIds } = context;
  const postReply = context.postReply ?? ((threadId: string, text: string) => api.replyInThread(threadId, text, context.workId));
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
      await postReply(threadId, text);
      return { content: [{ type: "text", text: "Reply posted." }] };
    },
  );
  server.registerTool(
    ADD_ARTBOARD_TOOL,
    {
      description:
        "Add an artboard (a self-contained HTML file) to the page: writes the file and its manifest entry in the working copy; it is published when the run ends. Call read_guide first if unsure about tokens or tweaks.",
      inputSchema: {
        file: z.string().describe("Relative path of the HTML file, e.g. checkout.html"),
        html: z.string().describe("Full HTML document"),
        title: z.string().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        device: z.enum(ARTBOARD_DEVICES as [ArtboardDevice, ...ArtboardDevice[]]).optional().describe("How play mode presents the artboard; always set it"),
        url: z.string().optional().describe("Address bar text of a desktop artboard; omit when there is no real address"),
      },
    },
    async (artboard) => {
      const invalid = artboardFileError(artboard.file);
      if (invalid) return text(invalid, true);
      try {
        addArtboardToWorkingCopy(context.workingCopyDir, artboard);
      } catch (error) {
        return text((error as Error).message, true);
      }
      return text(`Artboard ${artboard.file} added to the working copy; it is published with this run.`);
    },
  );
  if (!context.ownCreatePage) {
    server.registerTool(
      CREATE_PAGE_TOOL,
      {
        description: "Create a new, empty page (a manifest, no artboard) in the same project. Returns its id.",
        inputSchema: { title: z.string() },
      },
      async ({ title }) => {
        const page = await api.createPageBeside(context.pageId, title, context.workId);
        return text(`Page "${page.title}" created (id ${page.id}).`);
      },
    );
  }
  server.registerTool(
    READ_GUIDE_TOOL,
    { description: "Read the Redline guide: page manifest, artboards, design system tokens, tweaks and rules." },
    async () => text(REDLINE_GUIDE),
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
