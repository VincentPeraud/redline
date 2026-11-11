import { defaultConfigDir } from "./login.js";
import { ServerApi } from "./server-api.js";
import { listInstallations, type InstanceLabel } from "./installations.js";
import { serveTerminalMcp } from "./terminal-mcp.js";

/**
 * The entry point the global `redline mcp` hands over to, in the same process: stable across versions, so that a launcher
 * can run any installation's own MCP. A build without this file is too old for the launcher.
 */
export async function serveInstallationMcp({ serverUrl, token, folder, instance }: { serverUrl: string; token: string; folder: string; instance: InstanceLabel }): Promise<void> {
  const otherInstances = () => listInstallations(defaultConfigDir()).filter((installation) => installation.serverUrl !== serverUrl).map((installation) => installation.name);
  await serveTerminalMcp({ api: new ServerApi(serverUrl, token), folder, instance, otherInstances });
}
