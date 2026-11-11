import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const HUMAN = "h".repeat(32);
const LOGOUT = "https://auth.example.com/logout";
const sso = (user: string, name: string, email: string) => ({ "x-redline-proxy-secret": HUMAN, "remote-user": user, "remote-name": name, "remote-email": email });

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-proxy-accounts-"));
  copyBuiltWeb(webDir);
  server = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    authMode: "proxy",
    firstAdminEmail: "vincent@example.com",
    proxySecrets: { human: HUMAN, machine: "m".repeat(32) },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email", logoutUrl: LOGOUT },
  });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function tabAs(headers: Record<string, string>): Promise<Page> {
  return (await browser.newContext({ extraHTTPHeaders: headers })).newPage();
}

it("the first SSO person becomes admin and adds people by e-mail, a stranger sees who to ask, the added person gets in", async () => {
  const admin = await tabAs(sso("vincent", "Vincent Peraud", "vincent@example.com"));
  await admin.goto(server.url);
  await admin.getByRole("link", { name: "Comptes" }).click();
  await admin.getByRole("heading", { name: "Comptes" }).waitFor();
  await admin.getByText("1 compte · 0 ajout en attente · connexion par Authelia").waitFor();
  await admin.getByText("Connexion par Authelia : chacun entre avec son compte Authelia").waitFor();

  // The sign-out of the account menu leads to the SSO.
  await admin.getByTestId("account-block").click();
  expect(await admin.getByRole("menuitem", { name: "Se déconnecter" }).getAttribute("href")).toBe(LOGOUT);
  await admin.keyboard.press("Escape");

  const add = async (email: string) => {
    await admin.getByRole("button", { name: "Ajouter quelqu'un" }).click();
    await admin.getByRole("heading", { name: "Ajouter quelqu'un" }).waitFor();
    await admin.getByText("La personne entre avec son compte Authelia").waitFor();
    await admin.getByLabel("Email").fill(email);
    await admin.getByRole("button", { name: "Ajouter", exact: true }).click();
    await admin.getByText(email).waitFor();
  };
  await add("marc@example.com");
  await add("ghost@example.com");
  await admin.getByText("1 compte · 2 ajouts en attente · connexion par Authelia").waitFor();
  expect(await admin.getByText("En attente de sa première connexion").count()).toBe(2);
  expect(await admin.getByText("ajouté par Vincent Peraud").count()).toBe(2);
  expect(await admin.getByRole("button", { name: "Copier le lien" }).count()).toBe(0);

  // A person the list does not know is told whom to ask.
  const stranger = await tabAs(sso("ariane", "Ariane Martin", "ariane@example.com"));
  await stranger.goto(server.url);
  await stranger.getByRole("heading", { name: "Tu n'as pas accès à Redline" }).waitFor();
  const text = await stranger.locator("main").innerText();
  expect(text).toContain("ariane@example.com");
  expect(text).toContain("Vincent Peraud");
  await stranger.getByRole("button", { name: "Se déconnecter" }).waitFor();

  // An added person gets in at their first sign-in, with no Comptes entry as a member.
  const marc = await tabAs(sso("mdurand", "Marc Durand", "marc@example.com"));
  await marc.goto(server.url);
  await expect.poll(() => marc.getByTestId("account-block").innerText()).toContain("Marc Durand");
  expect(await marc.getByRole("link", { name: "Comptes" }).count()).toBe(0);

  // The other pending entry is cancelled.
  await admin.reload();
  await admin.getByText("2 comptes · 1 ajout en attente").waitFor();
  await admin.getByRole("button", { name: "Annuler" }).click();
  await admin.getByText("2 comptes · 0 ajout en attente").waitFor();
}, 60_000);
