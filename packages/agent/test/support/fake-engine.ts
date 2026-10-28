import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EngineEvent } from "@redline/shared";
import type { Engine, EngineRunRequest } from "../../src/engine.js";
import { REPLY_IN_THREAD_TOOL } from "../../src/session-mcp.js";
import { readWorkingCopy } from "../../src/working-copy.js";

/** One scripted step: an engine event to emit, or a side effect the fake session performs. */
export type FakeAction =
  | EngineEvent
  /** Writes a file in the working copy (bytes for images and fonts). */
  | { edit: { path: string; content: string | Buffer } }
  /** Deletes a file from the working copy. */
  | { remove: string }
  /** Calls the "reply in thread" MCP tool, through the run's real local MCP server. */
  | { replyInThread: { threadId: string; text: string } }
  /** Calls any tool of the run's MCP server. */
  | { callTool: { name: string; arguments: Record<string, unknown> } };

export interface FakeRunContext extends EngineRunRequest {
  /** Calls the reply tool and returns the tool's answer text (also for refusals). */
  tryReplyInThread(threadId: string, text: string): Promise<string>;
  /** Calls any MCP tool and returns the tool's answer text. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export type FakeScript = FakeAction[] | ((run: FakeRunContext) => FakeAction[] | Promise<FakeAction[]>);

/** What the fake engine saw when a run began. */
export interface FakeRunRecord extends EngineRunRequest {
  resume: boolean;
  /** The working copy's files when the session started. */
  filesAtStart: Record<string, string>;
  /** Names of the MCP tools the run's server offered. */
  mcpTools: string[];
}

async function withMcpClient<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "fake-engine", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

function toolText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

/**
 * Scripted stand-in for a coding engine (seam 2): replays the script as an event stream, edits the
 * working copy and calls MCP tools like Claude would. The script may be a function of the run.
 */
export class FakeEngine implements Engine {
  readonly runs: FakeRunRecord[] = [];
  /** Session ids of the runs cancelled by an aborted signal, in order. */
  readonly cancelled: string[] = [];
  private finishedRuns = 0;
  private waiters: { count: number; resolve: () => void }[] = [];

  constructor(private readonly script: FakeScript) {}

  start(request: EngineRunRequest): AsyncIterable<EngineEvent> {
    return this.run(request, false);
  }

  resume(request: EngineRunRequest): AsyncIterable<EngineEvent> {
    return this.run(request, true);
  }

  /** Resolves once `count` runs have ended their event stream. */
  finished(count: number): Promise<void> {
    if (this.finishedRuns >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  private async *run(request: EngineRunRequest, resume: boolean): AsyncGenerator<EngineEvent> {
    const cancel = () => this.cancelled.push(request.sessionId);
    if (request.signal?.aborted) cancel();
    else request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const mcpTools = await withMcpClient(request.mcpUrl, async (client) => (await client.listTools()).tools.map((t) => t.name));
      this.runs.push({ ...request, resume, filesAtStart: readWorkingCopy(request.workingCopyDir, true), mcpTools });
      const callTool = (name: string, args: Record<string, unknown>) =>
        withMcpClient(request.mcpUrl, async (client) => toolText(await client.callTool({ name, arguments: args })));
      const context: FakeRunContext = {
        ...request,
        callTool,
        tryReplyInThread: (threadId, text) =>
          withMcpClient(request.mcpUrl, async (client) =>
            toolText(await client.callTool({ name: REPLY_IN_THREAD_TOOL, arguments: { threadId, text } })),
          ),
      };
      const actions = typeof this.script === "function" ? await this.script(context) : this.script;
      for (const action of actions) {
        if ("edit" in action) {
          const target = join(request.workingCopyDir, action.edit.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, action.edit.content);
        } else if ("remove" in action) {
          rmSync(join(request.workingCopyDir, action.remove), { force: true });
        } else if ("replyInThread" in action) {
          const { threadId, text } = action.replyInThread;
          await context.tryReplyInThread(threadId, text);
        } else if ("callTool" in action) {
          await context.callTool(action.callTool.name, action.callTool.arguments);
        } else {
          yield action;
        }
      }
    } finally {
      this.finishedRuns += 1;
      for (const waiter of this.waiters.filter((w) => w.count <= this.finishedRuns)) waiter.resolve();
      this.waiters = this.waiters.filter((w) => w.count > this.finishedRuns);
    }
  }
}
