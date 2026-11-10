import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentTokenResponse, type DesignSystem, type Page, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

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

it("shows requests to the design system as cards without Résoudre, counts them on the artboard header and lists them on the overview", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "manifest.json": manifestOf("components/modal.html"), "components/modal.html": MODAL } })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string };
  const planning = (await (await server.post(`/api/projects/${app.id}/pages`, { title: "Planning", files: { "manifest.json": manifestOf("planning.html", ds.id), "planning.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` } })).json()) as Page;
  const comment = (await (await server.post(`/api/pages/${planning.id}/threads`, { artboard: "planning.html", selector: "#edit", xPct: 10, yPct: 10, body: "La croix doit être ronde." })).json()) as Thread;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const send = async (body: object) =>
    (await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${planning.id}/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ component: "ui-modal", artboard: "planning.html", selector: "#edit", ...body }),
    })).json()) as SendRequestResponse;
  const own = await send({ missing: "Ajouter une taille 720 px à ui-modal, pour le formulaire d'édition d'une mission." });
  const routed = await send({ missing: "Round close cross", threadId: comment.id });
  const plain = (await (await server.post(`/api/pages/${ds.pageId}/threads`, { target: { kind: "artboard", artboard: "components/modal.html" }, body: "Le titre peut passer en 18 px ?" })).json()) as Thread;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await tab.getByTestId("artboard-requests").waitFor();
  expect(await tab.getByTestId("artboard-requests").textContent()).toBe("2 demandes");
  expect((await tab.getByTestId("artboard-requests").boundingBox())!.height).toBe(24);
  if (process.env.REDLINE_CAPTURES) {
    const strip = tab.locator('[data-strip="components/modal.html"]');
    await strip.screenshot({ path: join(process.env.REDLINE_CAPTURES, "fix-request-app-strip.png") });
  }

  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const ownCard = tab.locator(`[data-thread="${own.threadId}"]`);
  await ownCard.waitFor();
  expect(await ownCard.getByTestId("request-state").textContent()).toBe("En cours");
  expect(await ownCard.getByTestId("request-origins").textContent()).toBe("Demandé par App · Planning · voir l'instance ↗");
  expect(await ownCard.getByTestId("message-author").first().textContent()).toBe("Claude · App");
  expect(await ownCard.getByRole("button", { name: "Répondre" }).count()).toBe(1);
  expect(await ownCard.getByRole("button", { name: "Résoudre" }).count()).toBe(0);

  const routedCard = tab.locator(`[data-thread="${routed.threadId}"]`);
  expect(await routedCard.getByTestId("request-origins").textContent()).toBe("Ton commentaire sur App · Planning, transmis par Claude · App · voir l'instance ↗");
  expect(await routedCard.getByTestId("message-author").first().textContent()).toBe("Toi");
  expect(await routedCard.textContent()).toContain("La croix doit être ronde.");
  expect(await routedCard.getByRole("button", { name: "Résoudre" }).count()).toBe(0);

  const plainCard = tab.locator(`[data-thread="${plain.id}"]`);
  expect(await plainCard.getByRole("button", { name: "Résoudre" }).count()).toBe(1);
  expect(await plainCard.getByTestId("request-state").count()).toBe(0);

  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  const section = tab.getByTestId("ds-requests");
  await section.waitFor();
  expect(await section.getByRole("heading").textContent()).toBe("Demandes des projets · 2");
  const rows = section.getByTestId("ds-request");
  expect(await rows.count()).toBe(2);
  expect(await rows.first().textContent()).toContain("ui-modal");
  expect(await rows.first().textContent()).toContain("App · Planning");
}, 90_000);
