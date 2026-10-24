import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Project } from "@redline/shared";
import { FakeEngine, startSeam2, type FakeAction, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine((run): FakeAction[] => {
  const threadId = /thread id: ([0-9a-f-]{36})/.exec(run.message)?.[1];
  return [
    { callTool: { name: "create_page", arguments: { title: "Pricing" } } },
    ...(threadId ? [{ replyInThread: { threadId, text: "Pricing page added" } } satisfies FakeAction] : []),
    { type: "result", summary: "Created Pricing" },
  ];
});

const ARTBOARD = `<!doctype html><html><body><h1>Welcome</h1><button id="go">Continuer</button></body></html>`;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("names the commented element, then shows the page Claude created under its answer and in the page menu", async () => {
  const page = await seam.createPage({ "home.html": ARTBOARD });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);

  await tab.getByRole("button", { name: "Commenter (C)" }).click();
  await tab.frameLocator("iframe").locator("#go").click();
  await tab.getByRole("tab", { name: /Commentaires/ }).waitFor();
  await tab.getByText("Commentaire sur").waitFor();
  expect(await tab.locator("code", { hasText: "bouton « Continuer »" }).count()).toBe(1);

  await tab.getByLabel("Nouveau commentaire").fill("Make a pricing page");
  await tab.getByLabel("Nouveau commentaire").press("Enter");
  await engine.finished(1);
  await seam.waitForWorkEnd();

  const [thread] = (await (await seam.server.get(`/api/pages/${page.id}/threads`)).json()) as { elementName: string | null; selector: string }[];
  expect(thread.elementName).toBe("bouton « Continuer »");
  expect(thread.selector).toBe("#go");
  await expect.poll(() => tab.getByText("home.html · bouton « Continuer »").count()).toBe(1);
  const pin = tab.locator("[data-pin]");
  expect(await pin.getAttribute("title")).toContain("home.html · bouton « Continuer »");

  const card = tab.getByTestId("created-page");
  await card.waitFor();
  expect((await card.textContent())?.replace(/\s+/g, " ")).toContain("Pricing · 0 artboard");

  await tab.getByRole("button", { name: page.title ?? "Untitled", exact: false }).first().click();
  const created = tab.getByRole("menuitem", { name: /Pricing/ });
  await expect(created.textContent()).resolves.toContain("créée par Claude");
  await tab.keyboard.press("Escape");

  await card.click();
  await expect.poll(() => tab.url()).not.toContain(page.id);
  await tab.getByTestId("canvas-empty").waitFor();
}, 60_000);

it("shows exchange counts in the conversation list and the created page under Claude's message", async () => {
  const page = await seam.createPage({ "home.html": ARTBOARD });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByLabel("Message à Claude").fill("Add a pricing page");
  await panel.getByLabel("Message à Claude").press("Enter");
  await panel.getByTestId("created-page").waitFor();
  expect((await panel.getByTestId("created-page").textContent())?.replace(/\s+/g, " ")).toContain("Pricing · 0 artboard");

  await panel.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect.poll(() => panel.getByRole("listbox").textContent()).toContain("1 échange · à l'instant");
}, 60_000);

it("renames the project and a page inline: Enter saves, Escape cancels, an empty name is refused", async () => {
  const seeded = await seam.createPage({ "home.html": ARTBOARD });
  const project = (await (await seam.server.get(`/api/projects/${seeded.projectId}`)).json()) as Project;
  const page = (await (await seam.server.post(`/api/projects/${project.id}/pages`, { title: "Unique page", files: { "home.html": ARTBOARD } })).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/projects/${project.id}`);

  await tab.getByRole("button", { name: "Renommer le projet" }).focus();
  await tab.keyboard.press("Enter");
  const input = tab.getByLabel("Nom du projet");
  await input.fill("Abandoned");
  await tab.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });
  expect(((await (await seam.server.get(`/api/projects/${project.id}`)).json()) as Project).title).toBe(project.title);

  await tab.getByRole("button", { name: "Renommer le projet" }).click();
  await input.fill("   ");
  await input.press("Enter");
  expect(await input.isVisible()).toBe(true);
  expect(((await (await seam.server.get(`/api/projects/${project.id}`)).json()) as Project).title).toBe(project.title);
  await input.fill("Renamed project");
  await input.press("Enter");
  await tab.getByRole("heading", { name: "Renamed project" }).waitFor();
  expect(((await (await seam.server.get(`/api/projects/${project.id}`)).json()) as Project).title).toBe("Renamed project");

  const card = tab.getByTestId("page-card").filter({ hasText: page.title });
  await card.hover();
  await card.getByRole("button", { name: "Renommer la page" }).click();
  await tab.getByLabel("Nom de la page").fill("Renamed page");
  await tab.getByRole("button", { name: "OK" }).click();
  await tab.getByTestId("page-card").filter({ hasText: "Renamed page" }).waitFor();
  expect(((await (await seam.server.get(`/api/pages/${page.id}`)).json()) as Page).title).toBe("Renamed page");

  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: "Renommer la page" }).click({ force: true });
  await tab.getByLabel("Nom de la page").fill("Canvas title");
  await tab.keyboard.press("Enter");
  await tab.getByRole("button", { name: "Canvas title", exact: false }).first().waitFor();
  expect(((await (await seam.server.get(`/api/pages/${page.id}`)).json()) as Page).title).toBe("Canvas title");
}, 60_000);
