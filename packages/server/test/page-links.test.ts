import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtboardCapability, Page, Project, ShareLink, ShareLinkView } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { AccountsInstance, FILES, type SignedIn } from "./accounts-harness.js";

const DAY_MS = 86_400_000;

describe("page share links in Lecture", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  /** A page of Ariane's, with a second page and a second project around it. */
  const setup = async () => {
    const { ariane } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(ariane, project.id);
    const otherPageId = await instance.createPage(ariane, project.id, "Other");
    const otherProject = await instance.createProject(ariane, { title: "Secret" });
    const otherProjectPage = await instance.createPage(ariane, otherProject.id, "Hidden");
    return { project, pageId, otherPageId, otherProject, otherProjectPage };
  };

  const createLink = async (who: SignedIn, pageId: string, body: object = {}): Promise<ShareLink> => {
    const response = await who.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "read", ...body });
    expect(response.status).toBe(201);
    return (await response.json()) as ShareLink;
  };

  /** A call as the visitor of a link: no cookie, the link's own address. */
  const visit = (token: string, path: string, init: RequestInit = {}) => fetch(`${instance.server.url}/s/${token}${path}`, init);

  it("lets a member in Écriture create, list and copy a link with its name, kind, level, creator and counters", async () => {
    const { pageId } = await setup();
    const link = await createLink(instance.ariane, pageId, { name: "Client HAIDF", kind: "generic", expiresAt: new Date(Date.now() + 14 * DAY_MS).toISOString() });
    expect(link).toMatchObject({ scope: "page", scopeId: pageId, kind: "generic", name: "Client HAIDF", level: "read", status: "active", deviceCount: 0, createdBy: { name: "Ariane Martin" } });
    expect(link.token.length).toBeGreaterThanOrEqual(22);
    // Another member in Écriture sees it and who made it.
    const listed = await instance.thomas.json<ShareLink[]>(`/api/pages/${pageId}/links`);
    expect(listed.map((l) => [l.id, l.createdBy?.name])).toEqual([[link.id, "Ariane Martin"]]);
  });

  it("refuses links to a member below Écriture, and a generic link above Commentaire", async () => {
    const { project, pageId } = await setup();
    await instance.ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "comment" });
    expect((await instance.thomas.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "read" })).status).toBe(403);
    expect((await instance.thomas.get(`/api/pages/${pageId}/links`)).status).toBe(403);
    expect((await instance.ariane.send("POST", `/api/pages/${pageId}/links`, { kind: "generic", name: "Everyone", level: "write" })).status).toBe(400);
    expect((await instance.ariane.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: " ", level: "read" })).status).toBe(400);
  });

  it("opens the page for a visitor with no account, and tells the link's level and page", async () => {
    const { pageId, project } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const info = (await (await visit(link.token, "/api/link")).json()) as ShareLinkView;
    expect(info).toMatchObject({ level: "read", kind: "personal", page: { id: pageId, title: "Home" }, project: { id: project.id, title: "Acme" } });
    expect(JSON.stringify(info)).not.toContain("Ariane");
    const page = (await (await visit(link.token, `/api/pages/${pageId}`)).json()) as Page;
    expect(page.id).toBe(pageId);
    expect((await visit(link.token, `/api/pages/${pageId}/files/home.html`)).status).toBe(200);
    const trimmed = (await (await visit(link.token, `/api/projects/${project.id}`)).json()) as Record<string, unknown>;
    expect(trimmed).toMatchObject({ id: project.id, title: "Acme", viewerLevel: "read" });
    expect(trimmed.instructions).toBeUndefined();
  });

  it("keeps a visitor on the link's page: no other page, project, history, listing or write route", async () => {
    const { pageId, otherPageId, otherProject, otherProjectPage, project } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const refused = async (path: string, init?: RequestInit) => expect((await visit(link.token, path, init)).status, path).toBe(403);
    const json = { "content-type": "application/json" };
    await refused(`/api/pages/${otherPageId}`);
    await refused(`/api/pages/${otherProjectPage}`);
    await refused(`/api/projects/${otherProject.id}`);
    await refused(`/api/projects/${project.id}/pages`);
    await refused("/api/projects");
    await refused("/api/home");
    await refused(`/api/pages/${pageId}/versions`);
    await refused(`/api/pages/${pageId}/links`);
    await refused(`/api/pages/${pageId}/working-copy`);
    await refused(`/api/pages/${pageId}/threads`, { method: "POST", headers: json, body: JSON.stringify({ body: "hi", artboard: "home.html", selector: "h1", xPct: 1, yPct: 1 }) });
    await refused(`/api/pages/${pageId}/versions`, { method: "POST", headers: json, body: JSON.stringify({ files: FILES }) });
    await refused(`/api/pages/${pageId}/tweaks`, { method: "POST", headers: json, body: JSON.stringify({}) });
    await refused(`/api/pages/${pageId}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "Mine" }) });
    await refused(`/api/pages/${pageId}/archive`, { method: "POST", headers: json, body: "{}" });
    await refused(`/api/projects/${otherProject.id}/artboard-capability`);
    expect((await instance.ariane.json<Page>(`/api/pages/${pageId}`)).title).toBe("Home");
  });

  it("serves a visitor an artboard capability for its project only, and artboards load with it", async () => {
    const { pageId, project, otherProjectPage } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const issued = (await (await visit(link.token, `/api/projects/${project.id}/artboard-capability`)).json()) as ArtboardCapability;
    const open = (path: string) => fetch(`${instance.server.artboardOrigin}/c/${issued.capability}${path}`);
    expect((await open(`/pages/${pageId}/home.html`)).status).toBe(200);
    expect((await open(`/pages/${otherProjectPage}/home.html`)).status).toBe(403);
  });

  it("gives every failure the same dead-link answer: unknown, disabled, expired, archived and deleted", async () => {
    const { pageId, project } = await setup();
    const answers: Array<[number, string]> = [];
    const probe = async (token: string) => {
      const response = await visit(token, "/api/link");
      answers.push([response.status, await response.text()]);
    };
    await probe("not-a-link");
    const disabled = await createLink(instance.ariane, pageId);
    await instance.ariane.send("POST", `/api/links/${disabled.id}/disable`);
    await probe(disabled.token);
    const expired = await createLink(instance.ariane, pageId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await probe(expired.token);
    const onArchivedPage = await createLink(instance.ariane, pageId);
    await instance.ariane.send("POST", `/api/pages/${pageId}/archive`);
    await probe(onArchivedPage.token);
    await instance.ariane.send("POST", `/api/pages/${pageId}/unarchive`);
    expect((await visit(onArchivedPage.token, "/api/link")).status).toBe(200);
    await instance.ariane.send("POST", `/api/projects/${project.id}/archive`);
    await probe(onArchivedPage.token);
    await instance.ariane.send("POST", `/api/projects/${project.id}/unarchive`);
    expect((await visit(onArchivedPage.token, "/api/link")).status).toBe(200);
    const doomed = await instance.createPage(instance.ariane, project.id, "Doomed");
    const onDeleted = await createLink(instance.ariane, doomed);
    await instance.ariane.send("POST", `/api/pages/${doomed}/archive`);
    await instance.ariane.send("DELETE", `/api/pages/${doomed}`);
    await probe(onDeleted.token);
    expect(answers).toHaveLength(6);
    expect(new Set(answers.map(([, body]) => body)).size).toBe(1);
    expect(answers.every(([status]) => status === 404)).toBe(true);
    expect(answers[0][1]).toContain("link-dead");
    // The dead answer wins over every route, even one a visitor never has.
    expect((await visit("not-a-link", `/api/pages/${pageId}`)).status).toBe(404);
  });

  it("disables with the creator's say-so and reactivates the same address; only the author, the project creator and admins edit it", async () => {
    const { pageId } = await setup();
    const link = await createLink(instance.thomas, pageId);
    expect((await instance.marc.send("POST", `/api/links/${link.id}/disable`)).status).toBe(403);
    expect((await instance.ariane.send("POST", `/api/links/${link.id}/disable`)).status).toBe(200);
    expect((await visit(link.token, "/api/link")).status).toBe(404);
    const [off] = await instance.thomas.json<ShareLink[]>(`/api/pages/${pageId}/links`);
    expect(off).toMatchObject({ status: "disabled", disabledBy: { name: "Ariane Martin" } });
    const back = (await (await instance.thomas.send("POST", `/api/links/${link.id}/reactivate`)).json()) as ShareLink;
    expect(back).toMatchObject({ status: "active", token: link.token });
    expect((await visit(link.token, "/api/link")).status).toBe(200);
  });

  it("edits the name, expiry and level of a link", async () => {
    const { pageId } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const edited = (await (await instance.ariane.send("PATCH", `/api/links/${link.id}`, { name: "Relecture", expiresAt: null })).json()) as ShareLink;
    expect(edited).toMatchObject({ name: "Relecture", token: link.token });
    expect(edited.expiresAt).toBeUndefined();
    expect((await instance.marc.send("PATCH", `/api/links/${link.id}`, { name: "Mine" })).status).toBe(403);
  });

  it("records the last opening and counts the devices by cookie", async () => {
    const { pageId } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const first = await visit(link.token, "/api/link");
    const device = (first.headers.get("set-cookie") ?? "").split(";")[0];
    expect(device).toMatch(/^redline_link_device=/);
    expect((first.headers.get("set-cookie") ?? "").toLowerCase()).toContain(`path=/s/${link.token.toLowerCase()}`);
    await visit(link.token, "/api/link", { headers: { cookie: device } });
    const [counted] = await instance.ariane.json<ShareLink[]>(`/api/pages/${pageId}/links`);
    expect(counted.deviceCount).toBe(1);
    expect(counted.lastOpenedAt).toBeDefined();
    await visit(link.token, "/api/link");
    expect((await instance.ariane.json<ShareLink[]>(`/api/pages/${pageId}/links`))[0].deviceCount).toBe(2);
  });

  it("sends a signed-in member to the normal page when their level reaches the link's, else keeps the visitor view", async () => {
    const { pageId, project } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const commentLink = await createLink(instance.ariane, pageId, { level: "comment", name: "Review" });
    const asMember = async (who: SignedIn, token: string) => ((await (await visit(token, "/api/link", { headers: { cookie: who.cookie } })).json()) as ShareLinkView).memberRedirect;
    expect(await asMember(instance.thomas, link.token)).toBe(true);
    expect(await asMember(instance.thomas, commentLink.token)).toBe(true);
    await instance.ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "read" });
    expect(await asMember(instance.thomas, link.token)).toBe(true);
    expect(await asMember(instance.thomas, commentLink.token)).toBe(false);
    expect(((await (await visit(link.token, "/api/link")).json()) as ShareLinkView).memberRedirect).toBe(false);
  });

  it("deletes the links with their page", async () => {
    const { project } = await setup();
    const doomed = await instance.createPage(instance.ariane, project.id, "Doomed");
    const link = await createLink(instance.ariane, doomed);
    await instance.ariane.send("POST", `/api/pages/${doomed}/archive`);
    await instance.ariane.send("DELETE", `/api/pages/${doomed}`);
    expect((await visit(link.token, "/api/link")).status).toBe(404);
  });

  it("streams a visitor only the events of its page", async () => {
    const { pageId, otherPageId } = await setup();
    const link = await createLink(instance.ariane, pageId);
    const controller = new AbortController();
    const stream = await visit(link.token, "/api/events", { signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let received = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        received += new TextDecoder().decode(value);
      }
    })();
    const changed = { files: { ...FILES, "home.html": "<h1>Changed</h1>" }, message: "Change", origin: "user" };
    expect((await instance.ariane.send("POST", `/api/pages/${otherPageId}/versions`, changed)).status).toBe(201);
    expect((await instance.ariane.send("POST", `/api/pages/${pageId}/versions`, changed)).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await pump;
    expect(received).toContain(pageId);
    expect(received).not.toContain(otherPageId);
  });
});

describe("page share links behind the SSO", () => {
  let dataDir: string;
  let server: RunningServer;
  const HUMAN = "h".repeat(32);
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-links-proxy-"));
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "proxy", proxySecrets: { human: HUMAN, machine: "m".repeat(32) } });
  });
  afterEach(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("opens for a visitor who carries no SSO identity, and still needs the proxy secret", async () => {
    const member = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com", "content-type": "application/json" };
    const project = (await (await fetch(`${server.url}/api/projects`, { method: "POST", headers: member, body: JSON.stringify({ title: "Acme" }) })).json()) as Project;
    const page = (await (await fetch(`${server.url}/api/projects/${project.id}/pages`, { method: "POST", headers: member, body: JSON.stringify({ title: "Home", files: FILES }) })).json()) as Page;
    const link = (await (await fetch(`${server.url}/api/pages/${page.id}/links`, { method: "POST", headers: member, body: JSON.stringify({ kind: "generic", name: "Client", level: "read" }) })).json()) as ShareLink;
    const visitor = await fetch(`${server.url}/s/${link.token}/api/pages/${page.id}`, { headers: { [PROXY_SECRET_HEADER]: HUMAN } });
    expect(visitor.status).toBe(200);
    expect((await fetch(`${server.url}/s/${link.token}/api/pages/${page.id}`)).status).toBe(403);
    expect((await fetch(`${server.url}/s/${link.token}/api/projects`, { headers: { [PROXY_SECRET_HEADER]: HUMAN } })).status).toBe(403);
  });
});
