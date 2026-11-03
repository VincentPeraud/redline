import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type ChangeRecord, type DesignSystem, type DesignSystemDetail, type Page, type Project, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div class="modal"><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });

describe("change records and merged requests", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let app: Project;
  let planning: Page;
  let signup: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", {
      title: "Lumora",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL },
    })).json()) as DesignSystem;
    app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    const page = async (title: string) =>
      (await (await server.post(`/api/projects/${app.id}/pages`, {
        title,
        files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` },
      })).json()) as Page;
    planning = await page("Planning");
    signup = await page("Inscription");
  });
  afterEach(async () => {
    await server.stop();
  });

  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const ask = async (pageId: string, missing = "A 720 px size") =>
    ((await (await agent(`/pages/${pageId}/requests`, { component: "ui-modal", missing, artboard: "page.html", selector: "#edit" })).json()) as SendRequestResponse).threadId;
  const threadOf = async (id: string) => ((await (await server.get(`/api/pages/${ds.pageId}/threads`)).json()) as Thread[]).find((t) => t.id === id)!;
  const changesOf = async () => (await (await server.get(`/api/design-systems/${ds.id}/changes`)).json()) as ChangeRecord[];
  /** The design system's session publishes a new modal, with the changes it recorded. */
  const publish = async (changes: object[], html = MODAL.replace("modal", "modal wide")) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${ds.pageId}/versions`, {
      files: { ...checkout.files, "components/modal.html": html },
      message: "Wide modal",
      origin: "thread",
      baseVersionId: checkout.versionId,
      changes,
    });
  };

  it("stores the changes recorded at publish, per component, as pending", async () => {
    const res = await publish([{ component: "ui-modal", label: "Taille 720 px", kind: "added", anchor: { draft: ".modal.wide" } }]);
    expect(res.status).toBe(201);
    const version = (await res.json()) as { id: string };

    expect(await changesOf()).toEqual([
      expect.objectContaining({ designSystemId: ds.id, component: "modal", label: "Taille 720 px", kind: "added", state: "pending", anchor: { draft: ".modal.wide" }, versionId: version.id }),
    ]);
  });

  it("turns the linked request to done_in_draft, and leaves a request nobody linked", async () => {
    const answered = await ask(planning.id);
    const other = await ask(signup.id, "Round corners");

    await publish([{ component: "modal", label: "Taille 720 px", kind: "modified", threadId: answered }]);

    expect((await threadOf(answered)).request!.state).toBe("done_in_draft");
    expect((await threadOf(other)).request!.state).toBe("in_progress");
    expect((await changesOf())[0]).toMatchObject({ threadId: answered });
    // Still open: it waits for the diffusion.
    expect(((await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail).requests).toHaveLength(2);
  });

  it("refuses a publish whose changes are malformed, and publishes nothing", async () => {
    const before = ((await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout).versionId;
    for (const change of [
      { component: "modal", label: "", kind: "added" },
      { component: "modal", label: "x", kind: "renamed" },
      { component: "", label: "x", kind: "added" },
      { component: "modal", label: "x", kind: "added", threadId: "nope" },
      { component: "modal", label: "x", kind: "added", anchor: { draft: 3 } },
    ]) {
      expect((await publish([change])).status).toBe(400);
    }
    expect(((await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout).versionId).toBe(before);
    expect(await changesOf()).toEqual([]);
  });

  it("refuses changes on a page that is not a design system's", async () => {
    const checkout = (await (await agent(`/pages/${planning.id}/files`)).json()) as AgentCheckout;
    const res = await agent(`/pages/${planning.id}/versions`, { files: checkout.files, message: "m", origin: "thread", baseVersionId: checkout.versionId, changes: [{ component: "modal", label: "x", kind: "added" }] });
    expect(res.status).toBe(400);
  });

  it("lists the pending changes since the current diffusion and clears them at a diffusion", async () => {
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    await publish([{ component: "modal", label: "Taille 720 px", kind: "modified" }]);
    expect(await changesOf()).toHaveLength(1);

    expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(201);

    expect(await changesOf()).toEqual([]);
    await publish([{ component: "modal", label: "Coins ronds", kind: "modified" }], MODAL.replace("modal", "modal round"));
    expect((await changesOf()).map((c) => c.label)).toEqual(["Coins ronds"]);
  });

  describe("merging requests", () => {
    const merge = (threadId: string, into: string) => agent(`/requests/${threadId}/merge`, { into });

    it("attaches the origins to the existing request, which stays the only open one", async () => {
      const first = await ask(planning.id);
      const second = await ask(signup.id, "Also 720 px");

      expect((await merge(second, first)).status).toBe(200);

      const kept = await threadOf(first);
      expect(kept.request!.origins.map((o) => `${o.projectTitle} · ${o.pageTitle}`)).toEqual(["App · Planning", "App · Inscription"]);
      const closed = await threadOf(second);
      expect(closed).toMatchObject({ status: "resolved", request: { mergedInto: first } });
      const detail = (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
      expect(detail.requests.map((r) => r.threadId)).toEqual([first]);
    });

    it("refuses a merge into itself, into a request of another component, into a closed one, or of a non-request", async () => {
      const first = await ask(planning.id);
      const second = await ask(signup.id);
      const plain = (await (await server.post(`/api/pages/${ds.pageId}/threads`, { target: { kind: "artboard", artboard: "components/modal.html" }, body: "Title?" })).json()) as Thread;

      expect((await merge(first, first)).status).toBe(400);
      expect((await merge(plain.id, first)).status).toBe(400);
      expect((await merge(first, plain.id)).status).toBe(400);
      expect((await merge(first, "nope")).status).toBe(404);
      const third = await ask(planning.id, "Same again");
      expect((await merge(second, first)).status).toBe(200);
      expect((await merge(third, second)).status).toBe(409);
      expect((await threadOf(third)).request!.mergedInto).toBeUndefined();
    });

    it("follows the merged request's state: a change linked to the kept one is done for every origin", async () => {
      const first = await ask(planning.id);
      const second = await ask(signup.id);
      await merge(second, first);

      await publish([{ component: "modal", label: "Taille 720 px", kind: "modified", threadId: first }]);

      expect((await threadOf(first)).request!.state).toBe("done_in_draft");
      expect((await threadOf(second)).request!.mergedInto).toBe(first);
    });

    it("counts a change linked to the merged request as an answer to the one that stayed", async () => {
      const first = await ask(planning.id);
      const second = await ask(signup.id);
      await merge(second, first);

      await publish([{ component: "modal", label: "Taille 720 px", kind: "modified", threadId: second }]);

      expect((await threadOf(first)).request!.state).toBe("done_in_draft");
    });
  });
});
