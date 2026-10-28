import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo, AgentTokenResponse, Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startAgentHost, HostAlreadyRunningError, type AgentHost } from "../src/agent-host.js";
import { createNewAgentFlow, type NewAgentFlow } from "../src/new-agent.js";
import { runAgentsScreen, type ScreenTerminal } from "../src/agents-screen.js";
import { plainText } from "../src/agents-view.js";
import { ensureHost, HostClient } from "../src/host-client.js";
import { agentLogPath, hostLockPath, hostSocketPath, type HostEvent, type HostLogEntry, type LaunchSettings } from "../src/host-protocol.js";
import { chooseModelEffort } from "../src/launch-choice.js";
import { saveLogin } from "../src/login.js";
import { hostWorkerCommand, tsxCommand } from "./support/host-launch.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

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
  const comment = async (body = "Change the title") => {
    const page = (await (await s.post(`/api/projects/${project.id}/pages`, { title: "Home", files: PAGE_FILES })).json()) as Page;
    await s.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 20, yPct: 30, body });
    return page;
  };
  const startHost = async (env: NodeJS.ProcessEnv = {}, idleExitMs = 60_000, logCap?: number) => {
    const host = await startAgentHost({ configDir, worker: hostWorkerCommand(env), idleExitMs, logCap });
    hosts.push(host);
    return host;
  };
  const client = async () => {
    const connected = await HostClient.connect(configDir);
    clients.push(connected);
    return connected;
  };
  return { server: s, configDir, onServer, launchSettings, startHost, client, comment };
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
    // The host learns of the connection from the worker, a moment after the server does.
    await until(async () => (await api.list())[0]?.state === "idle");

    expect(await api.list()).toEqual([expect.objectContaining({ id: agent.id, folder: settings.folder, kind: "project", serverUrl: settings.serverUrl, projectIds: settings.projectIds, model: "opus", effort: "high", claudeConfigDir: settings.claudeConfigDir, account: "me@example.com", state: "idle" })]);

    await api.stop(agent.id);
    await until(async () => (await onServer())[0]?.status === "offline");
    expect((await api.list())[0]).toMatchObject({ id: agent.id, state: "stopped" });
  });

  describe("changing the model and effort", () => {
    const runsOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

    it("makes the next run use the new model and effort, without restarting the worker or taking the agent offline", async () => {
      const { configDir, onServer, launchSettings, startHost, client, comment } = await setup();
      const runs = join(configDir, "runs.log");
      const starts = join(configDir, "starts.log");
      await startHost({ REDLINE_TEST_RUNS: runs, REDLINE_TEST_REPORT: starts });
      const api = await client();
      const { agent } = await api.launch(launchSettings());
      await until(async () => (await onServer())[0]?.status === "online");
      await comment();
      await until(() => runsOf(runs).length === 1);
      await until(async () => (await api.list())[0].state === "idle");

      const changed = await api.setModelEffort(agent.id, { model: "sonnet", effort: "low" });

      expect(changed).toMatchObject({ model: "sonnet", effort: "low" });
      expect(await api.list()).toEqual([expect.objectContaining({ model: "sonnet", effort: "low", state: "idle" })]);
      expect((await onServer())[0].status).toBe("online");
      await comment("Another change");
      await until(() => runsOf(runs).length === 2);
      expect(runsOf(runs)).toEqual([{ model: "opus", effort: "high" }, { model: "sonnet", effort: "low" }]);
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
      expect((await onServer())[0].status).toBe("online");
    });

    it("lets a run in progress finish with the old model and effort", async () => {
      const { configDir, onServer, launchSettings, startHost, client, comment } = await setup();
      const hold = join(configDir, "hold");
      const runs = join(configDir, "runs.log");
      writeFileSync(hold, "");
      await startHost({ REDLINE_TEST_HOLD_RUN: hold, REDLINE_TEST_RUNS: runs });
      const api = await client();
      const { agent } = await api.launch(launchSettings());
      await until(async () => (await onServer())[0]?.status === "online");
      await comment();
      await until(async () => (await api.list())[0].state === "running");

      await api.setModelEffort(agent.id, { model: "haiku" });
      rmSync(hold);

      await until(async () => (await api.list())[0].state === "idle");
      expect(runsOf(runs)).toEqual([{ model: "opus", effort: "high" }]);
      expect((await api.list())[0]).toMatchObject({ model: "haiku" });
      expect((await api.list())[0].effort).toBeUndefined();
      await comment("Next");
      await until(() => runsOf(runs).length === 2);
      expect(runsOf(runs)[1].model).toBe("haiku");
      expect(runsOf(runs)[1].effort).toBeUndefined();
    });

    it("updates the folder's last launch choice, which the next launch in that folder proposes", async () => {
      const { configDir, launchSettings, startHost, client } = await setup();
      await startHost();
      const api = await client();
      const settings = launchSettings();
      const { agent } = await api.launch(settings);
      await until(async () => (await api.list())[0].state === "idle");

      await api.setModelEffort(agent.id, { model: "haiku", effort: "max" });

      const proposed = await chooseModelEffort({ folder: settings.folder, configDir, claudeSettingsFile: join(configDir, "no-settings.json"), flags: {}, ask: async () => "" });
      expect(proposed).toEqual({ model: "haiku", effort: "max" });
    });

    it("keeps the new choice for a stopped agent, its restart and a restarted host", async () => {
      const { configDir, launchSettings, startHost, client } = await setup();
      const report = join(configDir, "starts.log");
      const host = await startHost({ REDLINE_TEST_REPORT: report });
      const api = await client();
      const { agent } = await api.launch(launchSettings());
      await until(async () => (await api.list())[0].state === "idle");
      await api.stop(agent.id);

      await api.setModelEffort(agent.id, { model: "sonnet", effort: "xhigh" });
      await api.restart(agent.id);
      await until(async () => (await api.list())[0].state === "idle");
      await api.stop(agent.id);
      await host.stop();
      await startHost();
      const after = await client();

      const starts = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(starts.at(-1)).toMatchObject({ model: "sonnet", effort: "xhigh" });
      expect(await after.list()).toEqual([expect.objectContaining({ model: "sonnet", effort: "xhigh" })]);
    });

    it("tells subscribers the agent changed, and refuses an unknown agent", async () => {
      const { launchSettings, startHost, client } = await setup();
      await startHost();
      const api = await client();
      const events: HostEvent[] = [];
      await api.subscribe((event) => events.push(event));
      const { agent } = await api.launch(launchSettings());
      await until(async () => (await api.list())[0].state === "idle");

      await api.setModelEffort(agent.id, { model: "sonnet", effort: "low" });

      await until(() => events.some((event) => event.event === "agent-changed" && event.agent.model === "sonnet" && event.agent.effort === "low"));
      await expect(api.setModelEffort("nope", { model: "opus" })).rejects.toThrow("No such agent.");
    });
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
    await until(async () => (await api.list())[0].state === "idle");
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

    expect(again).toMatchObject({ started: true, agent: { id: agent.id, model: "sonnet" } });
    expect(await api.list()).toHaveLength(1);
    await until(async () => (await onServer())[0]?.status === "online");
  });

  it("restarts a stopped agent with its folder, model, effort and Claude config directory, and does not touch a running one", async () => {
    const { onServer, launchSettings, startHost, client, configDir } = await setup();
    const report = join(configDir, "starts.log");
    await startHost({ REDLINE_TEST_REPORT: report });
    const api = await client();
    const settings = launchSettings();
    const { agent } = await api.launch(settings);
    await until(async () => (await onServer())[0]?.status === "online");
    expect((await api.restart(agent.id)).started).toBe(false);
    await api.stop(agent.id);
    await until(async () => (await onServer())[0]?.status === "offline");

    const restarted = await api.restart(agent.id);

    expect(restarted).toMatchObject({ started: true, agent: { id: agent.id } });
    await until(async () => (await onServer())[0]?.status === "online");
    const starts = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual({ claudeConfigDir: settings.claudeConfigDir, model: "opus", effort: "high", folder: settings.folder });
    await until(async () => (await api.list())[0].state === "idle");
  });

  it("restarts every stopped agent, and only those", async () => {
    const { launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const project = await api.launch(launchSettings());
    const global = await api.launch({ ...launchSettings(), kind: "global", projectIds: undefined });
    await until(async () => (await api.list()).every((agent) => agent.state === "idle"));
    await api.stop(project.agent.id);

    expect((await api.restartAll()).map((agent) => agent.id)).toEqual([project.agent.id]);
    await until(async () => (await api.list()).every((agent) => agent.state === "idle"));

    await api.stop(project.agent.id);
    await api.stop(global.agent.id);
    expect((await api.restartAll()).map((agent) => agent.id).sort()).toEqual([project.agent.id, global.agent.id].sort());
    await until(async () => (await api.list()).every((agent) => agent.state === "idle"));
    expect(await api.list()).toHaveLength(2);
  });

  it("removes an agent from the list and deletes its log file", async () => {
    const { launchSettings, startHost, client, configDir } = await setup();
    await startHost();
    const watcher = await client();
    const events: HostEvent[] = [];
    await watcher.subscribe((event) => events.push(event));
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await api.log(agent.id)).length > 0);
    await api.stop(agent.id);
    expect(existsSync(agentLogPath(configDir, agent.id))).toBe(true);

    await api.remove(agent.id);

    expect(await api.list()).toEqual([]);
    expect(existsSync(agentLogPath(configDir, agent.id))).toBe(false);
    await expect(api.log(agent.id)).rejects.toThrow(/No such agent/);
    await until(() => events.some((event) => event.event === "agent-removed" && event.agentId === agent.id));
  });

  it("stops a running agent when it is removed", async () => {
    const { onServer, launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await onServer())[0]?.status === "online");

    await api.remove(agent.id);

    expect(await api.list()).toEqual([]);
    await until(async () => (await onServer())[0]?.status === "offline");
  });

  it("stops during a run: the server sees the run failed and the agent offline, and the agent is stopped", async () => {
    const { configDir, server, onServer, launchSettings, startHost, client, comment } = await setup();
    const hold = join(configDir, "hold");
    writeFileSync(hold, "");
    await startHost({ REDLINE_TEST_HOLD_RUN: hold });
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await api.list())[0].state === "idle");
    const page = await comment();
    await until(async () => (await api.list())[0].state === "running");

    await api.stop(agent.id);

    expect((await api.list())[0]).toMatchObject({ id: agent.id, state: "stopped" });
    expect((await api.list())[0].page).toBeUndefined();
    await until(async () => (await onServer())[0]?.status === "offline");
    await until(async () => ((await (await server.get(`/api/pages/${page.id}/queue`)).json()) as { reason?: string }[]).some((entry) => entry.reason === "agent-offline"));
    rmSync(hold);
  });

  it("tells clients a fresh start only when the previous host died without stopping its agents", async () => {
    const { configDir, onServer, launchSettings, startHost, client } = await setup();
    const host = await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await onServer())[0]?.status === "online");
    expect((await api.snapshot()).freshStartAt).toBeUndefined();
    await host.stop();
    hosts = [];
    api.close();
    clients = [];

    await startHost();
    expect((await (await client()).snapshot()).freshStartAt).toBeUndefined();
    await (await client()).launch(launchSettings());
    expect((await (await client()).snapshot()).freshStartAt).toBeUndefined();

    // A host that died (Mac restarted, session closed) left its agents recorded as running.
    const registryFile = join(configDir, "agents.json");
    const stored = JSON.parse(readFileSync(registryFile, "utf8")) as { id: string; state: string }[];
    expect(stored.some((entry) => entry.id === agent.id)).toBe(true);
    for (const c of clients) c.close();
    clients = [];
    await hosts[0].stop();
    hosts = [];
    writeFileSync(registryFile, JSON.stringify(stored.map((entry) => ({ ...entry, state: "idle" }))));
    await startHost();
    const again = await client();

    const snapshot = await again.snapshot();
    expect(Date.parse(snapshot.freshStartAt!)).toBeLessThanOrEqual(Date.now());
    expect(snapshot.agents.every((a) => a.state === "stopped")).toBe(true);
    expect((await again.log(agent.id)).at(-1)?.event).toEqual({ type: "stopped", reason: "host-restarted" });

    await again.restartAll();
    expect((await again.snapshot()).freshStartAt).toBeUndefined();
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

describe("the agent host's run log", { timeout: 20_000 }, () => {
  const types = (entries: HostLogEntry[]) => entries.map((entry) => entry.event.type);

  it("returns the run started, progress and published lines, in order, as structured entries", async () => {
    const { launchSettings, startHost, client, comment } = await setup();
    await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => types(await api.log(agent.id)).includes("connected"));

    await comment("Make the title bigger");

    await until(async () => types(await api.log(agent.id)).includes("run-published"));
    const entries = await api.log(agent.id);
    expect(types(entries)).toEqual(["connected", "run-started", "run-progress", "run-published"]);
    expect(entries[1]).toMatchObject({ event: { project: "Acme", page: "Home", kind: "comment", excerpt: "Make the title bigger" } });
    expect(entries[3]).toMatchObject({ event: { page: "Home", changed: ["home.html"] } });
    expect(Number.isNaN(Date.parse(entries[0].at))).toBe(false);
    expect(await api.log(agent.id, 2)).toEqual(entries.slice(-2));
  });

  it("streams each new line and the state changes to a subscriber, with the page of the run in progress", async () => {
    const { configDir, launchSettings, startHost, client, comment } = await setup();
    const hold = join(configDir, "hold");
    writeFileSync(hold, "");
    await startHost({ REDLINE_TEST_HOLD_RUN: hold });
    const watcher = await client();
    const events: HostEvent[] = [];
    await watcher.subscribe((event) => events.push(event));
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await api.list())[0].state === "idle");

    await comment();

    await until(async () => (await api.list())[0].state === "running");
    expect((await api.list())[0]).toMatchObject({ state: "running", page: "Home" });
    rmSync(hold);
    await until(async () => (await api.list())[0].state === "idle");
    expect((await api.list())[0].page).toBeUndefined();
    await until(() => events.some((event) => event.event === "log-line" && event.entry.event.type === "run-published"));
    const lines = events.flatMap((event) => (event.event === "log-line" ? [event] : []));
    expect(lines.every((line) => line.agentId === agent.id)).toBe(true);
    expect(types(lines.map((line) => line.entry))).toEqual(types(await api.log(agent.id)));
    const states = events.flatMap((event) => (event.event === "agent-changed" ? [event.agent.state] : []));
    expect(states).toEqual(expect.arrayContaining(["idle", "running"]));
    expect(states.lastIndexOf("running")).toBeLessThan(states.lastIndexOf("idle"));
  });

  it("follows the connection: reconnecting while the server is away, idle when it is back", async () => {
    const { server, launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => (await api.list())[0].state === "idle");

    await server.restart({ downForMs: 1500 });

    await until(async () => (await api.list())[0].state === "reconnecting");
    await until(async () => (await api.list())[0].state === "idle");
    expect(types(await api.log(agent.id))).toEqual(["connected", "connection-lost", "reconnected"]);
  });

  it("survives the client disconnecting and a host restart, and is capped", async () => {
    const { launchSettings, startHost, client, comment } = await setup();
    const host = await startHost({}, 60_000, 4);
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => types(await api.log(agent.id)).includes("connected"));
    await comment();
    await until(async () => types(await api.log(agent.id)).includes("run-published"));
    api.close();
    clients = [];
    const before = await (await client()).log(agent.id);
    expect(before.length).toBeLessThanOrEqual(4);
    expect(types(before)).toContain("run-published");

    await host.stop();
    hosts = [];
    await startHost({}, 60_000, 4);
    const again = await client();

    const after = await again.log(agent.id);
    expect(types(after)).toEqual(["run-started", "run-progress", "run-published", "stopped"]);
  });

  it("ends a refused agent's log with a stopped line carrying the reason", async () => {
    const { configDir, launchSettings, startHost, client } = await setup();
    saveLogin({ configDir, serverUrl: launchSettings().serverUrl, token: "wrong-token" });
    await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());

    await until(async () => (await api.list())[0].state === "stopped");

    const entries = await api.log(agent.id);
    expect(types(entries)).toEqual(["refused", "stopped"]);
    expect(entries[1].event).toMatchObject({ type: "stopped", reason: "failed", error: expect.stringMatching(/token/i) });
    expect((await api.list())[0].reason).toBe((entries[1].event as { error: string }).error);
  });

  it.each([
    ["exits with an error", "exit", /code 3/],
    ["is killed by a signal", "signal", /SIGKILL/],
  ])("ends the log with a stopped line carrying the error when the worker %s", async (_name, crash, message) => {
    const { launchSettings, startHost, client } = await setup();
    await startHost({ REDLINE_TEST_CRASH: crash });
    const api = await client();
    const { agent } = await api.launch(launchSettings());

    await until(async () => (await api.list())[0].state === "stopped");

    const last = (await api.log(agent.id)).at(-1)!;
    expect(last.event).toMatchObject({ type: "stopped", reason: "failed", error: expect.stringMatching(message) });
    expect((await api.list())[0].reason).toMatch(message);
  });

  it("ends the log with a plain stopped line when the agent is stopped on request", async () => {
    const { launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const { agent } = await api.launch(launchSettings());
    await until(async () => types(await api.log(agent.id)).includes("connected"));

    await api.stop(agent.id);

    expect((await api.log(agent.id)).at(-1)?.event).toEqual({ type: "stopped", reason: "stopped" });
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
    await until(async () => (await later.list())[0]?.state === "idle");
    expect((await later.list())[0]).toMatchObject({ id: agent.id, state: "idle" });
    await later.stop(agent.id);
    later.close();
    await until(async () => HostClient.connect(configDir).then((c) => (c.close(), false), () => true));
  });

  it("records the project names, the machine and when the worker started, for the agents screen", async () => {
    const { launchSettings, startHost, client } = await setup();
    await startHost();
    const api = await client();
    const before = Date.now();

    const { agent } = await api.launch({ ...launchSettings(), projectNames: ["Acme"] });

    const [listed] = await api.list();
    expect(listed).toMatchObject({ id: agent.id, projectNames: ["Acme"], machine: expect.not.stringContaining(".") });
    expect(Date.parse(listed.startedAt!)).toBeGreaterThanOrEqual(before);
  });

  it("shows the same agents and the same live log on two agents screens", async () => {
    const { launchSettings, startHost, client, comment, onServer } = await setup();
    await startHost();
    const api = await client();
    const { agent } = await api.launch({ ...launchSettings(), projectNames: ["Acme"] });
    await until(async () => (await onServer())[0]?.status === "online");

    const screens = [0, 1].map(async () => {
      const terminal = new RecordingTerminal();
      const host = await client();
      const done = runAgentsScreen({ host, terminal, selectedId: agent.id, home: "/nowhere", folder: "/nowhere", newAgent: noNewAgent, openUrl: () => undefined });
      return { terminal, done };
    });
    const [first, second] = await Promise.all(screens);
    await comment();

    for (const { terminal } of [first, second]) {
      await until(() => terminal.frame.includes("Published"));
      expect(terminal.frame).toMatch(/Run started {2}Acme \/ Home/);
      expect(terminal.frame).toContain("Projects  Acme");
    }
    first.terminal.keyListener("q");
    second.terminal.keyListener("ctrl-c");
    await Promise.all([first.done, second.done]);
    expect([first.terminal.closed, second.terminal.closed]).toEqual([true, true]);
  });
});

describe("starting an agent from the agents screen", { timeout: 20_000 }, () => {
  it("creates the project from the dialog, links the folder, and brings the agent online serving it", async () => {
    const { server: s, configDir, onServer, startHost, client } = await setup();
    await startHost();
    const host = await client();
    const folder = tempDir("rl-folder-");
    const flow = createNewAgentFlow({ folder, configDir, claudeSettingsFile: join(configDir, "settings.json"), host, checkClaude: async () => "me@example.com" });
    const terminal = new RecordingTerminal();
    const done = runAgentsScreen({ host, terminal, home: "/nowhere", folder, newAgent: flow, openUrl: () => undefined });
    await until(() => terminal.frame.includes("No agent yet"));

    terminal.keyListener("n");
    await until(() => terminal.frame.includes("Create a new project:"));
    expect(terminal.frame).toContain("Acme");
    terminal.keyListener("down");
    for (const char of "CV Vincent") terminal.keyListener(char);
    terminal.keyListener("enter");

    await until(async () => (await onServer())[0]?.status === "online");
    const created = ((await (await s.get("/api/projects")).json()) as Project[]).find((p) => p.title === "CV Vincent")!;
    expect(created).toBeDefined();
    expect(JSON.parse(readFileSync(join(folder, ".redline", "project.json"), "utf8"))).toEqual({ serverUrl: s.url, projectIds: [created.id] });
    expect(created.servedBy).toMatchObject({ folder, kind: "project" });
    await until(() => terminal.frame.includes("Projects  CV Vincent") && terminal.frame.includes("Account   me@example.com"));
    expect(terminal.frame).toContain("› ● ");
    terminal.keyListener("q");
    await done;
  });
});

const noNewAgent: NewAgentFlow = {
  inspect: async () => {
    throw new Error("not used");
  },
  projectsOf: async () => [],
  start: async () => {
    throw new Error("not used");
  },
};

class RecordingTerminal implements ScreenTerminal {
  lines: string[] = [];
  keyListener: (key: string) => void = () => undefined;
  closed = false;
  size() { return { columns: 184, rows: 43 }; }
  draw(lines: string[]) { this.lines = lines; }
  onKey(listener: (key: string) => void) { this.keyListener = listener; }
  onResize() {}
  close() { this.closed = true; }
  get frame() { return plainText(this.lines).join("\n"); }
}
