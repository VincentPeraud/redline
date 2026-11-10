import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import type { AgentActivity } from "../src/activity.js";
import { serveAgent } from "../src/serve-agent.js";
import { FakeEngine } from "./support/seam2.js";

let server: TestServer | undefined;
let folder: string | undefined;
afterEach(async () => {
  await server?.stop();
  if (folder) rmSync(folder, { recursive: true, force: true });
  server = folder = undefined;
});

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(condition()).toBe(true);
};

describe("stopping an agent during a run", () => {
  it("cancels the engine's session and reports nothing more about the run", async () => {
    server = await startTestServer();
    folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>T</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }) } })).json()) as Page;
    // The session waits until it is cancelled, like Claude Code at work.
    const engine = new FakeEngine(async (run) => {
      await new Promise<void>((resolve) => run.signal!.addEventListener("abort", () => resolve()));
      return [];
    });
    const activity: AgentActivity[] = [];
    const service = serveAgent({ serverUrl: server.url, token, machine: "m", folder, kind: "project", projectIds: [project.id], engine, onActivity: (event) => activity.push(event) });
    await until(() => activity.some((event) => event.type === "connected"));
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 1, yPct: 1, body: "Change it" });
    await until(() => engine.runs.length === 1);

    service.stop();
    await service.done;

    expect(engine.cancelled).toHaveLength(1);
    await engine.finished(1);
    expect(activity.map((event) => event.type)).toEqual(["connected", "run-started", "stopped"]);
  });
});
