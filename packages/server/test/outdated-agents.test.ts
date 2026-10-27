import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_API_PREFIX,
  BUILD_HASH_HEADER,
  OUTDATED_HEADER,
  PROTOCOL_VERSION,
  type AgentInfo,
  type AgentTokenResponse,
  type HomeOverview,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("outdated and refused agents", () => {
  let cliDir: string;
  let server: TestServer;

  beforeEach(async () => {
    cliDir = mkdtempSync(join(tmpdir(), "redline-outdated-"));
    writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
    writeFileSync(join(cliDir, "build-hash.txt"), "server-build\n");
    server = await startTestServer({ cliDir });
  });
  afterEach(async () => {
    await server.stop();
    rmSync(cliDir, { recursive: true, force: true });
  });

  const token = async () => ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  const agents = async () => (await (await server.get("/api/agents")).json()) as AgentInfo[];
  const home = async () => (await (await server.get("/api/home")).json()) as HomeOverview;

  it("marks a connected agent outdated when its build differs, and not when it matches", async () => {
    const old = await server.connectAgent({ machine: "A", folder: "/a", buildHash: "old-build" });
    const current = await server.connectAgent({ machine: "B", folder: "/b", buildHash: "server-build" });
    expect(await old.hello).toMatchObject({ type: "welcome", outdated: true });
    expect(await current.hello).not.toHaveProperty("outdated");
    expect((await agents()).map((a) => [a.machine, a.outdated])).toEqual([["A", true], ["B", undefined]]);
    expect((await home()).agents.find((a) => a.machine === "A")?.outdated).toBe(true);
  });

  it("treats an agent without a build hash as outdated", async () => {
    const agent = await server.connectAgent({ machine: "A", folder: "/a" });
    await agent.hello;
    expect((await agents())[0].outdated).toBe(true);
  });

  it("does not flag an agent that went offline", async () => {
    const agent = await server.connectAgent({ machine: "A", folder: "/a", buildHash: "old-build" });
    await agent.hello;
    agent.close();
    await agent.closed;
    await expect.poll(async () => (await agents())[0].status).toBe("offline");
    expect((await agents())[0].outdated).toBeUndefined();
  });

  it("answers the agents' API with the outdated header only for another build", async () => {
    const t = await token();
    const get = (build?: string) =>
      fetch(server.url + AGENT_API_PREFIX + "/projects", { headers: { authorization: `Bearer ${t}`, ...(build ? { [BUILD_HASH_HEADER]: build } : {}) } });
    expect((await get("old-build")).headers.get(OUTDATED_HEADER)).toBe("1");
    expect((await get("server-build")).headers.get(OUTDATED_HEADER)).toBeNull();
    expect((await get()).headers.get(OUTDATED_HEADER)).toBeNull();
  });

  it("records an agent refused for its protocol until it connects again", async () => {
    const refused = await server.connectAgent({ machine: "A", folder: "/work/blog", kind: "project", protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await refused.hello).toMatchObject({ type: "error", code: "incompatible_protocol" });
    expect((await home()).refusedAgents).toMatchObject([{ machine: "A", folder: "/work/blog", kind: "project" }]);
    expect(await agents()).toEqual([]);

    const again = await server.connectAgent({ machine: "A", folder: "/work/blog", buildHash: "server-build" });
    await again.hello;
    expect((await home()).refusedAgents).toEqual([]);
  });
});

describe("without a CLI build (development)", () => {
  it("never marks an agent outdated", async () => {
    const server = await startTestServer();
    try {
      const agent = await server.connectAgent({ buildHash: "dev" });
      await agent.hello;
      const listed = (await (await server.get("/api/agents")).json()) as AgentInfo[];
      expect(listed[0].outdated).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
