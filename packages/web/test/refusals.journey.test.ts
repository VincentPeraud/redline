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
const captures = process.env.REDLINE_CAPTURES;

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

async function setup() {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "manifest.json": manifestOf("components/modal.html"), "components/modal.html": MODAL } })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string };
  const planning = (await (await server.post(`/api/projects/${app.id}/pages`, { title: "Planning", files: { "manifest.json": manifestOf("planning.html", ds.id), "planning.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` } })).json()) as Page;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ask = async (missing: string) =>
    ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", artboard: "planning.html", selector: "#edit", missing })).json()) as SendRequestResponse).threadId;
  let version = 0;
  const publish = async (changes: object[]) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${ds.pageId}/versions`, { files: { ...checkout.files, "components/modal.html": MODAL.replace("modal", `modal v${++version}`) }, message: "Edit", origin: "thread", baseVersionId: checkout.versionId, changes });
  };
  return { ds, planning, ask, publish };
}

it("refuses a change from the review: annulation en cours blocks Diffuser until the session undoes it", async () => {
  const { ds, ask, publish } = await setup();
  const request = await ask("Ajouter une taille 720 px");
  await publish([
    { component: "modal", label: "Taille 720 px", kind: "added", threadId: request },
    { component: "modal", label: "Croix ronde", kind: "modified", threadId: request },
  ]);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await tab.getByRole("button", { name: /Diffuser aux projets/ }).click();
  const dialog = tab.getByRole("dialog");
  await dialog.waitFor();
  const rows = dialog.getByTestId("review-change");
  expect(await rows.getByRole("button", { name: "Refuser" }).count()).toBe(2);
  expect(await dialog.textContent()).toContain("Refuser un changement le défait dans le brouillon et prévient le projet qui l'a demandé.");

  await rows.filter({ hasText: "Taille 720 px" }).getByRole("button", { name: "Refuser" }).click();
  await tab.getByRole("dialog", { name: /^Refuser/ }).getByTestId("refuse-confirm").click();
  await dialog.getByTestId("change-undoing").waitFor();
  expect(await dialog.getByTestId("change-undoing").textContent()).toBe("annulation en cours");
  expect(await rows.getByRole("button", { name: "Refuser" }).count()).toBe(1);
  expect(await dialog.getByRole("button", { name: "Diffuser", exact: true }).isDisabled()).toBe(true);
  if (captures) await tab.screenshot({ path: join(captures, "14-app-review.png") });

  await publish([{ component: "modal", label: "Taille retirée", kind: "modified", threadId: request }]);
  await expect.poll(async () => dialog.getByRole("button", { name: "Diffuser", exact: true }).isDisabled(), { timeout: 8000 }).toBe(false);
  expect(await dialog.getByTestId("change-undoing").count()).toBe(0);
  await tab.close();
}, 30_000);

it("refuses a request from its card", async () => {
  const { ds, ask, publish } = await setup();
  const request = await ask("Ajouter une taille 720 px");
  await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const card = tab.locator(`[data-thread="${request}"]`);
  await card.waitFor();
  if (captures) await card.screenshot({ path: join(captures, "14-app-request-card.png") });
  await card.getByRole("button", { name: "Refuser" }).click();
  await tab.getByRole("dialog", { name: /^Refuser la demande/ }).getByTestId("refuse-answer").fill("Pas pour ce lot");
  if (captures) await tab.screenshot({ path: join(captures, "fix-refuse-dialog.png") });
  await tab.getByRole("dialog", { name: /^Refuser la demande/ }).getByTestId("refuse-confirm").click();

  await expect.poll(async () => ((await (await server.get(`/api/pages/${ds.pageId}/threads`)).json()) as Thread[]).find((t) => t.id === request)!.request!.state).toBe("refused");
  await expect.poll(async () => tab.locator(`[data-thread="${request}"]`).getByRole("button", { name: "Refuser" }).count()).toBe(0);
  await tab.close();
}, 30_000);
