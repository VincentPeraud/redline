import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type Page as Tab } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type AgentTokenResponse, type DesignSystem } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import { startAgent } from "../../agent/src/agent.js";
import type { AgentConnection } from "../../agent/src/connection.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000000"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body><div class="card">Hi</div></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

let browser: Browser;
let webDir: string;
let seam: Seam2;
let globalAgent: AgentConnection;
let globalFolder: string;
const engine = new FakeEngine([
  { edit: { path: "tokens.css", content: tokensCss("#222222") } },
  { edit: { path: "manifest.json", content: manifestOf(["components/card.html", "components/badge.html"]) } },
  { edit: { path: "components/card.html", content: component(".card{color:blue}") } },
  { edit: { path: "components/badge.html", content: component(".badge{color:green}") } },
  { type: "result", summary: "Changed the primary colour and added a badge" },
]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(new FakeEngine([]), { webDir });
  globalFolder = mkdtempSync(join(tmpdir(), "redline-global-folder-"));
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  globalAgent = await startAgent({ serverUrl: seam.server.url, token, machine: "global-machine", folder: globalFolder, kind: "global", engine });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  globalAgent?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(globalFolder, { recursive: true, force: true });
});

const cardTexts = (tab: Tab) => tab.getByTestId("design-system").allTextContents();

it("signals what Claude left undiffused: the card under its answer, the pill on the Design systems screen and the strip pills", async () => {
  const ds = (await (await seam.server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/card.html"]), "components/card.html": component(".card{color:red}") },
  })).json()) as DesignSystem;
  await seam.server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id });
  await seam.server.post("/api/projects", { title: "Style propre" });
  // No project using the design system has an agent running: its work goes to the global agent when the default allows it.
  await fetch(`${seam.server.url}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeover: true }) });

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/design-systems`);
  await expect.poll(async () => (await cardTexts(tab)).length).toBe(1);
  expect(await tab.getByTestId("pending-pill").count()).toBe(0);
  expect((await cardTexts(tab))[0]).toContain("Lumora");

  await tab.goto(`${seam.server.url}/#/pages/${ds.pageId}`);
  const panel = tab.getByTestId("conversations");
  await panel.getByLabel("Message à Claude").waitFor();
  expect(await tab.getByTestId("component-change").count()).toBe(0);
  await panel.getByLabel("Message à Claude").fill("Make the primary colour darker and add a badge");
  await panel.getByLabel("Message à Claude").press("Enter");
  await engine.finished(1);

  // The card under the answer.
  const card = panel.getByTestId("pending-diffusion");
  await card.waitFor();
  expect(await card.textContent()).toContain("Pas encore diffusé");
  expect(await card.textContent()).toContain("1 token et 2 composants modifiés · 1 projet concerné");
  // The strip pills match the pending diff.
  await expect.poll(() => tab.getByTestId("component-change").allTextContents()).toEqual(["modifié", "nouveau"]);

  // The Design systems screen.
  const screen = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await screen.goto(`${seam.server.url}/#/design-systems`);
  await expect.poll(() => screen.getByTestId("pending-pill").allTextContents()).toEqual(["non diffusé · 3 changements"]);
  expect(await cardTexts(screen)).toHaveLength(1);

  // The sidebar badge and the home subtitle give the same alert.
  expect(await screen.getByTestId("sidebar-to-diffuse").textContent()).toBe("1");
  await screen.goto(`${seam.server.url}/#/`);
  await expect.poll(() => screen.getByTestId("home-to-diffuse").textContent()).toBe("1 design system à diffuser");
  expect(await screen.getByTestId("home-design-systems").getByTestId("pending-pill").textContent()).toBe("non diffusé · 3 changements");
  expect(await screen.getByTestId("sidebar-to-diffuse").textContent()).toBe("1");

  // "Relire et diffuser" opens the review.
  await screen.goto(`${seam.server.url}/#/design-systems`);
  await screen.getByTestId("review-and-diffuse").click();
  await screen.getByRole("dialog").waitFor();
  expect(screen.url()).toContain("/#/design-systems/");
  await screen.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();
  await screen.getByRole("dialog").waitFor({ state: "detached" });
  await screen.goto(`${seam.server.url}/#/design-systems`);
  await expect.poll(() => screen.getByTestId("pending-pill").count()).toBe(1);

  // Diffusing clears all three signals.
  await card.getByRole("button", { name: "Diffuser…" }).click();
  await tab.getByRole("dialog").getByRole("button", { name: "Diffuser", exact: true }).click();
  await tab.getByTestId("diffusion-toast").waitFor();
  await expect.poll(() => panel.getByTestId("pending-diffusion").count()).toBe(0);
  await expect.poll(() => tab.getByTestId("component-change").count()).toBe(0);
  await screen.reload();
  await expect.poll(async () => (await cardTexts(screen)).length).toBe(1);
  expect(await screen.getByTestId("pending-pill").count()).toBe(0);

  await tab.close();
  await screen.close();
}, 60_000);
