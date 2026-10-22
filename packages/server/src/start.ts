import type { AddressInfo } from "node:net";
import { buildArtboardApp, buildMainApp } from "./app.js";
import { Store } from "./store.js";

export interface StartOptions {
  dataDir: string;
  port: number;
  artboardPort: number;
  host: string;
  /** Public origin of the artboard listener, when behind a proxy; defaults to the listener's address. */
  artboardOrigin?: string;
  webDir?: string;
  /** Waits before each retry of a failed work item; default 1, 5 and 15 minutes. */
  retryDelaysMs?: number[];
}

export interface RunningServer {
  url: string;
  artboardOrigin: string;
  close(): Promise<void>;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const store = new Store(options.dataDir);
  const artboardApp = await buildArtboardApp(store);
  await artboardApp.listen({ port: options.artboardPort, host: options.host });
  const artboardOrigin = options.artboardOrigin ?? `http://${options.host}:${portOf(artboardApp.server.address())}`;

  const mainApp = await buildMainApp(store, { artboardOrigin }, options.webDir, { retryDelaysMs: options.retryDelaysMs });
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
