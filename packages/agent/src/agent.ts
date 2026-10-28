import { cliUpdateCommand } from "@redline/shared";
import type { ReportActivity } from "./activity.js";
import { connectToServer, type AgentConnection, type ConnectOptions } from "./connection.js";
import type { Engine } from "./engine.js";
import { buildHash } from "./build-hash.js";
import { installCli, type InstallCli } from "./install-cli.js";
import { ServerApi } from "./server-api.js";
import { runWorkItem } from "./work-runner.js";

export interface AgentOptions extends Omit<ConnectOptions, "onMessage"> {
  engine: Engine;
  /** Installs the CLI when the server asks for an update; defaults to running npm. */
  install?: InstallCli;
  /** The build hash of the files the supervisor will relaunch, read after the install; defaults to this CLI's build-hash.txt. */
  installedBuildHash?(): string;
  /** Called once the update is installed: the agent should exit so that its supervisor relaunches it. */
  onUpdated?(): void;
  /** Receives the activity of the work runs. */
  onActivity?: ReportActivity;
}

/** Connects to the server and runs the work items it pushes, with the given engine. */
export async function startAgent({ engine, install = installCli, installedBuildHash = buildHash, onUpdated, onActivity, ...connect }: AgentOptions): Promise<AgentConnection> {
  const api = new ServerApi(connect.serverUrl, connect.token, connect.buildHash);
  const running = new Set<Promise<void>>();
  const attempts = new Map<string, number>();

  /**
   * Lets the running sessions finish, installs the update, and tells the server when it failed (the agent then keeps its build).
   * An install that left this agent's files unchanged failed too: relaunching would run the same outdated build again.
   */
  async function update(): Promise<void> {
    while (running.size > 0) await Promise.allSettled([...running]);
    const command = cliUpdateCommand(connect.serverUrl);
    try {
      await install(command);
    } catch (error) {
      connection.send({ type: "update-failed", message: (error as Error).message });
      return;
    }
    if (installedBuildHash() === connect.buildHash) {
      const message = `npm installed the update in another folder than the one this agent runs from. Run \`${command}\` in a terminal, then restart the agent.`;
      connection.send({ type: "update-failed", message });
      return;
    }
    onUpdated?.();
  }

  const connection = await connectToServer({
    ...connect,
    onMessage(message) {
      if (message.type === "work") {
        const item = { ...message.item, model: message.item.model ?? connect.model, effort: message.item.effort ?? connect.effort };
        const attempt = (attempts.get(item.id) ?? 0) + 1;
        attempts.set(item.id, attempt);
        const report: ReportActivity = (event) => {
          if (event.type === "run-published") attempts.delete(item.id);
          onActivity?.(event);
        };
        const run = runWorkItem(item, { folder: connect.folder, api, engine, send: (m) => connection.send(m), report, attempt });
        running.add(run);
        void run.finally(() => running.delete(run));
      } else if (message.type === "update") void update();
    },
  });
  return connection;
}
