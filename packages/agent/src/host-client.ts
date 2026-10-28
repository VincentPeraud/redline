import type { Effort } from "@redline/shared";
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { claudeEnvironment } from "./worker-environment.js";
import { encodeLine, lineReader } from "./ndjson.js";
import { hostSocketPath, type HostAgent, type HostEvent, type HostLogEntry, type HostReply, type HostRequest, type LaunchSettings } from "./host-protocol.js";

type Reply = Extract<HostReply, { ok: true }>;
type Pending = { resolve(reply: Reply): void; reject(error: Error): void };

/** A connection to the agent host's control API: the agents screen, `redline agent` and the tests are all clients. */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: HostEvent) => void>();

  private constructor(
    private readonly socket: Socket,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    socket.setEncoding("utf8");
    const read = lineReader((line) => {
      try {
        this.receive(JSON.parse(line) as HostReply | HostEvent);
      } catch {
        // A line that is not JSON is not from a host this client can talk to: skip it.
      }
    });
    socket.on("data", (chunk: string) => {
      if (!read(chunk)) socket.destroy();
    });
    const lost = () => {
      for (const { reject } of this.pending.values()) reject(new Error("The agent host closed the connection."));
      this.pending.clear();
    };
    socket.on("close", lost);
    socket.on("error", () => undefined);
  }

  /** Rejects when no host listens on the config directory's socket. */
  static connect(configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<HostClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(hostSocketPath(configDir));
      socket.once("connect", () => resolve(new HostClient(socket, env)));
      socket.once("error", reject);
    });
  }

  private receive(message: HostReply | HostEvent): void {
    if ("event" in message) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.ok) waiting.resolve(message);
    else waiting.reject(new Error(message.error));
  }

  private request(request: HostRequest): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeLine({ ...request, id }));
    });
  }

  /** The agents, and when the host started fresh after the previous one died with agents running (until an agent is started again). */
  async snapshot(): Promise<{ agents: HostAgent[]; freshStartAt?: string }> {
    const reply = await this.request({ type: "list" });
    return { agents: reply.agents ?? [], freshStartAt: reply.freshStartAt };
  }

  async list(): Promise<HostAgent[]> {
    return (await this.snapshot()).agents;
  }

  /** Starts the agent of this folder and server, or returns the one that already exists (`started` is then false). */
  async launch(settings: LaunchSettings): Promise<{ agent: HostAgent; started: boolean }> {
    const reply = await this.request({ type: "launch", ...settings, env: claudeEnvironment(this.env) });
    return { agent: reply.agent!, started: reply.started! };
  }

  /** Resolves once the agent's worker has exited. */
  async stop(agentId: string): Promise<HostAgent> {
    return (await this.request({ type: "stop", agentId })).agent!;
  }

  /** Removes the agent from the host's list and deletes its log. */
  async remove(agentId: string): Promise<void> {
    await this.request({ type: "remove", agentId });
  }

  /** Starts a stopped agent again with its stored settings; `started` is false when it was not stopped. */
  async restart(agentId: string): Promise<{ agent: HostAgent; started: boolean }> {
    const reply = await this.request({ type: "restart", agentId, env: claudeEnvironment(this.env) });
    return { agent: reply.agent!, started: reply.started! };
  }

  /** Restarts every stopped agent and returns those. */
  async restartAll(): Promise<HostAgent[]> {
    return (await this.request({ type: "restart-all", env: claudeEnvironment(this.env) })).agents ?? [];
  }

  /** Sets the model and effort (absent = Claude's default) the agent's next runs use; a run in progress keeps its own. */
  async setModelEffort(agentId: string, { model, effort }: { model: string; effort?: Effort }): Promise<HostAgent> {
    return (await this.request({ type: "set-model-effort", agentId, model, effort })).agent!;
  }

  /** The last `lines` entries of the agent's run log (all that are kept by default), oldest first. */
  async log(agentId: string, lines?: number): Promise<HostLogEntry[]> {
    return (await this.request({ type: "log", agentId, lines })).entries ?? [];
  }

  /** Keeps the host alive while this connection is open. */
  async attach(agentId: string): Promise<HostAgent> {
    return (await this.request({ type: "attach", agentId })).agent!;
  }

  /** Keeps the host alive while this connection is open, and calls `listener` for each change. */
  async subscribe(listener: (event: HostEvent) => void): Promise<void> {
    this.listeners.add(listener);
    await this.request({ type: "subscribe" });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Connects to the running host, or starts one detached from this terminal and connects to it. */
export async function ensureHost({ configDir, hostCommand, timeoutMs = 10_000 }: { configDir: string; hostCommand: { command: string; args: string[]; env?: NodeJS.ProcessEnv }; timeoutMs?: number }): Promise<HostClient> {
  try {
    return await HostClient.connect(configDir);
  } catch {
    spawn(hostCommand.command, hostCommand.args, { detached: true, stdio: "ignore", env: { ...process.env, ...hostCommand.env } }).unref();
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await HostClient.connect(configDir);
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`The agent host did not start (${(error as Error).message}).`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
