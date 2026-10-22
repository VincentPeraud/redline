import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_EVENTS_PATH,
  type AgentTokenResponse,
  type AgentWorkMessage,
  type CreateThreadRequest,
  type Page,
  type PageVersionSummary,
  type Project,
  type ServerEvent,
  type Thread,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startAgent } from "../../src/agent.js";
import type { AgentConnection } from "../../src/connection.js";
import type { Engine } from "../../src/engine.js";

export { FakeEngine } from "./fake-engine.js";
export type { FakeAction, FakeRunContext, FakeRunRecord, FakeScript } from "./fake-engine.js";

export interface Seam2 {
  /** The real server (seam-1 harness); drive its HTTP API as the web UI would. */
  server: TestServer;
  /** The folder the agent serves; `.redline/` working copies appear here. */
  folder: string;
  project: Project;
  agent: AgentConnection;
  createPage(files: Record<string, string>, title?: string): Promise<Page>;
  /** Sends a comment thread pinned on an artboard element (the server dispatches it to the agent). */
  pinThread(pageId: string, artboard: string, body: string, pin?: Partial<CreateThreadRequest>): Promise<Thread>;
  versions(pageId: string): Promise<PageVersionSummary[]>;
  readFile(pageId: string, path: string): Promise<string>;
  /** Server events received so far, in order. */
  events(): ServerEvent[];
  /** What the agent reported about its work items, in order (`work-event`, `work-done`, `work-failed`). */
  workMessages(): AgentWorkMessage[];
  waitForVersions(pageId: string, count: number): Promise<void>;
  /** Resolves once `count` work items have ended (done or failed). */
  waitForWorkEnd(count?: number): Promise<void>;
  stop(): Promise<void>;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function collectEvents(url: string, into: ServerEvent[], signal: AbortSignal): Promise<void> {
  return (async () => {
    const res = await fetch(url + SERVER_EVENTS_PATH, { signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop()!;
      for (const frame of frames) if (frame.startsWith("data: ")) into.push(JSON.parse(frame.slice(6)) as ServerEvent);
    }
  })().catch(() => undefined);
}

/**
 * Seam 2: a real server and a real agent (project agent in a temp folder) driven by the given engine
 * (usually a `FakeEngine`). Pass `webDir` to serve the web UI for browser journeys.
 */
export async function startSeam2(engine: Engine, options: { webDir?: string } = {}): Promise<Seam2> {
  const server = await startTestServer({ webDir: options.webDir });
  const folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
  const events: ServerEvent[] = [];
  const abort = new AbortController();
  void collectEvents(server.url, events, abort.signal);

  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agent = await startAgent({
    serverUrl: server.url,
    token,
    machine: "test-machine",
    folder,
    kind: "project",
    projectId: project.id,
    engine,
  });

  const workMessages = () => events.flatMap((e) => (e.type === "work" ? [e.message] : []));
  const versions = async (pageId: string) =>
    (await (await server.get(`/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[];

  return {
    server,
    folder,
    project,
    agent,
    async createPage(files, title = "Home") {
      return (await (await server.post(`/api/projects/${project.id}/pages`, { title, type: "prototype", files })).json()) as Page;
    },
    async pinThread(pageId, artboard, body, pin = {}) {
      const request: CreateThreadRequest = { artboard, selector: "h1", xPct: 20, yPct: 30, body, ...pin };
      return (await (await server.post(`/api/pages/${pageId}/threads`, request)).json()) as Thread;
    },
    versions,
    async readFile(pageId, path) {
      return (await server.get(`/api/pages/${pageId}/files/${path}`)).text();
    },
    events: () => events,
    workMessages,
    waitForVersions: (pageId, count) => until(async () => (await versions(pageId)).length >= count, `${count} versions`),
    waitForWorkEnd: (count = 1) =>
      until(() => workMessages().filter((m) => m.type === "work-done" || m.type === "work-failed").length >= count, "the work item to end"),
    async stop() {
      agent.close();
      abort.abort();
      await server.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
