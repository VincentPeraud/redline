import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, SERVER_EVENTS_PATH, SESSIONS_PATH, type AgentTokenResponse, type CommentsOverview, type CommentsReminder, type QueueEntry, type ReleaseCommentsResponse, type SessionRow, type ShareLink, type TakeCommentsResponse, type Thread } from "@redline/shared";
import { AccountsInstance, FILES, type SignedIn, type TestAgent } from "./accounts-harness.js";

const SESSION_A = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
const SESSION_B = "8e2a2e2f-4d1b-4e7f-8b54-6c9e4d2b3a21";
const target = { kind: "artboard", artboard: "home.html" };
const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;
const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("comments on demand: final review fixes", () => {
  let instance: AccountsInstance;
  let agent: TestAgent | undefined;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(async () => {
    agent?.close();
    agent = undefined;
    await instance.close();
  });

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(instance.server.url + AGENT_API_PREFIX + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const beat = (token: string, session: string, folder: string) => call(token, "POST", `/terminal-sessions/${session}/heartbeat`, { folder, machine: "MacBook-Air" });
  const take = async <T = TakeCommentsResponse>(token: string, session: string, body: object) => (await call(token, "POST", `/terminal-sessions/${session}/take`, body)).json() as Promise<T>;
  const reply = (token: string, session: string | undefined, threadId: string, extra: object = {}) => call(token, "POST", `/threads/${threadId}/replies`, { body: "Done", ...(session ? { terminalSessionId: session } : {}), ...extra });
  const threadsOf = (pageId: string) => instance.admin.json<Thread[]>(`/api/pages/${pageId}/threads`);
  const queueOf = (pageId: string) => instance.admin.json<QueueEntry[]>(`/api/pages/${pageId}/queue`);

  /** A Team project where Ariane and Thomas write (Marc comments), one page in Conversation mode with one thread Thomas's conversation took (unless `taken` is false). */
  async function setup(options: { taken?: boolean; project?: object } = {}) {
    const { admin, people } = instance;
    const project = await instance.createProject(admin, options.project);
    for (const person of [people.ariane, people.thomas]) await admin.send("PUT", `/api/projects/${project.id}/members/${person.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.marc.id}`, { level: "comment" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const thread = (await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Bigger" })).json()) as Thread;
    const [ariane, thomas, marc] = [await tokenOf(instance.ariane), await tokenOf(instance.thomas), await tokenOf(instance.marc)];
    await beat(thomas, SESSION_A, "/Users/tom/site");
    if (options.taken !== false) await take(thomas, SESSION_A, { pageId });
    return { project, pageId, thread, ariane, thomas, marc };
  }

  describe("spec", () => {
    it("3: a resolution ends the take; a late answer is added as resolved; a reopened thread follows the page's mode", async () => {
      const { pageId, thread, thomas } = await setup();

      expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`)).status).toBe(200);
      const [resolved] = await threadsOf(pageId);
      expect(resolved).not.toHaveProperty("take");
      expect(resolved.traces).toMatchObject([{ kind: "resolved", taker: { name: "Thomas Lefevre" }, by: { name: "Ariane Martin" } }]);

      const late = await reply(thomas, SESSION_A, thread.id);
      expect(late.status).toBe(201);
      expect((await threadsOf(pageId))[0]).toMatchObject({ status: "resolved", replies: [{ author: "claude", late: "resolved" }] });

      expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/reopen`)).status).toBe(200);
      expect((await threadsOf(pageId))[0]).toMatchObject({ status: "open", toTake: true });
    });

    it("4: with a page, the account's takes from another folder are listed apart, not handled", async () => {
      const { pageId, thread, thomas } = await setup();
      await beat(thomas, SESSION_B, "/Users/tom/other");

      const answer = await take(thomas, SESSION_B, { pageId });

      expect(answer.comments).toEqual([]);
      expect(answer.mineElsewhere).toEqual([expect.objectContaining({ threadId: thread.id, folder: "~/site" })]);
    });

    it("5: a late answer of the conversation after a hand-over reaches the agent's work", async () => {
      const { project, pageId, thread, thomas } = await setup();
      agent = await instance.connectAgent(await tokenOf(instance.ariane), { projectIds: [project.id] });
      await agent.hello;
      expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true })).status).toBe(200);
      await tick();
      expect(await queueOf(pageId)).toEqual([]);

      expect((await reply(thomas, SESSION_A, thread.id, { body: "Late but useful" })).status).toBe(201);

      expect(await queueOf(pageId)).toEqual([expect.objectContaining({ threadIds: [thread.id] })]);
    });

    it("6: a refused answer says why and what to ask for", async () => {
      const { thread, marc } = await setup();
      await beat(marc, SESSION_B, "/Users/marc/site");

      const refused = await reply(marc, SESSION_B, thread.id);

      expect(refused.status).toBe(403);
      const { error } = (await refused.json()) as { error: string };
      expect(error).toMatch(/Commentaire right/);
      expect(error).toMatch(/ask an admin/);
    });

    it("8: publishing a page makes it one of the pages the reminder line is about", async () => {
      const { pageId, thomas } = await setup({ taken: false });
      const base = (await instance.admin.json<{ id: string }[]>(`/api/pages/${pageId}/versions`))[0].id;

      const published = await call(thomas, "POST", `/pages/${pageId}/versions`, { files: { "home.html": "<h1>Blue</h1>", "manifest.json": FILES["manifest.json"] }, message: "Blue", origin: "terminal", baseVersionId: base, terminalSessionId: SESSION_A });

      expect(published.status).toBe(201);
      const reminder = (await (await call(thomas, "GET", `/terminal-sessions/${SESSION_A}/reminder`)).json()) as CommentsReminder;
      expect(reminder.pages).toEqual([expect.objectContaining({ pageId, count: 1 })]);
    });

    it("9: a failed run does not block a takeover", async () => {
      // Covered at the lock level in waiting-takes.test.ts; here only the shape of the refusal for a running one.
      const { project, thread, ariane } = await setup();
      agent = await instance.connectAgent(await tokenOf(instance.ariane), { projectIds: [project.id] });
      await agent.hello;
      await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true });
      await beat(ariane, SESSION_B, "/Users/ana/crm");

      const answer = await take(ariane, SESSION_B, { threadIds: [thread.id], takeOver: true });

      expect(answer.refused).toEqual([expect.objectContaining({ threadId: thread.id, reason: expect.stringMatching(/running/) })]);
    });

    it("10: a Team project turned Private frees the takes of the members who lose access", async () => {
      const { project, pageId } = await setup();

      expect((await instance.admin.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" })).status).toBe(200);

      const [freed] = await threadsOf(pageId);
      expect(freed).not.toHaveProperty("take");
      expect(freed).toMatchObject({ toTake: true, traces: [{ kind: "released", taker: { name: "Thomas Lefevre" } }] });
    });

    it("H6: an admin demoted to member loses the takes of a project they no longer write in", async () => {
      const { admin, people } = instance;
      const project = await instance.createProject(admin, { visibility: "private" });
      const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
      await admin.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Bigger" });
      await admin.send("PATCH", `/api/accounts/${people.thomas.id}`, { role: "admin" });
      const thomas = await tokenOf(await instance.signIn("thomas@example.com"));
      await beat(thomas, SESSION_A, "/Users/tom/site");
      expect((await take(thomas, SESSION_A, { pageId })).comments).toHaveLength(1);

      await admin.send("PATCH", `/api/accounts/${people.thomas.id}`, { role: "member" });

      expect((await threadsOf(pageId))[0]).toMatchObject({ toTake: true });
    });
  });

  describe("security", () => {
    const draft = async (who: SignedIn, pageId: string, body: string) => (await (await who.send("POST", `/api/pages/${pageId}/threads`, { target, body, held: true })).json()) as Thread;

    it("S1: the Sessions screen hides other members' drafts, on the list and on the detail", async () => {
      const { pageId } = await setup();
      const secret = await draft(instance.thomas, pageId, "Secret remark about the boss");

      const rows = await instance.ariane.json<SessionRow[]>(SESSIONS_PATH);
      expect(JSON.stringify(rows)).not.toContain("Secret remark");
      expect((await instance.ariane.send("GET", `${SESSIONS_PATH}/${secret.id}`)).status).toBe(404);
      expect((await instance.thomas.send("GET", `${SESSIONS_PATH}/${secret.id}`)).status).toBe(200);
    });

    it("S2: a draft cannot be resolved, reopened, answered or made public by someone else", async () => {
      const { pageId, ariane } = await setup();
      const secret = await draft(instance.thomas, pageId, "Secret");

      for (const [method, path, body] of [
        ["POST", `/api/threads/${secret.id}/resolve`, {}],
        ["POST", `/api/threads/${secret.id}/reopen`, {}],
        ["POST", `/api/threads/${secret.id}/messages`, { body: "Hello" }],
      ] as const) expect((await instance.ariane.send(method, path, body)).status, path).toBe(409);
      expect((await reply(ariane, undefined, secret.id)).status).toBe(409);
      expect((await instance.thomas.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === secret.id)).toMatchObject({ status: "held", replies: [] });
    });

    it("S2: the event stream does not tell other accounts about a draft", async () => {
      const { pageId } = await setup();
      const controller = new AbortController();
      const stream = await fetch(instance.server.url + SERVER_EVENTS_PATH, { headers: { cookie: instance.ariane.cookie }, signal: controller.signal });
      let heard = "";
      void (async () => {
        const reader = stream.body!.getReader();
        for (;;) heard += new TextDecoder().decode((await reader.read()).value);
      })().catch(() => undefined);
      const secret = await draft(instance.thomas, pageId, "Secret");
      const open = (await (await instance.thomas.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Public" })).json()) as Thread;
      await tick(300);
      controller.abort();

      expect(heard).toContain(open.id);
      expect(heard).not.toContain(secret.id);
    });

    it("S3: a link visitor never gets e-mails, account ids or folders from a resolved, taken, traced thread", async () => {
      const { pageId, thread } = await setup();
      const link = (await (await instance.admin.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "write" })).json()) as ShareLink;
      await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`);
      await instance.admin.send("POST", `/api/threads/${thread.id}/reopen`);

      const seen = await (await fetch(`${instance.server.url}/s/${link.token}/api/pages/${pageId}/threads`)).text();

      expect(seen).toContain("Thomas Lefevre");
      expect(seen).not.toContain("@example.com");
      for (const person of Object.values(instance.people)) expect(seen).not.toContain(person.id);
      expect(seen).not.toContain("/Users/tom");
      expect(seen).not.toContain("MacBook-Air");
    });

    it("S3: and the same holds for a thread that is still taken", async () => {
      const { pageId } = await setup();
      const link = (await (await instance.admin.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "write" })).json()) as ShareLink;

      const seen = await (await fetch(`${instance.server.url}/s/${link.token}/api/pages/${pageId}/threads`)).text();

      expect(seen).not.toContain("~/site");
      expect(seen).not.toContain("MacBook-Air");
      expect(seen).not.toContain("@example.com");
    });

    it("H1: an answer cannot borrow another account's terminal session", async () => {
      const { thread, ariane } = await setup();
      await beat(ariane, SESSION_B, "/Users/ana/crm");

      const stolen = await reply(await tokenOf(instance.thomas), SESSION_B, thread.id);

      expect(stolen.status).toBe(403);
      expect((await threadsOf(thread.pageId))[0].replies).toEqual([]);
    });

    it("H3: take and release refuse an archived page and skip its threads", async () => {
      const { pageId, thread, thomas } = await setup();
      await instance.admin.send("POST", `/api/pages/${pageId}/archive`);

      expect((await call(thomas, "POST", `/terminal-sessions/${SESSION_A}/take`, { pageId })).status).toBe(409);
      expect((await call(thomas, "POST", `/terminal-sessions/${SESSION_A}/release`, { pageId })).status).toBe(409);
      const byId = await take(thomas, SESSION_A, { threadIds: [thread.id] });
      expect(byId.comments).toEqual([]);
      expect(byId.refused).toEqual([expect.objectContaining({ threadId: thread.id, reason: expect.stringMatching(/archived/) })]);
      const released = (await (await call(thomas, "POST", `/terminal-sessions/${SESSION_A}/release`, { threadIds: [thread.id] })).json()) as ReleaseCommentsResponse;
      expect(released.released).toEqual([]);
      expect((await threadsOf(pageId))[0]).toMatchObject({ take: { person: { name: "Thomas Lefevre" } } });
    });

    it("H4: the overview gives nothing about a project the account cannot see", async () => {
      const { admin } = instance;
      const hidden = await instance.createProject(admin, { title: "Confidential launch", visibility: "private" });
      await instance.createPage(admin, hidden.id, "Page");
      const marc = await tokenOf(instance.marc);
      await beat(marc, SESSION_B, "/Users/marc/site");

      const overview = await take<CommentsOverview>(marc, SESSION_B, { projectIds: [hidden.id] });

      expect(JSON.stringify(overview)).not.toContain("Confidential");
      expect(overview.projects[0]).toMatchObject({ pageCount: 0 });
    });
  });
});
