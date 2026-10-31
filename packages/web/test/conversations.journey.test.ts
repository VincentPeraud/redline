import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine([
  { type: "usage", model: "opus", inputTokens: 100_000, cacheTokens: 50_000, outputTokens: 10_000 },
  { type: "result", summary: "Added the error screen" },
]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("creates a conversation, talks to Claude with model and effort, shows the session line, then archives it", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByLabel("Modèle").selectOption("opus");
  await panel.getByRole("radio", { name: "high", exact: true }).click();
  await panel.getByLabel("Message à Claude").fill("Add an error screen");
  await panel.getByLabel("Message à Claude").press("Enter");

  await engine.finished(1);
  await expect.poll(() => panel.getByTestId("conversation-message").allTextContents()).toEqual([
    "Add an error screen",
    "ClaudeAdded the error screen",
  ]);
  expect(engine.runs[0].message).toContain(page.id);
  await expect.poll(() => panel.getByTestId("conversation-session").textContent()).toBe("opus · high · 80 %");
  expect(await panel.getByTestId("conversation-session").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(194, 65, 12)");

  await panel.getByRole("button", { name: "Supprimer cette conversation" }).click();
  await expect.poll(() => panel.getByRole("button", { name: "Conversation", exact: true }).textContent()).toContain("Aucune conversation");
}, 60_000);

it("types and sends on a page without conversation: the first message creates it with the chosen model and effort", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByText("Nouvelle conversation", { exact: true }).waitFor();
  await panel.getByText("Écris ton premier message : la conversation est créée à l'envoi.").waitFor();
  expect(await panel.getByLabel("Message à Claude").isEnabled()).toBe(true);
  await panel.getByLabel("Modèle").selectOption("opus");
  await panel.getByRole("radio", { name: "low", exact: true }).click();
  await panel.getByLabel("Message à Claude").fill("First words");
  await panel.getByRole("button", { name: "Envoyer" }).click();

  await engine.finished(before + 1);
  await expect.poll(() => panel.getByTestId("conversation-message").first().textContent()).toBe("First words");
  await expect.poll(() => panel.getByTestId("conversation-session").textContent()).toContain("opus · low");
  expect(engine.runs[before].message).toContain(page.id);

  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await expect.poll(() => panel.getByRole("button", { name: "Conversation", exact: true }).textContent()).toContain("Nouvelle conversation");
  await expect.poll(() => panel.getByTestId("conversation-message").count()).toBe(0);
}, 60_000);

it("creates no conversation on \"+ Nouvelle\": only the first message sent does", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const conversationCount = async () => ((await (await seam.server.get(`/api/pages/${page.id}/conversations`)).json()) as unknown[]).length;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByLabel("Message à Claude").fill("First words");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 1);
  await expect.poll(() => panel.getByTestId("conversation-message").count()).toBe(2);

  for (let i = 0; i < 3; i++) await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByText("Écris ton premier message : la conversation est créée à l'envoi.").waitFor();
  expect(await panel.getByRole("button", { name: "Conversation", exact: true }).textContent()).toContain("Nouvelle conversation");
  expect(await conversationCount()).toBe(1);

  await panel.getByLabel("Message à Claude").fill("Second topic");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 2);
  await expect.poll(() => panel.getByTestId("conversation-message").first().textContent()).toBe("Second topic");
  expect(await conversationCount()).toBe(2);
}, 60_000);

it("shows what goes with a message, follows pan and tweaks, and sends it with the message", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage(
    {
      "accueil.html": "<!doctype html><h1>Accueil</h1>",
      "paiement.html": "<!doctype html><h1>Paiement</h1>",
      "confirmation.html": "<!doctype html><h1>Confirmation</h1>",
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "accueil.html", x: 60, y: 100, width: 360, height: 420 },
          { file: "paiement.html", x: 500, y: 100, width: 360, height: 420 },
          { file: "confirmation.html", x: 940, y: 100, width: 360, height: 420 },
        ],
        tweaks: [{ id: "theme", type: "choice", label: "Thème", options: ["clair", "sombre"] }],
      }),
    },
    "Parcours billet",
  );
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByText("Parcours billet · 3 artboards", { exact: true }).waitFor();
  await panel.getByText("Visibles : accueil, paiement, confirmation", { exact: true }).waitFor();
  await panel.getByText("Tweaks : thème clair", { exact: true }).waitFor();

  await tab.getByRole("button", { name: "Tweaks · 1" }).click();
  await tab.getByRole("button", { name: "sombre" }).click();
  await panel.getByText("Tweaks : thème sombre", { exact: true }).waitFor();

  await tab.getByTestId("canvas").hover({ position: { x: 500, y: 700 } });
  await tab.mouse.wheel(1000, 0);
  await panel.getByText("Visibles : confirmation", { exact: true }).waitFor();

  await panel.getByLabel("Message à Claude").fill("Change ce titre");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 1);
  expect(engine.runs[before].message).toContain("Change ce titre\n\nThe user is looking at: confirmation.html\nTweak values: Thème: sombre");
}, 60_000);

it("keeps the text when creating the conversation or posting the message fails, shows an error, and sends once it works", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");
  await panel.getByText("Écris ton premier message : la conversation est créée à l'envoi.").waitFor();

  const posted: string[] = [];
  await tab.route(/\/api\/(pages\/[^/]+\/conversations|conversations\/[^/]+\/messages)$/, (route) => {
    posted.push(route.request().url());
    return route.request().method() === "POST" ? route.fulfill({ status: 500, body: "{}" }) : route.continue();
  });
  await panel.getByLabel("Message à Claude").fill("Do not lose me");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await panel.getByRole("alert").waitFor();
  expect(await panel.getByLabel("Message à Claude").inputValue()).toBe("Do not lose me");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/\/conversations$/);

  await tab.unroute(/\/api\/(pages\/[^/]+\/conversations|conversations\/[^/]+\/messages)$/);
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 1);
  await expect.poll(() => panel.getByLabel("Message à Claude").inputValue()).toBe("");
  await expect.poll(() => panel.getByRole("alert").count()).toBe(0);
}, 60_000);
