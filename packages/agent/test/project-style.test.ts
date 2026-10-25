import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NEUTRAL_TOKENS_CSS, type DesignMdVersion } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};
const PURPLE = ":root { --color-primary: #7c3aed; }\n";

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const stored = async () => ((await (await seam!.server.get(`/api/projects/${seam!.project.id}/project-style`)).json()) as { content: string }).content;
const versions = async () => (await (await seam!.server.get(`/api/projects/${seam!.project.id}/project-style/versions`)).json()) as DesignMdVersion[];

describe("project style in a session's working copy", () => {
  it("is at the root of the working copy and never published as a page file", async () => {
    const engine = new FakeEngine([{ type: "result", summary: "Nothing" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await seam.pinThread(page.id, "home.html", "Look at the style");
    await seam.waitForWorkEnd();

    expect(readFileSync(join(seam.folder, ".redline", page.id, "tokens.css"), "utf8")).toBe(NEUTRAL_TOKENS_CSS);
    expect(engine.runs[0].filesAtStart).toEqual(PAGE_FILES);
    expect(await seam.versions(page.id)).toHaveLength(1);
    expect(await versions()).toHaveLength(1);
  });

  it("is edited by a thread run and saved as a project-style version with the thread's origin", async () => {
    const engine = new FakeEngine([{ edit: { path: "tokens.css", content: PURPLE } }, { type: "result", summary: "Purple accent" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Accent in purple for Halloween");
    await seam.waitForWorkEnd();

    expect(await stored()).toBe(PURPLE);
    expect((await versions())[0]).toMatchObject({ origin: "thread", originId: thread.id, originLabel: "Accent in purple for Halloween" });
    expect((await seam.server.get(`/api/pages/${page.id}/files/tokens.css`)).status).toBe(404);
  });
});
