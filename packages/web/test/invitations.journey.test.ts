import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const PASSWORD = "correct horse";

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let setupLink: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-invitations-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function newTab(): Promise<Page> {
  return (await browser.newContext()).newPage();
}

it("an admin invites two people from Comptes, one joins, the other is cancelled, and the member has no Comptes", async () => {
  const admin = await newTab();
  await admin.goto(setupLink);
  await admin.getByLabel("Nom").fill("Vincent Peraud");
  await admin.getByLabel("Email").fill("vincent@example.com");
  await admin.getByLabel("Mot de passe").fill(PASSWORD);
  await admin.getByRole("button", { name: "Créer le compte et entrer" }).click();
  await admin.getByRole("link", { name: "Comptes" }).click();
  await admin.getByRole("heading", { name: "Comptes" }).waitFor();
  await admin.getByText("1 compte · 0 invitation en attente · connexion Redline").waitFor();

  const invite = async (email: string) => {
    await admin.getByRole("button", { name: "Inviter quelqu'un" }).click();
    await admin.getByLabel("Email").fill(email);
    await admin.getByRole("button", { name: "Créer le lien d'invitation" }).click();
    await admin.getByText(`Invitation créée pour ${email}, comme membre.`).waitFor();
    const link = await admin.locator("input[readonly]").inputValue();
    await admin.getByRole("button", { name: "Terminé" }).click();
    return link;
  };
  const marcLink = await invite("marc@example.com");
  const ghostLink = await invite("ghost@example.com");
  expect(marcLink).toMatch(/#\/invitation\/[A-Za-z0-9_-]{20,}$/);
  await admin.getByText("1 compte · 2 invitations en attente").waitFor();
  await admin.getByText("Invitation · expire le").first().waitFor();

  // The invitee chooses a name and a password.
  const marc = await newTab();
  await marc.goto(marcLink);
  await marc.getByRole("heading", { name: "Rejoindre Redline" }).waitFor();
  expect(await marc.getByLabel("Email").inputValue()).toBe("marc@example.com");
  await marc.getByLabel("Ton nom").fill("Marc Durand");
  await marc.getByLabel("Mot de passe").fill("short");
  await marc.getByRole("button", { name: "Créer mon compte" }).click();
  await marc.getByText("8 caractères au moins.").waitFor();
  await marc.getByLabel("Mot de passe").fill(PASSWORD);
  await marc.getByRole("button", { name: "Créer mon compte" }).click();
  await expect.poll(() => marc.getByTestId("account-block").innerText()).toContain("Marc Durand");

  // A member has no Comptes entry, and its address is the no-access screen.
  expect(await marc.getByRole("link", { name: "Comptes" }).count()).toBe(0);
  await marc.goto(`${server.url}/#/accounts`);
  await marc.getByRole("heading", { name: "Réservé aux admins" }).waitFor();

  // The link has served: it now says it no longer works.
  const again = await newTab();
  await again.goto(marcLink);
  await again.getByRole("heading", { name: "Ce lien ne marche plus" }).waitFor();

  // The admin sees Marc as an account, cancels the other invitation, whose link dies.
  await admin.reload();
  await admin.getByText("2 comptes · 1 invitation en attente").waitFor();
  await admin.getByText("Marc Durand").waitFor();
  await admin.getByRole("button", { name: "Annuler" }).click();
  await admin.getByText("2 comptes · 0 invitation en attente").waitFor();
  const ghost = await newTab();
  await ghost.goto(ghostLink);
  await ghost.getByRole("heading", { name: "Ce lien ne marche plus" }).waitFor();
}, 120_000);
