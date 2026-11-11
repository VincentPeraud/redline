import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentTokenResponse } from "@redline/shared";
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

it("shows one setup command with the token masked, and copies it whole", async () => {
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/agents`);

  await tab.getByRole("button", { name: "Lancer un agent" }).click();
  const panel = tab.getByRole("complementary", { name: "Lancer un agent" });
  await panel.getByText("Une fois par machine").waitFor();
  await panel.getByText("--token abt_", { exact: false }).waitFor();
  const shown = (await panel.locator("pre").first().textContent()) ?? "";
  expect(shown).toContain(`npm i -g ${server.url}/cli/redline-cli.tgz`);
  expect(shown).toContain(`redline setup ${server.url}`);
  expect(shown).toContain("--token abt_•");
  expect(shown).not.toContain(token);
  expect(await panel.getByText("claude mcp add").count()).toBe(0);
  expect(await panel.getByText("Personnel : ne le donne à personne.", { exact: false }).count()).toBe(1);

  await panel.getByRole("button", { name: "Copier la commande" }).click();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(
    `npm i -g ${server.url}/cli/redline-cli.tgz && redline setup ${server.url} --token ${token}`,
  );
  await context.close();
}, 60_000);
