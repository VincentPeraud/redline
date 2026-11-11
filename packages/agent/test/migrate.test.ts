import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostAgent } from "../src/host-protocol.js";
import { listInstallations, resolveFolder } from "../src/installations.js";
import { launchMcp } from "../src/mcp-launcher.js";
import { legacyRefusal, migrateLegacy, MIGRATE_STOP_REASON, type MigrateHost } from "../src/migrate.js";
import { readLogins, saveLogin } from "../src/login.js";
import { fakeWorld, tempDir } from "./support/installations.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const LOCAL = "https://redline.localhost";
const LUMORA = "https://redline.lumora.com";
const STAGING = "https://redline.lumora-staging.fr";

const agent = (name: string, serverUrl: string, extra: Partial<HostAgent> = {}): HostAgent => ({
  id: `${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}-0000-4000-8000-000000000000`,
  name,
  folder: `/work/${name}`,
  kind: "project",
  serverUrl,
  claudeConfigDir: "/c",
  state: "idle",
  since: "2026-11-11T10:00:00Z",
  ...extra,
});

function fakeHost(agents: HostAgent[], pollsBeforeRunsEnd = 0) {
  let polls = 0;
  const stopped: { id: string; reason: string }[] = [];
  const host: MigrateHost = {
    async agents() {
      polls += 1;
      return agents.map((a) => (a.state === "running" && polls > pollsBeforeRunsEnd ? { ...a, state: "idle" as const, run: undefined } : a));
    },
    async stop(id, reason) {
      stopped.push({ id, reason });
    },
    async untilGone() {},
  };
  return { host, stopped };
}

function legacy(servers: [string, string][], agents: HostAgent[] = []) {
  const configDir = tempDir();
  for (const [serverUrl, token] of servers) saveLogin({ configDir, serverUrl, token });
  if (agents.length) writeFileSync(join(configDir, "agents.json"), JSON.stringify(agents));
  return configDir;
}

async function migrate(configDir: string, world = fakeWorld(), options: { host?: MigrateHost; now?: boolean; names?: Record<string, string> } = {}) {
  const out: string[] = [];
  const result = await migrateLegacy({ configDir, deps: world.deps, host: options.host, now: options.now, names: options.names, out: (line) => out.push(line), sleep: async () => {}, home: "/h" });
  return { out, result };
}

describe("redline migrate", () => {
  it("creates one installation per server, moves each token, and reports in the mock-up's words", async () => {
    const world = fakeWorld();
    world.servers.set(LOCAL, { version: "0.2.0" });
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const agents = [agent("a", LOCAL), agent("b", LOCAL), agent("c", LUMORA)];
    const configDir = legacy([[LOCAL, "t_local"], [LUMORA, "t_lumora"]], agents);
    const { host, stopped } = fakeHost(agents);
    const { out } = await migrate(configDir, world, { host });

    expect(listInstallations(configDir).map(({ id, name, serverUrl, token }) => ({ id, name, serverUrl, token }))).toEqual([
      { id: "local", name: "Local", serverUrl: LOCAL, token: "t_local" },
      { id: "lumora", name: "Lumora", serverUrl: LUMORA, token: "t_lumora" },
    ]);
    expect(existsSync(join(configDir, "login.json"))).toBe(false);
    expect(stopped.map((s) => s.reason)).toEqual([MIGRATE_STOP_REASON, MIGRATE_STOP_REASON, MIGRATE_STOP_REASON]);
    expect(out).toEqual([
      "Stopped the agent host (3 agents).",
      "✓ Local   redline.localhost    → /h/instances/local   token moved · 2 agents".replace("/h/", `${configDir}/`),
      "✓ Lumora  redline.lumora.com   → /h/instances/lumora   token moved · 1 agent".replace("/h/", `${configDir}/`),
      "✓ Claude Code: the redline MCP now starts the installation of each folder's instance.",
      "Migrated 2 instances. In open Claude Code sessions, type /mcp and reconnect redline; then redline and R restarts the agents.",
    ]);
  });

  it("waits for runs in progress and names them", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const agents = [agent("lumora-site", LUMORA, { state: "running", run: { page: "Accueil", pageId: "p" }, projectNames: ["Site public"] })];
    const configDir = legacy([[LUMORA, "t"]], agents);
    const { host, stopped } = fakeHost(agents, 2);
    const { out } = await migrate(configDir, world, { host });
    expect(out[0]).toBe("Waiting for 1 run to finish: lumora-site on Lumora · Site public › Accueil (--now stops it)…");
    expect(stopped).toHaveLength(1);
    expect(listInstallations(configDir)).toHaveLength(1);
  });

  it("stops runs at once with --now", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const agents = [agent("x", LUMORA, { state: "running", run: { page: "Accueil", pageId: "p" } })];
    const configDir = legacy([[LUMORA, "t"]], agents);
    const { host } = fakeHost(agents, 1_000_000);
    const { out } = await migrate(configDir, world, { host, now: true });
    expect(out.some((line) => line.startsWith("Waiting"))).toBe(false);
    expect(listInstallations(configDir)).toHaveLength(1);
  });

  it("counts the agents of a computer with no host running from the registry", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const configDir = legacy([[LUMORA, "t"]], [agent("x", LUMORA, { state: "stopped" })]);
    const { out } = await migrate(configDir, world);
    expect(out[0]).toMatch(/^✓ Lumora {2}redline\.lumora\.com {3}→ .*token moved · 1 agent$/);
    expect(out.at(-1)).toBe("Migrated 1 instance. In open Claude Code sessions, type /mcp and reconnect redline.");
  });

  it("is idempotent: a second run says nothing is left", async () => {
    const world = fakeWorld();
    world.servers.set(LOCAL, { version: "0.2.0" });
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const configDir = legacy([[LOCAL, "a"], [LUMORA, "b"]]);
    await migrate(configDir, world);
    const installs = world.installs.length;
    const { out } = await migrate(configDir, world);
    expect(out).toEqual(["Nothing to migrate: 2 instances are already installed (Local, Lumora)."]);
    expect(world.installs).toHaveLength(installs);
  });

  it("leaves a server whose name is taken in the old login, and moves it with --name", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.servers.set(STAGING, { instanceName: "Lumora", version: "0.2.0" });
    const configDir = legacy([[LUMORA, "t1"], [STAGING, "t2"]]);
    const first = await migrate(configDir, world);
    expect(first.out.at(-5)).toMatch(/^✓ Lumora {2}redline\.lumora\.com {10}→ /);
    expect(first.out.at(-4)).toBe('✗ Lumora  redline.lumora-staging.fr: the name "lumora" is already taken by redline.lumora.com.');
    expect(first.out.at(-1)).toBe("Migrated 1 of 2 instances. Other commands still refuse until every server is migrated.");
    expect(first.out.at(-3)).toBe(`          Left in the old login. Run redline migrate --name ${STAGING}=<name>.`);
    expect(readLogins(configDir)).toEqual([{ serverUrl: STAGING, token: "t2" }]);

    const second = await migrate(configDir, world, { names: { [STAGING]: "lumora-staging" } });
    expect(second.out.at(-1)).toBe("Migrated 1 instance. In open Claude Code sessions, type /mcp and reconnect redline.");
    expect(listInstallations(configDir).map((i) => i.id)).toEqual(["lumora", "lumora-staging"]);
    expect(existsSync(join(configDir, "login.json"))).toBe(false);
  });

  it("leaves a server whose build cannot be installed in the old login, nothing saved for it", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.failInstall = "answered 502";
    const configDir = legacy([[LUMORA, "t1"]]);
    const { out } = await migrate(configDir, world);
    expect(out.join("\n")).toContain("✗ Lumora");
    expect(out.at(-1)).toBe("Migrated 0 of 1 instances. Other commands still refuse until every server is migrated.");
    expect(listInstallations(configDir)).toEqual([]);
    expect(readLogins(configDir)).toHaveLength(1);
  });

  it("keeps folders already linked working: their link holds the address", async () => {
    const world = fakeWorld();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const configDir = legacy([[LUMORA, "t1"]]);
    await migrate(configDir, world);
    const folder = tempDir("linked-");
    mkdirSync(join(folder, ".redline"));
    writeFileSync(join(folder, ".redline", "project.json"), JSON.stringify({ serverUrl: LUMORA, projectIds: ["p"] }));
    expect(resolveFolder(configDir, folder)).toMatchObject({ kind: "linked", installation: { id: "lumora" } });
  });
});

describe("before migrate", () => {
  it("refuses with the mock-up's two messages", () => {
    expect(legacyRefusal(false)).toBe("This computer still has the old Redline installation (one login for every server).\n  Run redline migrate first: it moves each server to its own installation.");
    expect(legacyRefusal(true)).toBe("This computer still has the old Redline installation (one login for every server).\n  Run redline migrate first.");
  });

  it("makes every MCP tool answer the migrate message", async () => {
    const configDir = legacy([[LUMORA, "t"]]);
    const server = await launchMcp({ configDir, folder: tempDir(), home: "/h", fetchInstance: async () => ({}), handOver: async () => undefined });
    expect(server).toBeDefined();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server!.connect(b);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(a);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_projects");
    for (const name of ["list_projects", "checkout_page"]) {
      const answer = (await client.callTool({ name, arguments: name === "checkout_page" ? { pageId: "p" } : {} })) as { content: { text: string }[] };
      expect(answer.content[0].text).toBe("Redline changed: this computer still has the old single installation. Tell the user to run redline migrate in a terminal, then /mcp and reconnect redline.");
    }
  });
});
