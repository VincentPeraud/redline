import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type ShareLink, type Thread } from "@redline/shared";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hashPassword } from "../src/accounts.js";
import { AccountsInstance, PASSWORD, type SignedIn } from "./accounts-harness.js";

const SESSION = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
const OTHER_SESSION = "8e2a2e2f-4d1b-4e7f-8b54-6c9e4d2b3a21";
const target = { kind: "artboard", artboard: "home.html" };
const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;

describe("accounts and rights around takes", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(instance.server.url + AGENT_API_PREFIX + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const threadsOf = (pageId: string) => instance.admin.json<Thread[]>(`/api/pages/${pageId}/threads`);

  /** Thomas has Écriture and his conversation took the page's thread. Marc has Commentaire. */
  async function setup(mode: "conversation" | "agent" = "conversation", projectBody: object = {}) {
    const { admin, people } = instance;
    const project = await instance.createProject(admin, projectBody);
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.marc.id}`, { level: "comment" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const thread = (await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Bigger" })).json()) as Thread;
    const token = await tokenOf(instance.thomas);
    await call(token, "POST", `/terminal-sessions/${SESSION}/heartbeat`, { folder: "/Users/tom/site", machine: "MacBook-Air" });
    await call(token, "POST", `/terminal-sessions/${SESSION}/take`, { pageId });
    if (mode === "agent") await admin.send("POST", `/api/pages/${pageId}/comment-mode`, { mode });
    return { project, pageId, thread, token };
  }

  describe("deactivation", () => {
    it("frees the account's takes with the trace, and counts them in the account list", async () => {
      const { pageId } = await setup();
      const entryOf = async () => (await instance.admin.json<{ accounts: { id: string; takenThreads?: number }[] }>("/api/accounts")).accounts.find((a) => a.id === instance.people.thomas.id);
      expect((await entryOf())?.takenThreads).toBe(1);

      expect((await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`)).status).toBe(200);

      const [freed] = await threadsOf(pageId);
      expect(freed).toMatchObject({ toTake: true, traces: [{ kind: "released", taker: { name: "Thomas Lefevre" } }] });
      expect(freed).not.toHaveProperty("take");
    });

    it("sends the freed thread to the agent when its page is in Agent mode", async () => {
      const { pageId } = await setup("agent");

      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`);

      const [freed] = await threadsOf(pageId);
      expect(freed).not.toHaveProperty("take");
      expect(freed.toTake).not.toBe(true);
      expect((await instance.admin.json<unknown[]>(`/api/pages/${pageId}/queue`)).length).toBe(1);
    });

    it("frees the takes on an archived page too, which follows its mode once unarchived", async () => {
      const { pageId } = await setup("agent");
      await instance.admin.send("POST", `/api/pages/${pageId}/archive`);

      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`);
      expect(await threadsOf(pageId)).toMatchObject([{ traces: [{ kind: "released" }] }]);
      expect((await threadsOf(pageId))[0]).not.toHaveProperty("take");
      expect(await instance.admin.json<{ reason: string }[]>(`/api/pages/${pageId}/queue`)).toMatchObject([{ reason: "page-archived" }]);

      await instance.admin.send("POST", `/api/pages/${pageId}/unarchive`);
      expect((await instance.admin.json<unknown[]>(`/api/pages/${pageId}/queue`)).length).toBe(1);
    });

    it("keeps the account's drafts invisible, and gives them back on reactivation", async () => {
      const { pageId } = await setup();
      await instance.thomas.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Prepared", held: true });
      const heldOf = async (who: SignedIn) => (await who.json<Thread[]>(`/api/pages/${pageId}/held`)).map((t) => t.body);

      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`);
      expect(await heldOf(instance.admin)).toEqual([]);
      expect((await threadsOf(pageId)).map((t) => t.body)).toEqual(["Bigger"]);

      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/reactivate`);
      const thomas = await instance.signIn("thomas@example.com");
      expect(await heldOf(thomas)).toEqual(["Prepared"]);
    });
  });

  describe("lowering a member", () => {
    it("below Écriture frees their takes, like a deactivation", async () => {
      const { project, pageId } = await setup();

      await instance.admin.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "comment" });

      const [freed] = await threadsOf(pageId);
      expect(freed).toMatchObject({ toTake: true, traces: [{ kind: "released", taker: { name: "Thomas Lefevre" } }] });
    });

    it("by removing their entry from a private project frees their takes", async () => {
      const { project, pageId } = await setup("conversation", { visibility: "private" });

      await instance.admin.send("DELETE", `/api/projects/${project.id}/members/${instance.people.thomas.id}`);

      expect(await threadsOf(pageId)).toMatchObject([{ toTake: true }]);
    });

    it("keeps their takes when they stay at Écriture", async () => {
      const { project, pageId } = await setup();

      await instance.admin.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "write" });

      expect(await threadsOf(pageId)).toMatchObject([{ take: { person: { name: "Thomas Lefevre" } } }]);
    });
  });

  describe("Commentaire members", () => {
    it("reply in a thread taken by someone, which stays with its handler as a relaunch, but cannot resolve it", async () => {
      const { pageId, thread, token } = await setup();
      await call(token, "POST", `/threads/${thread.id}/replies`, { body: "Done", terminalSessionId: SESSION });

      expect((await instance.marc.send("POST", `/api/threads/${thread.id}/messages`, { body: "Still too small" })).status).toBe(201);
      expect((await instance.marc.send("POST", `/api/threads/${thread.id}/resolve`)).status).toBe(403);

      expect(await threadsOf(pageId)).toMatchObject([{ status: "open", relaunch: true, take: { person: { name: "Thomas Lefevre" } } }]);
    });

    it("cannot switch the mode of the page", async () => {
      const { pageId } = await setup();
      expect((await instance.marc.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" })).status).toBe(403);
    });
  });

  describe("link visitor with Écriture", () => {
    it("posts a thread to take, never À relire, and can neither hand over, switch the mode nor take", async () => {
      const { pageId } = await setup();
      const created = await instance.admin.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "write" });
      expect(created.status).toBe(201);
      const link = (await created.json()) as ShareLink;
      const visit = (method: string, path: string, body?: unknown) =>
        fetch(`${instance.server.url}/s/${link.token}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

      const posted = await visit("POST", `/api/pages/${pageId}/threads`, { target, body: "From the client", visitorName: "Marc" });

      expect(posted.status).toBe(201);
      const thread = (await posted.json()) as Thread;
      expect(thread).toMatchObject({ status: "open", toTake: true });
      expect((await visit("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true })).status).toBe(403);
      expect((await visit("POST", `/api/threads/${thread.id}/release`, {})).status).toBe(403);
      expect((await visit("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" })).status).toBe(403);
    });
  });

  describe("accounts sharing a display name", () => {
    it("are told apart by their e-mail in what a conversation is told about other takes", async () => {
      const { project, pageId } = await setup();
      const db = new Database(join(instance.dataDir, "redline.db"));
      db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, 'Thomas Lefevre', 'thomas.l@example.com', ?, 'member', 'active', ?, 'local')").run(randomUUID(), new Date().toISOString(), await hashPassword(PASSWORD));
      db.close();
      const namesake = await instance.signIn("thomas.l@example.com");
      await instance.admin.send("PUT", `/api/projects/${project.id}/members/${(await namesake.json<{ id: string }>("/api/me")).id}`, { level: "write" });
      const token = await tokenOf(namesake);
      await call(token, "POST", `/terminal-sessions/${OTHER_SESSION}/heartbeat`, { folder: "/Users/other/site", machine: "iMac" });

      const answer = (await (await call(token, "POST", `/terminal-sessions/${OTHER_SESSION}/take`, { pageId })).json()) as { others: { by: string }[] };

      expect(answer.others.map((other) => other.by)).toEqual(["Thomas Lefevre (thomas@example.com)"]);
      expect(await threadsOf(pageId)).toMatchObject([{ take: { person: { email: "thomas@example.com" }, sameName: true } }]);
    });
  });

  describe("admins", () => {
    it("count as Écriture to take threads, even without a member entry on a private project", async () => {
      const project = await instance.createProject(instance.ariane, { visibility: "private" });
      const pageId = await instance.createPage(instance.ariane, project.id, "Partager", "conversation");
      await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Bigger" });
      const token = await tokenOf(instance.admin);
      await call(token, "POST", `/terminal-sessions/${SESSION}/heartbeat`, { folder: "/Users/v/site", machine: "MacBook-Air" });

      const answer = (await (await call(token, "POST", `/terminal-sessions/${SESSION}/take`, { pageId })).json()) as { comments: unknown[] };

      expect(answer.comments).toHaveLength(1);
    });
  });

  describe("archived pages and deleted threads", () => {
    it("skips an archived page in the listing and the counters, refuses replies, and brings everything back on unarchive", async () => {
      const { project, pageId, thread, token } = await setup();
      await instance.admin.send("POST", `/api/pages/${pageId}/archive`);

      const refused = await call(token, "POST", `/threads/${thread.id}/replies`, { body: "Done", terminalSessionId: SESSION });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(await refused.json())).toContain("archiv");
      const listing = await (await call(token, "POST", `/terminal-sessions/${SESSION}/take`, { projectIds: [project.id] })).json();
      expect(JSON.stringify(listing)).not.toContain("Partager");

      await instance.admin.send("POST", `/api/pages/${pageId}/unarchive`);
      expect(await threadsOf(pageId)).toMatchObject([{ take: { person: { name: "Thomas Lefevre" } } }]);
      expect((await call(token, "POST", `/threads/${thread.id}/replies`, { body: "Done", terminalSessionId: SESSION })).status).toBe(201);
    });

    it("refuses a reply to a deleted thread with a clear message", async () => {
      const { pageId, thread, token } = await setup();
      await instance.admin.send("POST", `/api/pages/${pageId}/archive`);
      expect((await instance.admin.send("DELETE", `/api/pages/${pageId}`, { title: "Partager" })).status).toBe(204);

      const refused = await call(token, "POST", `/threads/${thread.id}/replies`, { body: "Done", terminalSessionId: SESSION });

      expect(refused.status).toBe(404);
      expect(((await refused.json()) as { error: string }).error).toMatch(/no longer exists/);
    });
  });
});
