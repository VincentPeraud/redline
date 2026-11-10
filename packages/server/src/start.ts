import type { AddressInfo } from "node:net";
import { assertModeCanStart, type AuthMode } from "./access.js";
import { ArtboardCapabilities, loadCapabilityKey } from "./artboard-capabilities.js";
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
  /** `none` (no login, local use only), `proxy` (SSO behind the proxy secrets) or `local` (built-in accounts); defaults to `proxy` when proxy secrets are set, else `none`. */
  authMode?: AuthMode;
  /** When set, both listeners refuse requests that do not carry the proxy secret of their route. */
  proxySecrets?: ProxySecrets;
  /** Names of the SSO identity headers and the logout URL; the headers are read only when proxy secrets are set. */
  identity?: IdentityConfig;
  /** Proxy mode: the e-mail of the SSO person who becomes the first admin of an instance with no account (required in that mode). */
  firstAdminEmail?: string;
  /** Behind a reverse proxy that sets `X-Forwarded-For`: the sign-in lockout then counts the address it reports. Never set it when clients can reach Redline directly. */
  trustedProxy?: boolean;
  /** Public address of the web UI, used in the setup link written to the logs (default: the address the server listens on). */
  publicUrl?: string;
  /** Where the setup link is written; default the console. */
  log?: (line: string) => void;
  /** After this date, requests whose `Host` is not a local name (a tunnel's) are refused. */
  publicUntil?: Date;
  /** How long an artboard viewing capability lasts; default 10 minutes (the app renews it at half). */
  artboardCapabilityLifetimeMs?: number;
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
  const authMode = options.authMode ?? (options.proxySecrets ? "proxy" : "none");
  assertModeCanStart(authMode, options);
  if (options.proxySecrets) assertValidProxySecrets(options.proxySecrets);
  const log = options.log ?? ((line: string) => console.log(line));
  const store = new Store(options.dataDir);
  store.accounts.log = log;
  const capabilities = new ArtboardCapabilities(loadCapabilityKey(options.dataDir), options.artboardCapabilityLifetimeMs);
  const artboardApp = await buildArtboardApp(store, { proxySecrets: options.proxySecrets, publicUntil: options.publicUntil, capabilities, authMode });
  await artboardApp.listen({ port: options.artboardPort, host: options.host });
  const artboardOrigin = options.artboardOrigin ?? `http://${options.host}:${portOf(artboardApp.server.address())}`;

  const mainApp = await buildMainApp(store, { artboardOrigin }, options.webDir, {
    retryDelaysMs: options.retryDelaysMs,
    terminalPresenceTimeoutMs: options.terminalPresenceTimeoutMs,
    proxySecrets: options.proxySecrets,
    identity: options.identity,
    firstAdminEmail: options.firstAdminEmail,
    publicUrl: options.publicUrl,
    trustedProxy: options.trustedProxy,
    authMode,
    capabilities,
    publicUntil: options.publicUntil,
    cliBuild: loadCliBuild(options.cliDir),
  });
  await mainApp.listen({ port: options.port, host: options.host });
  const url = `http://${options.host}:${portOf(mainApp.server.address())}`;
  if (authMode === "local") {
    const setupToken = store.accounts.issueSetupToken();
    if (setupToken) log(`No account yet. Open this link to create the first admin: ${(options.publicUrl ?? url).replace(/\/$/, "")}/#/setup/${setupToken}`);
  }

  return {
    url,
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
