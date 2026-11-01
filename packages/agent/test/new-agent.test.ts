import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import type { LaunchSettings } from "../src/host-protocol.js";
import { saveLogin } from "../src/login.js";
import { createNewAgentFlow } from "../src/new-agent.js";

let dirs: string[] = [];
let server: TestServer | undefined;
afterEach(async () => {
  await server?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  server = undefined;
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A server with three projects, and a folder linked to the first two. */
async function linkedFolder() {
  const s = (server = await startTestServer());
  const create = async (title: string) => (await (await s.post("/api/projects", { title })).json()) as Project;
  const [acme, beta, gamma] = [await create("Acme"), await create("Beta"), await create("Gamma")];
  const { token } = (await (await s.get("/api/agent-token")).json()) as AgentTokenResponse;
  const configDir = tempDir("rl-config-");
  saveLogin({ configDir, serverUrl: s.url, token });
  const folder = tempDir("rl-folder-");
  mkdirSync(join(folder, ".redline"));
  writeFileSync(join(folder, ".redline", "project.json"), JSON.stringify({ serverUrl: s.url, projectIds: [acme.id, beta.id] }));
  const launched: LaunchSettings[] = [];
  const host = {
    launch: async (settings: LaunchSettings) => {
      launched.push(settings);
      return { agent: { id: "a1" } as never, started: true };
    },
  };
  const flow = createNewAgentFlow({ folder, configDir, claudeSettingsFile: join(configDir, "settings.json"), host, checkClaude: async () => "me@example.com" });
  const link = () => JSON.parse(readFileSync(join(folder, ".redline", "project.json"), "utf8")) as { projectIds: string[] };
  return { s, acme, beta, gamma, flow, launched, link };
}

describe("a new agent for a folder that is already linked", { timeout: 20_000 }, () => {
  it("offers every open project of the server, with the folder's own ones ticked", async () => {
    const { acme, beta, gamma, flow } = await linkedFolder();
    const questions = await flow.inspect();
    expect(questions.linkedTitles).toEqual(["Acme", "Beta"]);
    expect(questions.linkedIds).toEqual([acme.id, beta.id]);
    expect(questions.projects?.map((p) => p.id)).toEqual(expect.arrayContaining([acme.id, beta.id, gamma.id]));
  });

  it("rewrites the link to the projects ticked: one added, one dropped, one created", async () => {
    const { s, acme, gamma, flow, launched, link } = await linkedFolder();
    await flow.start({ serve: { projectIds: [acme.id, gamma.id], create: "Delta" }, model: "opus" });
    const delta = ((await (await s.get("/api/projects")).json()) as Project[]).find((p) => p.title === "Delta")!;
    expect(delta).toBeDefined();
    expect(new Set(link().projectIds)).toEqual(new Set([acme.id, gamma.id, delta.id]));
    expect(new Set(launched[0].projectIds)).toEqual(new Set([acme.id, gamma.id, delta.id]));
    expect(new Set(launched[0].projectNames)).toEqual(new Set(["Acme", "Gamma", "Delta"]));
  });

  it("refuses a project archived since the dialog opened, before creating anything or touching the link", async () => {
    const { s, acme, gamma, flow, launched, link } = await linkedFolder();
    await s.post(`/api/projects/${gamma.id}/archive`, {});
    await expect(flow.start({ serve: { projectIds: [acme.id, gamma.id], create: "Delta" }, model: "opus" })).rejects.toThrow("archived or deleted meanwhile");
    const titles = ((await (await s.get("/api/projects")).json()) as Project[]).map((p) => p.title);
    expect(titles).not.toContain("Delta");
    expect(link().projectIds).toHaveLength(2);
    expect(launched).toEqual([]);
  });

  it("refuses to leave the folder with no project", async () => {
    const { flow, link } = await linkedFolder();
    await expect(flow.start({ serve: { projectIds: [] }, model: "opus" })).rejects.toThrow("at least one project");
    expect(link().projectIds).toHaveLength(2);
  });

  it("can swap the only project for another", async () => {
    const { gamma, flow, link } = await linkedFolder();
    await flow.start({ serve: { projectIds: [gamma.id] }, model: "opus" });
    expect(link().projectIds).toEqual([gamma.id]);
  });
});
