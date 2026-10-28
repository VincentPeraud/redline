import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename } from "node:path";
import { encodeLine, lineReader } from "./ndjson.js";
import { AgentLog, DEFAULT_LOG_CAP } from "./agent-log.js";
import { rememberChoice } from "./launch-choice.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  agentLogPath,
  hostLockPath,
  hostSocketPath,
  modelChoiceError,
  type HostAgent,
  type HostEvent,
  type HostLogEvent,
  type HostReply,
  type HostRequestEnvelope,
  type HostToWorker,
  type LaunchSettings,
  type WorkerToHost,
} from "./host-protocol.js";
import type { AgentActivity } from "./activity.js";
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
  /** How many entries an agent's run log keeps. Default 1000. */
  logCap?: number;
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
  log: AgentLog;
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
export async function startAgentHost({ configDir, worker, idleExitMs = 5000, stopTimeoutMs = 10_000, logCap = DEFAULT_LOG_CAP }: AgentHostOptions): Promise<AgentHost> {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(configDir);
  const socketPath = hostSocketPath(configDir);
  const registry = new AgentRegistry(configDir);
  const logOf = (agentId: string) => new AgentLog(agentLogPath(configDir, agentId), logCap);
  const startedAt = new Date().toISOString();
  const loaded = registry.load(startedAt);
  const entries = new Map<string, Entry>(loaded.agents.map((agent) => [agent.id, { agent, log: logOf(agent.id) }]));
  for (const id of loaded.interrupted) entries.get(id)!.log.append({ at: startedAt, event: { type: "stopped", reason: "host-restarted" } });
  /** The agents the previous host died with, while they are still stopped: the fresh start lasts as long as one is. */
  const lost = loaded.interrupted;
  const clients = new Set<Socket>();
  const attached = new Set<Socket>();
  const subscribers = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const freshStartAt = () => (lost.size > 0 ? startedAt : undefined);
  const found = (agentId: string) => {
    if (lost.delete(agentId) && lost.size === 0) publish({ event: "fresh-start" });
  };
  const persist = () => registry.save([...entries.values()].map((entry) => entry.agent));
  const publish = (event: HostEvent) => {
    for (const client of subscribers) client.write(encodeLine(event));
  };
  const setAgent = (entry: Entry, change: Partial<HostAgent>) => {
    entry.agent = { ...entry.agent, ...change };
    persist();
    publish({ event: "agent-changed", agent: entry.agent });
  };

  const record = (entry: Entry, event: HostLogEvent) => {
    const logged = { at: new Date().toISOString(), event };
    entry.log.append(logged);
    publish({ event: "log-line", agentId: entry.agent.id, entry: logged });
  };
  const stoppedAs = (entry: Entry, reason?: string) => setAgent(entry, { state: "stopped", since: new Date().toISOString(), reason, page: undefined, pageId: undefined });
  const follow = (entry: Entry, event: AgentActivity) => {
    const now = new Date().toISOString();
    switch (event.type) {
      case "connected":
      case "reconnected":
      case "run-published":
      case "run-failed":
        setAgent(entry, { state: "idle", since: now, page: undefined, pageId: undefined });
        break;
      case "connection-lost":
        setAgent(entry, { state: "reconnecting", since: now, page: undefined, pageId: undefined });
        break;
      case "run-started":
        setAgent(entry, { state: "running", since: now, page: event.page, pageId: event.pageId });
        break;
    }
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
      const error = `No token for ${agent.serverUrl}. Run \`redline setup\` first.`;
      record(entry, { type: "stopped", reason: "failed", error });
      stoppedAs(entry, error);
      return;
    }
    found(agent.id);
    const child = spawn(worker.command, worker.args, {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ...worker.env, CLAUDE_CONFIG_DIR: agent.claudeConfigDir },
    });
    entry.child = child;
    entry.failure = undefined;
    entry.exited = new Promise((resolve) => {
      let done = false;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let disconnected = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (done) return;
        done = true;
        entry.child = undefined;
        if (entry.stopRequested) {
          entry.stopRequested = false;
          stoppedAs(entry);
        } else if (code === UPDATE_EXIT_CODE && !shuttingDown) startWorker(entry);
        else {
          const reason = entry.failure ?? error?.message ?? (signal ? `The agent process was killed (${signal}).` : `The agent process exited (code ${code}).`);
          record(entry, { type: "stopped", reason: "failed", error: reason });
          stoppedAs(entry, reason);
        }
        resolve();
        checkIdle();
      };
      // The channel closes after every message the worker sent has been read: finish only then, so the log is complete.
      const settle = () => {
        if (exit && disconnected) finish(exit.code, exit.signal);
      };
      child.on("exit", (code, signal) => {
        exit = { code, signal };
        settle();
      });
      child.on("disconnect", () => {
        disconnected = true;
        settle();
      });
      child.on("error", (error) => finish(null, null, error));
    });
    child.on("message", (message: WorkerToHost) => {
      if (message.type === "failed") entry.failure = message.reason;
      else {
        record(entry, message.event);
        follow(entry, message.event);
      }
    });
    const { serverUrl, token } = login;
    const start: HostToWorker = {
      type: "start",
      config: { serverUrl, token, machine: hostname(), folder: agent.folder, kind: agent.kind, projectIds: agent.projectIds, model: agent.model, effort: agent.effort },
    };
    child.send(start);
    const startedAt = new Date().toISOString();
    setAgent(entry, { state: "reconnecting", since: startedAt, startedAt, machine: hostname().split(".")[0], reason: undefined, page: undefined, pageId: undefined });
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
    if (existing && existing.agent.state !== "stopped") return { agent: existing.agent, started: false };
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
    const entry: Entry = { agent, log: logOf(agent.id) };
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
        return { id: request.id, ok: true, agents: [...entries.values()].map((entry) => entry.agent), freshStartAt: freshStartAt() };
      case "launch":
      {
        const invalid = modelChoiceError(request);
        if (invalid) throw new Error(invalid);
        const { folder, kind, serverUrl, projectIds, projectNames, model, effort, claudeConfigDir, account } = request;
        return { id: request.id, ok: true, ...launch({ folder, kind, serverUrl, projectIds, projectNames, model, effort, claudeConfigDir, account }) };
      }
      case "attach":
        attached.add(client);
        checkIdle();
        return { id: request.id, ok: true, agent: entryOf(request.agentId).agent };
      case "log":
        return { id: request.id, ok: true, entries: entryOf(request.agentId).log.read(request.lines) };
      case "set-model-effort": {
        const entry = entryOf(request.agentId);
        const { model, effort } = request;
        const invalid = modelChoiceError(request);
        if (invalid) throw new Error(invalid);
        setAgent(entry, { model, effort });
        rememberChoice({ folder: entry.agent.folder, configDir, choice: { model, effort } });
        if (entry.child?.connected) entry.child.send({ type: "set-model-effort", model, effort } satisfies HostToWorker);
        return { id: request.id, ok: true, agent: entry.agent };
      }
      case "stop": {
        const entry = entryOf(request.agentId);
        await stopWorker(entry);
        return { id: request.id, ok: true, agent: entry.agent };
      }
      case "remove": {
        const entry = entryOf(request.agentId);
        await stopWorker(entry);
        entries.delete(request.agentId);
        found(request.agentId);
        entry.log.delete();
        persist();
        publish({ event: "agent-removed", agentId: request.agentId });
        return { id: request.id, ok: true };
      }
      case "restart": {
        const entry = entryOf(request.agentId);
        const started = entry.agent.state === "stopped";
        if (started) startWorker(entry);
        return { id: request.id, ok: true, agent: entry.agent, started };
      }
      case "restart-all": {
        const stopped = [...entries.values()].filter((entry) => entry.agent.state === "stopped");
        for (const entry of stopped) startWorker(entry);
        return { id: request.id, ok: true, agents: stopped.map((entry) => entry.agent) };
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
    client.setEncoding("utf8");
    const read = lineReader((line) => void respond(client, line));
    client.on("data", (chunk: string) => {
      if (!read(chunk)) client.destroy();
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
    if (!client.destroyed) client.write(encodeLine(reply));
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
