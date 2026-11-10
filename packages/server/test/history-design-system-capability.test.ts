import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, MANIFEST_PATH, type ArtboardCapability, type DesignSystem, type PageVersionSummary } from "@redline/shared";
import { AccountsInstance } from "./accounts-harness.js";

const tokens = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111;`).join("\n")}\n}\n`;
const designSystemFiles = { "tokens.css": tokens, [MANIFEST_PATH]: JSON.stringify({ artboards: [] }) };

describe("history previews and design systems", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  it("keeps serving the design system an old version was drawn with, after the project changed design system", async () => {
    const create = async (title: string) => (await (await instance.ariane.send("POST", "/api/design-systems", { title, files: designSystemFiles })).json()) as DesignSystem;
    const [before, after] = [await create("Before"), await create("After")];
    const project = await instance.createProject(instance.ariane, { designSystem: before.id });
    const page = (await (await instance.ariane.send("POST", `/api/projects/${project.id}/pages`, { title: "Flow", files: { [MANIFEST_PATH]: JSON.stringify({ designSystem: before.id, artboards: [{ file: "a.html", x: 0, y: 0 }] }), "a.html": "<h1>Old</h1>" } })).json()) as { id: string };
    const oldVersion = (await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${page.id}/versions`))[0];
    expect((await instance.ariane.send("PUT", `/api/projects/${project.id}/design-system`, { designSystem: after.id })).status).toBe(200);

    const { capability } = await instance.ariane.json<ArtboardCapability>(`/api/projects/${project.id}/artboard-capability`);
    const open = (path: string) => fetch(`${instance.server.artboardOrigin}/c/${capability}${path}`);
    expect((await open(`/page-versions/${page.id}/${oldVersion.id}/a.html`)).status).toBe(200);
    expect((await open(`/design-systems/${before.id}/tokens.css`)).status).toBe(200);
    expect((await open(`/design-systems/${after.id}/tokens.css`)).status).toBe(200);
    const stranger = await create("Stranger");
    expect((await open(`/design-systems/${stranger.id}/tokens.css`)).status).toBe(403);
  });
});
