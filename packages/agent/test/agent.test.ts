import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_UPDATE_COMMAND, PROTOCOL_VERSION, type AgentInfo, type AgentTokenResponse } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { checkClaude } from "../src/claude.js";
import { connectToServer } from "../src/connection.js";
import { login, readLogin } from "../src/login.js";

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

describe("redline login", () => {
  it("stores the server URL and token for the machine and reads them back", () => {
    const configDir = tempDir();
    login({ configDir, serverUrl: "https://redline.example.fr/", token: "abt_123" });
    expect(readLogin(configDir)).toEqual({ serverUrl: "https://redline.example.fr", token: "abt_123" });
  });

  it("tells the user to log in when nothing is stored", () => {
    expect(() => readLogin(tempDir())).toThrow(/redline login/);
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

  it("passes when Claude Code is installed and logged in", async () => {
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
    ).rejects.toThrow(AGENT_UPDATE_COMMAND);
  });

  it("reports closing when the token is regenerated", async () => {
    const connection = await connectToServer({ serverUrl: server.url, token: await token(), ...identity });
    await server.post("/api/agent-token/regenerate", {});
    expect((await connection.closed).reason).toBe("unauthorized");
  });
});
