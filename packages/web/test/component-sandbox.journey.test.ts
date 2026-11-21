import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Thread } from "@redline/shared";
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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const BUTTON =
  `<!doctype html><html><head><style data-component>ui-button button{font:14px sans-serif;padding:8px 14px}</style></head><body>` +
  `<template data-component><button><slot>Bouton</slot></button></template>` +
  `<ui-button>Publier l'annonce</ui-button></body></html>`;
const TOKENS_ONLY = `<!doctype html><html><body><p>Tokens</p></body></html>`;

async function designSystem() {
  const manifest = {
    artboards: [
      { file: "components/button.html", x: 0, y: 0, width: 420, height: 80, matrix: { rows: "variant" } },
      { file: "components/tokens.html", x: 0, y: 400, width: 420, height: 80 },
    ],
    tweaks: [
      { id: "variant", type: "choice", label: "Variante", options: ["primary", "secondary", "ghost"], artboard: "components/button.html" },
      { id: "size", type: "choice", label: "Taille", options: ["sm", "md", "lg"], default: "md", artboard: "components/button.html" },
    ],
  };
  return (await (
    await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": JSON.stringify(manifest), "components/button.html": BUTTON, "components/tokens.html": TOKENS_ONLY } })
  ).json()) as DesignSystem;
}

it("tries a component in its sandbox, comments the instance there, and replays that trial from the thread", async () => {
  const ds = await designSystem();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);

  const buttons = tab.getByTestId("sandbox-button");
  await expect.poll(() => buttons.count()).toBe(2);
  // A component without a template cannot be tried.
  expect(await buttons.nth(1).getAttribute("aria-disabled")).toBe("true");
  await buttons.nth(1).click({ force: true });
  expect(await tab.locator("[data-sandbox]").count()).toBe(0);

  await buttons.nth(0).click();
  const card = tab.locator("[data-sandbox]");
  await card.waitFor();
  expect(await buttons.nth(0).getAttribute("aria-pressed")).toBe("true");
  const instance = card.locator("iframe").contentFrame().locator("#redline-sandbox");
  await expect.poll(() => instance.getAttribute("variant")).toBe("primary");
  expect(await instance.getAttribute("size")).toBe("md");
  expect(await card.getByText("défaut : md").count()).toBe(1);

  // Settings and slot texts change the lone instance, never the grid.
  await card.getByRole("button", { name: "ghost" }).click();
  await expect.poll(() => instance.getAttribute("variant")).toBe("ghost");
  const content = card.getByRole("textbox", { name: "Contenu" });
  expect(await content.inputValue()).toBe("Bouton");
  await content.fill("Enregistrer");
  await expect.poll(() => instance.locator("button").textContent()).toBe("Enregistrer");
  const cellVariant = tab.locator("[data-grid-cell] iframe").first().contentFrame().locator("ui-button");
  await expect.poll(() => cellVariant.getAttribute("variant")).toBe("primary");

  // A comment pinned in the preview keeps the trial.
  await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tab.keyboard.press("c");
  await instance.locator("button").click();
  await tab.locator("#new-comment").fill("Padding off");
  await tab.locator("#new-comment").press("Enter");
  await expect.poll(async () => ((await (await server.get(`/api/pages/${ds.pageId}/threads`)).json()) as Thread[]).length).toBe(1);
  const [thread] = (await (await server.get(`/api/pages/${ds.pageId}/threads`)).json()) as Thread[];
  expect(thread!.sandbox).toEqual({ values: { variant: "ghost", size: "md" }, slots: { "": "Enregistrer" } });
  await expect.poll(() => card.locator("[data-pin]").count()).toBe(1);
  expect(await tab.locator("[data-grid-cell] [data-pin]").count()).toBe(0);
  await expect.poll(() => buttons.nth(0).textContent()).toBe("Essayer1");
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("thread-sandbox").textContent()).toBe("Vu en bac à sable : ghost · md · Contenu « Enregistrer »");

  // Closed, the trial is forgotten; the thread brings it back.
  await tab.keyboard.press("p");
  await card.getByRole("button", { name: "Fermer le bac à sable" }).click();
  expect(await card.count()).toBe(0);
  await buttons.nth(0).click();
  await expect.poll(() => instance.getAttribute("variant")).toBe("primary");
  await card.getByRole("button", { name: "Fermer le bac à sable" }).click();
  await tab.getByTestId("thread-sandbox").click();
  await expect.poll(() => instance.getAttribute("variant")).toBe("ghost");
  expect(await card.getByRole("textbox", { name: "Contenu" }).inputValue()).toBe("Enregistrer");
  await expect.poll(() => card.locator("[data-pin]").count()).toBe(1);
}, 90_000);
