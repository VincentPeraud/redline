import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { isLocalHost, publicDeadlineFromEnv, registerPublicDeadline } from "../src/public-deadline.js";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";

const SECRETS = { human: "h".repeat(32), machine: "m".repeat(32) };
const TUNNEL = "motel-need-handled-proudly.trycloudflare.com";

/** fetch cannot set `Host`, so the requests go through node:http. */
function statusFor(url: string, host: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { [PROXY_SECRET_HEADER]: SECRETS.human, ...headers, host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("public deadline", () => {
  let dataDir: string | undefined;
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    server = undefined;
    dataDir = undefined;
  });

  const start = async (publicUntil: Date) => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-deadline-"));
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", proxySecrets: SECRETS, publicUntil });
    return server;
  };

  it("serves a tunnel's host before the deadline", async () => {
    const { url, artboardOrigin } = await start(new Date(Date.now() + 60_000));
    expect(await statusFor(`${url}/api/projects`, TUNNEL)).toBe(200);
    // 404: the request reaches the router, which has no route without a capability in the path.
    expect(await statusFor(`${artboardOrigin}/__redline/bridge.js`, TUNNEL)).toBe(404);
  });

  it("refuses a tunnel's host after the deadline, on the UI, the API and the artboard origin", async () => {
    const { url, artboardOrigin } = await start(new Date(Date.now() - 1));
    expect(await statusFor(`${url}/`, TUNNEL)).toBe(403);
    expect(await statusFor(`${url}/api/projects`, TUNNEL)).toBe(403);
    expect(await statusFor(`${artboardOrigin}/__redline/bridge.js`, TUNNEL)).toBe(403);
  });

  it("keeps serving local names after the deadline", async () => {
    const { url, artboardOrigin } = await start(new Date(Date.now() - 1));
    for (const host of ["localhost:3000", "redline.localhost", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(await statusFor(`${url}/api/projects`, host)).toBe(200);
    }
    expect(await statusFor(`${artboardOrigin}/__redline/bridge.js`, "artboards.redline.localhost")).toBe(404);
  });

  it("ignores X-Forwarded-Host, which a tunnel's visitor can set", async () => {
    const { url } = await start(new Date(Date.now() - 1));
    expect(await statusFor(`${url}/api/projects`, TUNNEL, { "x-forwarded-host": "localhost" })).toBe(403);
  });

  it("refuses a request once the clock passes the deadline, with no restart", async () => {
    let clock = 1_000;
    const app = Fastify();
    registerPublicDeadline(app, new Date(2_000), () => clock);
    app.get("/", async () => "ok");
    const ask = async () => (await app.inject({ url: "/", headers: { host: TUNNEL } })).statusCode;
    expect(await ask()).toBe(200);
    clock = 2_000;
    expect(await ask()).toBe(403);
    await app.close();
  });

  it("does nothing without a deadline", async () => {
    const app = Fastify();
    registerPublicDeadline(app, undefined);
    app.get("/", async () => "ok");
    expect((await app.inject({ url: "/", headers: { host: TUNNEL } })).statusCode).toBe(200);
    await app.close();
  });
});

describe("publicDeadlineFromEnv", () => {
  it("reads an ISO date, or nothing when unset", () => {
    expect(publicDeadlineFromEnv({ REDLINE_PUBLIC_UNTIL: "2026-11-01T13:39:00+01:00" })?.toISOString()).toBe("2026-11-01T12:39:00.000Z");
    expect(publicDeadlineFromEnv({})).toBeUndefined();
    expect(publicDeadlineFromEnv({ REDLINE_PUBLIC_UNTIL: " " })).toBeUndefined();
  });

  it("refuses to start on a date it cannot read", () => {
    expect(() => publicDeadlineFromEnv({ REDLINE_PUBLIC_UNTIL: "tomorrow" })).toThrow(/not a date/);
  });
});

describe("isLocalHost", () => {
  it("knows the loopback names and nothing else", () => {
    for (const host of ["localhost", "redline.localhost", "127.0.0.1", "[::1]"]) expect(isLocalHost(host)).toBe(true);
    for (const host of [TUNNEL, "localhost.evil.com", "192.168.1.10", ""]) expect(isLocalHost(host)).toBe(false);
  });
});
