import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, EngineEvent, Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { formatActivity, type AgentActivity } from "../src/activity.js";
import { serveAgent, type AgentService } from "../src/serve-agent.js";
import { FakeEngine, type FakeScript } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Title</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

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

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(script: FakeScript, options: { retryDelaysMs?: number[]; token?: string } = {}) {
  server = await startTestServer({ retryDelaysMs: options.retryDelaysMs });
  folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const activity: AgentActivity[] = [];
  const lines: string[] = [];
  const serverStarted = server;
  service = serveAgent({
    serverUrl: server.url,
    token: options.token ?? token,
    machine: "test-machine",
    folder,
    kind: "project",
    projectIds: [project.id],
    engine: new FakeEngine(script),
    reconnectDelaysMs: [20, 40],
    onActivity: (event) => activity.push(event),
    log: (line) => lines.push(line),
  });
  const types = () => activity.map((e) => e.type);
  const comment = async (body = "Change the title") => {
    const page = (await (await serverStarted.post(`/api/projects/${project.id}/pages`, { title: "Home", files: PAGE_FILES })).json()) as Page;
    await until(() => types().includes("connected"), "the agent to connect");
    await serverStarted.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 20, yPct: 30, body });
    return page;
  };
  return { activity, lines, types, comment };
}

const of = <T extends AgentActivity["type"]>(activity: AgentActivity[], type: T) =>
  activity.filter((e): e is Extract<AgentActivity, { type: T }> => e.type === type);

const publishes: EngineEvent[] = [{ type: "step", tool: "Read", summary: "home.html" }, { type: "result", summary: "Done" }];

describe("agent activity: connection", () => {
  it("reports connected once, and reconnected after the server comes back", async () => {
    const { activity, types } = await start([]);
    await until(() => types().includes("connected"), "connected");
    expect(of(activity, "connected")).toHaveLength(1);

    await server!.restart({ downForMs: 300 });
    await until(() => types().includes("reconnected"), "reconnected");
    expect(types()).toEqual(["connected", "connection-lost", "reconnected"]);
  });

  it("reports a refusal with its reason before the service rejects", async () => {
    const { activity } = await start([], { token: "abt_wrong" });
    await expect(service!.done).rejects.toThrow(/token/i);
    const [refused] = of(activity, "refused");
    expect(refused.reason).toMatch(/token/i);
  });

  it("reports stopped when it is stopped", async () => {
    const { activity, types } = await start([]);
    await until(() => types().includes("connected"), "connected");
    service!.stop();
    await service!.done;
    expect(of(activity, "stopped")).toEqual([{ type: "stopped", reason: "stopped" }]);
  });
});

describe("agent activity: runs", () => {
  it("reports a run's start, its steps and its publication", async () => {
    const { activity, types, comment } = await start([
      { type: "step", tool: "Read", summary: "home.html" },
      { type: "step", tool: "Edit", summary: "home.html" },
      { edit: { path: "home.html", content: "<h1>New</h1>" } },
      { type: "result", summary: "Done" },
    ]);
    await comment("Make the title bigger");
    await until(() => types().includes("run-published"), "the run to publish");

    const [started] = of(activity, "run-started");
    expect(started).toMatchObject({ project: "Acme", page: "Home", kind: "comment", excerpt: "Make the title bigger", attempt: 1 });
    const progress = of(activity, "run-progress");
    expect(progress.at(-1)?.steps).toEqual(["Read home.html", "Edit home.html"]);
    expect(progress.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(0);
    const [published] = of(activity, "run-published");
    expect(published.changed).toEqual(["home.html"]);
    expect(published.artboards).toEqual({ added: 0, changed: 1, removed: 0 });
    expect(published.durationMs).toBeGreaterThanOrEqual(0);
    expect(types().filter((t) => t.startsWith("run-"))).toEqual(["run-started", "run-progress", "run-progress", "run-published"]);
  });

  it("counts the artboards a run added and changed, apart from the other files", async () => {
    const { activity, types, comment } = await start([
      { edit: { path: "home.html", content: "<h1>New</h1>" } },
      { edit: { path: "pricing.html", content: "<h1>Pricing</h1>" } },
      { edit: { path: "manifest.json", content: JSON.stringify({ artboards: [{ file: "home.html" }, { file: "pricing.html" }] }) } },
      { type: "result", summary: "Done" },
    ]);
    await comment("Add a pricing artboard");
    await until(() => types().includes("run-published"), "the run to publish");

    const [published] = of(activity, "run-published");
    expect(published.artboards).toEqual({ added: 1, changed: 1, removed: 0 });
  });

  it("reports a failed run with the engine's reason, then the retry", async () => {
    let runs = 0;
    const { activity, types, comment } = await start(() => (++runs === 1 ? [{ type: "error", message: "Overloaded" }] : publishes), { retryDelaysMs: [30] });
    await comment();
    await until(() => types().includes("run-published"), "the retry to end");

    const [failed] = of(activity, "run-failed");
    expect(failed).toMatchObject({ reason: "Overloaded", attempt: 1 });
    expect(of(activity, "run-started").map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("reports a run that fails for good", async () => {
    const { activity, types, comment } = await start([{ type: "error", message: "Engine crashed" }], { retryDelaysMs: [] });
    await comment();
    await until(() => types().includes("run-failed"), "the run to fail");
    expect(of(activity, "run-failed")[0].reason).toBe("Engine crashed");
    expect(types()).not.toContain("run-published");
  });
});

describe("foreground output", () => {
  it("prints one plain line per event", async () => {
    const { lines, types, comment } = await start(publishes);
    await comment("Make the title bigger");
    await until(() => types().includes("run-published"), "the run to publish");
    expect(lines.some((l) => l.startsWith("Connected to"))).toBe(true);
    expect(lines).toContain('Run started on Acme / Home (comment): "Make the title bigger"');
    expect(lines.some((l) => /^Run published on Home in \d/.test(l) || l.startsWith("Run finished"))).toBe(true);
  });

  it("formats each event as one line", () => {
    expect(formatActivity({ type: "refused", reason: "Unknown project." })).toBe("Refused by the server: Unknown project.");
    expect(formatActivity({ type: "run-failed", workId: "w", reason: "Overloaded", attempt: 1 })).toBe("Run failed: Overloaded");
    expect(formatActivity({ type: "run-started", workId: "w", project: "Acme", page: "Home", kind: "conversation", author: "Ariane Martin", attempt: 2 })).toBe(
      "Run started on Acme / Home (conversation) for Ariane Martin, attempt 2",
    );
  });

  it("prints server-provided text without control characters", () => {
    const evil = "\x1b]0;pwned\x07\x1b[2Jx\ny";
    const lines = [
      formatActivity({ type: "run-started", workId: "w", project: evil, page: evil, kind: "comment", author: evil, excerpt: evil, attempt: 1 }),
      formatActivity({ type: "run-failed", workId: "w", page: evil, reason: evil, attempt: 1 }),
      formatActivity({ type: "refused", reason: evil }),
      formatActivity({ type: "run-progress", workId: "w", steps: [evil], elapsedMs: 1000 }),
      formatActivity({ type: "connection-lost", reason: evil }),
    ];
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(lines[2]).toBe("Refused by the server: ]0;pwned[2Jx y");
  });
});
