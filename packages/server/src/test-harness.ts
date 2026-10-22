import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ENDPOINT, PROTOCOL_VERSION, type AgentHello, type ServerToAgentMessage } from "@redline/shared";
import { startServer, type RunningServer } from "./start.js";

export interface TestAgent {
  /** The first message the server answers to the hello (welcome or error). */
  hello: Promise<ServerToAgentMessage>;
  /** Every message received so far. */
  messages: ServerToAgentMessage[];
  send(message: unknown): void;
  /** Resolves when the socket closes, with the close code. */
  closed: Promise<{ code: number }>;
  close(): void;
}

export type ConnectAgentOptions = Partial<Omit<AgentHello, "type">>;

export interface TestServer {
  /** Changes after `restart()` (new random port). */
  readonly url: string;
  readonly artboardOrigin: string;
  dataDir: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  /** Opens an agent connection and sends the hello (token defaults to the server's current token). */
  connectAgent(options?: ConnectAgentOptions): Promise<TestAgent>;
  /** Number of distinct blobs on disk. */
  blobCount(): number;
  /** Stops the server (dropping every agent connection) and starts a new one on the same data folder, like a process restart. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts a real server on a temporary data folder with random free ports. */
export async function startTestServer(options: { webDir?: string; retryDelaysMs?: number[] } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "redline-test-"));
  const start = () =>
    startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir: options.webDir, retryDelaysMs: options.retryDelaysMs });
  let server: RunningServer = await start();
  const sockets: WebSocket[] = [];
  return {
    get url() {
      return server.url;
    },
    get artboardOrigin() {
      return server.artboardOrigin;
    },
    dataDir,
    get: (path) => fetch(server.url + path),
    post: (path, body) =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    async connectAgent(options = {}) {
      const token = options.token ?? ((await (await fetch(server.url + "/api/agent-token")).json()) as { token: string }).token;
      const socket = new WebSocket(server.url.replace(/^http/, "ws") + AGENT_ENDPOINT);
      sockets.push(socket);
      const messages: ServerToAgentMessage[] = [];
      let onFirst: (m: ServerToAgentMessage) => void = () => {};
      const hello = new Promise<ServerToAgentMessage>((resolve) => (onFirst = resolve));
      const closed = new Promise<{ code: number }>((resolve) => socket.addEventListener("close", (e) => resolve({ code: e.code })));
      socket.addEventListener("message", (e) => {
        const message = JSON.parse(String(e.data)) as ServerToAgentMessage;
        messages.push(message);
        if (messages.length === 1) onFirst(message);
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("agent socket failed to open")));
      });
      const message: AgentHello = {
        type: "hello",
        token,
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        machine: options.machine ?? "test-machine",
        folder: options.folder ?? "/test/folder",
        kind: options.kind ?? "project",
        projectId: options.projectId,
        model: options.model,
        effort: options.effort,
      };
      socket.send(JSON.stringify(message));
      return { hello, messages, send: (m) => socket.send(JSON.stringify(m)), closed, close: () => socket.close() };
    },
    blobCount: () => readdirSync(join(dataDir, "blobs")).length,
    async restart() {
      await server.close();
      server = await start();
    },
    async stop() {
      for (const socket of sockets) socket.close();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
