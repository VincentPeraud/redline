import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { encodeLine, lineReader } from "./ndjson.js";
export { HostAlreadyRunningError } from "./host-lock.js";
import { acquireLock, claimSocket, prepareHostDirectory } from "./host-lock.js";
import { AgentLog, DEFAULT_LOG_CAP } from "./agent-log.js";
import { rememberChoice } from "./launch-choice.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  agentLogPath,
  acceptsProtocol,
  hostProtocol as currentProtocol,
  hostSocketPath,
  modelChoiceError,
  refusalMessage,
  type HostAgent,
  type HostEvent,
  type HostLogEntry,
  type HostLogEvent,
  type HostProtocol,
  type HostReply,
  type HostRequestEnvelope,
  type LaunchSettings,
  type WorkerToHost,
} from "./host-protocol.js";
import type { AgentActivity } from "./activity.js";
import { claudeEnvironment, workerEnvironment } from "./worker-environment.js";
import { spawnWorker, type WorkerProcess } from "./worker-process.js";
import { buildHash, cliVersion } from "./build-hash.js";
import { listInstallations, type Installation } from "./installations.js";
import { normalizeServerUrl } from "./login.js";
import { UPDATE_EXIT_CODE } from "./supervisor.js";

export interface WorkerCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** The build of the global command: the host restarts when the files on disk are another build than the one it started with. */
export interface CommandBuild {
  /** The build the host runs. "dev" (from the sources) never changes. */
  build: string;
  /** The build installed on disk now. */
  installedBuild(): string;
  /** The version installed now, told in the agents' logs. */
  version(): string;
}

export interface AgentHostOptions {
  configDir: string;
  /**
   * How a worker process is started; it receives its configuration on the parent channel (see `runAgentWorker`). A function
   * gets the installation of the agent, so that the worker runs that installation's own code.
   */
  worker: WorkerCommand | ((installation: Installation) => WorkerCommand);
  /** The host protocol this host speaks and accepts. Default: this command's. */
  protocol?: HostProtocol;
  /** Default: this command's own build, against the one on disk. */
  command?: CommandBuild;
  /** How often the host looks at the global command's build. Default 5 s. */
  commandCheckMs?: number;
  /** Starts the host that replaces this one, once it has stopped because the global command changed. Without it, nothing replaces it. */
  respawn?: WorkerCommand;
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
  worker?: WorkerProcess;
  /** The Claude-relevant environment of the client that launched the agent; memory only, never persisted or logged. */
  env?: Record<string, string>;
  stopRequested?: boolean;
  failure?: string;
  log: AgentLog;
  /** The latest progress of the run in progress: streamed and answered like a log line, but not written to the log (see `record`). */
  progress?: HostLogEntry;
  exited?: Promise<void>;
}

/** Starts the agent host: the registry, the workers, and the control API on a Unix socket only the user can use. */
const resumePath = (configDir: string) => join(configDir, "host", "resume.json");

export async function startAgentHost({
  configDir,
  worker,
  protocol = currentProtocol(cliVersion()),
  command = { build: buildHash(), installedBuild: buildHash, version: cliVersion },
  commandCheckMs = 5000,
  respawn,
  idleExitMs = 5000,
  stopTimeoutMs = 10_000,
  logCap = DEFAULT_LOG_CAP,
}: AgentHostOptions): Promise<AgentHost> {
  prepareHostDirectory(configDir);
  const releaseLock = acquireLock(configDir);
  const socketPath = hostSocketPath(configDir);
  const registry = new AgentRegistry(configDir);
  const logOf = (agentId: string) => new AgentLog(agentLogPath(configDir, agentId), logCap);
  const startedAt = new Date().toISOString();
  const loaded = registry.load(startedAt);
  const entries = new Map<string, Entry>(loaded.agents.map((agent) => [agent.id, { agent, log: logOf(agent.id) }]));
  for (const id of loaded.interrupted) entries.get(id)!.log.append({ at: startedAt, event: { type: "stopped", reason: "host-restarted" } });
  /** The agents the previous host stopped to restart for a new global command: this host starts them again. */
  const resumed = takeResumeList(configDir);
  /** The agents this host stops for its own restart (the new command's version, once a change is seen), and those it will give back. */
  let restartingFor: string | undefined;
  const toResume = new Set<string>();
  /** The agents of an updated installation whose worker restarts once its run ends. */
  const restartAfterRun = new Set<string>();
  /** The agents the previous host died with, while they are still stopped: the fresh start lasts as long as one is. */
  const lost = loaded.interrupted;
  const clients = new Set<Socket>();
  const attached = new Set<Socket>();
  const subscribers = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let settling = false;
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
    if (restartingFor !== undefined) void settleRestart();
    if (restartAfterRun.has(entry.agent.id)) void restartWhenIdle(entry);
  };

  const record = (entry: Entry, event: HostLogEvent) => {
    const logged = { at: new Date().toISOString(), event };
    if (event.type === "run-progress") entry.progress = logged;
    else {
      // Every step would push the history out of the capped log: only the latest progress of the run in progress is kept.
      if (event.type !== "reconnected" && event.type !== "connection-lost") entry.progress = undefined;
      entry.log.append(logged);
    }
    publish({ event: "log-line", agentId: entry.agent.id, entry: logged });
  };
  const stoppedAs = (entry: Entry, reason?: string) => {
    entry.progress = undefined;
    setAgent(entry, { state: "stopped", since: new Date().toISOString(), reason, run: undefined });
  };
  const follow = (entry: Entry, event: AgentActivity) => {
    const now = new Date().toISOString();
    switch (event.type) {
      case "connected":
      case "reconnected":
      case "run-published":
      case "run-failed":
        setAgent(entry, { state: "idle", since: now, run: undefined });
        break;
      case "connection-lost":
        setAgent(entry, { state: "reconnecting", since: now, run: undefined });
        break;
      case "run-started":
        setAgent(entry, { state: "running", since: now, run: { page: event.page, pageId: event.pageId } });
        break;
    }
  };

  /**
   * The global command changed: no run is ever cancelled. Agents that are not running a piece of work are stopped at once (their
   * work waits for the new host), the others when their run ends; once no worker is left, the host stops and its replacement starts
   * the agents that were stopped here.
   */
  async function settleRestart(): Promise<void> {
    if (restartingFor === undefined || settling || shuttingDown) return;
    settling = true;
    try {
      for (;;) {
        const idle = [...entries.values()].filter((entry) => entry.worker && entry.agent.state !== "running");
        if (idle.length === 0) break;
        for (const entry of idle) {
          toResume.add(entry.agent.id);
          await stopWorker(entry);
        }
      }
      if ([...entries.values()].some((entry) => entry.worker)) return;
      mkdirSync(dirname(resumePath(configDir)), { recursive: true, mode: 0o700 });
      writeFileSync(resumePath(configDir), JSON.stringify([...toResume]), { mode: 0o600 });
      await stop();
      if (respawn) spawn(respawn.command, respawn.args, { detached: true, stdio: "ignore", env: { ...process.env, ...respawn.env } }).unref();
    } finally {
      settling = false;
    }
  }

  async function restartWhenIdle(entry: Entry): Promise<void> {
    const { id } = entry.agent;
    if (!entry.worker) restartAfterRun.delete(id);
    if (!restartAfterRun.has(id) || entry.agent.state === "running") return;
    restartAfterRun.delete(id);
    await stopWorker(entry);
    if (!shuttingDown && restartingFor === undefined) startWorker(entry);
  }

  /**
   * An installation's files changed: its agents restart with them, each after its run (`except` already did, it is what exited to
   * update). A host that is restarting anyway starts every agent from the new files already.
   */
  function restartInstallationAgents(installationId: string, except?: Entry): Entry[] {
    const affected = [...entries.values()].filter((entry) => entry !== except && entry.worker && installationOf(entry.agent)?.id === installationId);
    if (shuttingDown || restartingFor !== undefined) return affected;
    for (const entry of affected) restartAfterRun.add(entry.agent.id);
    for (const entry of affected) void restartWhenIdle(entry);
    return affected;
  }

  function checkCommand(): void {
    if (restartingFor !== undefined || shuttingDown) return;
    if (command.installedBuild() === command.build) return;
    restartingFor = command.version();
    void settleRestart();
  }

  function checkIdle(): void {
    const busy = attached.size > 0 || [...entries.values()].some((entry) => entry.worker);
    if (busy || shuttingDown) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    } else idleTimer ??= setTimeout(() => void stop(), idleExitMs);
  }

  const installationOf = ({ installation, serverUrl }: Pick<HostAgent, "installation" | "serverUrl">): Installation | undefined => {
    const all = listInstallations(configDir);
    return all.find((candidate) => candidate.id === installation) ?? all.find((candidate) => normalizeServerUrl(candidate.serverUrl) === normalizeServerUrl(serverUrl));
  };

  function startWorker(entry: Entry, env?: Record<string, string>): void {
    const { agent } = entry;
    const installation = installationOf(agent);
    if (!installation) {
      const error = `${agent.serverUrl} is not set up. Run \`redline setup ${agent.serverUrl}\` first.`;
      record(entry, { type: "stopped", reason: "failed", error });
      stoppedAs(entry, error);
      return;
    }
    found(agent.id);
    if (!acceptsProtocol(protocol, installation.hostProtocol)) {
      const reason = refusalMessage(protocol, installation);
      record(entry, { type: "refused", reason });
      stoppedAs(entry, reason);
      return;
    }
    const workerCommand = typeof worker === "function" ? worker(installation) : worker;
    // The environment of the client that launched the agent is kept in memory: an update relaunch reuses it, a restart replaces it.
    if (env) entry.env = claudeEnvironment(env);
    const running = spawnWorker(workerCommand, workerEnvironment({ host: process.env, client: entry.env, extra: workerCommand.env, claudeConfigDir: agent.claudeConfigDir }), (message: WorkerToHost) => {
      if (message.type === "failed") entry.failure = message.reason;
      else {
        record(entry, message.event);
        follow(entry, message.event);
      }
    });
    entry.worker = running;
    entry.failure = undefined;
    entry.exited = running.exited.then(({ code, signal, error, stderrTail }) => {
      entry.worker = undefined;
      if (entry.stopRequested) {
        entry.stopRequested = false;
        stoppedAs(entry);
      } else if (code === UPDATE_EXIT_CODE && !shuttingDown) {
        startWorker(entry);
        // The update replaced the installation's files: the other agents running them restart too.
        const installation = installationOf(agent);
        if (installation) restartInstallationAgents(installation.id, entry);
      }
      else {
        const lastWords = stderrTail.trim().split("\n").at(-1)?.slice(0, 300);
        const how = signal ? `The agent process was killed (${signal})` : `The agent process exited (code ${code})`;
        const reason = entry.failure ?? error?.message ?? `${how}${lastWords ? `: ${lastWords}` : "."}`;
        record(entry, { type: "stopped", reason: "failed", error: reason });
        stoppedAs(entry, reason);
      }
      checkIdle();
    });
    const { serverUrl, token } = installation;
    running.send({
      type: "start",
      config: { serverUrl, token, machine: hostname(), folder: agent.folder, kind: agent.kind, projectIds: agent.projectIds, model: agent.model, effort: agent.effort },
    });
    const startedAt = new Date().toISOString();
    setAgent(entry, { state: "reconnecting", since: startedAt, startedAt, machine: hostname().split(".")[0], reason: undefined, run: undefined });
    checkIdle();
  }

  async function stopWorker(entry: Entry): Promise<void> {
    if (!entry.worker || !entry.exited) return;
    entry.stopRequested = true;
    await entry.worker.stop(stopTimeoutMs);
    await entry.exited;
  }

  function launch(settings: LaunchSettings, env?: Record<string, string>): { agent: HostAgent; started: boolean } {
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    const existing = [...entries.values()].find((entry) => entry.agent.folder === settings.folder && normalizeServerUrl(entry.agent.serverUrl) === serverUrl);
    if (existing && existing.agent.state !== "stopped") return { agent: existing.agent, started: false };
    const installation = installationOf({ serverUrl });
    if (!installation) {
      throw new Error(`${serverUrl} is not set up. Run \`redline setup ${serverUrl} --token <token>\` first.`);
    }
    const settled = { ...settings, serverUrl, installation: installation.id };
    if (existing) {
      existing.agent = { ...existing.agent, ...settled };
      startWorker(existing, env);
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
    startWorker(entry, env);
    return { agent: entry.agent, started: true };
  }

  const logEntries = ({ log, progress }: Entry, lines?: number) => {
    const all = progress ? [...log.read(), progress] : log.read();
    return lines === undefined ? all : lines <= 0 ? [] : all.slice(-lines);
  };
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
        return { id: request.id, ok: true, ...launch({ folder, kind, serverUrl, projectIds, projectNames, model, effort, claudeConfigDir, account }, request.env) };
      }
      case "attach":
        attached.add(client);
        checkIdle();
        return { id: request.id, ok: true, agent: entryOf(request.agentId).agent };
      case "log":
        return { id: request.id, ok: true, entries: logEntries(entryOf(request.agentId), request.lines) };
      case "set-model-effort": {
        const entry = entryOf(request.agentId);
        const { model, effort } = request;
        const invalid = modelChoiceError(request);
        if (invalid) throw new Error(invalid);
        setAgent(entry, { model, effort });
        rememberChoice({ folder: entry.agent.folder, configDir, choice: { model, effort } });
        entry.worker?.send({ type: "set-model-effort", model, effort });
        return { id: request.id, ok: true, agent: entry.agent };
      }
      case "stop": {
        const entry = entryOf(request.agentId);
        await stopWorker(entry);
        if (request.reason && entry.agent.state === "stopped") setAgent(entry, { reason: request.reason });
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
        if (started) startWorker(entry, request.env);
        return { id: request.id, ok: true, agent: entry.agent, started };
      }
      case "restart-all": {
        const stopped = [...entries.values()].filter((entry) => entry.agent.state === "stopped");
        for (const entry of stopped) startWorker(entry, request.env);
        return { id: request.id, ok: true, agents: stopped.map((entry) => entry.agent) };
      }
      case "installation-updated":
        return { id: request.id, ok: true, agents: restartInstallationAgents(request.installation).map((entry) => entry.agent) };
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
    clearInterval(commandTimer);
    await Promise.all([...entries.values()].map(stopWorker));
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketPath, { force: true });
    releaseLock();
    resolveClosed();
  }

  try {
    await claimSocket(configDir);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    releaseLock();
    throw error;
  }
  for (const id of resumed) {
    const entry = entries.get(id);
    if (!entry) continue;
    entry.log.append({ at: new Date().toISOString(), event: { type: "host-updated", version: command.version() } });
    startWorker(entry);
  }
  commandTimer = setInterval(checkCommand, commandCheckMs);
  commandTimer.unref();
  checkIdle();
  return { stop, closed };
}

/** The agents the previous host stopped for its restart (read once: the list is deleted). */
function takeResumeList(configDir: string): string[] {
  const file = resumePath(configDir);
  try {
    const ids: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  } finally {
    rmSync(file, { force: true });
  }
}
