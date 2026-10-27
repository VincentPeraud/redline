import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMainApp } from "../src/app.js";
import { PROXY_SECRET_HEADER, proxySecretsFromEnv } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { Store } from "../src/store.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);

describe("proxy secrets", () => {
  let dataDir: string;
  let server: RunningServer;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-secrets-"));
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", proxySecrets: { human: HUMAN, machine: MACHINE } });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const status = async (url: string, secret?: string) =>
    (await fetch(url, { headers: secret === undefined ? {} : { [PROXY_SECRET_HEADER]: secret } })).status;
  const ui = (path: string) => server.url + path;
  const artboards = (path: string) => server.artboardOrigin + path;

  it("refuses requests without the header, on the UI, the API and the artboard origin", async () => {
    expect(await status(ui("/"))).toBe(403);
    expect(await status(ui("/api/projects"))).toBe(403);
    expect(await status(artboards("/anything"))).toBe(403);
  });

  it("refuses a wrong secret", async () => {
    expect(await status(ui("/api/projects"), "x".repeat(32))).toBe(403);
    expect(await status(artboards("/anything"), "x".repeat(32))).toBe(403);
  });

  it("accepts the human secret on the UI, the API and the artboard origin", async () => {
    expect(await status(ui("/api/projects"), HUMAN)).toBe(200);
    expect(await status(artboards("/anything"), HUMAN)).toBe(404);
  });

  it("refuses the machine secret on the UI, the API and the artboard origin", async () => {
    expect(await status(ui("/api/projects"), MACHINE)).toBe(403);
    expect(await status(artboards("/anything"), MACHINE)).toBe(403);
  });

  it("refuses the human secret on the agents' and CLI paths", async () => {
    for (const path of ["/agent", "/agent-api/work", "/cli/redline.js"]) {
      expect(await status(ui(path), HUMAN)).toBe(403);
    }
  });

  it("accepts the machine secret only on the agents' and CLI paths", async () => {
    for (const path of ["/agent", "/agent-api/work", "/cli/redline.js"]) {
      expect(await status(ui(path), MACHINE)).not.toBe(403);
    }
    expect(await status(ui("/agent-apiary"), MACHINE)).toBe(403);
  });

  it("answers the health route on loopback without any secret", async () => {
    const res = await fetch(ui("/healthz"));
    expect(res.status).toBe(200);
  });

  it("refuses the health route from another address", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "redline-health-")));
    const app = await buildMainApp(store, { artboardOrigin: "http://localhost" });
    expect((await app.inject({ url: "/healthz", remoteAddress: "10.0.0.5" })).statusCode).toBe(403);
    expect((await app.inject({ url: "/healthz", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    await app.close();
    store.close();
  });
});

describe("proxy secrets at startup", () => {
  const start = (proxySecrets: { human: string; machine: string }) => {
    const dataDir = mkdtempSync(join(tmpdir(), "redline-secrets-"));
    return startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", proxySecrets });
  };

  it("refuses a short secret", async () => {
    await expect(start({ human: "short", machine: MACHINE })).rejects.toThrow(/at least 32/);
    await expect(start({ human: HUMAN, machine: "short" })).rejects.toThrow(/at least 32/);
  });

  it("refuses two equal secrets", async () => {
    await expect(start({ human: HUMAN, machine: HUMAN })).rejects.toThrow(/different/);
  });

  it("reads the secret files named by the environment, and checks nothing without them", () => {
    const dir = mkdtempSync(join(tmpdir(), "redline-secret-files-"));
    writeFileSync(join(dir, "human"), `${HUMAN}\n`);
    writeFileSync(join(dir, "machine"), MACHINE);
    expect(proxySecretsFromEnv({})).toBeUndefined();
    expect(proxySecretsFromEnv({ REDLINE_PROXY_SECRET_HUMAN_FILE: join(dir, "human"), REDLINE_PROXY_SECRET_MACHINE_FILE: join(dir, "machine") })).toEqual({
      human: HUMAN,
      machine: MACHINE,
    });
    expect(() => proxySecretsFromEnv({ REDLINE_PROXY_SECRET_HUMAN_FILE: join(dir, "human") })).toThrow(/both/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
