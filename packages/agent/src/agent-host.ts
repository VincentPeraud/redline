import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename } from "node:path";
import { AgentRegistry } from "./agent-registry.js";
import {
  hostLockPath,
  hostSocketPath,
  type HostAgent,
  type HostEvent,
  type HostReply,
  type HostRequestEnvelope,
  type HostToWorker,
  type LaunchSettings,
  type WorkerToHost,
} from "./host-protocol.js";
import { normalizeServerUrl, readLogins } from "./login.js";
import { UPDATE_EXIT_CODE } from "./supervisor.js";

export class HostAlreadyRunningError extends Error {
  constructor() {
    super("An agent host is already running.");
  }
}

export interface AgentHostOptions {
  configDir: string;
  /** How a worker process is started; it receives its configuration on the parent channel (see `runAgentWorker`). */
  worker: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** How long the host waits, with no agent running and no client attached, before it exits. Default 5 s. */
  idleExitMs?: number;
  /** How long a worker gets to stop gracefully before it is killed. Default 10 s. */
  stopTimeoutMs?: number;
}

export interface AgentHost {
  /** Stops every worker and closes the socket. */
  stop(): Promise<void>;
  /** Resolves once the host has shut down, on `stop()` or by itself when idle. */
  closed: Promise<void>;
}

interface Entry {
  agent: HostAgent;
  child?: ChildProcess;
  stopRequested?: boolean;
  failure?: string;
  exited?: Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One host per config directory: the lock file holds the pid of the running host; a dead pid's lock is taken over. */
function acquireLock(configDir: string): () => void {
  const lock = hostLockPath(configDir);
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      if (pid && isAlive(pid)) throw new HostAlreadyRunningError();
      rmSync(lock, { force: true });
    }
  }
}

/** Starts the agent host: the registry, the workers, and the control API on a Unix socket only the user can use. */
export async function startAgentHost({ configDir, worker, idleExitMs = 5000, stopTimeoutMs = 10_000 }: AgentHostOptions): Promise<AgentHost> {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(configDir);
  const socketPath = hostSocketPath(configDir);
  const registry = new AgentRegistry(configDir);
  const entries = new Map<string, Entry>(registry.load(new Date().toISOString()).map((agent) => [agent.id, { agent }]));
  const clients = new Set<Socket>();
  const attached = new Set<Socket>();
  const subscribers = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const persist = () => registry.save([...entries.values()].map((entry) => entry.agent));
  const publish = (event: HostEvent) => {
    for (const client of subscribers) client.write(`${JSON.stringify(event)}\n`);
  };
  const setAgent = (entry: Entry, change: Partial<HostAgent>) => {
    entry.agent = { ...entry.agent, ...change };
    persist();
    publish({ event: "agent-changed", agent: entry.agent });
  };

  function checkIdle(): void {
    const busy = attached.size > 0 || [...entries.values()].some((entry) => entry.child);
    if (busy || shuttingDown) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    } else idleTimer ??= setTimeout(() => void stop(), idleExitMs);
  }

  function startWorker(entry: Entry): void {
    const { agent } = entry;
    const login = readLogins(configDir).find((candidate) => normalizeServerUrl(candidate.serverUrl) === normalizeServerUrl(agent.serverUrl));
    if (!login) {
      setAgent(entry, { state: "stopped", since: new Date().toISOString(), reason: `No token for ${agent.serverUrl}. Run \`redline setup\` first.` });
      return;
    }
    const child = spawn(worker.command, worker.args, {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ...worker.env, CLAUDE_CONFIG_DIR: agent.claudeConfigDir },
    });
    entry.child = child;
    entry.failure = undefined;
    entry.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, error?: Error) => {
        if (done) return;
        done = true;
        entry.child = undefined;
        if (entry.stopRequested) {
          entry.stopRequested = false;
          setAgent(entry, { state: "stopped", since: new Date().toISOString(), reason: undefined });
        } else if (code === UPDATE_EXIT_CODE && !shuttingDown) startWorker(entry);
        else setAgent(entry, { state: "stopped", since: new Date().toISOString(), reason: entry.failure ?? error?.message ?? `The agent process exited (code ${code}).` });
        resolve();
        checkIdle();
      };
      child.on("exit", (code) => finish(code));
      child.on("error", (error) => finish(null, error));
    });
    child.on("message", (message: WorkerToHost) => {
      if (message.type === "failed") entry.failure = message.reason;
    });
    const { serverUrl, token } = login;
    const start: HostToWorker = {
      type: "start",
      config: { serverUrl, token, machine: hostname(), folder: agent.folder, kind: agent.kind, projectIds: agent.projectIds, model: agent.model, effort: agent.effort },
    };
    child.send(start);
    if (agent.state !== "running") setAgent(entry, { state: "running", since: new Date().toISOString(), reason: undefined });
    checkIdle();
  }

  async function stopWorker(entry: Entry): Promise<void> {
    const { child, exited } = entry;
    if (!child || !exited) return;
    entry.stopRequested = true;
    if (child.connected) child.send({ type: "stop" } satisfies HostToWorker);
    const killer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
    await exited;
    clearTimeout(killer);
  }

  function launch(settings: LaunchSettings): { agent: HostAgent; started: boolean } {
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    const existing = [...entries.values()].find((entry) => entry.agent.folder === settings.folder && normalizeServerUrl(entry.agent.serverUrl) === serverUrl);
    if (existing?.agent.state === "running") return { agent: existing.agent, started: false };
    if (!readLogins(configDir).some((login) => normalizeServerUrl(login.serverUrl) === serverUrl)) {
      throw new Error(`${serverUrl} is not set up. Run \`redline setup ${serverUrl} --token <token>\` first.`);
    }
    const settled = { ...settings, serverUrl };
    if (existing) {
      existing.agent = { ...existing.agent, ...settled };
      startWorker(existing);
      return { agent: existing.agent, started: true };
    }
    const agent: HostAgent = {
      ...settled,
      id: randomUUID(),
      name: settings.kind === "global" ? "global" : basename(settings.folder),
      state: "stopped",
      since: new Date().toISOString(),
    };
    const entry: Entry = { agent };
    entries.set(agent.id, entry);
    persist();
    publish({ event: "agent-added", agent });
    startWorker(entry);
    return { agent: entry.agent, started: true };
  }

  const entryOf = (agentId: string) => {
    const entry = entries.get(agentId);
    if (!entry) throw new Error("No such agent.");
    return entry;
  };

  async function handle(client: Socket, request: HostRequestEnvelope): Promise<HostReply> {
    switch (request.type) {
      case "list":
        return { id: request.id, ok: true, agents: [...entries.values()].map((entry) => entry.agent) };
      case "launch":
      {
        const { folder, kind, serverUrl, projectIds, model, effort, claudeConfigDir, account } = request;
        return { id: request.id, ok: true, ...launch({ folder, kind, serverUrl, projectIds, model, effort, claudeConfigDir, account }) };
      }
      case "attach":
        attached.add(client);
        checkIdle();
        return { id: request.id, ok: true, agent: entryOf(request.agentId).agent };
      case "stop": {
        const entry = entryOf(request.agentId);
        await stopWorker(entry);
        return { id: request.id, ok: true, agent: entry.agent };
      }
      case "subscribe":
        attached.add(client);
        subscribers.add(client);
        checkIdle();
        return { id: request.id, ok: true };
    }
  }

  const server: Server = createServer((client) => {
    clients.add(client);
    let buffer = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void respond(client, line);
      }
    });
    client.on("error", () => undefined);
    client.on("close", () => {
      clients.delete(client);
      attached.delete(client);
      subscribers.delete(client);
      checkIdle();
    });
  });

  async function respond(client: Socket, line: string): Promise<void> {
    let id = 0;
    let reply: HostReply;
    try {
      const request = JSON.parse(line) as HostRequestEnvelope;
      id = request.id;
      reply = await handle(client, request);
    } catch (error) {
      reply = { id, ok: false, error: (error as Error).message };
    }
    if (!client.destroyed) client.write(`${JSON.stringify(reply)}\n`);
  }

  async function stop(): Promise<void> {
    if (shuttingDown) return closed;
    shuttingDown = true;
    clearTimeout(idleTimer);
    await Promise.all([...entries.values()].map(stopWorker));
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketPath, { force: true });
    releaseLock();
    resolveClosed();
  }

  try {
    rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    releaseLock();
    throw error;
  }
  checkIdle();
  return { stop, closed };
}
