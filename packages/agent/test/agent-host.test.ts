import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo, AgentTokenResponse, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startAgentHost, HostAlreadyRunningError, type AgentHost } from "../src/agent-host.js";
import { ensureHost, HostClient } from "../src/host-client.js";
import { hostLockPath, hostSocketPath, type HostEvent, type LaunchSettings } from "../src/host-protocol.js";
import { saveLogin } from "../src/login.js";
import { hostWorkerCommand, tsxCommand } from "./support/host-launch.js";

let dirs: string[] = [];
let server: TestServer | undefined;
let hosts: AgentHost[] = [];
let clients: HostClient[] = [];
afterEach(async () => {
  for (const client of clients) client.close();
  for (const host of hosts) await host.stop();
  await server?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  hosts = [];
  clients = [];
  server = undefined;
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await condition()).toBe(true);
}

async function setup() {
  const s = (server = await startTestServer());
  const project = (await (await s.post("/api/projects", { title: "Acme" })).json()) as Project;
  const { token } = (await (await s.get("/api/agent-token")).json()) as AgentTokenResponse;
  const configDir = tempDir("rl-host-");
  saveLogin({ configDir, serverUrl: s.url, token });
  const onServer = async () => (await (await s.get("/api/agents")).json()) as AgentInfo[];
  const launchSettings = (folder = tempDir("rl-folder-")): LaunchSettings => ({
    folder,
    kind: "project",
    serverUrl: s.url,
    projectIds: [project.id],
    model: "opus",
    effort: "high",
    claudeConfigDir: join(configDir, "claude-a"),
    account: "me@example.com",
  });
  const startHost = async (env: NodeJS.ProcessEnv = {}, idleExitMs = 60_000) => {
    const host = await startAgentHost({ configDir, worker: hostWorkerCommand(env), idleExitMs });
    hosts.push(host);
    return host;
  };
  const client = async () => {
    const connected = await HostClient.connect(configDir);
    clients.push(connected);
    return connected;
  };
  return { configDir, onServer, launchSettings, startHost, client };
}

describe("the agent host's control API", { timeout: 20_000 }, () => {
  it("launches an agent that is online on the server, lists it with its settings, and stops it", async () => {
    const { onServer, launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const settings = launchSettings();

    const { agent, started } = await api.launch(settings);
    expect(started).toBe(true);
    await until(async () => (await onServer())[0]?.status === "online");

    expect(await api.list()).toEqual([expect.objectContaining({ id: agent.id, folder: settings.folder, kind: "project", serverUrl: settings.serverUrl, projectIds: settings.projectIds, model: "opus", effort: "high", claudeConfigDir: settings.claudeConfigDir, account: "me@example.com", state: "running" })]);

    await api.stop(agent.id);
    await until(async () => (await onServer())[0]?.status === "offline");
    expect((await api.list())[0]).toMatchObject({ id: agent.id, state: "stopped" });
  });

  it("returns the existing agent when the same folder and server are launched twice, without a second worker", async () => {
    const { onServer, launchSettings, startHost, client, configDir } = await setup();
    const report = join(configDir, "starts.log");
    await startHost({ REDLINE_TEST_REPORT: report });
    const api = await client();
    const settings = launchSettings();

    const first = await api.launch(settings);
    const second = await api.launch(settings);

    expect(second.started).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);
    await until(async () => (await onServer())[0]?.status === "online");
    expect(await api.list()).toHaveLength(1);
    expect(await onServer()).toHaveLength(1);
    expect(readFileSync(report, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("relaunches a worker that exits with the update code, with the same settings", async () => {
    const { onServer, launchSettings, startHost, client, configDir } = await setup();
    const report = join(configDir, "starts.log");
    await startHost({ REDLINE_TEST_REPORT: report, REDLINE_TEST_UPDATE_ONCE: join(configDir, "updated") });
    const api = await client();
    const settings = launchSettings();

    await api.launch(settings);

    await until(async () => (await onServer())[0]?.status === "online");
    const starts = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(starts).toEqual([
      { claudeConfigDir: settings.claudeConfigDir, model: "opus", effort: "high", folder: settings.folder },
      { claudeConfigDir: settings.claudeConfigDir, model: "opus", effort: "high", folder: settings.folder },
    ]);
    expect((await api.list())[0].state).toBe("running");
  });

  it("runs the worker with the Claude config directory of the launching terminal and keeps the account", async () => {
    const { launchSettings, startHost, client, configDir } = await setup();
    const report = join(configDir, "starts.log");
    await startHost({ REDLINE_TEST_REPORT: report });
    const api = await client();
    const settings = launchSettings();

    await api.launch(settings);

    await until(() => existsSync(report));
    expect(JSON.parse(readFileSync(report, "utf8")).claudeConfigDir).toBe(settings.claudeConfigDir);
    expect((await api.list())[0].account).toBe("me@example.com");
  });

  it("lists every agent as stopped when the host restarts, and starts nothing by itself", async () => {
    const { onServer, launchSettings, startHost, client } = await setup();
    const host = await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await onServer())[0]?.status === "online");

    await host.stop();
    hosts = [];
    api.close();
    clients = [];
    await startHost();
    const again = await client();

    expect(await again.list()).toEqual([expect.objectContaining({ id: agent.id, state: "stopped" })]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await onServer())[0].status).toBe("offline");
  });

  it("launches a stopped agent again instead of adding a second one", async () => {
    const { onServer, launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const settings = launchSettings();
    const { agent } = await api.launch(settings);
    await api.stop(agent.id);

    const again = await api.launch({ ...settings, model: "sonnet" });

    expect(again).toMatchObject({ started: true, agent: { id: agent.id, model: "sonnet", state: "running" } });
    expect(await api.list()).toHaveLength(1);
    await until(async () => (await onServer())[0]?.status === "online");
  });

  it("streams agent added and state changes to a subscriber", async () => {
    const { launchSettings, startHost, client } = await setup();
    await startHost();
    const watcher = await client();
    const events: HostEvent[] = [];
    await watcher.subscribe((event) => events.push(event));
    const api = await client();

    const { agent } = await api.launch(launchSettings());
    await api.stop(agent.id);

    await until(() => events.some((event) => event.event === "agent-changed" && event.agent.state === "stopped"));
    expect(events[0]).toMatchObject({ event: "agent-added", agent: { id: agent.id } });
    expect(events.map((event) => event.event)).toContain("agent-changed");
  });

  it("refuses to launch for a server that has no login, and to attach to an unknown agent", async () => {
    const { launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();

    await expect(api.launch({ ...launchSettings(), serverUrl: "http://127.0.0.1:1" })).rejects.toThrow(/not set up/);
    await expect(api.attach("nope")).rejects.toThrow(/No such agent/);
  });

  it("shows an agent the server refuses as stopped with the reason", async () => {
    const { configDir, launchSettings, startHost, client } = await setup();
    saveLogin({ configDir, serverUrl: launchSettings().serverUrl, token: "wrong-token" });
    await startHost();
    const api = await client();

    const { agent } = await api.launch(launchSettings());

    await until(async () => (await api.list())[0].state === "stopped");
    expect((await api.list())[0]).toMatchObject({ id: agent.id, state: "stopped" });
    expect((await api.list())[0].reason).toBeTruthy();
  });
});

describe("the agent host's process", { timeout: 20_000 }, () => {
  it("keeps one host per config directory", async () => {
    const { startHost, configDir } = await setup();
    await startHost();
    await expect(startAgentHost({ configDir, worker: hostWorkerCommand() })).rejects.toBeInstanceOf(HostAlreadyRunningError);
  });

  it("takes over the lock of a host that died", async () => {
    const { startHost, configDir } = await setup();
    writeFileSync(hostLockPath(configDir), "999999");
    await startHost();
    expect(await (await HostClient.connect(configDir)).list()).toEqual([]);
  });

  it("serves a socket other users cannot use", async () => {
    const { startHost, configDir } = await setup();
    await startHost();
    expect(statSync(hostSocketPath(configDir)).mode & 0o077).toBe(0);
    expect(statSync(configDir).mode & 0o077).toBe(0);
  });

  it("exits once no agent runs and no client is attached", async () => {
    const { startHost, launchSettings, client } = await setup();
    const host = await startHost({}, 100);
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await api.stop(agent.id);
    api.close();
    clients = [];

    await host.closed;
    hosts = [];
  });

  it("stays alive while an agent runs and nobody is attached, and keeps the agent online when the terminal closes", async () => {
    const { configDir, onServer, launchSettings } = await setup();
    // A host in its own detached process, started on demand like `redline agent` does.
    const terminal = await ensureHost({ configDir, hostCommand: tsxCommand("./agent-host-process.ts", { REDLINE_CONFIG_DIR: configDir }) });
    clients.push(terminal);
    const { agent } = await terminal.launch(launchSettings());
    await until(async () => (await onServer())[0]?.status === "online");

    terminal.close();
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect((await onServer())[0].status).toBe("online");
    const later = await HostClient.connect(configDir);
    clients.push(later);
    expect((await later.list())[0]).toMatchObject({ id: agent.id, state: "running" });
    await later.stop(agent.id);
    later.close();
    await until(async () => HostClient.connect(configDir).then((c) => (c.close(), false), () => true));
  });
});
