import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENDPOINT, PROTOCOL_VERSION, type AccessLevel, type AgentHello, type ServerToAgentMessage, type Thread, type WorkItem } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

describe("À relire comments", () => {
  let instance: AccountsInstance;
  let sockets: WebSocket[];
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
    sockets = [];
  });
  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
  });

  /** Ariane's project with Thomas at Commentaire and Marc at Écriture, one page, and an agent connected for it. */
  async function setup() {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(ariane, project.id);
    await ariane.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "comment" satisfies AccessLevel });
    const { token } = await ariane.json<{ token: string }>("/api/agent-token");
    const socket = new WebSocket(instance.server.url.replace(/^http/, "ws") + AGENT_ENDPOINT);
    sockets.push(socket);
    const messages: ServerToAgentMessage[] = [];
    socket.addEventListener("message", (e) => {
      const message = JSON.parse(String(e.data)) as ServerToAgentMessage;
      messages.push(message);
      // The agent finishes at once, so the page is free for the next message.
      if (message.type === "work") socket.send(JSON.stringify({ type: "work-done", workId: message.item.id }));
    });
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    const hello: AgentHello = { type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "m", folder: "/f", kind: "project", projectId: project.id };
    socket.send(JSON.stringify(hello));
    await until(() => messages.length > 0);
    const received = (): WorkItem[] => messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
    return { project, pageId, ariane, thomas, received };
  }
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const comment = async (who: SignedIn, pageId: string, body: string) =>
    (await (await who.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;
  const threadsOf = (who: SignedIn, pageId: string) => who.json<Thread[]>(`/api/pages/${pageId}/threads`);

  it("keeps a Commentaire member's thread À relire and sends it to no agent", async () => {
    const { pageId, thomas, ariane, received } = await setup();
    const thread = await comment(thomas, pageId, "Make it bigger");
    await settle();
    expect(thread.status).toBe("review");
    expect(received()).toEqual([]);
    expect((await threadsOf(ariane, pageId)).map((t) => t.status)).toEqual(["review"]);
  });

  it("still dispatches at once the thread of a member in Écriture", async () => {
    const { pageId, ariane, received } = await setup();
    const thread = await comment(ariane, pageId, "Fix it");
    expect(thread.status).toBe("open");
    await until(() => received().length === 1);
  });

  it("sends one À relire thread, or several in one message, only when an Écriture member asks", async () => {
    const { pageId, thomas, ariane, received } = await setup();
    const first = await comment(thomas, pageId, "One");
    const second = await comment(thomas, pageId, "Two");
    const third = await comment(thomas, pageId, "Three");

    const single = await ariane.send("POST", `/api/pages/${pageId}/send-review`, { threadIds: [first.id] });
    expect(await single.json()).toEqual({ threads: 1 });
    await until(() => received().length === 1);
    expect(received()[0].threads.map((t) => t.threadId)).toEqual([first.id]);

    const batch = await ariane.send("POST", `/api/pages/${pageId}/send-review`, { threadIds: [second.id, third.id] });
    expect(await batch.json()).toEqual({ threads: 2 });
    await until(() => received().length === 2);
    expect(received()[1].threads.map((t) => t.threadId)).toEqual([second.id, third.id]);
    expect((await threadsOf(ariane, pageId)).map((t) => t.status)).toEqual(["open", "open", "open"]);
  });

  it("sends every À relire thread of the page when no ids are given", async () => {
    const { pageId, thomas, ariane, received } = await setup();
    await comment(thomas, pageId, "One");
    await comment(thomas, pageId, "Two");
    expect(await (await ariane.send("POST", `/api/pages/${pageId}/send-review`, {})).json()).toEqual({ threads: 2 });
    await until(() => received().length === 1);
    expect(received()[0].threads).toHaveLength(2);
  });

  it("refuses the Commentaire member who tries to send", async () => {
    const { pageId, thomas, received } = await setup();
    const thread = await comment(thomas, pageId, "Mine");
    expect((await thomas.send("POST", `/api/pages/${pageId}/send-review`, { threadIds: [thread.id] })).status).toBe(403);
    await settle();
    expect(received()).toEqual([]);
  });

  it("lets Écriture reply to or resolve an À relire thread without sending anything", async () => {
    const { pageId, thomas, ariane, received } = await setup();
    const answered = await comment(thomas, pageId, "Question");
    const closed = await comment(thomas, pageId, "Done already");
    expect((await ariane.send("POST", `/api/threads/${answered.id}/messages`, { body: "Next week" })).status).toBe(201);
    expect((await ariane.send("POST", `/api/threads/${closed.id}/resolve`)).status).toBe(200);
    await settle();
    expect(received()).toEqual([]);
    const threads = await threadsOf(ariane, pageId);
    expect(threads.map((t) => [t.status, t.replies.length])).toEqual([["review", 1], ["resolved", 0]]);
  });

  it("puts a thread already sent to Claude back to À relire when a Commentaire member replies, without dispatching", async () => {
    const { pageId, thomas, ariane, received } = await setup();
    const thread = await comment(thomas, pageId, "First");
    await ariane.send("POST", `/api/pages/${pageId}/send-review`, { threadIds: [thread.id] });
    await until(() => received().length === 1);

    expect((await thomas.send("POST", `/api/threads/${thread.id}/messages`, { body: "And also this" })).status).toBe(201);
    await settle();
    expect(received()).toHaveLength(1);
    expect((await threadsOf(ariane, pageId))[0].status).toBe("review");

    await ariane.send("POST", `/api/pages/${pageId}/send-review`, { threadIds: [thread.id] });
    await until(() => received().length === 2);
    expect(received()[1].message).toContain("And also this");
  });

  it("keeps À relire the threads of a member who was deactivated", async () => {
    const { pageId, thomas, ariane } = await setup();
    await comment(thomas, pageId, "Stays");
    expect((await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`)).status).toBe(200);
    expect((await threadsOf(ariane, pageId)).map((t) => t.status)).toEqual(["review"]);
  });
});
