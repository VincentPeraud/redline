import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DesignSystemDetail, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #123456;`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const detailOf = async (id: string) => (await (await server.get(`/api/design-systems/${id}`)).json()) as DesignSystemDetail;

async function seed() {
  const files: Record<string, string> = { "tokens.css": tokensCss, "components/btn.html": component(".btn{color:red}") };
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { ...files, "manifest.json": manifestOf(["components/btn.html"]) } })).json()) as DesignSystem;
  const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  return { ds, dsPage, files };
}

const addComponent = (dsPage: Page, files: Record<string, string>, name: string) =>
  server.post(`/api/pages/${dsPage.id}/versions`, {
    files: { ...files, [`components/${name}.html`]: component(`.${name}{color:blue}`), "manifest.json": manifestOf(["components/btn.html", `components/${name}.html`]) },
    message: "Add",
    origin: "thread",
  });

it("undoes a diffusion from the toast", async () => {
  const { ds, dsPage, files } = await seed();
  await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id });
  expect((await addComponent(dsPage, files, "cta")).status).toBe(201);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("button", { name: "Diffuser…" }).click();
  await tab.getByRole("button", { name: "Diffuser", exact: true }).click();
  const toast = tab.getByTestId("diffusion-toast");
  await expect.poll(async () => toast.textContent()).toBe("Diffusion 2 envoyée à 1 projetAnnuler");
  expect((await detailOf(ds.id)).current.number).toBe(2);

  await toast.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(async () => toast.count()).toBe(0);
  expect((await detailOf(ds.id)).current.number).toBe(1);

  const rows = tab.getByTestId("diffusion-row");
  await expect.poll(async () => rows.count()).toBe(2);
  expect(await rows.nth(0).innerText()).toContain("Diffusion 2");
  expect(await rows.nth(0).innerText()).toContain("annulée");
  expect(await rows.nth(0).getByRole("button", { name: "Revenir à cette diffusion" }).count()).toBe(0);
  expect(await rows.nth(1).innerText()).toContain("en cours");
  await tab.close();
});

it("keeps the toast and says why when the undo is refused", async () => {
  const { ds, dsPage, files } = await seed();
  await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id });
  expect((await addComponent(dsPage, files, "cta")).status).toBe(201);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("button", { name: "Diffuser…" }).click();
  await tab.getByRole("button", { name: "Diffuser", exact: true }).click();
  const toast = tab.getByTestId("diffusion-toast");
  await expect.poll(async () => toast.textContent()).toBe("Diffusion 2 envoyée à 1 projetAnnuler");
  // Someone else already undid it.
  expect((await server.post(`/api/design-systems/${ds.id}/diffusions/undo`, {})).status).toBe(200);

  await toast.getByRole("button", { name: "Annuler" }).click();
  await toast.getByText("Rien à annuler : cette diffusion l'a déjà été.").waitFor();
  expect(await toast.getByRole("button", { name: "Annuler" }).count()).toBe(1);
  await tab.close();
});

it("rolls back to an earlier diffusion after a warning about pages using a component added since", async () => {
  const { ds, dsPage, files } = await seed();
  const project = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as { id: string };
  await server.post(`/api/projects/${project.id}/pages`, {
    title: "Stories",
    files: { "index.html": '<!doctype html><html><head></head><body><p class="cta">Hi</p></body></html>', "manifest.json": manifestOf(["index.html"]) },
  });
  await addComponent(dsPage, files, "cta");
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  const rows = tab.getByTestId("diffusion-row");
  await expect.poll(async () => rows.count()).toBe(2);
  expect(await rows.nth(0).getByRole("button", { name: "Revenir à cette diffusion" }).count()).toBe(0);

  await rows.nth(1).getByRole("button", { name: "Revenir à cette diffusion" }).click();
  const dialog = tab.getByRole("dialog", { name: "Revenir à la diffusion 1" });
  await dialog.waitFor();
  const warning = await dialog.getByTestId("rollback-warning").innerText();
  expect(warning).toContain("cta");
  expect(warning).toContain('page "Stories" of project "Semaine Halloween"');

  await dialog.getByRole("button", { name: "Annuler" }).click();
  expect(await tab.getByRole("dialog").count()).toBe(0);
  expect((await detailOf(ds.id)).current.number).toBe(2);

  await rows.nth(1).getByRole("button", { name: "Revenir à cette diffusion" }).click();
  await tab.getByRole("dialog").getByRole("button", { name: "Revenir à la diffusion 1" }).click();
  await expect.poll(async () => rows.count()).toBe(3);
  expect(await rows.nth(0).innerText()).toContain("Diffusion 3");
  expect(await rows.nth(0).innerText()).toContain("en cours");
  expect(await rows.nth(0).innerText()).toContain("Retour à la diffusion 1");
  expect((await detailOf(ds.id)).current.number).toBe(3);
  expect((await detailOf(ds.id)).pending.components.added).toContain("cta");
  await tab.close();
});

it("rolls back without a warning when no page uses what was added since", async () => {
  const { ds, dsPage, files } = await seed();
  await addComponent(dsPage, files, "cta");
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  const rows = tab.getByTestId("diffusion-row");
  await expect.poll(async () => rows.count()).toBe(2);
  await rows.nth(1).getByRole("button", { name: "Revenir à cette diffusion" }).click();
  const dialog = tab.getByRole("dialog", { name: "Revenir à la diffusion 1" });
  await dialog.waitFor();
  expect(await dialog.getByTestId("rollback-warning").count()).toBe(0);
  await dialog.getByRole("button", { name: "Revenir à la diffusion 1" }).click();
  await expect.poll(async () => rows.count()).toBe(3);
  await tab.close();
});
