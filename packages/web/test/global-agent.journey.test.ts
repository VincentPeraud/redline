import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows which agent serves a project in the top bar, including the global agent taking over once allowed", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  const pill = tab.getByTestId("agent-pill");
  await expect.poll(() => pill.textContent()).toBe("Aucun agent connecté");

  const projectAgent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id });
  await projectAgent.hello;
  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Agent acme connecté");

  const global = await server.connectAgent({ machine: "iMac", folder: "/home/neutral", kind: "global" });
  await global.hello;
  projectAgent.close();
  await projectAgent.closed;

  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Aucun agent connecté");

  await fetch(`${server.url}/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeoverOverride: true }) });
  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Agent global iMac connecté");
}, 60_000);

it("sets the project's takeover exception from the agent pill popover, keyboard friendly", async () => {
  const project = (await (await server.post("/api/projects", { title: "Blog" })).json()) as Project;
  const projectAgent = await server.connectAgent({ machine: "MacBook", folder: "/work/blog", projectId: project.id, model: "sonnet", effort: "low" });
  await projectAgent.hello;
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);

  await tab.getByTestId("agent-pill").click();
  const popover = tab.getByRole("dialog", { name: "Agent du projet" });
  await popover.getByText("/work/blog").waitFor();
  await popover.getByText("sonnet · low").waitFor();
  const group = popover.getByRole("radiogroup", { name: "Quand aucun agent ne tourne pour ce projet" });
  const override = async () => ((await (await server.get(`/api/projects/${project.id}`)).json()) as Project).globalTakeoverOverride;
  await expect.poll(() => group.getByLabel("Comme le réglage général (le fil attend)").isChecked()).toBe(true);

  await group.getByLabel("L'agent global le prend").click();
  await expect.poll(override).toBe(true);
  await group.getByLabel("Le fil attend", { exact: true }).click();
  await expect.poll(override).toBe(false);
  await group.getByLabel(/Comme le réglage général/).click();
  await expect.poll(override).toBeNull();

  await tab.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  await expect.poll(() => tab.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("agent-pill");
}, 60_000);
