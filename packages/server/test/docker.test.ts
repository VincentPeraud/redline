import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SETUP_PATH, type Project } from "@redline/shared";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const project = `redline-docker-test-${process.pid}`;
const port = 39000 + (process.pid % 500);
// The compose file defaults to the built-in accounts; the unauthenticated test below runs without them.
const env = { ...process.env, REDLINE_AUTH_MODE: "none", REDLINE_PORT: String(port), REDLINE_ARTBOARD_PORT: String(port + 1000) };

function compose(...args: string[]) {
  return execFileSync("docker", ["compose", "-p", project, ...args], { cwd: repoRoot, env, stdio: "pipe" }).toString();
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

describe.skipIf(!process.env.REDLINE_DOCKER_TEST)("docker compose deployment, built-in accounts", () => {
  const accountsProject = `${project}-accounts`;
  const accountsPort = port + 2000;
  const accountsEnv = { ...process.env, REDLINE_PORT: String(accountsPort), REDLINE_ARTBOARD_PORT: String(accountsPort + 1000), REDLINE_PUBLIC_URL: `http://localhost:${accountsPort}` };
  delete accountsEnv.REDLINE_AUTH_MODE;
  const accountsCompose = (...args: string[]) =>
    execFileSync("docker", ["compose", "-p", accountsProject, ...args], { cwd: repoRoot, env: accountsEnv, stdio: "pipe" }).toString();

  afterAll(() => accountsCompose("down", "-v", "--rmi", "local"));

  it("starts in local mode with a setup link in the logs, and reset-admin writes a password link", async () => {
    accountsCompose("up", "-d", "--build");
    let setupToken: string | undefined;
    for (let attempt = 0; attempt < 60 && !setupToken; attempt++) {
      setupToken = /#\/setup\/([\w-]+)/.exec(accountsCompose("logs", "redline"))?.[1];
      if (!setupToken) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(setupToken).toBeDefined();

    expect((await fetch(`http://localhost:${accountsPort}/api/projects`)).status).toBe(401);

    const created = await fetch(`http://localhost:${accountsPort}${SETUP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: setupToken, name: "Ada", email: "ada@example.com", password: "correct horse battery staple" }),
    });
    expect(created.status).toBe(201);

    const output = accountsCompose("exec", "-T", "redline", "redline-server", "reset-admin");
    expect(output).toContain("ada@example.com");
    expect(output).toContain(`http://localhost:${accountsPort}/#/mot-de-passe/`);
  }, 300_000);
});
