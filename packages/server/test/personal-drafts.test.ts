import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessLevel, SendHeldResponse, Thread } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

describe("drafts are personal", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  /** Ariane's project where Thomas has Écriture too, with one page in Conversation mode. */
  async function setup() {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    await ariane.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "write" satisfies AccessLevel });
    const pageId = await instance.createPage(ariane, project.id, "Home", "conversation");
    return { project, pageId, ariane, thomas };
  }
  const target = { kind: "artboard", artboard: "home.html" };
  const draft = async (who: SignedIn, pageId: string, body: string) =>
    (await (await who.send("POST", `/api/pages/${pageId}/threads`, { target, body, held: true })).json()) as Thread;
  const threadsOf = (who: SignedIn, pageId: string) => who.json<Thread[]>(`/api/pages/${pageId}/threads`);

  it("lists, edits and deletes only the author's own drafts", async () => {
    const { pageId, ariane, thomas } = await setup();
    const mine = await draft(ariane, pageId, "Mine");
    const theirs = await draft(thomas, pageId, "Theirs");

    expect((await threadsOf(ariane, pageId)).map((t) => t.body)).toEqual(["Mine"]);
    expect((await threadsOf(thomas, pageId)).map((t) => t.body)).toEqual(["Theirs"]);
    expect((await ariane.json<Thread[]>(`/api/pages/${pageId}/held`)).map((t) => t.id)).toEqual([mine.id]);
    expect((await ariane.send("PATCH", `/api/threads/${theirs.id}`, { body: "Hijacked" })).status).toBe(403);
    expect((await ariane.send("DELETE", `/api/threads/${theirs.id}`)).status).toBe(403);
    expect((await thomas.json<Thread[]>(`/api/pages/${pageId}/held`)).map((t) => t.body)).toEqual(["Theirs"]);
    expect((await ariane.send("PATCH", `/api/threads/${mine.id}`, { body: "Better" })).status).toBe(200);
    expect((await ariane.send("DELETE", `/api/threads/${mine.id}`)).status).toBe(204);
    expect(await threadsOf(ariane, pageId)).toEqual([]);
  });

  it("sends only the caller's drafts with Tout envoyer, which become threads to take", async () => {
    const { pageId, ariane, thomas } = await setup();
    await draft(ariane, pageId, "Mine");
    await draft(thomas, pageId, "Theirs");

    const sent = (await (await ariane.send("POST", `/api/pages/${pageId}/send-held`, {})).json()) as SendHeldResponse;

    expect(sent.threads).toBe(1);
    expect((await threadsOf(ariane, pageId)).map((t) => [t.body, t.status, t.toTake ?? false])).toEqual([["Mine", "open", true]]);
    expect((await threadsOf(thomas, pageId)).map((t) => [t.body, t.status, t.toTake ?? false])).toEqual([
      ["Mine", "open", true],
      ["Theirs", "held", false],
    ]);
    expect((await ariane.json<{ toTakeCount: number }[]>(`/api/projects/${(await ariane.json<{ projectId: string }>(`/api/pages/${pageId}`)).projectId}/pages`))[0].toTakeCount).toBe(1);
  });

  it("keeps the drafts of a member lowered to Commentaire, who sends them À relire", async () => {
    const { project, pageId, ariane, thomas } = await setup();
    await draft(thomas, pageId, "Prepared before");
    await ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "comment" satisfies AccessLevel });

    expect((await threadsOf(thomas, pageId)).map((t) => t.status)).toEqual(["held"]);
    const sent = await thomas.send("POST", `/api/pages/${pageId}/send-held`, {});

    expect(sent.status).toBe(200);
    expect((await threadsOf(ariane, pageId)).map((t) => [t.status, t.toTake ?? false])).toEqual([["review", false]]);
  });
});
