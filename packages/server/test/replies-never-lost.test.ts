import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentReplyResponse, type AgentTokenResponse, type TakeCommentsResponse, type Thread } from "@redline/shared";
import { Store } from "../src/store.js";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

const SESSION_A = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
const SESSION_B = "8e2a2e2f-4d1b-4e7f-8b54-6c9e4d2b3a21";
const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;

describe("a reply is never lost", () => {
  let instance: AccountsInstance;
  let other: Store;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
    // A second handle on the same data: what the hand-over and takeover tickets will do through their own routes.
    other = new Store(instance.dataDir);
  });
  afterEach(async () => {
    await instance.close();
  });

  const call = async (token: string, method: string, path: string, body?: unknown) =>
    fetch(instance.server.url + AGENT_API_PREFIX + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const beat = (token: string, session: string, folder: string) => call(token, "POST", `/terminal-sessions/${session}/heartbeat`, { folder, machine: "MacBook-Air" });
  const take = (token: string, session: string, pageId: string) => call(token, "POST", `/terminal-sessions/${session}/take`, { pageId });
  const takeOver = (token: string, session: string, threadId: string) => call(token, "POST", `/terminal-sessions/${session}/take`, { threadIds: [threadId], takeOver: true });
  const reply = async (token: string, session: string, threadId: string, extra: Record<string, unknown> = {}) => {
    const res = await call(token, "POST", `/threads/${threadId}/replies`, { body: "Done", terminalSessionId: session, ...extra });
    return { status: res.status, body: (await res.json()) as AgentReplyResponse };
  };

  /** Ariane and Thomas have Écriture, each with a conversation; Ariane's took the thread unless `taken` is false. */
  async function setup(options: { taken?: boolean } = {}) {
    const { admin, people } = instance;
    const project = await instance.createProject(admin);
    for (const person of [people.ariane, people.thomas]) await admin.send("PUT", `/api/projects/${project.id}/members/${person.id}`, { level: "write" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const thread = (await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger" })).json()) as Thread;
    const [ariane, thomas] = [await tokenOf(instance.ariane), await tokenOf(instance.thomas)];
    await beat(ariane, SESSION_A, "/Users/ana/crm");
    await beat(thomas, SESSION_B, "/Users/tom/site");
    if (options.taken !== false) await take(ariane, SESSION_A, pageId);
    const read = async () => (await instance.admin.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === thread.id)!;
    return { pageId, thread, ariane, thomas, read };
  }

  it("takes a thread to take for the account that answers it", async () => {
    const { thread, ariane, read } = await setup({ taken: false });

    const answered = await reply(ariane, SESSION_A, thread.id);

    expect(answered.status).toBe(201);
    expect(answered.body.note).toBeUndefined();
    expect(await read()).toMatchObject({ take: { person: { name: "Ariane Martin" }, folder: "~/crm" }, replies: [{ conversation: { folder: "~/crm" } }] });
    expect(await read()).not.toHaveProperty("toTake");
  });

  it("adds the answer of another account to a thread somebody took, signed, and leaves the take alone", async () => {
    const { thread, thomas, read } = await setup();

    const answered = await reply(thomas, SESSION_B, thread.id);

    expect(answered.status).toBe(201);
    expect(answered.body.note).toMatch(/Ariane Martin/);
    expect(await read()).toMatchObject({ take: { person: { name: "Ariane Martin" } }, replies: [{ conversation: { person: { name: "Thomas Lefevre" }, folder: "~/site" } }] });
  });

  it("adds the answer after a hand-over to the agent, and says the thread is not the account's any more", async () => {
    const { thread, ariane, read } = await setup();
    other.releaseThreadTake(thread.id);
    other.setThreadSession(thread.id, "engine-session", "agent-1");
    other.addTrace(thread.id, { kind: "handed-over", takerId: instance.people.ariane.id, byId: instance.people.thomas.id });

    const answered = await reply(ariane, SESSION_A, thread.id);

    expect(answered.status).toBe(201);
    expect(answered.body.note).toMatch(/^Il n'est plus à toi : Thomas Lefevre l'a confié à l'agent .+\. L'agent verra ta réponse\.$/);
    const after = await read();
    expect(after.replies).toMatchObject([{ author: "claude", body: "Done", late: "handed-over" }]);
    expect(after).not.toHaveProperty("take");
    expect(after.traces).toMatchObject([{ kind: "handed-over", taker: { name: "Ariane Martin" }, by: { name: "Thomas Lefevre" } }]);
  });

  it("records the takeover trace for real through pending_comments takeOver", async () => {
    const { thread, thomas, read } = await setup();

    await takeOver(thomas, SESSION_B, thread.id);

    expect((await read()).traces).toMatchObject([{ kind: "taken-over", taker: { name: "Ariane Martin" }, by: { name: "Thomas Lefevre" } }]);
  });

  it("adds the answer after a takeover, and says who took the thread over", async () => {
    const { thread, ariane, thomas, read } = await setup();
    expect(((await (await takeOver(thomas, SESSION_B, thread.id)).json()) as TakeCommentsResponse).comments).toMatchObject([{ state: "taken-over" }]);

    const answered = await reply(ariane, SESSION_A, thread.id);

    expect(answered.status).toBe(201);
    expect(answered.body.note).toMatch(/^Il n'est plus à toi : Thomas Lefevre l'a repris .+\. Sa conversation verra ta réponse\.$/);
    expect(await read()).toMatchObject({ take: { person: { name: "Thomas Lefevre" } }, replies: [{ late: "taken-over" }] });
  });

  it("resolves a thread somebody else took with the trace \"Résolu par\", and keeps it resolved when a late answer comes", async () => {
    const { thread, ariane, thomas, read } = await setup();

    const resolved = await reply(thomas, SESSION_B, thread.id, { resolve: true });

    expect(resolved.status).toBe(201);
    expect(await read()).toMatchObject({ status: "resolved", resolvedBy: { name: "Thomas Lefevre" }, traces: [{ kind: "resolved", taker: { name: "Ariane Martin" }, by: { name: "Thomas Lefevre" } }] });

    const late = await reply(ariane, SESSION_A, thread.id);

    expect(late.status).toBe(201);
    expect(late.body.note).toMatch(/^Ce fil est résolu : Thomas Lefevre l'a résolu .+\. Ta réponse est ajoutée, il reste résolu\.$/);
    expect(await read()).toMatchObject({ status: "resolved", replies: [{ body: "Done" }, { body: "Done", late: "resolved" }] });
  });

  it("records who resolved from the web, with a trace only when it is not the taker", async () => {
    const { thread, read } = await setup();

    await instance.thomas.send("POST", `/api/threads/${thread.id}/resolve`);

    expect(await read()).toMatchObject({ status: "resolved", resolvedBy: { name: "Thomas Lefevre" }, traces: [{ kind: "resolved", by: { name: "Thomas Lefevre" } }] });

    await instance.thomas.send("POST", `/api/threads/${thread.id}/reopen`);
    await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`);

    const mine = await read();
    expect(mine).toMatchObject({ status: "resolved", resolvedBy: { name: "Ariane Martin" } });
    expect(mine.traces).toHaveLength(1);
  });

  it("does not reopen a resolved thread when the taker's own answer comes late, and says so", async () => {
    const { thread, ariane, read } = await setup();
    await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`);

    const late = await reply(ariane, SESSION_A, thread.id);

    expect(late.status).toBe(201);
    expect(late.body.note).toMatch(/résolu/);
    expect(await read()).toMatchObject({ status: "resolved" });
  });
});
