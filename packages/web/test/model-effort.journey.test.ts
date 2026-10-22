import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir, agent: { model: "sonnet", effort: "low" } });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows both controls as the agent's default until changed, and applies a change from the next message", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  await seam.pinThread(page.id, "home.html", "Look at this");
  await engine.finished(1);
  await seam.waitForWorkEnd(1);

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  const model = tab.getByLabel("Modèle");
  await expect.poll(() => model.inputValue()).toBe("");
  expect(await model.locator("option:checked").textContent()).toContain("par défaut");
  expect(await tab.getByTestId("effort-default").textContent()).toContain("défaut de l'agent");

  await model.selectOption("opus");
  expect(await model.locator("option:checked").textContent()).toBe("Opus");
  await expect.poll(() => tab.getByTestId("effort-default").count()).toBe(1);
  await tab.getByRole("radio", { name: "xhigh" }).click();
  await expect.poll(() => tab.getByTestId("effort-default").count()).toBe(0);
  expect(engine.runs).toHaveLength(1);

  await tab.getByRole("button", { name: "Répondre" }).click();
  await tab.getByLabel("Répondre").fill("Think harder");
  await tab.getByRole("button", { name: "Envoyer la réponse" }).click();
  await engine.finished(2);
  expect([engine.runs[1].model, engine.runs[1].effort]).toEqual(["opus", "xhigh"]);
  expect([engine.runs[0].model, engine.runs[0].effort]).toEqual(["sonnet", "low"]);

  await tab.goto(`${seam.server.url}/#/agents`);
  await expect.poll(() => tab.getByTestId("agent-defaults").textContent()).toBe("sonnet · low");
}, 60_000);
