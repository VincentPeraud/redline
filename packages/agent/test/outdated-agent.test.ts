import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cliUpdateCommand, type AgentInfo, type AgentTokenResponse, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { connectToServer } from "../src/connection.js";
import { serveAgent, type AgentService } from "../src/serve-agent.js";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine } from "./support/seam2.js";

const SERVER_BUILD = "server-build";

let dirs: string[] = [];
let server: TestServer | undefined;
let service: AgentService | undefined;
let client: Client | undefined;
afterEach(async () => {
  service?.stop();
  await service?.done.catch(() => undefined);
  await client?.close();
  await server?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  server = service = client = undefined;
});

async function startServerWithCli(): Promise<TestServer> {
  const cliDir = mkdtempSync(join(tmpdir(), "redline-cli-"));
  dirs.push(cliDir);
  writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
  writeFileSync(join(cliDir, "build-hash.txt"), SERVER_BUILD);
  server = await startTestServer({ cliDir });
  return server;
}

const tokenOf = async (s: TestServer) => ((await (await s.get("/api/agent-token")).json()) as AgentTokenResponse).token;
const agentsOf = async (s: TestServer) => (await (await s.get("/api/agents")).json()) as AgentInfo[];

describe("the agent's build hash", () => {
  it("is sent in the hello: an agent with another build is listed outdated, one with the same build is not", async () => {
    const s = await startServerWithCli();
    const identity = { serverUrl: s.url, token: await tokenOf(s), kind: "project" as const };
    const old = await connectToServer({ ...identity, machine: "A", folder: "/a", buildHash: "old-build" });
    const current = await connectToServer({ ...identity, machine: "B", folder: "/b", buildHash: SERVER_BUILD });
    expect(old.outdated).toBe(true);
    expect(current.outdated).toBe(false);
    expect((await agentsOf(s)).map((a) => [a.machine, a.outdated])).toEqual([["A", true], ["B", undefined]]);
    old.close();
    current.close();
  });

  it("makes `redline agent` say at start-up that it is not up to date, with the server's update command", async () => {
    const s = await startServerWithCli();
    const folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
    dirs.push(folder);
    const project = (await (await s.post("/api/projects", { title: "Acme" })).json()) as Project;
    const logs: string[] = [];
    service = serveAgent({
      serverUrl: s.url,
      token: await tokenOf(s),
      machine: "test-machine",
      folder,
      kind: "project",
      projectIds: [project.id],
      engine: new FakeEngine([]),
      buildHash: "old-build",
      log: (message) => logs.push(message),
    });
    await expect.poll(() => logs.some((l) => l.includes("not up to date"))).toBe(true);
    expect(logs.join("\n")).toContain(cliUpdateCommand(s.url));
  });

  it("is not mentioned when the agent is up to date", async () => {
    const s = await startServerWithCli();
    const folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
    dirs.push(folder);
    const project = (await (await s.post("/api/projects", { title: "Acme" })).json()) as Project;
    const logs: string[] = [];
    service = serveAgent({
      serverUrl: s.url,
      token: await tokenOf(s),
      machine: "test-machine",
      folder,
      kind: "project",
      projectIds: [project.id],
      engine: new FakeEngine([]),
      buildHash: SERVER_BUILD,
      log: (message) => logs.push(message),
    });
    await expect.poll(() => logs.some((l) => l.startsWith("Connected"))).toBe(true);
    expect(logs.join("\n")).not.toContain("not up to date");
  });
});

describe("the terminal MCP of an outdated CLI", () => {
  const LUMORA = { name: "Lumora", address: "redline.lumora.com", version: "0.2.0" };
  async function connectTerminal(s: TestServer, buildHash: string, installedBuild: () => string = () => buildHash, more: { installedVersion?: () => string; otherInstances?: () => string[] } = {}) {
    const folder = mkdtempSync(join(tmpdir(), "redline-mcp-folder-"));
    dirs.push(folder);
    mkdirSync(folder, { recursive: true });
    const mcp = createTerminalMcpServer({ api: new ServerApi(s.url, await tokenOf(s), buildHash), folder, runningBuild: buildHash, installedBuild, instance: LUMORA, ...more });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    client = new Client({ name: "terminal-claude", version: "0.0.0" });
    await client.connect(clientSide);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      return ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
    };
  }

  it("tells, once and after the answer, that the installation is behind its server and which command updates it", async () => {
    const s = await startServerWithCli();
    const call = await connectTerminal(s, "old-build");
    const first = await call("list_projects");
    expect(first.split("\n")[0]).toBe("Instance: Lumora (redline.lumora.com, v0.2.0)");
    expect(first).toMatch(new RegExp(`No project yet\\. Create one with create_project\\.\\nRedline: Lumora's server runs v\\S+ and this installation v0\\.2\\.0\\.\\nTell the user to run redline update ${s.url}\\.$`));
    expect(await call("list_projects")).not.toContain("redline update");
  });

  it("pauses every tool once its installation was updated on this computer, naming the versions, and says other instances are fine", async () => {
    const s = await startServerWithCli();
    let installed = SERVER_BUILD;
    const call = await connectTerminal(s, SERVER_BUILD, () => installed, { installedVersion: () => "0.2.1", otherInstances: () => ["Local", "Brightco"] });
    expect(await call("list_projects")).toContain("No project yet");

    installed = "newer-build";
    const refused = await call("create_project", { title: "Never created" });
    expect(refused).toBe(
      "Redline: the Lumora installation was updated to v0.2.1 on this computer, but this MCP still runs v0.2.0, so its tools are paused. Tell the user to type /mcp and reconnect redline, then call the tool again.\nSessions on other instances (Local, Brightco) are not affected.",
    );
    expect(((await (await s.get("/api/projects")).json()) as Project[]).length).toBe(0);

    // a file being replaced reads as "dev": no pause
    installed = "dev";
    expect(await call("list_projects")).toContain("No project yet");
  });

  it("says nothing when the build matches", async () => {
    const s = await startServerWithCli();
    const call = await connectTerminal(s, SERVER_BUILD);
    expect(await call("list_projects")).toBe("Instance: Lumora (redline.lumora.com, v0.2.0)\nNo project yet. Create one with create_project.");
  });
});
