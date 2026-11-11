import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { listInstallations, setupInstallation, type SetupResult } from "../src/installations.js";
import { ServerApi } from "../src/server-api.js";
import { registerMcp, setupReport, systemDeps } from "../src/setup.js";
import { fakeClaude, tempDir } from "./support/installations.js";

describe("registering the redline MCP in Claude Code", () => {
  it("registers it at user scope, once", async () => {
    const claude = fakeClaude();
    expect(await registerMcp(claude.env)).toBe("registered");
    expect(await registerMcp(claude.env)).toBe("already");
    expect(claude.calls()).toContain("mcp add --scope user redline -- redline mcp");
    expect(claude.calls().filter((call) => call.startsWith("mcp add"))).toHaveLength(1);
  });

  it("replaces a different entry", async () => {
    const claude = fakeClaude();
    await registerMcp(claude.env);
    writeFileSync(claude.state, "other\nmcp\n");
    expect(await registerMcp(claude.env)).toBe("registered");
    expect(claude.calls()).toContain("mcp remove --scope user redline");
    expect(readFileSync(claude.state, "utf8")).toBe("redline\nmcp\n");
  });

  it("reports Claude Code missing", async () => {
    expect(await registerMcp({ PATH: tempDir() })).toBe("claude-missing");
  });
});

describe("redline setup against a real server", () => {
  const originalPath = process.env.PATH;
  let server: TestServer;
  let token: string;
  afterEach(() => {
    process.env.PATH = originalPath;
  });
  beforeEach(async () => {
    server = await startTestServer({ instanceName: "Acme" });
    token = ((await (await server.get("/api/agent-token")).json()) as { token: string }).token;
  });
  afterEach(() => server.stop());

  /** A fake `npm` that records its arguments and drops the installed build where npm would. */
  function fakeNpm() {
    const dir = tempDir("redline-npm-");
    writeFileSync(
      join(dir, "npm"),
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
mkdir -p "$prefix/lib/node_modules/redline-cli/dist"
echo '{"name":"redline-cli","version":"0.2.0"}' > "$prefix/lib/node_modules/redline-cli/package.json"
`,
    );
    chmodSync(join(dir, "npm"), 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    return { args: () => readFileSync(join(dir, "args"), "utf8").trim().split("\n") };
  }

  it("takes the name from the server, installs the served tarball under the installation's prefix", async () => {
    const cliDir = tempDir("redline-cli-dir-");
    writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
    writeFileSync(join(cliDir, "build-hash.txt"), "abc\n");
    const served = await startTestServer({ instanceName: "Acme", cliDir });
    try {
      const servedToken = ((await (await served.get("/api/agent-token")).json()) as { token: string }).token;
      const claude = fakeClaude();
      const npm = fakeNpm();
      const configDir = tempDir();
      const result = await setupInstallation({ configDir, serverUrl: served.url, token: servedToken, deps: systemDeps(configDir, claude.env) });
      expect(result.installation).toMatchObject({ id: "acme", name: "Acme", version: "0.2.0" });
      expect(npm.args().slice(0, 3)).toEqual(["i", "-g", expect.stringMatching(/redline-cli\.tgz$/)]);
      expect(npm.args()[3]).toBe("--prefix");
      expect(npm.args()[4]).toContain(join("instances", ".acme-"));
      expect(existsSync(join(configDir, "instances", "acme", "npm", "lib", "node_modules", "redline-cli", "package.json"))).toBe(true);
      expect(listInstallations(configDir)).toHaveLength(1);
    } finally {
      await served.stop();
    }
  });

  it("saves nothing when the server answers an error for the build", async () => {
    const configDir = tempDir();
    await expect(setupInstallation({ configDir, serverUrl: server.url, token, deps: systemDeps(configDir, fakeClaude().env) })).rejects.toThrow(
      new RegExp(`Could not install Acme's build: ${server.url}/cli/redline-cli.tgz answered 404\\.\\n  Nothing was saved`),
    );
    expect(listInstallations(configDir)).toEqual([]);
  });

  it("saves nothing with a wrong token", async () => {
    const configDir = tempDir();
    await expect(setupInstallation({ configDir, serverUrl: server.url, token: "abt_wrong", deps: systemDeps(configDir, fakeClaude().env) })).rejects.toThrow(/Cannot use .* with this token/);
    expect(existsSync(join(configDir, "instances"))).toBe(false);
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
    await expect(setupInstallation({ configDir, serverUrl: url, token: "abt_x", deps: systemDeps(configDir, fakeClaude().env) })).rejects.toThrow();
    expect(targetHit).toBe(false);
    expect(existsSync(join(configDir, "instances"))).toBe(false);
  });
});

describe("what redline setup prints", () => {
  const installation = { id: "lumora", name: "Lumora", nameChosen: false, serverUrl: "https://redline.lumora.com", token: "t", dir: "/home/jo/.config/redline/instances/lumora", prefix: "", entry: "", version: "0.2.0" };
  const result = (overrides: Partial<SetupResult>): SetupResult => ({ installation, created: true, mcp: "registered", tooOld: false, restarted: [], ...overrides });
  const options = { deps: { commandVersion: "0.3.0", oldestAccepted: "0.2.0" }, home: "/home/jo" };

  it("first instance (mock-up case 1)", () => {
    expect(setupReport(result({}), options)).toEqual([
      "✓ Lumora · redline.lumora.com · v0.2.0",
      "  Installed in ~/.config/redline/instances/lumora",
      "✓ Claude Code: registered the redline MCP for every session. In a folder linked to Lumora, it runs this installation.",
      "  Next: redline link in a project folder, or redline agent to start an agent there.",
    ]);
  });

  it("another instance, MCP already registered, too old (case 2)", () => {
    expect(setupReport(result({ mcp: "already", tooOld: true, installation: { ...installation, name: "Brightco", version: "0.1.0", serverUrl: "https://redline.brightco.fr", dir: "/home/jo/.config/redline/instances/brightco" } }), options)).toEqual([
      "✓ Brightco · redline.brightco.fr · v0.1.0",
      "  Installed in ~/.config/redline/instances/brightco",
      "  Claude Code: the redline MCP is already registered.",
      "! v0.1.0 is too old for this redline command (v0.3.0, accepts v0.2.0 and later):",
      "  its agents will be refused until Brightco's server is upgraded. Its MCP works.",
    ]);
  });

  it("token replaced and agents restarted (case 6)", () => {
    expect(setupReport(result({ created: false, mcp: "already", restarted: ["agora"] }), options)).toEqual([
      "✓ Lumora: token replaced (name and build kept).",
      "  Restarted 1 agent stopped by the old token: agora.",
    ]);
  });

  it("Claude Code missing (case 8)", () => {
    expect(setupReport(result({ mcp: "claude-missing" }), options).slice(2)).toEqual([
      "✗ Claude Code is not installed. Install it (https://docs.claude.com/claude-code), then run redline setup again.",
    ]);
  });
});
