import type { AddressInfo } from "node:net";
import { buildArtboardApp, buildMainApp } from "./app.js";
import type { IdentityConfig } from "./identity.js";
import { loadCliBuild } from "./cli-build.js";
import { assertValidProxySecrets, type ProxySecrets } from "./proxy-secrets.js";
import { Store } from "./store.js";

export interface StartOptions {
  dataDir: string;
  port: number;
  artboardPort: number;
  host: string;
  /** Public origin of the artboard listener, when behind a proxy; defaults to the listener's address. */
  artboardOrigin?: string;
  webDir?: string;
  /** Folder holding `redline-cli.tgz` and `build-hash.txt`; when both exist the tarball is served at `/cli/redline-cli.tgz`. */
  cliDir?: string;
  /** When set, both listeners refuse requests that do not carry the proxy secret of their route. */
  proxySecrets?: ProxySecrets;
  /** Names of the SSO identity headers and the logout URL; the headers are read only when proxy secrets are set. */
  identity?: IdentityConfig;
  /** After this date, requests whose `Host` is not a local name (a tunnel's) are refused. */
  publicUntil?: Date;
  /** Waits before each retry of a failed work item; default 1, 5 and 15 minutes. */
  retryDelaysMs?: number[];
  /** How long a terminal session may go without a heartbeat before it counts as gone; default 60 s. */
  terminalPresenceTimeoutMs?: number;
}

export interface RunningServer {
  url: string;
  artboardOrigin: string;
  close(): Promise<void>;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  if (options.proxySecrets) assertValidProxySecrets(options.proxySecrets);
  const store = new Store(options.dataDir);
  const artboardApp = await buildArtboardApp(store, options.proxySecrets, options.publicUntil);
  await artboardApp.listen({ port: options.artboardPort, host: options.host });
  const artboardOrigin = options.artboardOrigin ?? `http://${options.host}:${portOf(artboardApp.server.address())}`;

  const mainApp = await buildMainApp(store, { artboardOrigin }, options.webDir, {
    retryDelaysMs: options.retryDelaysMs,
    terminalPresenceTimeoutMs: options.terminalPresenceTimeoutMs,
    proxySecrets: options.proxySecrets,
    identity: options.identity,
    publicUntil: options.publicUntil,
    cliBuild: loadCliBuild(options.cliDir),
  });
  await mainApp.listen({ port: options.port, host: options.host });

  return {
    url: `http://${options.host}:${portOf(mainApp.server.address())}`,
    artboardOrigin,
    async close() {
      await mainApp.close();
      await artboardApp.close();
      store.close();
    },
  };
}

function portOf(address: string | AddressInfo | null): number {
  return (address as AddressInfo).port;
}
