import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliUpdateCommand, PROTOCOL_VERSION, type AgentInfo, type AgentTokenResponse } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { checkClaude } from "../src/claude.js";
import { connectToServer } from "../src/connection.js";
import { pickServer, readLogins, requireLogins, saveLogin, validateServerUrl } from "../src/login.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "redline-agent-test-"));
}

/** A PATH holding only a fake `claude` executable with the given shell body. */
function fakeClaudePath(script: string): string {
  const dir = tempDir();
  const file = join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return dir;
}

describe("login file", () => {
  it("stores the server URL and token for the machine and reads them back", () => {
    const configDir = tempDir();
    saveLogin({ configDir, serverUrl: "https://redline.example.fr/", token: "abt_123" });
    expect(readLogins(configDir)).toEqual([{ serverUrl: "https://redline.example.fr", token: "abt_123" }]);
  });

  it("keeps several servers, and updates the token of a server already there", () => {
    const configDir = tempDir();
    saveLogin({ configDir, serverUrl: "https://a.example.fr", token: "abt_a" });
    saveLogin({ configDir, serverUrl: "http://redline.localhost", token: "abt_b" });
    saveLogin({ configDir, serverUrl: "https://a.example.fr/", token: "abt_a2" });
    expect(readLogins(configDir)).toEqual([
      { serverUrl: "http://redline.localhost", token: "abt_b" },
      { serverUrl: "https://a.example.fr", token: "abt_a2" },
    ]);
  });

  it("reads the old single-server file and rewrites it as a list on the next save", () => {
    const configDir = tempDir();
    writeFileSync(join(configDir, "login.json"), JSON.stringify({ serverUrl: "https://old.example.fr", token: "abt_old" }));
    expect(readLogins(configDir)).toEqual([{ serverUrl: "https://old.example.fr", token: "abt_old" }]);
    saveLogin({ configDir, serverUrl: "https://new.example.fr", token: "abt_new" });
    expect(JSON.parse(readFileSync(join(configDir, "login.json"), "utf8"))).toHaveLength(2);
  });

  it("keeps the login file readable by its owner only, even when it already existed", () => {
    const configDir = tempDir();
    writeFileSync(join(configDir, "login.json"), "{}", { mode: 0o644 });
    saveLogin({ configDir, serverUrl: "https://redline.example.fr", token: "abt_123" });
    expect(statSync(join(configDir, "login.json")).mode & 0o777).toBe(0o600);
  });

  it("tells the user to set up a server when nothing is stored", () => {
    expect(() => requireLogins(tempDir())).toThrow(/redline setup/);
  });

  it("picks the only server, requires --server when there are several, and rejects an unknown one", () => {
    const a = { serverUrl: "https://a.example.fr", token: "a" };
    const b = { serverUrl: "https://b.example.fr", token: "b" };
    expect(pickServer([a])).toBe(a);
    expect(() => pickServer([a, b])).toThrow(/--server/);
    expect(pickServer([a, b], "https://b.example.fr/")).toBe(b);
    expect(() => pickServer([a], "https://c.example.fr")).toThrow(/not set up/);
  });
});

describe("server URL validation", () => {
  it.each(["https://redline.example.fr/", "http://localhost:3000", "http://redline.localhost", "http://127.0.0.1:3000", "https://example.fr/redline"])("accepts %s", (url) => {
    expect(validateServerUrl(url)).toBe(url.replace(/\/+$/, ""));
  });

  it.each(["http://redline.example.fr", "http://evil-localhost.com", "ftp://localhost", "redline.example.fr", "http://localhost.evil.com", "https://x.com/a;touch${IFS}/tmp/p;#", "https://x.com/$(id)", "https://x.com/a?b=1", "https://x.com/#frag", "https://user:pw@x.com", "https://x.com/a b", "https://x$(id).com"])("refuses %s", (url) => {
    expect(() => validateServerUrl(url)).toThrow();
  });
});

describe("Claude Code check", () => {
  it("fails with a clear error when Claude Code is not installed", async () => {
    await expect(checkClaude({ PATH: tempDir() })).rejects.toThrow(/Claude Code is not installed/);
  });

  it("fails with a clear error when Claude Code is not logged in", async () => {
    const PATH = fakeClaudePath('if [ "$1" = "auth" ]; then echo \'{"loggedIn": false}\'; exit 1; fi; echo 2.1.0');
    await expect(checkClaude({ PATH })).rejects.toThrow(/not logged in.*claude/);
  });

  it("passes when Claude Code is installed and logged in, and returns the logged-in account", async () => {
    const PATH = fakeClaudePath('if [ "$1" = "auth" ]; then echo \'{"loggedIn": true, "email": "someone@example.fr"}\'; exit 0; fi; echo 2.1.0');
    await expect(checkClaude({ PATH })).resolves.toBe("someone@example.fr");
  });

  it("returns no account when the auth status has no email", async () => {
    const PATH = fakeClaudePath('if [ "$1" = "auth" ]; then echo \'{"loggedIn": true}\'; exit 0; fi; echo 2.1.0');
    await expect(checkClaude({ PATH })).resolves.toBeUndefined();
  });
});

describe("agent connection", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function token() {
    return ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  }

  const identity = { machine: "MacBook", folder: "/work/acme", kind: "project" as const };

  it("connects with the stored token and shows up online on the server", async () => {
    const connection = await connectToServer({ serverUrl: server.url, token: await token(), ...identity });
    const list = (await (await server.get("/api/agents")).json()) as AgentInfo[];
    expect(list).toMatchObject([{ id: connection.agentId, machine: "MacBook", folder: "/work/acme", status: "online" }]);
    connection.close();
    await connection.closed;
  });

  it("fails with the server's message on a wrong token", async () => {
    await expect(connectToServer({ serverUrl: server.url, token: "abt_wrong", ...identity })).rejects.toThrow(
      /Wrong token/,
    );
  });

  it("fails with the update command when the protocol is incompatible", async () => {
    await expect(
      connectToServer({ serverUrl: server.url, token: await token(), ...identity, protocolVersion: PROTOCOL_VERSION + 1 }),
    ).rejects.toThrow(cliUpdateCommand(server.url));
  });

  it("reports closing when the token is regenerated", async () => {
    const connection = await connectToServer({ serverUrl: server.url, token: await token(), ...identity });
    await server.post("/api/agent-token/regenerate", {});
    expect((await connection.closed).reason).toBe("unauthorized");
  });
});
