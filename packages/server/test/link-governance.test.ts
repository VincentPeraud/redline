import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountEntry, MemberChangeResponse, MyLink, ProjectSharing, ShareLink } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

describe("link rules and lifecycle", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  /** Ariane's project and page; Thomas works there in Écriture (Équipe), unless the project is Privé. */
  const setup = async (body: object = {}) => {
    const project = await instance.createProject(instance.ariane, body);
    const pageId = await instance.createPage(instance.ariane, project.id);
    return { project, pageId };
  };
  const createLink = async (who: SignedIn, pageId: string, body: object = {}): Promise<ShareLink> => {
    const response = await who.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "read", ...body });
    expect(response.status).toBe(201);
    return (await response.json()) as ShareLink;
  };
  const visit = (token: string, path: string) => fetch(`${instance.server.url}/s/${token}${path}`);
  const listed = (who: SignedIn, pageId: string) => who.json<ShareLink[]>(`/api/pages/${pageId}/links`);
  const lower = (project: { id: string }, who: "thomas" | "marc", level: string) => instance.ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people[who].id}`, { level });

  it("lets an Écriture member see every link with its author, but change only their own (the creator and admins change any)", async () => {
    const { pageId } = await setup();
    const hers = await createLink(instance.ariane, pageId, { name: "Hers" });
    const his = await createLink(instance.thomas, pageId, { name: "His", level: "comment" });
    const seenByThomas = await listed(instance.thomas, pageId);
    expect(seenByThomas.map((l) => [l.name, l.createdBy?.name, l.canManage])).toEqual([["Hers", "Ariane Martin", false], ["His", "Thomas Lefevre", true]]);
    expect(seenByThomas.map((l) => l.token)).toEqual([hers.token, his.token]);
    expect((await instance.thomas.send("PATCH", `/api/links/${hers.id}`, { name: "Mine" })).status).toBe(403);
    expect((await instance.thomas.send("POST", `/api/links/${hers.id}/disable`)).status).toBe(403);
    // The project creator and an admin change a colleague's link.
    expect((await instance.ariane.send("POST", `/api/links/${his.id}/disable`)).status).toBe(200);
    expect((await instance.admin.send("POST", `/api/links/${his.id}/reactivate`)).status).toBe(200);
    expect((await listed(instance.admin, pageId)).every((l) => l.canManage)).toBe(true);
  });

  it("limits link creation on a Privé project to its creator and the admins", async () => {
    const { project, pageId } = await setup({ visibility: "private" });
    await instance.ariane.send("PUT", `/api/projects/${project.id}/members/${instance.people.thomas.id}`, { level: "write" });
    expect((await instance.thomas.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "read" })).status).toBe(403);
    expect((await instance.admin.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "read" })).status).toBe(201);
    await createLink(instance.ariane, pageId);
    // The member still sees them.
    expect(await listed(instance.thomas, pageId)).toHaveLength(2);
  });

  it("keeps a link working and offers to disable it when its author is lowered below its level", async () => {
    const { project, pageId } = await setup();
    const writeLink = await createLink(instance.thomas, pageId, { name: "Pour Alix", level: "write" });
    const readLink = await createLink(instance.thomas, pageId, { name: "Lecture", level: "read" });
    const response = await lower(project, "thomas", "comment");
    expect(response.status).toBe(200);
    expect(((await response.json()) as MemberChangeResponse).links.map((l) => l.id)).toEqual([writeLink.id]);
    expect((await visit(writeLink.token, "/api/link")).status).toBe(200);
    // The dialog shows the same list on reopening, and the creator disables it.
    const sharing = await instance.ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing.members[0].aboveLinks.map((l) => l.id)).toEqual([writeLink.id]);
    expect((await instance.ariane.send("POST", `/api/links/${writeLink.id}/disable`)).status).toBe(200);
    expect((await visit(writeLink.token, "/api/link")).status).toBe(404);
    expect((await instance.ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).members[0].aboveLinks).toEqual([]);
    expect((await visit(readLink.token, "/api/link")).status).toBe(200);
  });

  it("answers the removal of a lowered member with the links they could no longer have", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(instance.thomas, pageId, { level: "write" });
    await lower(project, "thomas", "read");
    const removed = await instance.ariane.send("DELETE", `/api/projects/${project.id}/members/${instance.people.thomas.id}`);
    expect(((await removed.json()) as MemberChangeResponse).links).toEqual([]);
    expect((await visit(link.token, "/api/link")).status).toBe(200);
  });

  it("lists the links of members who would lose access on the switch to Privé, and keeps them working", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(instance.thomas, pageId, { level: "comment" });
    await createLink(instance.ariane, pageId, { name: "Hers" });
    const sharing = await instance.ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing.lostAccessLinks.map((l) => l.id)).toEqual([link.id]);
    await instance.ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" });
    expect((await visit(link.token, "/api/link")).status).toBe(200);
    // Thomas no longer sees the project; the creator still lists and disables the link.
    expect((await instance.thomas.get(`/api/pages/${pageId}/links`)).status).toBe(403);
    expect((await listed(instance.ariane, pageId)).map((l) => l.name)).toEqual(["Alix", "Hers"]);
    expect((await instance.ariane.send("POST", `/api/links/${link.id}/disable`)).status).toBe(200);
    expect((await visit(link.token, "/api/link")).status).toBe(404);
  });

  it("counts an account's working links and leaves them working when it is deactivated without the flag", async () => {
    const { pageId } = await setup();
    const keep = await createLink(instance.thomas, pageId, { name: "One" });
    await createLink(instance.thomas, pageId, { name: "Two" });
    const disabled = await createLink(instance.thomas, pageId, { name: "Off" });
    await instance.thomas.send("POST", `/api/links/${disabled.id}/disable`);
    const { accounts } = await instance.admin.json<{ accounts: AccountEntry[] }>("/api/accounts");
    expect(accounts.find((a) => a.id === instance.people.thomas.id)?.linkCount).toBe(2);
    expect((await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`)).status).toBe(200);
    expect((await visit(keep.token, "/api/link")).status).toBe(200);
  });

  it("disables the links of the deactivated account with the flag, signed by the admin", async () => {
    const { pageId } = await setup();
    const a = await createLink(instance.thomas, pageId, { name: "One" });
    const b = await createLink(instance.thomas, pageId, { name: "Two" });
    const ariane = await createLink(instance.ariane, pageId, { name: "Hers" });
    await instance.admin.send("POST", `/api/accounts/${instance.people.thomas.id}/deactivate`, { disableLinks: true });
    expect((await visit(a.token, "/api/link")).status).toBe(404);
    expect((await visit(b.token, "/api/link")).status).toBe(404);
    expect((await visit(ariane.token, "/api/link")).status).toBe(200);
    const all = await listed(instance.ariane, pageId);
    expect(all.find((l) => l.id === a.id)).toMatchObject({ status: "disabled", disabledBy: { name: "Vincent Peraud" } });
  });

  it("lists in Mon compte the links the account created, with where they lead", async () => {
    const { project, pageId } = await setup();
    const mine = await createLink(instance.thomas, pageId, { name: "Mine", level: "comment" });
    await createLink(instance.ariane, pageId, { name: "Hers" });
    const off = await createLink(instance.thomas, pageId, { name: "Off" });
    await instance.thomas.send("POST", `/api/links/${off.id}/disable`);
    const links = await instance.thomas.json<MyLink[]>("/api/account/links");
    expect(links.map((l) => [l.link.name, l.link.status, l.projectTitle, l.pageTitle])).toEqual([["Mine", "active", "Acme", "Home"], ["Off", "disabled", "Acme", "Home"]]);
    expect(links[0]).toMatchObject({ projectId: project.id, pageId, link: { id: mine.id } });
  });

  it("deletes the links of a deleted project, page links included", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(instance.ariane, pageId);
    await instance.ariane.send("POST", `/api/projects/${project.id}/archive`);
    expect((await instance.ariane.send("DELETE", `/api/projects/${project.id}`, { title: "Acme" })).status).toBeLessThan(300);
    expect((await visit(link.token, "/api/link")).status).toBe(404);
    expect(await instance.ariane.json<MyLink[]>("/api/account/links")).toEqual([]);
  });
});
