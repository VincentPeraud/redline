import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./start.js";

export interface TestServer {
  url: string;
  artboardOrigin: string;
  dataDir: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  /** Number of distinct blobs on disk. */
  blobCount(): number;
  stop(): Promise<void>;
}

/** Starts a real server on a temporary data folder with random free ports. */
export async function startTestServer(options: { webDir?: string } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "redline-test-"));
  const server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir: options.webDir });
  return {
    url: server.url,
    artboardOrigin: server.artboardOrigin,
    dataDir,
    get: (path) => fetch(server.url + path),
    post: (path, body) =>
      fetch(server.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    blobCount: () => readdirSync(join(dataDir, "blobs")).length,
    async stop() {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
