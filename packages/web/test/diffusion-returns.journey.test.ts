import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type Page, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const CAPTURES = "/private/tmp/claude-501/-Users-vincentperaud-claude-projects-redline/8d72028a-4256-4bb2-92f0-44d7375b5163/scratchpad/captures";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div><slot></slot></div></template></body></html>`;
const manifestOf = (file: string, designSystem?: string) => JSON.stringify({ ...(designSystem && { designSystem }), artboards: [{ file, x: 0, y: 0, width: 600, height: 400 }] });

it("shows the thread Redline reopens after a diffusion: 'rouvert' pill, message signed Redline, still answerable", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "manifest.json": manifestOf("components/modal.html"), "components/modal.html": MODAL } })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string };
  const planning = (await (await server.post(`/api/projects/${app.id}/pages`, { title: "Planning", files: { "manifest.json": manifestOf("planning.html", ds.id), "planning.html": `<!doctype html><body><ui-modal id="edit-mission"></ui-modal></body>` } })).json()) as Page;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agent = (path: string, body: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const comment = (await (await server.post(`/api/pages/${planning.id}/threads`, { artboard: "planning.html", selector: "#edit-mission", xPct: 10, yPct: 10, body: "Il faut une modale de 720 px pour ce formulaire." })).json()) as Thread;
  await agent(`/threads/${comment.id}/replies`, { body: "Demande ouverte au design system Lumora." });
  const request = (await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "720 px", artboard: "planning.html", selector: "#edit-mission", threadId: comment.id })).json()) as SendRequestResponse;
  const checkout = (await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${ds.pageId}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout;
  await agent(`/pages/${ds.pageId}/versions`, {
    files: { ...checkout.files, "components/modal.html": MODAL.replace("<div>", "<div class=wide>") },
    message: "Wide",
    origin: "thread",
    baseVersionId: checkout.versionId,
    changes: [{ component: "modal", label: "La taille 720 px", kind: "added", threadId: request.threadId }],
  });
  expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(201);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${planning.id}`);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const card = tab.locator(`[data-thread="${comment.id}"]`);
  await card.waitFor();
  expect(await card.getByTestId("reopened").textContent()).toBe("rouvert");
  const authors = await card.getByTestId("message-author").allTextContents();
  expect(authors).toEqual(["Toi", "Claude", "Redline"]);
  expect(await card.getByTestId("reply").last().textContent()).toContain("La taille 720 px : disponible dans ui-modal depuis la diffusion 2. Mets l'instance à jour.");
  expect(await card.getByRole("button", { name: "Répondre" }).count()).toBe(1);
  expect(await card.getByRole("button", { name: "Résoudre" }).count()).toBe(1);

  await tab.screenshot({ path: `${CAPTURES}/13-app-full.png` });
  await card.screenshot({ path: `${CAPTURES}/13-app-card.png` });
}, 60_000);
