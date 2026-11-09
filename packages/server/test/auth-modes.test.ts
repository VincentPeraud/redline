import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeResponse } from "@redline/shared";
import { authModeFromEnv } from "../src/access.js";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer, type StartOptions } from "../src/start.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);

describe("authentication modes", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-modes-"));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async (options: Partial<StartOptions> = {}) => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", ...options });
    return server;
  };

  describe("none", () => {
    it("allows everything, as before", async () => {
      const { url } = await start({ authMode: "none" });
      expect((await fetch(`${url}/api/projects`)).status).toBe(200);
      const created = await fetch(`${url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "P" }) });
      expect(created.status).toBe(201);
      expect(await (await fetch(`${url}/api/me`)).json()).toBeNull();
    });

    it("is the mode when none is named and there are no proxy secrets", async () => {
      const { url } = await start();
      expect((await fetch(`${url}/api/projects`)).status).toBe(200);
    });

    it("refuses to start with the public deadline set", async () => {
      await expect(start({ authMode: "none", publicUntil: new Date(Date.now() + 60_000) })).rejects.toThrow(/Mode "none".*REDLINE_PUBLIC_UNTIL/);
    });

    it("refuses to start behind a tunnel (artboard origin on a public name)", async () => {
      await expect(start({ authMode: "none", artboardOrigin: "https://artboards.trycloudflare.com" })).rejects.toThrow(/Mode "none".*tunnel/);
    });

    it("refuses to start on a host that is not local", async () => {
      await expect(start({ authMode: "none", host: "192.168.1.10" })).rejects.toThrow(/Mode "none".*host/);
    });

    it("starts with a local artboard origin", async () => {
      await start({ authMode: "none", artboardOrigin: "https://artboards.redline.localhost" });
    });
  });

  describe("proxy", () => {
    const secrets = { human: HUMAN, machine: MACHINE };

    it("refuses to start without the proxy secrets", async () => {
      await expect(start({ authMode: "proxy" })).rejects.toThrow(/proxy secrets/);
    });

    it("refuses proxy secrets in another mode", async () => {
      await expect(start({ authMode: "none", proxySecrets: secrets })).rejects.toThrow(/proxy/);
    });

    it("keeps reading the SSO person and allows the rest, with the public deadline set", async () => {
      const { url } = await start({ authMode: "proxy", proxySecrets: secrets, publicUntil: new Date(Date.now() + 60_000) });
      const headers = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };
      const me = (await (await fetch(`${url}/api/me`, { headers })).json()) as MeResponse;
      expect(me?.id).toBe("amartin");
      expect((await fetch(`${url}/api/projects`, { headers })).status).toBe(200);
      expect((await fetch(`${url}/api/projects`)).status).toBe(403);
    });

    it("is the mode when proxy secrets are given and none is named", async () => {
      const { url } = await start({ proxySecrets: secrets });
      expect((await fetch(`${url}/api/projects`, { headers: { [PROXY_SECRET_HEADER]: HUMAN } })).status).toBe(200);
    });
  });

  describe("local", () => {
    it("asks the access module on every route: nobody may do anything, and is told to sign in", async () => {
      const { url } = await start({ authMode: "local" });
      const json = { "content-type": "application/json" };
      const calls: Array<[string, string]> = [
        ["GET", "/api/projects"],
        ["POST", "/api/projects"],
        ["GET", "/api/settings"],
        ["PATCH", "/api/settings"],
        ["GET", "/api/pages/p1/queue"],
        ["POST", "/api/pages/p1/threads"],
        ["GET", "/api/design-systems"],
        ["GET", "/api/agent-token"],
      ];
      for (const [method, path] of calls) {
        const response = await fetch(url + path, { method, headers: json, body: method === "GET" ? undefined : "{}" });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
      expect((await fetch(`${url}/api/me`)).status).toBe(401);
    });
  });
});

describe("authModeFromEnv", () => {
  it("reads none and proxy, and nothing when unset", () => {
    expect(authModeFromEnv({ REDLINE_AUTH_MODE: "none" })).toBe("none");
    expect(authModeFromEnv({ REDLINE_AUTH_MODE: " Proxy " })).toBe("proxy");
    expect(authModeFromEnv({})).toBeUndefined();
  });

  it("reads local, and rejects unknown values", () => {
    expect(authModeFromEnv({ REDLINE_AUTH_MODE: "local" })).toBe("local");
    expect(() => authModeFromEnv({ REDLINE_AUTH_MODE: "sso" })).toThrow(/REDLINE_AUTH_MODE/);
  });
});
