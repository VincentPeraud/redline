import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { readLogins } from "../src/login.js";
import { ServerApi } from "../src/server-api.js";
import { setupServer } from "../src/setup.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "redline-setup-test-"));

/** A fake `claude` that remembers its user-scope MCP entry in a file and logs every call. */
function fakeClaude() {
  const dir = tempDir();
  const state = join(dir, "entry");
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "mcp get")
    [ -f "${state}" ] || exit 1
    printf 'redline:\\n  Scope: User config (available in all your projects)\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n' "$(sed -n 1p "${state}")" "$(sed -n 2p "${state}")" ;;
  "mcp add") shift 6; printf '%s\\n%s\\n' "$1" "$2" > "${state}" ;;
  "mcp remove") rm -f "${state}" ;;
esac
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { env: { PATH: `${dir}:/usr/bin:/bin` }, state, calls };
}

describe("redline setup", () => {
  let server: TestServer;
  let token: string;
  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as { token: string }).token;
  });
  afterEach(() => server.stop());

  it("checks the token, stores the server (mode 0600) and registers the MCP at user scope", async () => {
    const configDir = tempDir();
    const claude = fakeClaude();
    await setupServer({ configDir, serverUrl: `${server.url}/`, token, env: claude.env });
    expect(readLogins(configDir)).toEqual([{ serverUrl: server.url, token }]);
    expect(statSync(join(configDir, "login.json")).mode & 0o777).toBe(0o600);
    expect(claude.calls()).toContain("mcp add --scope user redline -- redline mcp");
  });

  it("saves nothing with a wrong token", async () => {
    const configDir = tempDir();
    const claude = fakeClaude();
    await expect(setupServer({ configDir, serverUrl: server.url, token: "abt_wrong", env: claude.env })).rejects.toThrow(/token/i);
    expect(readLogins(configDir)).toEqual([]);
    expect(claude.calls()).toEqual([]);
  });

  it("refuses a plain http URL that is not a loopback host, before any call", async () => {
    const claude = fakeClaude();
    await expect(setupServer({ configDir: tempDir(), serverUrl: "http://redline.example.fr", token, env: claude.env })).rejects.toThrow(/https/);
    expect(claude.calls()).toEqual([]);
  });

  it("is safe to rerun: no second MCP entry, and the token is updated", async () => {
    const configDir = tempDir();
    const claude = fakeClaude();
    await setupServer({ configDir, serverUrl: server.url, token, env: claude.env });
    await setupServer({ configDir, serverUrl: server.url, token, env: claude.env });
    expect(claude.calls().filter((call) => call.startsWith("mcp add"))).toHaveLength(1);
    expect(readLogins(configDir)).toHaveLength(1);
  });

  it("recreates a missing MCP entry and replaces a different one", async () => {
    const configDir = tempDir();
    const claude = fakeClaude();
    await setupServer({ configDir, serverUrl: server.url, token, env: claude.env });
    writeFileSync(claude.state, "other\nmcp\n");
    await setupServer({ configDir, serverUrl: server.url, token, env: claude.env });
    expect(claude.calls()).toContain("mcp remove --scope user redline");
    expect(readFileSync(claude.state, "utf8")).toBe("redline\nmcp\n");
  });

  it("keeps several servers side by side", async () => {
    const other = await startTestServer();
    try {
      const otherToken = ((await (await other.get("/api/agent-token")).json()) as { token: string }).token;
      const configDir = tempDir();
      const claude = fakeClaude();
      await setupServer({ configDir, serverUrl: server.url, token, env: claude.env });
      await setupServer({ configDir, serverUrl: other.url, token: otherToken, env: claude.env });
      expect(readLogins(configDir).map((login) => login.serverUrl).sort()).toEqual([server.url, other.url].sort());
      expect(claude.calls().filter((call) => call.startsWith("mcp add"))).toHaveLength(1);
    } finally {
      await other.stop();
    }
  });

  it("tells the user when Claude Code is not installed", async () => {
    await expect(setupServer({ configDir: tempDir(), serverUrl: server.url, token, env: { PATH: tempDir() } })).rejects.toThrow(/Claude Code is not installed/);
  });
});

describe("authenticated calls never follow a redirect", () => {
  let redirector: Server;
  let target: Server;
  let targetHit = false;
  let url: string;
  beforeEach(async () => {
    targetHit = false;
    target = createServer((_req, res) => {
      targetHit = true;
      res.end("[]");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` }).end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;
  });
  afterEach(() => {
    redirector.close();
    target.close();
  });

  it("the agent API client refuses to follow it", async () => {
    await expect(new ServerApi(url, "abt_x").listProjects()).rejects.toThrow();
    expect(targetHit).toBe(false);
  });

  it("setup fails and stores nothing", async () => {
    const configDir = tempDir();
    await expect(setupServer({ configDir, serverUrl: url, token: "abt_x", env: fakeClaude().env })).rejects.toThrow();
    expect(targetHit).toBe(false);
    expect(readLogins(configDir)).toEqual([]);
  });
});
