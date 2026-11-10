import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type ArtboardCapability, type InvitationEntry, type PageVersionSummary, type PasswordLinkEntry, type ShareLink, type Thread } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { AccountsInstance, PASSWORD, type SignedIn } from "./accounts-harness.js";

const JSON_HEADERS = { "content-type": "application/json" };
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("security fixes: links and capabilities", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const setup = async () => {
    const project = await instance.createProject(instance.ariane);
    const pageId = await instance.createPage(instance.ariane, project.id);
    return { project, pageId };
  };
  const makeLink = async (who: SignedIn, scopeUrl: string, body: object = {}): Promise<ShareLink> => {
    const response = await who.send("POST", scopeUrl, { kind: "personal", name: "Alix", level: "write", ...body });
    expect(response.status).toBe(201);
    return (await response.json()) as ShareLink;
  };
  const visit = (link: ShareLink, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(`${instance.server.url}/s/${link.token}${path}`, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });

  it("S1: a page link in Écriture cannot create pages, a project link can", async () => {
    const { project, pageId } = await setup();
    const pageLink = await makeLink(instance.ariane, `/api/pages/${pageId}/links`);
    const projectLink = await makeLink(instance.ariane, `/api/projects/${project.id}/links`);
    const body = { title: "New", files: { "home.html": "<h1>x</h1>" } };
    expect((await visit(pageLink, `/api/projects/${project.id}/pages`, body)).status).toBe(403);
    expect((await visit(projectLink, `/api/projects/${project.id}/pages`, body)).status).toBe(201);
  });

  it("S2: link visitors never read a member's e-mail", async () => {
    const { project, pageId } = await setup();
    const link = await makeLink(instance.ariane, `/api/pages/${pageId}/links`);
    const projectLink = await makeLink(instance.ariane, `/api/projects/${project.id}/links`);
    const thread = (await (await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team note", held: true })).json()) as Thread;
    await instance.thomas.send("POST", `/api/threads/${thread.id}/messages`, { body: "Reply" });
    await instance.ariane.send("POST", `/api/pages/${pageId}/versions`, { files: { "home.html": "<h1>v2</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) }, message: "v2", origin: "user" });
    for (const path of [`/api/pages/${pageId}/threads`, `/api/pages/${pageId}/versions`]) {
      const text = await (await visit(link, path)).text();
      expect(text).not.toContain("@example.com");
    }
    const projectThreads = await (await visit(projectLink, `/api/projects/${project.id}/threads`)).text();
    expect(projectThreads).not.toContain("@example.com");
    const versions = (await (await visit(link, `/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[];
    expect(versions.some((v) => v.person?.name === "Ariane Martin")).toBe(true);
    expect(Object.keys(versions.find((v) => v.person)!.person!).sort()).toEqual(["initials", "name"]);
    // Members keep reading e-mails.
    expect(JSON.stringify(await instance.ariane.json(`/api/pages/${pageId}/versions`))).toContain("@example.com");
  });

  it("S5: an author lowered below their link cannot edit or reactivate it, and Privé creation rules apply to reactivation", async () => {
    const { project, pageId } = await setup();
    const link = await makeLink(instance.thomas, `/api/pages/${pageId}/links`, { level: "write" });
    await instance.ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "comment" });
    expect((await instance.thomas.send("PATCH", `/api/links/${link.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await instance.thomas.send("POST", `/api/links/${link.id}/reactivate`)).status).toBe(403);

    const other = await instance.createProject(instance.ariane);
    const otherPage = await instance.createPage(instance.ariane, other.id);
    const readLink = await makeLink(instance.thomas, `/api/pages/${otherPage}/links`, { level: "read" });
    await instance.thomas.send("POST", `/api/links/${readLink.id}/disable`);
    await instance.ariane.send("PATCH", `/api/projects/${other.id}`, { visibility: "private" });
    await instance.ariane.send("PUT", `/api/projects/${other.id}/members/${instance.people.thomas.id}`, { level: "write" });
    expect((await instance.thomas.send("POST", `/api/links/${readLink.id}/reactivate`)).status).toBe(403);
    expect((await instance.thomas.send("PATCH", `/api/links/${readLink.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await instance.ariane.send("POST", `/api/links/${readLink.id}/reactivate`)).status).toBe(200);
  });

  describe("S6: artboard capabilities", () => {
    const capabilityFor = async (link: ShareLink, projectId: string) => ((await (await visit(link, `/api/projects/${projectId}/artboard-capability`)).json()) as ArtboardCapability).capability;
    const artboard = (capability: string, path: string) => fetch(`${instance.server.artboardOrigin}/c/${capability}${path}`);

    it("refuses version previews to Lecture and Commentaire links, serves them to Écriture", async () => {
      const { project, pageId } = await setup();
      const versions = await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${pageId}/versions`);
      const path = `/page-versions/${pageId}/${versions[0].id}/home.html`;
      const read = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "read" });
      const comment = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "comment" });
      const write = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "write" });
      expect((await artboard(await capabilityFor(read, project.id), path)).status).toBe(403);
      expect((await artboard(await capabilityFor(comment, project.id), path)).status).toBe(403);
      expect((await artboard(await capabilityFor(write, project.id), path)).status).toBe(200);
      expect((await artboard(await capabilityFor(read, project.id), `/pages/${pageId}/home.html`)).status).toBe(200);
    });

    it("keeps archived pages out of a project link's capability", async () => {
      const { project, pageId } = await setup();
      const link = await makeLink(instance.ariane, `/api/projects/${project.id}/links`, { level: "read" });
      const capability = await capabilityFor(link, project.id);
      expect((await artboard(capability, `/pages/${pageId}/home.html`)).status).toBe(200);
      await instance.ariane.send("POST", `/api/pages/${pageId}/archive`);
      expect((await artboard(capability, `/pages/${pageId}/home.html`)).status).toBe(403);
    });
  });

  it("S7: a terminal session belongs to the first account that used it", async () => {
    const [arianeToken, thomasToken] = [(await instance.ariane.json<AgentTokenResponse>("/api/agent-token")).token, (await instance.thomas.json<AgentTokenResponse>("/api/agent-token")).token];
    const call = (token: string, action: string) =>
      fetch(`${instance.server.url}${AGENT_API_PREFIX}/terminal-sessions/${SESSION_ID}/${action}`, {
        method: action === "waiting" ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS },
        body: action === "heartbeat" ? JSON.stringify({ folder: "/f", machine: "m" }) : action === "waiting" ? undefined : "{}",
      });
    expect((await call(arianeToken, "heartbeat")).status).toBe(204);
    expect((await call(thomasToken, "heartbeat")).status).toBe(403);
    expect((await call(thomasToken, "waiting")).status).toBe(403);
    expect((await call(thomasToken, "pick")).status).toBe(403);
    expect((await call(arianeToken, "waiting")).status).toBe(200);
  });

  it("S8: setup-style tokens are read from a header, never from the query string", async () => {
    const invitation = (await (await instance.admin.send("POST", "/api/accounts/invitations", { email: "new@example.com", role: "member" })).json()) as InvitationEntry;
    expect((await fetch(`${instance.server.url}/api/invitation?token=${invitation.token}`)).status).toBe(404);
    expect((await fetch(`${instance.server.url}/api/invitation`, { headers: { "x-redline-token": invitation.token } })).status).toBe(200);
    const accounts = await instance.admin.json<{ accounts: { id: string; email: string }[] }>("/api/accounts");
    const ariane = accounts.accounts.find((a) => a.email === "ariane@example.com")!;
    const link = (await (await instance.admin.send("POST", `/api/accounts/${ariane.id}/password-link`)).json()) as PasswordLinkEntry;
    expect((await fetch(`${instance.server.url}/api/password-link?token=${link.token}`)).status).toBe(404);
    expect((await fetch(`${instance.server.url}/api/password-link`, { headers: { "x-redline-token": link.token } })).status).toBe(200);
  });

  it("S11: an invitation cannot be accepted with an empty name", async () => {
    const invitation = (await (await instance.admin.send("POST", "/api/accounts/invitations", { email: "new@example.com", role: "member" })).json()) as InvitationEntry;
    const response = await fetch(`${instance.server.url}/api/invitation`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: invitation.token, name: "   ", password: PASSWORD }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-name");
  });

  describe("immediate cut-off of the event stream", () => {
    /** Opens the stream and resolves true when the server closes it within `ms`. */
    const watch = async (headers: Record<string, string>, path = "/api/events") => {
      const response = await fetch(instance.server.url + path, { headers });
      const reader = response.body!.getReader();
      await reader.read();
      const closed = (ms: number) =>
        Promise.race([
          (async () => {
            for (;;) if ((await reader.read()).done) return true;
          })(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
        ]);
      return { closed, cancel: () => reader.cancel() };
    };

    it("stops a visitor's stream when its link is disabled", async () => {
      const { pageId } = await setup();
      const link = await makeLink(instance.ariane, `/api/pages/${pageId}/links`);
      const stream = await watch({}, `/s/${link.token}/api/events`);
      await instance.ariane.send("POST", `/api/links/${link.id}/disable`);
      await instance.ariane.send("PATCH", `/api/pages/${pageId}`, { title: "Other" });
      expect(await stream.closed(1500)).toBe(true);
    });

    it("stops a member's stream when the account is deactivated", async () => {
      const { pageId } = await setup();
      const stream = await watch({ cookie: instance.thomas.cookie });
      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`, {});
      await instance.ariane.send("PATCH", `/api/pages/${pageId}`, { title: "Other" });
      expect(await stream.closed(1500)).toBe(true);
    });
  });
});

describe("security fixes: sign-in lockout", () => {
  let instance: AccountsInstance | undefined;
  let trusted: { server: RunningServer; dataDir: string } | undefined;
  afterEach(async () => {
    await instance?.close();
    instance = undefined;
    await trusted?.server.close();
    if (trusted) rmSync(trusted.dataDir, { recursive: true, force: true });
    trusted = undefined;
  });
  const attempt = (url: string, email: string, password: string, forwarded?: string) =>
    fetch(`${url}/api/session`, { method: "POST", headers: { ...JSON_HEADERS, ...(forwarded ? { "x-forwarded-for": forwarded } : {}) }, body: JSON.stringify({ email, password }) });

  it("S3: ignores X-Forwarded-For unless a proxy is trusted", async () => {
    instance = await new AccountsInstance().start();
    const url = instance.server.url;
    for (let i = 0; i < 5; i++) await attempt(url, "ariane@example.com", "wrong", `10.0.0.${i}`);
    expect((await attempt(url, "ariane@example.com", PASSWORD, "9.9.9.9")).status).toBe(429);
  });

  it("S3: a global ceiling per address stops guessing across many e-mails", async () => {
    instance = await new AccountsInstance().start();
    const url = instance.server.url;
    for (let i = 0; i < 20; i++) await attempt(url, `nobody${i}@example.com`, "wrong");
    expect((await attempt(url, "ariane@example.com", PASSWORD)).status).toBe(429);
  });

  it("S3: with a trusted proxy, the address is the last X-Forwarded-For entry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "redline-trusted-"));
    const logs: string[] = [];
    const server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", trustedProxy: true, log: (line) => logs.push(line) });
    trusted = { server, dataDir };
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent", email: "v@example.com", password: PASSWORD }) });
    for (let i = 0; i < 5; i++) await attempt(server.url, "v@example.com", "wrong", "1.1.1.1");
    expect((await attempt(server.url, "v@example.com", PASSWORD, "1.1.1.1")).status).toBe(429);
    expect((await attempt(server.url, "v@example.com", PASSWORD, "2.2.2.2")).status).toBe(200);
  });
});

describe("security fixes: start-up checks and migration", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-start-"));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const HUMAN = "h".repeat(32);
  const MACHINE = "m".repeat(32);
  const sso = (email: string, id = "u1") => ({ [PROXY_SECRET_HEADER]: HUMAN, "remote-user": id, "remote-name": "Someone", "remote-email": email });

  it("S4: proxy mode refuses to start without REDLINE_FIRST_ADMIN_EMAIL", async () => {
    await expect(startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "proxy", proxySecrets: { human: HUMAN, machine: MACHINE } })).rejects.toThrow(/REDLINE_FIRST_ADMIN_EMAIL/);
  });

  it("S4: only the named e-mail becomes the first admin", async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "proxy", proxySecrets: { human: HUMAN, machine: MACHINE }, firstAdminEmail: "Boss@Example.com" });
    const stranger = await (await fetch(`${server.url}/api/me`, { headers: sso("eve@example.com", "eve") })).json();
    expect(stranger).toMatchObject({ noAccess: expect.anything() });
    const boss = await (await fetch(`${server.url}/api/me`, { headers: sso("boss@example.com", "boss") })).json();
    expect(boss).toMatchObject({ account: { role: "admin" } });
  });

  it("refuses a body-less cross-site style call in proxy mode as in local mode", async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "proxy", proxySecrets: { human: HUMAN, machine: MACHINE }, firstAdminEmail: "boss@example.com" });
    const headers = sso("boss@example.com", "boss");
    const project = (await (await fetch(`${server.url}/api/projects`, { method: "POST", headers: { ...headers, ...JSON_HEADERS }, body: JSON.stringify({ title: "P" }) })).json()) as { id: string };
    expect((await fetch(`${server.url}/api/projects/${project.id}/archive`, { method: "POST", headers })).status).toBe(415);
    expect((await fetch(`${server.url}/api/projects/${project.id}/archive`, { method: "POST", headers: { ...headers, "x-redline": "1" } })).status).toBe(200);
  });

  it("S9: mode none refuses a public URL that is not local", async () => {
    await expect(startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "none", publicUrl: "https://redline.example.com" })).rejects.toThrow(/none/);
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "none", publicUrl: "http://localhost:3000" });
  });

  it("S10: says in the logs that the old shared agent token became the first admin's", async () => {
    const logs: string[] = [];
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent", email: "v@example.com", password: PASSWORD }) });
    const db = new Database(join(dataDir, "redline.db"));
    db.prepare("INSERT INTO settings (key, value) VALUES ('agent_token', 'abt_old') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.close();
    const response = await fetch(`${server.url}${AGENT_API_PREFIX}/terminal-sessions/${SESSION_ID}/waiting`, { headers: { authorization: "Bearer abt_old" } });
    expect(response.status).toBe(200);
    expect(logs.some((line) => /shared agent token/i.test(line) && /regenerate/i.test(line))).toBe(true);
  });
});
