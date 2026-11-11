import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
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

const manifestOf = (...files: string[]) =>
  JSON.stringify({ artboards: files.map((file, i) => ({ file, width: 400, height: 300, x: i * 480, y: 0 })), elements: [], links: [], tweaks: [] });

const html = (heading: string) => `<!doctype html><h1>${heading}</h1>`;

async function createPage(title: string, files: Record<string, string>): Promise<Page> {
  const project = (await (await server.post("/api/projects", { title: `Project of ${title}` })).json()) as { id: string };
  return (await (await server.post(`/api/projects/${project.id}/pages`, { title, files })).json()) as Page;
}

it("previews an old version of one artboard in place, restores it, and undoes the restore from the toast", async () => {
  const page = await createPage("Landing", { "home.html": html("Version one") });
  await server.post(`/api/pages/${page.id}/versions`, {
    files: { "home.html": html("Version two") },
    message: "Second title",
    origin: "thread",
  });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version two");

  await tab.getByRole("button", { name: "Historique de home.html" }).click();
  const popover = tab.getByRole("dialog", { name: "Historique de home.html" });
  await popover.getByText("Historique · home").waitFor();
  const versions = popover.getByTestId("history-version");
  await expect.poll(() => versions.count()).toBe(2);
  await expect(versions.first().textContent()).resolves.toContain("Second title");
  await expect(versions.first().textContent()).resolves.toContain("actuelle");
  await expect(versions.nth(1).textContent()).resolves.toContain("Artboard créé");

  // Preview: the artboard shows the old version, nothing changed on the server yet.
  await versions.nth(1).click();
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version one");
  await popover.getByText("L'artboard affiche cette version. Rien ne change tant que tu ne restaures pas.").waitFor();
  expect(((await (await server.get(`/api/pages/${page.id}`)).json()) as Page).version.files["home.html"]).toBeDefined();

  // Cancel goes back to the live artboard.
  await popover.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version two");

  // Restore, then undo from the toast.
  await versions.nth(1).click();
  await popover.getByRole("button", { name: "Restaurer cette version" }).click();
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version one");
  const toast = tab.getByTestId("undo-toast");
  await expect(toast.textContent()).resolves.toMatch(/Version du .* restaurée\s*·\s*Annuler/);

  await toast.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version two");
  await toast.waitFor({ state: "detached" });
}, 60_000);

it("lists deleted artboards in the page menu and puts one back, with an undo", async () => {
  const page = await createPage("Flow", { "manifest.json": manifestOf("a.html", "b.html"), "a.html": html("Artboard A"), "b.html": html("Artboard B") });
  await server.post(`/api/pages/${page.id}/versions`, {
    files: { "manifest.json": manifestOf("a.html"), "a.html": html("Artboard A") },
    message: "Drop B",
    origin: "thread",
  });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await expect.poll(() => tab.locator("iframe").count()).toBe(1);

  await tab.getByRole("button", { name: "Flow", exact: false }).first().click();
  await tab.getByRole("menuitem", { name: /Artboards supprimés/ }).click();
  const list = tab.getByRole("dialog", { name: "Artboards supprimés" });
  const entry = list.getByTestId("deleted-artboard");
  await expect(entry.textContent()).resolves.toContain("b.html");
  await expect(entry.textContent()).resolves.toContain("Supprimé par Claude · fil");

  await entry.getByRole("button", { name: "Remettre" }).click();
  await expect.poll(() => tab.locator("iframe").count()).toBe(2);
  await expect(tab.getByTestId("undo-toast").textContent()).resolves.toContain("Remis depuis les artboards supprimés");

  await tab.getByTestId("undo-toast").getByRole("button", { name: "Annuler" }).click();
  await expect.poll(() => tab.locator("iframe").count()).toBe(1);

  // Nothing deleted any more would hide the menu entry; here B is deleted again.
  await tab.getByRole("button", { name: "Flow", exact: false }).first().click();
  await tab.getByRole("menuitem", { name: /Artboards supprimés/ }).waitFor();
}, 60_000);

it("hides the deleted artboards entry when nothing was deleted", async () => {
  const page = await createPage("Intact", { "home.html": html("Hello") });
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await expect.poll(() => tab.locator("iframe").count()).toBe(1);
  await tab.getByRole("button", { name: "Intact", exact: false }).first().click();
  await tab.getByRole("menuitem", { name: "Vue du projet" }).waitFor();
  expect(await tab.getByRole("menuitem", { name: /Artboards supprimés/ }).count()).toBe(0);
}, 60_000);
