import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type Page, type TakeCommentsResponse, type Thread } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

const SESSION_A = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
const SESSION_B = "8e2a2e2f-4d1b-4e7f-8b54-6c9e4d2b3a21";
const SESSION_C = "9f3b3f30-5e2c-4f80-9c65-7daf5e3c4b32";
const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;

describe("a take belongs to the account", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const call = async (token: string, method: string, path: string, body?: unknown) =>
    fetch(instance.server.url + AGENT_API_PREFIX + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const beat = (token: string, session: string, folder: string) => call(token, "POST", `/terminal-sessions/${session}/heartbeat`, { folder, machine: "MacBook-Air" });
  const take = async (token: string, session: string, pageId: string) => (await call(token, "POST", `/terminal-sessions/${session}/take`, { pageId })).json() as Promise<TakeCommentsResponse>;
  const reply = (token: string, session: string, threadId: string) => call(token, "POST", `/threads/${threadId}/replies`, { body: "Done", terminalSessionId: session });

  /** A project where Ariane and Thomas have Écriture, with one page in Conversation mode and one thread on it. */
  async function setup() {
    const { admin, people } = instance;
    const project = await instance.createProject(admin);
    for (const person of [people.ariane, people.thomas]) await admin.send("PUT", `/api/projects/${project.id}/members/${person.id}`, { level: "write" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const thread = (await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger" })).json()) as Thread;
    return { project, pageId, thread };
  }

  it("is found again by another conversation of the same account, and is not to take for another account", async () => {
    const { pageId, thread } = await setup();
    const [ariane, thomas] = [await tokenOf(instance.ariane), await tokenOf(instance.thomas)];
    await beat(ariane, SESSION_A, "/Users/ana/crm");
    await beat(thomas, SESSION_B, "/Users/tom/site");
    await beat(ariane, SESSION_C, "/Users/ana/crm");

    expect((await take(ariane, SESSION_A, pageId)).comments).toEqual([expect.objectContaining({ threadId: thread.id, state: "new" })]);

    expect((await take(thomas, SESSION_B, pageId)).comments).toEqual([]);
    expect((await reply(thomas, SESSION_B, thread.id)).status).toBe(409);
    expect((await take(ariane, SESSION_C, pageId)).comments).toEqual([expect.objectContaining({ threadId: thread.id, state: "taken" })]);
    expect((await reply(ariane, SESSION_C, thread.id)).status).toBe(201);
    const [answered] = await instance.admin.json<Thread[]>(`/api/pages/${pageId}/threads`);
    expect(answered).toMatchObject({
      take: { person: { name: "Ariane Martin" }, folder: "~/crm", machine: "MacBook-Air" },
      replies: [{ author: "claude", conversation: { person: { name: "Ariane Martin" }, folder: "~/crm" } }],
    });
  });

  it("refuses an account without Écriture, whatever its conversation", async () => {
    const { project, pageId, thread } = await setup();
    await instance.admin.send("PUT", `/api/projects/${project.id}/members/${instance.people.marc.id}`, { level: "read" });
    const marc = await tokenOf(instance.marc);
    await beat(marc, SESSION_A, "/Users/marc/site");

    const refused = await call(marc, "POST", `/terminal-sessions/${SESSION_A}/take`, { pageId });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Écriture/);
    expect((await call(marc, "POST", `/threads/${thread.id}/replies`, { body: "Hi", terminalSessionId: SESSION_A })).status).toBe(403);
    expect(await instance.admin.json<Page>(`/api/pages/${pageId}`)).toMatchObject({ commentMode: "conversation" });
  });

  it("refuses to take a page that does not exist", async () => {
    const ariane = await tokenOf(instance.ariane);
    await beat(ariane, SESSION_A, "/Users/ana/crm");

    expect((await call(ariane, "POST", `/terminal-sessions/${SESSION_A}/take`, { pageId: "nope" })).status).toBe(404);
  });
});
