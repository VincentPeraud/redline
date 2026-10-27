import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cliUpdateCommand,
  AgentCloseCode,
  PROTOCOL_VERSION,
  type AgentInfo,
  type AgentTokenResponse,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("agent endpoint", () => {
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

  async function agents() {
    return (await (await server.get("/api/agents")).json()) as AgentInfo[];
  }

  it("welcomes an agent that presents the token", async () => {
    const agent = await server.connectAgent({ token: await token(), machine: "MacBook", folder: "/work/acme" });
    expect((await agent.hello).type).toBe("welcome");
    agent.close();
  });

  it("rejects a connection with a wrong token", async () => {
    const agent = await server.connectAgent({ token: "abt_wrong" });
    expect(await agent.hello).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await agent.closed).code).toBe(AgentCloseCode.Unauthorized);
    expect(await agents()).toEqual([]);
  });

  it("refuses an incompatible protocol version with the update command in the error", async () => {
    const agent = await server.connectAgent({ token: await token(), protocolVersion: PROTOCOL_VERSION + 1 });
    const reply = await agent.hello;
    expect(reply).toMatchObject({ type: "error", code: "incompatible_protocol" });
    expect(reply.type === "error" && reply.message).toContain(cliUpdateCommand(server.url));
    expect((await agent.closed).code).toBe(AgentCloseCode.IncompatibleProtocol);
  });

  it("lists connected agents with machine, folder and online status, then offline after disconnect", async () => {
    const agent = await server.connectAgent({ token: await token(), machine: "MacBook", folder: "/work/acme" });
    await agent.hello;
    expect(await agents()).toMatchObject([
      { machine: "MacBook", folder: "/work/acme", kind: "project", status: "online" },
    ]);

    agent.close();
    await agent.closed;
    await expect.poll(async () => (await agents())[0]?.status).toBe("offline");
    expect(await agents()).toHaveLength(1);
  });

  it("keeps one entry for an agent that reconnects from the same machine and folder", async () => {
    const t = await token();
    const first = await server.connectAgent({ token: t, machine: "MacBook", folder: "/work/acme" });
    await first.hello;
    first.close();
    await first.closed;
    const second = await server.connectAgent({ token: t, machine: "MacBook", folder: "/work/acme" });
    await second.hello;
    await expect.poll(async () => (await agents()).map((a) => a.status)).toEqual(["online"]);
    second.close();
  });

  it("regenerating the token disconnects every connected agent and invalidates the old token", async () => {
    const oldToken = await token();
    const a = await server.connectAgent({ token: oldToken, machine: "A", folder: "/a" });
    const b = await server.connectAgent({ token: oldToken, machine: "B", folder: "/b" });
    await a.hello;
    await b.hello;

    const res = await server.post("/api/agent-token/regenerate", {});
    expect(res.status).toBe(200);
    const newToken = ((await res.json()) as AgentTokenResponse).token;
    expect(newToken).not.toBe(oldToken);

    expect((await a.closed).code).toBe(AgentCloseCode.Unauthorized);
    expect((await b.closed).code).toBe(AgentCloseCode.Unauthorized);
    expect(await token()).toBe(newToken);
    const retry = await server.connectAgent({ token: oldToken });
    expect((await retry.hello).type).toBe("error");
    expect((await agents()).map((x) => x.status)).toEqual(["offline", "offline"]);
  });

  it("serves a stable token until it is regenerated", async () => {
    expect(await token()).toBe(await token());
  });
});
