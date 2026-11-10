import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "correct horse";

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let setupLink: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-signin-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    authMode: "local",
    log: (line) => {
      setupLink = line.slice(line.indexOf("http"));
    },
  });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

it("creates the first admin from the setup link, signs out, then signs in again", async () => {
  const tab = await (await browser.newContext()).newPage();

  // Not signed in: the sign-in screen, whatever the address.
  await tab.goto(`${server.url}/#/projects`);
  await tab.getByRole("heading", { name: "Se connecter" }).waitFor();

  await tab.goto(setupLink);
  await tab.getByRole("heading", { name: "Créer le compte admin" }).waitFor();
  await tab.getByLabel("Nom").fill("Vincent Peraud");
  await tab.getByLabel("Email").fill("vincent@example.com");
  await tab.getByLabel("Mot de passe").fill("short");
  await tab.getByRole("button", { name: "Créer le compte et entrer" }).click();
  await tab.getByText("8 caractères au moins.").waitFor();
  await tab.getByLabel("Mot de passe").fill(PASSWORD);
  await tab.getByRole("button", { name: "Créer le compte et entrer" }).click();

  const block = tab.getByTestId("account-block");
  await expect.poll(() => block.innerText()).toContain("Vincent Peraud");

  await block.click();
  await tab.getByRole("menuitem", { name: "Se déconnecter" }).click();
  await tab.getByRole("heading", { name: "Se connecter" }).waitFor();
  await tab.getByText("Tu es déconnecté.").waitFor();

  await tab.getByLabel("Email").fill("vincent@example.com");
  await tab.getByLabel("Mot de passe").fill("wrong password");
  await tab.getByRole("button", { name: "Se connecter" }).click();
  await tab.getByText("Email ou mot de passe incorrect.").waitFor();

  await tab.getByLabel("Mot de passe").fill(PASSWORD);
  await tab.getByRole("button", { name: "Se connecter" }).click();
  await expect.poll(() => tab.getByTestId("account-block").innerText()).toContain("Vincent Peraud");

  // The setup link is single use: opened again, it says so.
  const other = await (await browser.newContext()).newPage();
  await other.goto(setupLink);
  await other.getByRole("heading", { name: "Lien déjà utilisé" }).waitFor();
}, 90_000);

it("locks the form after five wrong passwords", async () => {
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(`${server.url}/`);
  await tab.getByLabel("Email").fill("vincent@example.com");
  for (let i = 0; i < 5; i++) {
    await tab.getByLabel("Mot de passe").fill(`bad ${i}`);
    await tab.getByRole("button", { name: "Se connecter" }).click();
    if (i < 4) await tab.getByText("Email ou mot de passe incorrect.").waitFor();
  }
  await tab.getByText(/Trop d'essais/).waitFor();
  expect(await tab.getByRole("button", { name: "Se connecter" }).isDisabled()).toBe(true);
}, 60_000);
