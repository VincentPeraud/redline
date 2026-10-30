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
  /**
   * Stops the server (dropping every agent connection) and starts a new one on the same data folder and the same
   * ports, like a process restart; it stays down for `downForMs` first.
   */
  restart(options?: { downForMs?: number }): Promise<void>;
  stop(): Promise<void>;
}

/** After a restart on the same port, fetch may still try a kept-alive connection to the old process: one more try opens a new one. */
async function sturdyFetch(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch (error) {
    const code = ((error as { cause?: { code?: string } }).cause ?? {}).code;
    if (code !== "ECONNRESET" && code !== "UND_ERR_SOCKET") throw error;
    return send();
  }
}

/** Starts a real server on a temporary data folder with random free ports. */
export async function startTestServer(options: { webDir?: string; cliDir?: string; retryDelaysMs?: number[]; terminalPresenceTimeoutMs?: number } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "redline-test-"));
  const start = (ports: { port: number; artboardPort: number }) =>
    startServer({ dataDir, ...ports, host: "127.0.0.1", webDir: options.webDir, cliDir: options.cliDir, retryDelaysMs: options.retryDelaysMs, terminalPresenceTimeoutMs: options.terminalPresenceTimeoutMs });
  let server: RunningServer = await start({ port: 0, artboardPort: 0 });
  const ports = { port: Number(new URL(server.url).port), artboardPort: Number(new URL(server.artboardOrigin).port) };
  const sockets: WebSocket[] = [];
  return {
    get url() {
      return server.url;
    },
    get artboardOrigin() {
      return server.artboardOrigin;
    },
    dataDir,
    get: (path) => sturdyFetch(() => fetch(server.url + path)),
    post: (path, body) =>
      sturdyFetch(() =>
        fetch(server.url + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
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
        projectIds: options.projectIds,
        model: options.model,
        effort: options.effort,
        buildHash: options.buildHash,
      };
      socket.send(JSON.stringify(message));
      return { hello, messages, send: (m) => socket.send(JSON.stringify(m)), closed, close: () => socket.close() };
    },
    blobCount: () => readdirSync(join(dataDir, "blobs")).length,
    async restart({ downForMs = 0 } = {}) {
      await server.close();
      if (downForMs > 0) await new Promise((resolve) => setTimeout(resolve, downForMs));
      server = await start(ports);
    },
    async stop() {
      for (const socket of sockets) socket.close();
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
