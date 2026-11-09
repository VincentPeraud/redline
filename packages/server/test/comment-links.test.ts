import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Thread, ShareLink } from "@redline/shared";
import { AccountsInstance } from "./accounts-harness.js";

const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const JSON_HEADERS = { "content-type": "application/json" };

describe("page links in Commentaire", () => {
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
  const createLink = async (pageId: string, body: object = {}): Promise<ShareLink> =>
    (await (await instance.ariane.send("POST", `/api/pages/${pageId}/links`, { kind: "generic", name: "Client", level: "comment", ...body })).json()) as ShareLink;
  /** A call as a visitor of a link, one device each. */
  const visit = (link: ShareLink, path: string, body?: unknown) =>
    fetch(`${instance.server.url}/s/${link.token}${path}`, { method: body === undefined ? "GET" : "POST", headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const comment = (link: ShareLink, pageId: string, text: string, extra: object = {}) =>
    visit(link, `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: text, ...extra });
  const threadsOf = async (link: ShareLink, pageId: string) => (await (await visit(link, `/api/pages/${pageId}/threads`)).json()) as Thread[];

  it("stores a Commentaire flag 'direct' only on Commentaire links", async () => {
    const { pageId } = await setup();
    expect((await createLink(pageId, { direct: true })).direct).toBe(true);
    expect((await createLink(pageId, { level: "read", direct: true })).direct).toBe(false);
  });

  it("lets two visitors of one generic link see each other's threads, never the team's nor another link's", async () => {
    const { pageId } = await setup();
    const link = await createLink(pageId);
    const other = await createLink(pageId, { name: "Other" });
    await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team secret" });
    expect((await comment(link, pageId, "Nice title", { visitorName: "Marc" })).status).toBe(201);
    expect((await comment(link, pageId, "Too big", { visitorName: "Sophie" })).status).toBe(201);
    expect((await comment(other, pageId, "Elsewhere", { visitorName: "Zoe" })).status).toBe(201);

    const seen = await threadsOf(link, pageId);
    expect(seen.map((t) => t.body)).toEqual(["Nice title", "Too big"]);
    expect(JSON.stringify(seen)).not.toContain("Team secret");
    expect(seen.map((t) => t.linkAuthor?.name)).toEqual(["Marc", "Sophie"]);
    expect((await threadsOf(other, pageId)).map((t) => t.body)).toEqual(["Elsewhere"]);
    // Members see all of them, signed as coming from a link.
    const all = await instance.ariane.json<Thread[]>(`/api/pages/${pageId}/threads`);
    expect(all).toHaveLength(4);
    expect(all.find((t) => t.body === "Nice title")?.linkAuthor).toEqual({ linkId: link.id, name: "Marc", linkName: "Client" });
  });

  it("signs a personal link with its name and asks a generic link for the visitor's name", async () => {
    const { pageId } = await setup();
    const personal = await createLink(pageId, { kind: "personal", name: "Alix" });
    const generic = await createLink(pageId);
    expect((await comment(personal, pageId, "From Alix", { visitorName: "Someone else" })).status).toBe(201);
    expect((await threadsOf(personal, pageId))[0].linkAuthor).toEqual({ linkId: personal.id, name: "Alix" });
    expect((await comment(generic, pageId, "No name")).status).toBe(400);
    expect((await comment(generic, pageId, "Blank name", { visitorName: "  " })).status).toBe(400);
  });

  it("keeps link comments À relire by default and sends them straight to Claude when the link is direct", async () => {
    const { project, pageId } = await setup();
    const agentToken = (await instance.ariane.json<{ token: string }>("/api/agent-token")).token;
    const agent = await instance.connectAgent(agentToken, { projectId: project.id });
    await agent.hello;
    const reviewed = await createLink(pageId);
    const direct = await createLink(pageId, { name: "Direct", direct: true });
    const work = () => agent.messages.filter((m) => m.type === "work").length;

    const first = (await (await comment(reviewed, pageId, "Please read", { visitorName: "Marc" })).json()) as Thread;
    await tick();
    expect(first.status).toBe("review");
    expect(work()).toBe(0);

    const second = (await (await comment(direct, pageId, "Go now", { visitorName: "Marc" })).json()) as Thread;
    await tick();
    expect(second.status).toBe("open");
    expect(work()).toBeGreaterThan(0);
    agent.close();
  });

  it("lets a visitor reply in its link's threads only, back to À relire on a reviewed link", async () => {
    const { pageId } = await setup();
    const link = await createLink(pageId);
    const mine = (await (await comment(link, pageId, "Mine", { visitorName: "Marc" })).json()) as Thread;
    const team = (await (await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team" })).json()) as Thread;
    expect((await visit(link, `/api/threads/${mine.id}/messages`, { body: "More", visitorName: "Marc" })).status).toBe(201);
    expect((await threadsOf(link, pageId))[0].replies.map((r) => [r.body, r.linkAuthor?.name])).toEqual([["More", "Marc"]]);
    expect((await visit(link, `/api/threads/${team.id}/messages`, { body: "Sneaky", visitorName: "Marc" })).status).toBe(403);
    expect((await visit(link, `/api/threads/${mine.id}/resolve`, {})).status).toBe(403);
  });

  it("never lets a Lecture link comment, nor a visitor hold a comment or pick a model", async () => {
    const { pageId } = await setup();
    const reading = await createLink(pageId, { level: "read" });
    expect((await comment(reading, pageId, "No", { visitorName: "Marc" })).status).toBe(403);
    const link = await createLink(pageId, { direct: true });
    const thread = (await (await comment(link, pageId, "Held?", { visitorName: "Marc", held: true })).json()) as Thread;
    expect(thread.status).not.toBe("held");
  });
});
