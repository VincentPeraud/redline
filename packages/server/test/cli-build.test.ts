import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";

const TARBALL = Buffer.from("fake tarball bytes");

describe("CLI served by the server", () => {
  let dir: string;
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-cli-dir-"));
    dataDir = mkdtempSync(join(tmpdir(), "redline-cli-data-"));
    writeFileSync(join(dir, "redline-cli.tgz"), TARBALL);
    writeFileSync(join(dir, "build-hash.txt"), "abc123\n");
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = (options: { cliDir?: string; machine?: string } = {}) =>
    startServer({
      dataDir,
      port: 0,
      artboardPort: 0,
      host: "127.0.0.1",
      cliDir: options.cliDir,
      firstAdminEmail: "admin@example.com",
      proxySecrets: options.machine ? { human: "h".repeat(32), machine: options.machine } : undefined,
    });

  it("serves the tarball without any token", async () => {
    server = await start({ cliDir: dir });
    const response = await fetch(server.url + "/cli/redline-cli.tgz");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(TARBALL);
  });

  it("serves it on the machine route only when proxy secrets are set", async () => {
    const machine = "m".repeat(32);
    server = await start({ cliDir: dir, machine });
    expect((await fetch(server.url + "/cli/redline-cli.tgz")).status).toBe(403);
    const response = await fetch(server.url + "/cli/redline-cli.tgz", { headers: { [PROXY_SECRET_HEADER]: machine } });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("serves nothing when the image carries no CLI", async () => {
    server = await start();
    expect((await fetch(server.url + "/cli/redline-cli.tgz")).status).toBe(404);
  });
});
