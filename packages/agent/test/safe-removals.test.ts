import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project } from "@redline/shared";
import { FakeEngine, startSeam2, type FakeScript, type Seam2 } from "./support/seam2.js";

const tokens = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const WITH_BRAND = tokens("  --brand: #f00;\n");
const MANIFEST = JSON.stringify({ artboards: [{ file: "index.html", x: 0, y: 0, width: 200, height: 100 }] });

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

/** A design system with a `--brand` token that a page of another project uses, and a conversation started on its page. */
async function runOnDesignSystem(script: FakeScript): Promise<DesignSystem> {
  let runs = 0;
  const engine = new FakeEngine((run) => {
    // The first run is the one started by the creation of the design system; the script is for the second.
    if (++runs === 1) return [{ type: "result", summary: "Created" }];
    return typeof script === "function" ? script(run) : script;
  });
  seam = await startSeam2(engine, { retryDelaysMs: [] });
  const ds = (await (await seam.server.post("/api/design-systems", { title: "Acme DS", fromProjectId: seam.project.id, files: { "tokens.css": WITH_BRAND, "index.html": "<h1>DS</h1>", "manifest.json": MANIFEST } })).json()) as DesignSystem;
  await seam.waitForWorkEnd();
  const project = (await (await seam.server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as Project;
  await seam.server.post(`/api/projects/${project.id}/pages`, { title: "Stories", files: { "a.html": '<p style="color: var(--brand)">Hi</p>' } });
  const [conversation] = (await (await seam.server.get(`/api/pages/${ds.pageId}/conversations`)).json()) as { id: string }[];
  await seam.server.post(`/api/conversations/${conversation!.id}/messages`, { body: "Drop the brand colour" });
  await seam.waitForWorkEnd(2);
  return ds;
}

const draftTokens = async (ds: DesignSystem) => ((await (await seam!.server.get(`/api/design-systems/${ds.id}/tokens`)).json()) as { content: string }).content;

describe("removing a token that pages use, from a design system session", () => {
  it("fails the run with the list of pages", async () => {
    const ds = await runOnDesignSystem([{ edit: { path: "tokens.css", content: tokens() } }, { type: "result", summary: "Dropped" }]);
    const failure = seam!.workMessages().find((m) => m.type === "work-failed");
    expect(failure && "message" in failure ? failure.message : "").toContain('page "Stories" of project "Halloween"');
    expect(await draftTokens(ds)).toContain("--brand");
  });

  it("goes through once Claude called confirm_removals after the user agreed", async () => {
    const ds = await runOnDesignSystem(
      async (run) => {
        await run.callTool("confirm_removals", {});
        return [{ edit: { path: "tokens.css", content: tokens() } }, { type: "result", summary: "Dropped" }];
      },
    );
    expect(await draftTokens(ds)).not.toContain("--brand");
  });
});
