import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type Page as Tab } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type Page, type SendRequestResponse } from "@redline/shared";
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
const componentFile = (name: string, body: string) =>
  `<!doctype html><html><head></head><body><template data-component>${body}</template><ui-${name}></ui-${name}></body></html>`;
const MODAL_V1 = componentFile("modal", `<div class="modal"><button class="close">x</button><p class="help">Cette action est définitive.</p></div>`);
const MODAL_V2 = componentFile("modal", `<div class="modal"><button class="close">x</button><div class="size"></div><footer>Footer</footer></div>`);
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 700, y: 0, width: 560, height: 400 })) });

async function setup() {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL_V1 } })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string };
  const planning = (await (await server.post(`/api/projects/${app.id}/pages`, { title: "Planning", files: { "manifest.json": manifestOf(["planning.html"], ds.id), "planning.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` } })).json()) as Page;
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ask = async (missing: string) =>
    ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", artboard: "planning.html", selector: "#edit", missing })).json()) as SendRequestResponse).threadId;
  const publish = async (files: Record<string, string>, changes: object[]) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    const res = await agent(`/pages/${ds.pageId}/versions`, { files: { ...checkout.files, ...files }, message: "Edit", origin: "thread", baseVersionId: checkout.versionId, changes });
    expect(res.status, await res.clone().text()).toBe(201);
  };
  return { ds, ask, publish };
}

const frameOf = (tab: Tab, part: string) => tab.frames().find((frame) => frame.url().includes(part))!;
const badgesIn = (tab: Tab, part: string) => frameOf(tab, part).evaluate(() => [...document.querySelectorAll("#__redline-compare [data-part=badge]")].map((el) => el.textContent));

it("compares the diffused and the draft artboard, with independent zooms, markers and Refuser", async () => {
  const { ds, ask, publish } = await setup();
  const request = await ask("Retirer le texte d'aide");
  await publish({ "components/modal.html": MODAL_V2 }, [
    { component: "modal", label: "Taille 720 px", kind: "added", threadId: request, anchor: { draft: ".size" } },
    { component: "modal", label: "Croix ronde", kind: "modified", threadId: request, anchor: { draft: ".close", diffused: ".close" } },
    { component: "modal", label: "Pied de page ajouté", kind: "added", anchor: { draft: "footer" } },
    { component: "modal", label: "Texte d’aide retiré", kind: "removed", anchor: { diffused: ".help" } },
  ]);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await tab.getByRole("button", { name: /Diffuser aux projets/ }).click();
  const dialog = tab.getByRole("dialog");
  await dialog.getByRole("link", { name: "Avant / après ↗" }).waitFor();
  if (captures) {
    await tab.waitForTimeout(500);
    await tab.screenshot({ path: join(captures, "15-app-review-links.png") });
  }
  await dialog.getByRole("link", { name: "Avant / après ↗" }).click();

  const diffused = tab.getByRole("region", { name: "Diffusé" });
  const draft = tab.getByRole("region", { name: "Brouillon" });
  await diffused.waitFor();
  expect(await tab.getByRole("heading", { name: "Ce qui change dans ui-modal" }).count()).toBe(1);
  expect(await diffused.textContent()).toContain("version 1");
  expect(await tab.getByTestId("before-after-change").count()).toBe(4);

  // Left renders the diffusion, right the draft.
  await expect.poll(() => badgesIn(tab, "diffusion=1")).toEqual(["2", "4"]);
  await expect.poll(() => badgesIn(tab, "components/modal.html").then((b) => b.join())).not.toBe("");
  const draftFrame = tab.frames().find((frame) => frame.url().includes("components/modal.html") && !frame.url().includes("diffusion"))!;
  expect(await draftFrame.evaluate(() => [...document.querySelectorAll("#__redline-compare [data-part=badge]")].map((el) => el.textContent))).toEqual(["1", "2", "3"]);
  expect(await frameOf(tab, "diffusion=1").evaluate(() => document.querySelector(".help") !== null)).toBe(true);
  expect(await draftFrame.evaluate(() => document.querySelector("footer") !== null)).toBe(true);
  await dialog.waitFor({ state: "detached" });
  if (captures) await tab.screenshot({ path: join(captures, "15-app-before-after.png") });

  // Each side zooms on its own.
  const percent = (side: typeof diffused) => side.getByTestId("zoom-percent").textContent();
  const before = await percent(draft);
  await diffused.getByRole("button", { name: "Dézoomer" }).click();
  expect(await percent(diffused)).not.toBe(before);
  expect(await percent(draft)).toBe(before);
  await diffused.getByRole("button", { name: "Ajuster" }).click();
  expect(await percent(diffused)).toBe(before);

  // One toggle hides the markers on both sides.
  const toggle = tab.getByRole("button", { name: "Repères" });
  expect(await toggle.getAttribute("aria-pressed")).toBe("true");
  await toggle.click();
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  await expect.poll(() => badgesIn(tab, "diffusion=1")).toEqual([]);
  expect(await draftFrame.evaluate(() => document.querySelectorAll("#__redline-compare [data-part=badge]").length)).toBe(0);
  await toggle.click();
  await expect.poll(() => badgesIn(tab, "diffusion=1")).toEqual(["2", "4"]);

  // Refuser works from here; only the request-born changes have one.
  const rows = tab.getByTestId("before-after-change");
  expect(await rows.getByRole("button", { name: "Refuser" }).count()).toBe(2);
  await rows.filter({ hasText: "Taille 720 px" }).getByRole("button", { name: "Refuser" }).click();
  await tab.getByTestId("change-undoing").waitFor();

  // Back to the review.
  await tab.getByRole("link", { name: "Retour à la relecture" }).click();
  await tab.getByRole("dialog").waitFor();
  expect(await tab.getByRole("dialog").getByTestId("change-undoing").count()).toBe(1);
  await tab.close();
});

it("shows a new component on its own", async () => {
  const { ds, publish } = await setup();
  await publish({ "manifest.json": manifestOf(["components/modal.html", "components/tag.html"]), "components/tag.html": componentFile("tag", `<span class="tag">Tag</span>`) }, []);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await tab.getByRole("button", { name: /Diffuser aux projets/ }).click();
  await tab.getByTestId("diffusion-component").filter({ hasText: "ui-tag" }).getByRole("link", { name: "Voir le composant ↗" }).click();
  await tab.getByRole("region", { name: "Brouillon" }).waitFor();
  expect(await tab.getByRole("region", { name: "Diffusé" }).count()).toBe(0);
  await tab.close();
});
