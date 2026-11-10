import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_ENDPOINT, PROTOCOL_VERSION, type AgentTokenResponse, type Project } from "@redline/shared";
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
  dataDir = mkdtempSync(join(tmpdir(), "redline-agent-tokens-"));
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

async function joinAs(admin: BrowserContext, email: string, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const response = await admin.request.post(`${server.url}/api/accounts/invitations`, { data: { email, role: "member" } });
  const { token } = (await response.json()) as { token: string };
  const signed = await newContext();
  await signed.page.goto(`${server.url}/#/invitation/${token}`);
  await signed.page.getByLabel("Ton nom").fill(name);
  await signed.page.getByLabel("Mot de passe").fill(PASSWORD);
  await signed.page.getByRole("button", { name: "Créer mon compte" }).click();
  await signed.page.getByTestId("account-block").waitFor();
  return signed;
}

function connect(token: string, folder: string, projectId?: string): { opened: Promise<unknown>; closed: Promise<number> } {
  const socket = new WebSocket(server.url.replace(/^http/, "ws") + AGENT_ENDPOINT);
  const opened = new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "mac", folder, kind: "project", projectId })));
  return { opened, closed };
}

it("shows a personal token, who launched each agent, masks a Privé project, and drops only the regenerating person's agents", async () => {
  const { context: adminContext, page: admin } = await newContext();
  await admin.goto(setupLink);
  await admin.getByLabel("Nom").fill("Vincent Peraud");
  await admin.getByLabel("Email").fill("vincent@example.com");
  await admin.getByLabel("Mot de passe").fill(PASSWORD);
  await admin.getByRole("button", { name: "Créer le compte et entrer" }).click();
  await admin.getByTestId("account-block").waitFor();
  const { context: arianeContext, page: ariane } = await joinAs(adminContext, "ariane@example.com", "Ariane Martin");

  const tokenOf = async (context: BrowserContext) => ((await (await context.request.get(`${server.url}/api/agent-token`)).json()) as AgentTokenResponse).token;
  const [adminToken, arianeToken] = [await tokenOf(adminContext), await tokenOf(arianeContext)];
  expect(adminToken).not.toBe(arianeToken);

  const secret = (await (await adminContext.request.post(`${server.url}/api/projects`, { data: { title: "Secret", visibility: "private" } })).json()) as Project;
  const adminAgent = connect(adminToken, "/work/alpha", secret.id);
  const arianeAgent = connect(arianeToken, "/work/ariane");
  await Promise.all([adminAgent.opened, arianeAgent.opened]);

  await ariane.goto(`${server.url}/#/agents`);
  const rows = ariane.getByTestId("agent-card");
  await rows.nth(1).waitFor();
  expect(await rows.filter({ hasText: "Vincent Peraud" }).getByText("Projet privé").count()).toBe(1);
  expect(await ariane.getByText("Secret").count()).toBe(0);
  expect(await rows.filter({ hasText: "Ariane Martin" }).count()).toBe(1);

  await ariane.getByRole("button", { name: "Lancer un agent" }).click();
  const panel = ariane.getByRole("complementary", { name: "Lancer un agent" });
  await panel.getByText("Personnel : ne le donne à personne. Le régénérer ne déconnecte que tes agents.").waitFor();
  ariane.once("dialog", (dialog) => void dialog.accept());
  await panel.getByRole("button", { name: "Régénérer" }).click();
  expect(await arianeAgent.closed).toBe(4401);
  expect(await tokenOf(arianeContext)).not.toBe(arianeToken);
  expect(await tokenOf(adminContext)).toBe(adminToken);
  expect(await ariane.getByText("Hors ligne").count()).toBeGreaterThan(0);
  await adminContext.close();
  await arianeContext.close();
}, 60_000);
