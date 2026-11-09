import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { hashPassword } from "../../server/src/accounts.js";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "correct horse";
const JSON_HEADERS = { "content-type": "application/json" };

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let setupLink = "";

async function cookieOf(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
}

async function tabFor(email: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "redline_session", value: await cookieOf(email), url: server.url }]);
  return context.newPage();
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-visibility-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  const hash = await hashPassword(PASSWORD);
  for (const [name, email] of [["Ariane Martin", "ariane@example.com"], ["Thomas Lefevre", "thomas@example.com"]]) {
    db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(randomUUID(), name, email, new Date().toISOString(), hash);
  }
  db.close();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

it("creates a Privé project, shows it with its badge to its creator only, and tells others who to ask", async () => {
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects`);
  await ariane.getByRole("button", { name: "Nouveau projet" }).first().click();
  const dialog = ariane.getByRole("dialog", { name: "Nouveau projet" });
  expect(await dialog.getByRole("radio", { name: /Équipe/ }).isChecked()).toBe(true);
  await dialog.getByRole("radio", { name: /Privé/ }).check();
  await dialog.getByLabel("Titre").fill("Maquettes perso");
  await dialog.getByRole("button", { name: "Créer le projet" }).click();
  await ariane.getByRole("heading", { name: "Maquettes perso" }).waitFor();
  expect(await ariane.getByTestId("visibility-badge").innerText()).toBe("Privé");
  const projectUrl = ariane.url();

  await ariane.goto(`${server.url}/#/projects`);
  const card = ariane.locator("a", { hasText: "Maquettes perso" });
  await card.waitFor();
  expect(await card.getByTestId("visibility-badge").innerText()).toBe("Privé");
  expect(await card.innerText()).toContain("créé par Ariane Martin");

  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects`);
  await thomas.getByRole("button", { name: "Nouveau projet" }).first().waitFor();
  expect(await thomas.getByText("Maquettes perso").count()).toBe(0);
  await thomas.goto(projectUrl);
  await thomas.getByRole("heading", { name: "Pas d'accès à ce projet" }).waitFor();
  await thomas.getByText("Demande à Ariane Martin, qui l'a créé, de t'y ajouter.").waitFor();
  await thomas.getByRole("button", { name: "Retour à l'accueil" }).click();
  await thomas.getByRole("heading", { name: "Accueil" }).waitFor();
}, 60_000);

it("switches an Équipe project to Privé after listing who loses access, and back", async () => {
  const ariane = await tabFor("ariane@example.com");
  const cookie = `redline_session=${await cookieOf("ariane@example.com")}`;
  const project = (await (await fetch(`${server.url}/api/projects`, { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ title: "Agora" }) })).json()) as Project;
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("heading", { name: "Agora" }).waitFor();
  expect(await ariane.getByTestId("visibility-badge").innerText()).toBe("Équipe");

  await ariane.getByRole("button", { name: "Partager", exact: true }).click();
  const sharing = ariane.getByRole("dialog", { name: "Partager le projet Agora" });
  await sharing.getByText("Tous les membres voient ce projet et y ont accès en Écriture.").waitFor();
  await sharing.getByRole("radio", { name: "Privé" }).click();
  const confirm = ariane.getByRole("dialog", { name: "Passer « Agora » en privé ?" });
  expect(await confirm.getByTestId("lose-access").innerText()).toContain("Thomas Lefevre");
  await confirm.getByRole("button", { name: "Annuler" }).click();
  expect(await ariane.getByTestId("visibility-badge").innerText()).toBe("Équipe");

  await sharing.getByRole("radio", { name: "Privé" }).click();
  await ariane.getByRole("dialog", { name: "Passer « Agora » en privé ?" }).getByRole("button", { name: "Passer en privé" }).click();
  await expect.poll(() => ariane.getByTestId("visibility-badge").innerText()).toBe("Privé");
  await ariane.getByRole("dialog", { name: "Partager le projet Agora" }).getByText("Seuls toi, les admins et les membres ajoutés ci-dessous voient ce projet.").waitFor();

  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects/${project.id}`);
  await thomas.getByRole("heading", { name: "Pas d'accès à ce projet" }).waitFor();

  await ariane.getByRole("dialog", { name: "Partager le projet Agora" }).getByRole("radio", { name: "Équipe" }).click();
  await expect.poll(() => ariane.getByTestId("visibility-badge").innerText()).toBe("Équipe");
  await thomas.reload();
  await thomas.getByRole("heading", { name: "Agora" }).waitFor();
  expect(await thomas.getByRole("button", { name: "Partager", exact: true }).count()).toBe(0);
}, 60_000);
