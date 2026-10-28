import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliUpdateCommand, type AgentInfo, type AgentTokenResponse, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { serveAgent, type AgentService } from "../src/serve-agent.js";
import { UPDATE_EXIT_CODE, superviseAgent } from "../src/supervisor.js";
import { FakeEngine } from "./support/seam2.js";

let dirs: string[] = [];
let server: TestServer | undefined;
let service: AgentService | undefined;
afterEach(async () => {
  service?.stop();
  await service?.done.catch(() => undefined);
  await server?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  server = service = undefined;
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await condition()).toBe(true);
}

async function setup() {
  const cliDir = tempDir("redline-cli-");
  writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
  writeFileSync(join(cliDir, "build-hash.txt"), "server-build");
  const s = (server = await startTestServer({ cliDir }));
  const project = (await (await s.post("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (await s.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>" } })).json()) as Page;
  const { token } = (await (await s.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agents = async () => (await (await s.get("/api/agents")).json()) as AgentInfo[];
  const options = {
    serverUrl: s.url,
    token,
    machine: "test-machine",
    folder: tempDir("redline-agent-folder-"),
    kind: "project" as const,
    projectIds: [project.id],
    buildHash: "old-build",
  };
  const requestUpdate = async () => s.post(`/api/agents/${(await agents())[0].id}/update`, {});
  const pin = () => s.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "Make it blue" });
  return { options, agents, requestUpdate, pin };
}

describe("an agent asked to update", () => {
  it("lets its running session finish, then runs the install command of its server and signals it is updated", async () => {
    const { options, agents, requestUpdate, pin } = await setup();
    const events: string[] = [];
    let finishSession: () => void = () => undefined;
    const sessionDone = new Promise<void>((resolve) => (finishSession = resolve));
    const engine = new FakeEngine(async () => {
      events.push("session started");
      await sessionDone;
      events.push("session finished");
      return [{ type: "result" as const, summary: "Done" }];
    });
    const installed: string[] = [];
    service = serveAgent({
      ...options,
      engine,
      install: async (command) => {
        events.push("install");
        installed.push(command);
      },
      installedBuildHash: () => "server-build",
    });
    await until(async () => (await agents()).length === 1 && (await agents())[0].status === "online");
    await pin();
    await until(() => events.includes("session started"));

    await requestUpdate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(installed).toEqual([]);

    finishSession();
    expect(await service.done).toEqual({ updated: true });
    expect(events).toEqual(["session started", "session finished", "install"]);
    expect(installed).toEqual([cliUpdateCommand(options.serverUrl)]);
  });

  it("keeps running its previous build when the install fails, and the error reaches the agent's row", async () => {
    const { options, agents, requestUpdate } = await setup();
    service = serveAgent({
      ...options,
      engine: new FakeEngine([]),
      install: async () => {
        throw new Error("npm ERR! 404 Not Found");
      },
    });
    await until(async () => (await agents())[0]?.status === "online");

    await requestUpdate();
    await until(async () => (await agents())[0].updateError === "npm ERR! 404 Not Found");
    expect((await agents())[0]).toMatchObject({ status: "online" });
    expect((await agents())[0].updating).toBeUndefined();
    const outcome = await Promise.race([service.done, new Promise((resolve) => setTimeout(() => resolve("still running"), 150))]);
    expect(outcome).toBe("still running");
  });

  it("keeps running its previous build when the install left its own files unchanged, and says how to update by hand", async () => {
    const { options, agents, requestUpdate } = await setup();
    service = serveAgent({ ...options, engine: new FakeEngine([]), install: async () => undefined, installedBuildHash: () => "old-build" });
    await until(async () => (await agents())[0]?.status === "online");

    await requestUpdate();
    await until(async () => (await agents())[0].updateError !== undefined);
    expect((await agents())[0].updateError).toContain(`Run \`${cliUpdateCommand(options.serverUrl)}\` in a terminal`);
    const outcome = await Promise.race([service.done, new Promise((resolve) => setTimeout(() => resolve("still running"), 150))]);
    expect(outcome).toBe("still running");
  });
});

describe("the agent supervisor", () => {
  it("relaunches the worker with the same arguments each time it exits with the update code, and ends on any other exit", async () => {
    const dir = tempDir("redline-supervisor-");
    const script = join(dir, "worker.mjs");
    const log = join(dir, "launches.log");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), worker: process.env.REDLINE_AGENT_WORKER, relaunched: process.env.REDLINE_AGENT_RELAUNCHED ?? null }) + "\\n");
const launches = (await import("node:fs")).readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
process.exit(launches < 3 ? ${UPDATE_EXIT_CODE} : 7);
`,
    );
    const messages: string[] = [];
    const code = await superviseAgent({ command: process.execPath, args: [script, "--global", "--model", "opus"], log: (m) => messages.push(m) });

    expect(code).toBe(7);
    const launches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(launches).toEqual([
      { args: ["--global", "--model", "opus"], worker: "1", relaunched: null },
      { args: ["--global", "--model", "opus"], worker: "1", relaunched: "1" },
      { args: ["--global", "--model", "opus"], worker: "1", relaunched: "1" },
    ]);
    expect(messages).toHaveLength(2);
  });
});
