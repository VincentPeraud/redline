import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Project } from "@redline/shared";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const project = `redline-docker-test-${process.pid}`;
const port = 39000 + (process.pid % 500);
const env = { ...process.env, REDLINE_PORT: String(port), REDLINE_ARTBOARD_PORT: String(port + 1000) };

function compose(...args: string[]) {
  execFileSync("docker", ["compose", "-p", project, ...args], { cwd: repoRoot, env, stdio: "pipe" });
}

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/projects`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("container did not become ready");
}

// Opt-in: builds the image (slow). Run with `npm run test:docker`.
describe.skipIf(!process.env.REDLINE_DOCKER_TEST)("docker compose deployment", () => {
  afterAll(() => compose("down", "-v", "--rmi", "local"));

  it("serves the web UI and keeps projects after the container is recreated", async () => {
    compose("up", "-d", "--build");
    await waitForApi();

    const created = await fetch(`http://localhost:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Survivor" }),
    });
    expect(created.status).toBe(201);

    const webUi = await fetch(`http://localhost:${port}/`);
    expect(await webUi.text()).toContain('id="root"');

    compose("up", "-d", "--force-recreate");
    await waitForApi();

    const projects = (await (await fetch(`http://localhost:${port}/api/projects`)).json()) as Project[];
    expect(projects.map((p) => p.title)).toEqual(["Survivor"]);
  }, 300_000);
});
