import { afterEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentTokenResponse, type ChangeRecord, type DesignSystem, type Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div><slot></slot></div></template></body></html>`;
const WIDER = MODAL.replace("display:block", "display:block;max-width:720px");
const designSystemFiles = {
  "tokens.css": `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`,
  "manifest.json": JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }] }),
  "components/modal.html": MODAL,
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

describe("design system session: change records and merging", () => {
  /** The seam's project follows a design system with a modal; two of its pages each asked for a wider modal. */
  async function twoRequests(script: (run: { callTool(name: string, args: Record<string, unknown>): Promise<string> }, requests: Thread[]) => Promise<void>) {
    let acted = false;
    const engine = new FakeEngine(async (run) => {
      if (acted) return [{ type: "result", summary: "Done" }];
      // The design system's work starts as soon as the first request lands: wait for the second.
      let requests: Thread[] = [];
      for (let i = 0; i < 100 && requests.length < 2; i++) {
        requests = ((await (await seam!.server.get(`/api/pages/${designSystem.pageId}/threads`)).json()) as Thread[]).filter((t) => t.request).reverse();
        if (requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (acted) return [{ type: "result", summary: "Done" }];
      acted = true;
      await script(run, requests);
      return [{ edit: { path: "components/modal.html", content: WIDER } }, { type: "result", summary: "Wider modal" }];
    });
    seam = await startSeam2(engine);
    designSystem = (await (await seam.server.post("/api/design-systems", { title: "Lumora", files: designSystemFiles })).json()) as DesignSystem;
    await fetch(`${seam.server.url}/api/projects/${seam.project.id}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ designSystem: designSystem.id }) });
    const files = { "manifest.json": JSON.stringify({ designSystem: designSystem.id, artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }] }), "home.html": "<ui-modal id=edit></ui-modal>" };
    const planning = await seam.createPage(files, "Planning");
    const signup = await seam.createPage(files, "Inscription");
    const token = ((await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    for (const [page, missing] of [[planning, "A 720 px size"], [signup, "Wider, please"]] as const) {
      await fetch(`${seam.server.url}${AGENT_API_PREFIX}/pages/${page.id}/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ component: "ui-modal", missing, artboard: "home.html", selector: "#edit" }),
      });
    }
    await engine.finished(1);
    await seam.waitForWorkEnd();
    return engine;
  }
  let designSystem: DesignSystem;

  const changes = async () => (await (await seam!.server.get(`/api/design-systems/${designSystem.id}/changes`)).json()) as ChangeRecord[];
  const requests = async () => ((await (await seam!.server.get(`/api/pages/${designSystem.pageId}/threads`)).json()) as Thread[]).filter((t) => t.request).reverse();

  it("offers record_change and merge_request", async () => {
    const engine = await twoRequests(async () => {});
    expect(engine.runs[0]!.mcpTools).toEqual(expect.arrayContaining(["record_change", "merge_request"]));
  });

  it("records the changes with the next publish, and the linked request turns done in the draft", async () => {
    await twoRequests(async (run, [first]) => {
      const answer = await run.callTool("record_change", { component: "ui-modal", label: "Taille 720 px", kind: "modified", threadId: first!.id, draftAnchor: ".wide" });
      expect(answer).toMatch(/Change recorded/);
    });

    expect(await changes()).toEqual([expect.objectContaining({ component: "modal", label: "Taille 720 px", kind: "modified", state: "pending", anchor: { draft: ".wide" } })]);
    expect((await requests()).map((t) => t.request!.state)).toEqual(["done_in_draft", "in_progress"]);
  });

  it("merges a request into an existing one", async () => {
    await twoRequests(async (run, [first, second]) => {
      const answer = await run.callTool("merge_request", { threadId: second!.id, into: first!.id });
      expect(answer).toMatch(/merged/i);
    });

    const [first, second] = await requests();
    expect(first!.request!.origins.map((o) => o.pageTitle).sort()).toEqual(["Inscription", "Planning"]);
    expect(second!.request!.mergedInto).toBe(first!.id);
  });

  it("says why a merge is refused", async () => {
    const answers: string[] = [];
    await twoRequests(async (run, [first]) => {
      answers.push(await run.callTool("merge_request", { threadId: first!.id, into: first!.id }));
    });
    expect(answers[0]).toMatch(/cannot be merged into itself/);
  });
});
