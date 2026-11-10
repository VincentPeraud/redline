import { describe, expect, it } from "vitest";
import type { HostAgent } from "../src/host-protocol.js";
import { servingAgent } from "../src/serving-agent.js";

const agent = (over: Partial<HostAgent>): HostAgent => ({ id: "a", name: "cv", folder: "/work/cv", kind: "project", serverUrl: "https://redline.example", claudeConfigDir: "/c", state: "idle", since: "2026-01-01T00:00:00.000Z", ...over });
const hostOf = (...agents: HostAgent[]) => ({ list: async () => agents });

describe("the agent that already serves a folder", () => {
  it("is the running agent of the same folder and server, whatever the trailing slash of the URL", async () => {
    const serving = agent({ id: "mine" });
    const found = await servingAgent({ host: hostOf(agent({ id: "other", folder: "/work/other" }), agent({ id: "elsewhere", serverUrl: "https://other.example" }), serving), folder: "/work/cv", serverUrl: "https://redline.example/" });
    expect(found).toBe(serving);
  });

  it("is none for a stopped agent, which `redline agent` restarts with the choices it asks", async () => {
    expect(await servingAgent({ host: hostOf(agent({ state: "stopped" })), folder: "/work/cv", serverUrl: "https://redline.example" })).toBeUndefined();
  });
});
