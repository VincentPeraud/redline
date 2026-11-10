import type { HostClient } from "./host-client.js";
import type { HostAgent } from "./host-protocol.js";
import { normalizeServerUrl } from "./login.js";

/** The agent of the host that already serves this folder for this server and is not stopped: `redline agent` opens it instead of asking anything. */
export async function servingAgent({ host, folder, serverUrl }: { host: Pick<HostClient, "list">; folder: string; serverUrl: string }): Promise<HostAgent | undefined> {
  const wanted = normalizeServerUrl(serverUrl);
  return (await host.list()).find((agent) => agent.folder === folder && normalizeServerUrl(agent.serverUrl) === wanted && agent.state !== "stopped");
}
