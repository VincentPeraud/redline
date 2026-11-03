import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project, type ProjectDesignSystem } from "@redline/shared";
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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #f25c2a;`).join("\n")}\n}\n`;
const componentFile = (name: string) =>
  `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component><div class="${name}"><slot></slot></div></template></body></html>`;
const choice = (name: string, options: string[]) => ({ id: "variant", type: "choice", label: "Variant", options, default: options[0], artboard: `components/${name}.html` });

function designSystemFiles(components: Record<string, string[]>) {
  const names = Object.keys(components);
  return {
    "tokens.css": tokensCss,
    ...Object.fromEntries(names.map((name) => [`components/${name}.html`, componentFile(name)])),
    "manifest.json": JSON.stringify({
      artboards: names.map((name, i) => ({ file: `components/${name}.html`, x: i * 300, y: 0, width: 200, height: 100 })),
      tweaks: names.map((name) => choice(name, components[name])),
    }),
  };
}

async function seed() {
  const create = async (title: string, components: Record<string, string[]>) =>
    (await (await server.post("/api/design-systems", { title, files: designSystemFiles(components) })).json()) as DesignSystem;
  const lumora = await create("Lumora", { button: ["solid", "ghost"], card: ["flat", "raised"], tabs: ["line", "pills"], modal: ["sm", "md"] });
  const social = await create("Réseaux sociaux", { button: ["solid", "ghost"], card: ["flat"], tabs: ["line"] });
  const project = (await (await server.post("/api/projects", { title: "App", designSystem: lumora.id })).json()) as Project;
  const body = `<ui-button variant="solid">a</ui-button><ui-button>b</ui-button><ui-card variant="flat">c</ui-card><ui-tabs variant="pills">d</ui-tabs><ui-modal>e</ui-modal>`;
  await server.post(`/api/projects/${project.id}/pages`, {
    title: "Planning",
    files: {
      "manifest.json": JSON.stringify({ designSystem: lumora.id, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }] }),
      "a.html": `<!doctype html><html><head></head><body>${body}</body></html>`,
    },
  });
  return { lumora, social, project };
}

const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;

it("lists the used components with their match, counts the broken instances and remembers what is left out", async () => {
  const { social, project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.locator("#ds-select").selectOption(social.id);

  const dialog = tab.getByRole("dialog", { name: "Passer App sur Réseaux sociaux" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("Composants de Lumora utilisés dans App · 4");
  const row = (name: string) => dialog.getByTestId(`switch-${name}`);
  expect(await row("button").textContent()).toContain("2 instances · Planning");
  expect(await row("button").textContent()).toContain("même nom, mêmes réglages");
  expect(await row("tabs").textContent()).toContain("même nom, variante pills absente");
  expect(await row("modal").textContent()).toContain("absent de Réseaux sociaux");

  // Pre-ticked: only the same-named, same-settings component; the absent one cannot be ticked.
  expect(await row("button").getByRole("checkbox").isChecked()).toBe(true);
  expect(await row("card").getByRole("checkbox").isChecked()).toBe(false);
  expect(await row("modal").getByRole("checkbox").isDisabled()).toBe(true);
  expect(await dialog.getByTestId("switch-broken").textContent()).toBe("3 instances en erreur après le changement");

  await row("card").getByRole("checkbox").check();
  expect(await dialog.getByTestId("switch-broken").textContent()).toBe("2 instances en erreur après le changement");
  await row("card").getByRole("checkbox").uncheck();

  await dialog.getByRole("button", { name: "Changer de design system" }).click();
  await dialog.waitFor({ state: "detached" });
  await expect.poll(async () => (await detail(project)).designSystem?.id).toBe(social.id);
  expect((await detail(project)).excluded.map((c) => c.tag)).toEqual(["ui-card", "ui-tabs", "ui-modal"]);

  // The left-out components are listed on the page, and can be taken back.
  const left = tab.getByTestId("excluded-components");
  await left.waitFor();
  await left.getByTestId("excluded-card").getByRole("button", { name: "Prendre celui de Réseaux sociaux" }).click();
  await expect.poll(async () => (await detail(project)).excluded.map((c) => c.name)).toEqual(["tabs", "modal"]);
  await tab.close();
});

it("cancels without changing anything", async () => {
  const { social, project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.locator("#ds-select").selectOption(social.id);
  const dialog = tab.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await dialog.waitFor({ state: "detached" });
  expect((await detail(project)).designSystem?.title).toBe("Lumora");
  await tab.close();
});
