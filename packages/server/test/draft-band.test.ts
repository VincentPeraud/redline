import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type ArtboardCapability, type DesignSystem, type Page, type ShareLink } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { AccountsInstance } from "./accounts-harness.js";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = `<!doctype html><html><head></head><body><p>Hello</p></body></html>`;

describe("pages of a project that follows the design system draft", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const designSystem = async () => (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) } })).json()) as DesignSystem;
  const projectOn = async (ds: DesignSystem, follow: boolean) => {
    const { id } = (await (await server.post("/api/projects", { title: "Acme", designSystem: ds.id })).json()) as { id: string };
    if (follow) await fetch(`${server.url}/api/projects/${id}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ followsDraft: true }) });
    const page = (await (await server.post(`/api/projects/${id}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup } })).json()) as Page;
    return { id, page };
  };
  const publishToken = (ds: DesignSystem, value: string) =>
    server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss(`  --brand: ${value};\n`) }, message: "Tweak", origin: "thread" });

  async function listenToEvents() {
    const frames: string[] = [];
    const abort = new AbortController();
    const reader = (await fetch(server.url + "/api/events", { signal: abort.signal })).body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        frames.push(decoder.decode(value));
      }
    })().catch(() => undefined);
    return {
      reloads: () =>
        frames
          .join("")
          .split("\n\n")
          .filter((frame) => frame.includes("design-system-updated"))
          .map((frame) => JSON.parse(frame.slice(frame.indexOf("{"))) as { pageIds: string[] }),
      stop: () => abort.abort(),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

  it("reloads when a page of its design system is published, once per burst, and leaves the other projects alone", async () => {
    const ds = await designSystem();
    const following = await projectOn(ds, true);
    const staying = await projectOn(ds, false);
    const events = await listenToEvents();
    await publishToken(ds, "#111");
    await publishToken(ds, "#222");
    await publishToken(ds, "#333");
    await settle();
    events.stop();
    const forFollowing = events.reloads().filter((event) => event.pageIds.includes(following.page.id));
    expect(forFollowing).toHaveLength(1);
    expect(events.reloads().some((event) => event.pageIds.includes(staying.page.id))).toBe(false);
  });
});

describe("a share-link visitor of a project on the draft", () => {
  it("gets the draft rendering of the page", async () => {
    const instance = await new AccountsInstance().start();
    try {
      const { ariane } = instance;
      const ds = (await (await ariane.send("POST", "/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) } })).json()) as DesignSystem;
      const project = await instance.createProject(ariane, { designSystem: ds.id });
      expect((await ariane.send("PUT", `/api/projects/${project.id}/design-system`, { followsDraft: true })).status).toBe(200);
      const page = (await (await ariane.send("POST", `/api/projects/${project.id}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup } })).json()) as Page;
      const link = (await (await ariane.send("POST", `/api/pages/${page.id}/links`, { kind: "personal", name: "Alix", level: "read" })).json()) as ShareLink;

      const visit = (path: string) => fetch(`${instance.server.url}/s/${link.token}${path}`);
      const issued = (await (await visit(`/api/projects/${project.id}/artboard-capability`)).json()) as ArtboardCapability;
      const open = (path: string) => fetch(`${instance.server.artboardOrigin}/c/${issued.capability}${path}`);
      const markup = await (await open(`/pages/${page.id}/a.html`)).text();
      expect(markup).toContain(`/design-systems/${ds.id}/tokens.css`);
      expect(markup).not.toContain(`/design-systems/${ds.id}/diffusions/`);
      expect((await open(`/design-systems/${ds.id}/tokens.css`)).status).toBe(200);

      const detail = (await (await visit(`/api/projects/${project.id}/design-system`)).json()) as { followsDraft: boolean };
      expect(detail.followsDraft).toBe(true);
    } finally {
      await instance.close();
    }
  });
});
