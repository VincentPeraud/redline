import { rmSync } from "node:fs";
import { TOKEN_REFUSED_REASON } from "./activity.js";
import { AgentRegistry } from "./agent-registry.js";
import { HostClient } from "./host-client.js";
import { agentLogPath, type HostAgent } from "./host-protocol.js";
import type { Installation } from "./installations.js";
import { normalizeServerUrl } from "./login.js";

/** An agent runs with the installation its record names; a record from before the installations has the address only. */
export const agentOf = (agent: Pick<HostAgent, "installation" | "serverUrl">, installation: Pick<Installation, "id" | "serverUrl">): boolean =>
  agent.installation ? agent.installation === installation.id : normalizeServerUrl(agent.serverUrl) === normalizeServerUrl(installation.serverUrl);

/** Runs `use` on the running host of this config dir; `none` is the answer when no host runs. */
async function withHost<T>(configDir: string, env: NodeJS.ProcessEnv, use: (host: HostClient) => Promise<T>, none: () => T | Promise<T>): Promise<T> {
  let host: HostClient;
  try {
    host = await HostClient.connect(configDir, env);
  } catch {
    return none();
  }
  try {
    return await use(host);
  } finally {
    host.close();
  }
}

/** The saved agents when no host runs: the next host starts them all stopped. */
const savedAgents = (configDir: string): HostAgent[] => new AgentRegistry(configDir).load(new Date().toISOString()).agents;

/** Agents of that address stopped by a refused token, restarted through the running host (no host: nothing to restart). */
export const restartStoppedAgents = (configDir: string, serverUrl: string, env: NodeJS.ProcessEnv): Promise<string[]> =>
  withHost(
    configDir,
    env,
    async (host) => {
      const stopped = (await host.list()).filter((agent) => agent.state === "stopped" && normalizeServerUrl(agent.serverUrl) === serverUrl && agent.reason?.startsWith(TOKEN_REFUSED_REASON));
      const restarted: string[] = [];
      for (const agent of stopped) if ((await host.restart(agent.id)).started) restarted.push(agent.name);
      return restarted;
    },
    () => [],
  );

/** Tells the host the installation was updated; returns the agents it restarts, each after its run (none when no host runs). */
export const restartInstallationAgents = (configDir: string, installation: Installation, env: NodeJS.ProcessEnv): Promise<string[]> =>
  withHost(configDir, env, async (host) => (await host.installationUpdated(installation.id)).map((agent) => agent.name), () => []);

/** The agents of the installation, `running` meaning anything but stopped. */
export const agentsOfInstallation = (configDir: string, installation: Installation, env: NodeJS.ProcessEnv): Promise<{ name: string; running: boolean }[]> =>
  withHost(
    configDir,
    env,
    async (host) => (await host.list()).filter((agent) => agentOf(agent, installation)).map((agent) => ({ name: agent.name, running: agent.state !== "stopped" })),
    () => savedAgents(configDir).filter((agent) => agentOf(agent, installation)).map((agent) => ({ name: agent.name, running: false })),
  );

/** Removes the installation's stopped agents and their logs, through the host or, when none runs, from the saved list. */
export const removeStoppedAgents = (configDir: string, installation: Installation, env: NodeJS.ProcessEnv): Promise<string[]> =>
  withHost(
    configDir,
    env,
    async (host) => {
      const stopped = (await host.list()).filter((agent) => agentOf(agent, installation) && agent.state === "stopped");
      for (const agent of stopped) await host.remove(agent.id);
      return stopped.map((agent) => agent.name);
    },
    () => {
      const all = savedAgents(configDir);
      const gone = all.filter((agent) => agentOf(agent, installation));
      if (gone.length === 0) return [];
      new AgentRegistry(configDir).save(all.filter((agent) => !gone.includes(agent)));
      for (const agent of gone) rmSync(agentLogPath(configDir, agent.id), { force: true });
      return gone.map((agent) => agent.name);
    },
  );
