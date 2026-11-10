import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, BrowserContext, Page } from "playwright";
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
  dataDir = mkdtempSync(join(tmpdir(), "redline-management-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function newContext(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** A member joins through an invitation the admin created; the returned page is signed in as them. */
async function joinAs(admin: BrowserContext, email: string, name: string): Promise<Page> {
  const response = await admin.request.post(`${server.url}/api/accounts/invitations`, { data: { email, role: "member" } });
  const { token } = (await response.json()) as { token: string };
  const { page } = await newContext();
  await page.goto(`${server.url}/#/invitation/${token}`);
  await page.getByLabel("Ton nom").fill(name);
  await page.getByLabel("Mot de passe").fill(PASSWORD);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.getByTestId("account-block").waitFor();
  return page;
}

it("an admin changes roles, hands out a password link and deactivates; a member edits Mon compte", async () => {
  const { context: adminContext, page: admin } = await newContext();
  await admin.goto(setupLink);
  await admin.getByLabel("Nom").fill("Vincent Peraud");
  await admin.getByLabel("Email").fill("vincent@example.com");
  await admin.getByLabel("Mot de passe").fill(PASSWORD);
  await admin.getByRole("button", { name: "Créer le compte et entrer" }).click();
  await admin.getByTestId("account-block").waitFor();
  const ariane = await joinAs(adminContext, "ariane@example.com", "Ariane Martin");
  const thomas = await joinAs(adminContext, "thomas@example.com", "Thomas Lefèvre");

  await admin.getByRole("link", { name: "Comptes" }).click();
  await admin.getByRole("heading", { name: "Comptes" }).waitFor();
  // The only admin can neither be lowered nor deactivated.
  await admin.getByText("Seul admin : il en faut au moins un").waitFor();
  expect(await admin.getByRole("button", { name: "Désactiver" }).count()).toBe(2);

  // Promotion asks first; the dialog can be cancelled.
  const role = admin.getByLabel("Rôle d'Ariane Martin");
  await role.selectOption("admin");
  await admin.getByRole("dialog", { name: "Passer Ariane Martin admin ?" }).waitFor();
  await admin.getByRole("button", { name: "Annuler" }).click();
  expect(await role.inputValue()).toBe("member");
  await role.selectOption("admin");
  await admin.getByRole("button", { name: "Passer admin" }).click();
  await expect.poll(() => role.inputValue()).toBe("admin");
  await ariane.goto(`${server.url}/#/accounts`);
  await ariane.reload();
  await ariane.getByRole("heading", { name: "Comptes" }).waitFor();
  // Demotion is direct.
  await role.selectOption("member");
  await expect.poll(() => role.inputValue()).toBe("member");

  // A password link for Thomas: he chooses a password with it, and his other device is signed out.
  const thomasRow = admin.getByRole("row", { name: /Thomas Lefèvre/ });
  await thomasRow.getByRole("button", { name: "Lien mot de passe" }).click();
  const dialog = admin.getByRole("dialog", { name: "Lien de mot de passe" });
  await dialog.getByText("Envoie ce lien à Thomas Lefèvre").waitFor();
  const link = await dialog.locator("input[readonly]").inputValue();
  expect(link).toMatch(/#\/mot-de-passe\/[A-Za-z0-9_-]{20,}$/);
  await dialog.getByRole("button", { name: "Terminé" }).click();
  const fresh = (await newContext()).page;
  await fresh.goto(link);
  await fresh.getByRole("heading", { name: "Nouveau mot de passe" }).waitFor();
  await fresh.getByLabel("Nouveau mot de passe").fill("short");
  await fresh.getByRole("button", { name: "Enregistrer et entrer" }).click();
  await fresh.getByText("8 caractères au moins.").waitFor();
  await fresh.getByLabel("Nouveau mot de passe").fill("a new password");
  await fresh.getByRole("button", { name: "Enregistrer et entrer" }).click();
  await fresh.getByTestId("account-block").waitFor();
  await thomas.reload();
  await thomas.getByRole("heading", { name: "Se connecter" }).waitFor();
  const used = (await newContext()).page;
  await used.goto(link);
  await used.getByRole("heading", { name: "Ce lien ne marche plus" }).waitFor();

  // Deactivation: dialog, then the account is off and signed out; it can be brought back.
  await thomasRow.getByRole("button", { name: "Désactiver" }).click();
  await admin.getByRole("alertdialog", { name: "Désactiver Thomas Lefèvre ?" }).waitFor();
  await admin.getByText("Thomas ne pourra plus se connecter.").waitFor();
  await admin.getByRole("button", { name: "Désactiver", exact: true }).last().click();
  await thomasRow.getByText("Désactivé").waitFor();
  await fresh.reload();
  await fresh.getByRole("heading", { name: "Se connecter" }).waitFor();
  await thomasRow.getByRole("button", { name: "Réactiver" }).click();
  await thomasRow.getByText("Actif").waitFor();

  // Mon compte: name, then password (the current one is required).
  await ariane.getByTestId("account-block").click();
  await ariane.getByRole("menuitem", { name: "Mon compte" }).click();
  await ariane.getByRole("heading", { name: "Mon compte", level: 1 }).waitFor();
  await ariane.getByLabel("Nom").fill("Ariane M.");
  await ariane.getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(() => ariane.getByTestId("account-block").innerText()).toContain("Ariane M.");

  await ariane.getByLabel("Mot de passe actuel").fill("not it");
  await ariane.getByLabel("Nouveau mot de passe").fill("another password");
  await ariane.getByRole("button", { name: "Changer le mot de passe" }).click();
  await ariane.getByText("Le mot de passe actuel n'est pas le bon.").waitFor();
  await ariane.getByLabel("Mot de passe actuel").fill(PASSWORD);
  await ariane.getByRole("button", { name: "Changer le mot de passe" }).click();
  await ariane.getByText("Mot de passe changé.").waitFor();
  await ariane.reload();
  await ariane.getByRole("heading", { name: "Mon compte", level: 1 }).waitFor();
}, 120_000);
