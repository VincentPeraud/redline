import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo, AgentTokenResponse, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { serveAgent, type AgentService } from "../src/serve-agent.js";
import { FakeEngine } from "./support/seam2.js";

let server: TestServer | undefined;
let service: AgentService | undefined;
let folder: string | undefined;
afterEach(async () => {
  service?.stop();
  await service?.done.catch(() => undefined);
  await server?.stop();
  if (folder) rmSync(folder, { recursive: true, force: true });
  server = service = folder = undefined;
});

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await condition()).toBe(true);
}

async function setup() {
  server = await startTestServer();
  folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const online = async () => ((await (await server!.get("/api/agents")).json()) as AgentInfo[]).some((a) => a.status === "online");
  const options = {
    serverUrl: server.url,
    token,
    machine: "test-machine",
    folder,
    kind: "project" as const,
    projectId: project.id,
    engine: new FakeEngine([]),
    reconnectDelaysMs: [20, 40],
  };
  return { options, online };
}

describe("an agent whose server goes away", () => {
  it("keeps retrying while the server is down and connects again when it is back", async () => {
    const { options, online } = await setup();
    service = serveAgent(options);
    await until(online);

    await server!.restart({ downForMs: 400 });
    await until(online);
  });

  it("keeps retrying when the server was not running yet", async () => {
    const { options, online } = await setup();
    const down = server!.restart({ downForMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    service = serveAgent(options);
    await down;
    await until(online);
  });

  it("stops, saying why, when the token is refused", async () => {
    const { options } = await setup();
    service = serveAgent({ ...options, token: "abt_wrong" });
    await expect(service.done).rejects.toThrow(/token/i);
  });
});
