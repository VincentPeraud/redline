import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageVersionSummary, ProjectSharing, ShareLink, Thread } from "@redline/shared";
import { AccountsInstance, FILES, type SignedIn } from "./accounts-harness.js";

const JSON_HEADERS = { "content-type": "application/json" };
const target = { kind: "artboard", artboard: "home.html" };

describe("rights fixes of the review", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const setup = async (body: object = {}) => {
    const project = await instance.createProject(instance.ariane, body);
    const pageId = await instance.createPage(instance.ariane, project.id);
    return { project, pageId };
  };
  const setLevel = (projectId: string, who: "thomas" | "marc", level: string) => instance.ariane.send("PUT", `/api/projects/${projectId}/members/${instance.people[who].id}`, { level });
  const makeLink = async (who: SignedIn, url: string, body: object = {}): Promise<ShareLink> => {
    const response = await who.send("POST", url, { kind: "personal", name: "Alix", level: "write", ...body });
    expect(response.status).toBe(201);
    return (await response.json()) as ShareLink;
  };
  /** A call through a link, signed in as `as` when given (a member opening it) or as a plain visitor. */
  const through = (link: ShareLink, path: string, body?: unknown, as?: SignedIn, method = body === undefined ? "GET" : "POST") =>
    fetch(`${instance.server.url}/s/${link.token}${path}`, { method, headers: { ...JSON_HEADERS, ...(as ? { cookie: as.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  describe("a member opening a link above their own level", () => {
    it("signs a comment with their account name, on a personal and on a generic link", async () => {
      const { project, pageId } = await setup();
      await setLevel(project.id, "thomas", "read");
      const personal = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "comment", name: "Alix" });
      const generic = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { kind: "generic", level: "comment", name: "Client" });
      for (const link of [personal, generic]) {
        const response = await through(link, `/api/pages/${pageId}/threads`, { target, body: "From Thomas" }, instance.thomas);
        expect(response.status).toBe(201);
        expect(((await response.json()) as Thread).linkAuthor).toMatchObject({ name: "Thomas Lefevre" });
      }
    });

    it("signs the versions they make through an Écriture link with their account name", async () => {
      const { project, pageId } = await setup();
      await instance.ariane.send("POST", `/api/pages/${pageId}/versions`, { files: { ...FILES, "home.html": "<h1>v2</h1>" }, message: "v2", origin: "user" });
      await setLevel(project.id, "thomas", "read");
      const link = await makeLink(instance.ariane, `/api/pages/${pageId}/links`);
      const first = (await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${pageId}/versions`)).at(-1)!;
      const restored = await through(link, `/api/pages/${pageId}/versions/${first.id}/restore`, { timeZone: "UTC" }, instance.thomas);
      expect(restored.status).toBe(201);
      const latest = (await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${pageId}/versions`))[0];
      expect(latest.linkAuthor?.name).toBe("Thomas Lefevre");
    });
  });

  describe("what an Écriture link reaches", () => {
    it("lets a visitor send À relire and held comments, rename the page and hand over a thread; refuses the other levels", async () => {
      const { pageId } = await setup();
      const write = await makeLink(instance.ariane, `/api/pages/${pageId}/links`);
      const comment = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "comment", name: "Bea" });
      const thread = (await (await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Hi" })).json()) as Thread;
      expect((await through(write, `/api/pages/${pageId}/send-review`, {})).status).toBe(200);
      expect((await through(write, `/api/pages/${pageId}/send-held`, {})).status).toBe(200);
      expect((await through(write, `/api/pages/${pageId}`, { title: "Renamed" }, undefined, "PATCH")).status).toBe(200);
      expect((await through(write, `/api/threads/${thread.id}/hand-over`, {})).status).toBe(409);
      for (const [path, body, method] of [[`/api/pages/${pageId}/send-review`, {}, "POST"], [`/api/pages/${pageId}/send-held`, {}, "POST"], [`/api/pages/${pageId}`, { title: "No" }, "PATCH"], [`/api/threads/${thread.id}/hand-over`, {}, "POST"]] as const) {
        expect((await through(comment, path, body, undefined, method)).status).toBe(403);
      }
    });

    it("still keeps links, archive, delete, members and agents out of reach", async () => {
      const { project, pageId } = await setup();
      const write = await makeLink(instance.ariane, `/api/projects/${project.id}/links`);
      const refused: [string, string][] = [
        ["POST", `/api/pages/${pageId}/links`],
        ["GET", `/api/pages/${pageId}/links`],
        ["POST", `/api/pages/${pageId}/archive`],
        ["DELETE", `/api/pages/${pageId}`],
        ["POST", `/api/projects/${project.id}/archive`],
        ["DELETE", `/api/projects/${project.id}`],
        ["PUT", `/api/projects/${project.id}/members/${instance.people.marc.id}`],
        ["GET", `/api/projects/${project.id}/sharing`],
        ["GET", "/api/agents"],
      ];
      for (const [method, path] of refused) expect((await through(write, path, method === "GET" ? undefined : {}, undefined, method)).status, `${method} ${path}`).toBe(403);
    });
  });

  it("drops every member entry when a Privé project goes back to Équipe", async () => {
    const { project } = await setup({ visibility: "private" });
    await setLevel(project.id, "thomas", "read");
    await setLevel(project.id, "marc", "write");
    expect((await instance.ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "team" })).status).toBe(200);
    const sharing = await instance.ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing.members).toEqual([]);
    expect((await instance.thomas.send("POST", `/api/projects/${project.id}/pages`, { title: "T", files: FILES })).status).toBe(201);
  });

  it("gives resolve and reopen to Écriture only, not to Commentaire members", async () => {
    const { project, pageId } = await setup();
    const thread = (await (await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Hi", held: true })).json()) as Thread;
    await setLevel(project.id, "thomas", "comment");
    expect((await instance.thomas.send("POST", `/api/threads/${thread.id}/resolve`)).status).toBe(403);
    expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`)).status).toBe(200);
    expect((await instance.thomas.send("POST", `/api/threads/${thread.id}/reopen`)).status).toBe(403);
    expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/reopen`)).status).toBe(200);
    expect((await instance.thomas.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Mine" })).status).toBe(201);
  });

  it("keeps 'directly to Claude' off any link that is not in Commentaire, as on creation", async () => {
    const { pageId } = await setup();
    const link = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "read" });
    const patched = (await (await instance.ariane.send("PATCH", `/api/links/${link.id}`, { direct: true })).json()) as ShareLink;
    expect(patched.direct).toBe(false);
    const comment = await makeLink(instance.ariane, `/api/pages/${pageId}/links`, { level: "comment", name: "Bea" });
    expect(((await (await instance.ariane.send("PATCH", `/api/links/${comment.id}`, { direct: true })).json()) as ShareLink).direct).toBe(true);
    expect(((await (await instance.ariane.send("PATCH", `/api/links/${comment.id}`, { level: "read" })).json()) as ShareLink).direct).toBe(false);
  });

  it("tells only the managers who would lose access to a Privé switch", async () => {
    const { project } = await setup();
    const forManager = await instance.ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(forManager.wouldLoseAccess.length).toBeGreaterThan(0);
    const forMember = await instance.thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(forMember.wouldLoseAccess).toEqual([]);
    expect(forMember.lostAccessLinks).toEqual([]);
  });

  describe("À relire threads", () => {
    const toReview = async (pageId: string) => (await (await instance.thomas.send("POST", `/api/pages/${pageId}/threads`, { target, body: "To read" })).json()) as Thread;

    it("come back as À relire when resolved then reopened", async () => {
      const { project, pageId } = await setup();
      await setLevel(project.id, "thomas", "comment");
      const thread = await toReview(pageId);
      expect(thread.status).toBe("review");
      await instance.ariane.send("POST", `/api/threads/${thread.id}/resolve`);
      const reopened = (await (await instance.ariane.send("POST", `/api/threads/${thread.id}/reopen`)).json()) as Thread;
      expect(reopened.status).toBe("review");
    });

    it("carry the time they were written", async () => {
      const { pageId } = await setup();
      const before = Date.now();
      const thread = (await (await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target, body: "Now" })).json()) as Thread;
      expect(Math.abs(Date.parse(thread.createdAt) - before)).toBeLessThan(10_000);
      const listed = await instance.ariane.json<Thread[]>(`/api/pages/${pageId}/threads`);
      expect(listed[0].createdAt).toBe(thread.createdAt);
    });

    it("stay with their readers when the account that wrote them is deactivated", async () => {
      const { project, pageId } = await setup();
      await setLevel(project.id, "thomas", "comment");
      const thread = await toReview(pageId);
      const before = (await instance.ariane.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === thread.id)!;
      expect(before.status).toBe("review");
      await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`, {});
      const after = (await instance.ariane.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === thread.id)!;
      expect(after.status).toBe("review");
      const waiting = await instance.ariane.json<unknown[]>(`/api/pages/${pageId}/queue`);
      expect(waiting).toEqual([]);
    });
  });
});
