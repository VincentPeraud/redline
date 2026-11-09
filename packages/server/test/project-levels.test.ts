import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessLevel, Project, ProjectSharing } from "@redline/shared";
import { AccountsInstance, FILES, type SignedIn } from "./accounts-harness.js";

describe("member levels", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const setLevel = (who: SignedIn, projectId: string, personId: string, level: AccessLevel) => who.send("PUT", `/api/projects/${projectId}/members/${personId}`, { level });

  /** An Équipe project of Ariane with one page, and Thomas lowered to `level`. */
  const lowered = async (level: AccessLevel) => {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(ariane, project.id);
    expect((await setLevel(ariane, project.id, people.thomas.id, level)).status).toBe(204);
    return { project, pageId, thomas };
  };

  const thread = (who: SignedIn, pageId: string) => who.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Remark" });

  it("keeps Écriture for every member of an Équipe project until the creator lowers one", async () => {
    const { ariane, thomas } = instance;
    const project = await instance.createProject(ariane);
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).viewerLevel).toBe("write");
    expect((await instance.createPage(thomas, project.id))).toBeTruthy();
  });

  it("refuses with 403 every write to a member lowered to Lecture, and still shows everything", async () => {
    const { project, pageId, thomas } = await lowered("read");
    for (const path of [`/api/projects/${project.id}`, `/api/projects/${project.id}/pages`, `/api/pages/${pageId}`, `/api/pages/${pageId}/threads`, `/api/pages/${pageId}/versions`, `/api/pages/${pageId}/files/home.html`]) {
      expect((await thomas.get(path)).status, path).toBe(200);
    }
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).viewerLevel).toBe("read");
    const refused: [string, string, unknown?][] = [
      ["POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Hi" }],
      ["POST", `/api/projects/${project.id}/pages`, { title: "Mine", files: FILES }],
      ["PATCH", `/api/pages/${pageId}`, { title: "Renamed" }],
      ["POST", `/api/pages/${pageId}/archive`],
      ["POST", `/api/pages/${pageId}/versions`, { files: FILES, message: "x", origin: "user" }],
      ["POST", `/api/pages/${pageId}/view-settings`, { hiddenFormats: [], renderingOverrides: {}, gapExceptions: [] }],
      ["POST", `/api/pages/${pageId}/conversations`, {}],
      ["PATCH", `/api/projects/${project.id}`, { title: "Renamed" }],
      ["POST", `/api/projects/${project.id}/archive`],
      ["DELETE", `/api/projects/${project.id}`, { title: "Acme" }],
      ["PATCH", `/api/projects/${project.id}`, { visibility: "private" }],
    ];
    for (const [method, path, body] of refused) expect((await thomas.send(method, path, body)).status, `${method} ${path}`).toBe(403);
    const body = (await (await thomas.send("PATCH", `/api/pages/${pageId}`, { title: "Renamed" })).json()) as { code: string };
    expect(body.code).toBe("insufficient-level");
  });

  it("lets a member lowered to Commentaire comment, reply and resolve, but nothing else", async () => {
    const { project, pageId, thomas } = await lowered("comment");
    const created = await thread(thomas, pageId);
    expect(created.status).toBe(201);
    const threadId = ((await created.json()) as { id: string }).id;
    expect((await thomas.send("POST", `/api/threads/${threadId}/messages`, { body: "More" })).status).toBe(201);
    expect((await thomas.send("POST", `/api/threads/${threadId}/resolve`, {})).status).toBe(200);
    expect((await thomas.send("POST", `/api/threads/${threadId}/reopen`, {})).status).toBe(200);
    expect((await thomas.send("POST", `/api/projects/${project.id}/pages`, { title: "Mine", files: FILES })).status).toBe(403);
    expect((await thomas.send("PATCH", `/api/pages/${pageId}`, { title: "Renamed" })).status).toBe(403);
    expect((await thomas.send("POST", `/api/pages/${pageId}/archive`)).status).toBe(403);
    expect((await thomas.send("POST", `/api/pages/${pageId}/send-held`, {})).status).toBe(403);
  });

  it("gives Écriture everything on pages, archive and delete pages included, but not the project", async () => {
    const { ariane, thomas } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(thomas, project.id);
    expect((await thomas.send("PATCH", `/api/pages/${pageId}`, { title: "Renamed" })).status).toBe(200);
    expect((await thomas.send("POST", `/api/pages/${pageId}/archive`)).status).toBe(200);
    expect((await thomas.send("DELETE", `/api/pages/${pageId}`, { title: "Renamed" })).status).toBe(204);
    expect((await thomas.send("POST", `/api/projects/${project.id}/archive`)).status).toBe(403);
    expect((await thomas.send("DELETE", `/api/projects/${project.id}`, { title: "Acme" })).status).toBe(403);
    expect((await thomas.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" })).status).toBe(403);
    expect((await setLevel(thomas, project.id, instance.people.marc.id, "read")).status).toBe(403);
  });

  it("leaves archive and delete of the project to its creator and the admins", async () => {
    const { ariane, admin } = instance;
    const mine = await instance.createProject(ariane);
    expect((await ariane.send("POST", `/api/projects/${mine.id}/archive`)).status).toBe(200);
    expect((await ariane.send("DELETE", `/api/projects/${mine.id}`, { title: "Acme" })).status).toBe(204);
    const other = await instance.createProject(ariane);
    expect((await admin.send("POST", `/api/projects/${other.id}/archive`)).status).toBe(200);
    expect((await admin.send("POST", `/api/projects/${other.id}/unarchive`)).status).toBe(200);
  });

  it("lists the lowered members and who can still be lowered, and lets the creator restore Écriture", async () => {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    await setLevel(ariane, project.id, people.thomas.id, "comment");
    const sharing = await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing.members).toEqual([{ person: people.thomas, level: "comment" }]);
    expect(sharing.candidates.map((p) => p.name)).toEqual(["Marc Petit"]);
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).candidates).toEqual([]);
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).members).toHaveLength(1);
    expect((await ariane.send("DELETE", `/api/projects/${project.id}/members/${people.thomas.id}`)).status).toBe(204);
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).viewerLevel).toBe("write");
    expect((await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).members).toEqual([]);
  });

  it("rejects a level that makes no sense, or aimed at the creator or an admin", async () => {
    const { ariane, admin, people } = instance;
    const project = await instance.createProject(ariane);
    expect((await setLevel(ariane, project.id, people.thomas.id, "owner" as AccessLevel)).status).toBe(400);
    expect((await setLevel(ariane, project.id, people.ariane.id, "read")).status).toBe(400);
    const adminId = (await (await admin.get("/api/me")).json() as { id: string }).id;
    expect((await setLevel(ariane, project.id, adminId, "read")).status).toBe(400);
    expect((await setLevel(ariane, project.id, "nobody", "read")).status).toBe(404);
  });

  it("adds chosen members with a level on a Privé project; the others see nothing", async () => {
    const { ariane, thomas, marc, people } = instance;
    const project = await instance.createProject(ariane, { visibility: "private" });
    const pageId = await instance.createPage(ariane, project.id);
    expect((await thomas.get(`/api/projects/${project.id}`)).status).toBe(403);
    expect((await setLevel(ariane, project.id, people.thomas.id, "read")).status).toBe(204);
    expect((await setLevel(ariane, project.id, people.marc.id, "write")).status).toBe(204);
    expect((await thomas.get(`/api/pages/${pageId}`)).status).toBe(200);
    expect((await thomas.send("PATCH", `/api/pages/${pageId}`, { title: "No" })).status).toBe(403);
    expect((await marc.send("PATCH", `/api/pages/${pageId}`, { title: "Yes" })).status).toBe(200);
    expect((await thomas.json<Project[]>("/api/projects")).map((p) => p.id)).toContain(project.id);
    const sharing = await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing.members.map((m) => [m.person.name, m.level])).toEqual([["Thomas Lefevre", "read"], ["Marc Petit", "write"]]);
    expect(sharing.candidates).toEqual([]);
    expect((await ariane.send("DELETE", `/api/projects/${project.id}/members/${people.thomas.id}`)).status).toBe(204);
    expect((await thomas.get(`/api/pages/${pageId}`)).status).toBe(403);
  });

  it("drops the lowered levels when an Équipe project becomes Privé, and lists only who really loses access", async () => {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    await setLevel(ariane, project.id, people.thomas.id, "read");
    await ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" });
    expect((await thomas.get(`/api/projects/${project.id}`)).status).toBe(403);
    expect((await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).members).toEqual([]);
    await ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "team" });
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).viewerLevel).toBe("write");
  });

  it("sees an Équipe project's admins at Écriture whatever the table says, and keeps the table out of reach of other projects", async () => {
    const { ariane, thomas, people } = instance;
    const first = await instance.createProject(ariane);
    const second = await instance.createProject(ariane);
    await setLevel(ariane, first.id, people.thomas.id, "read");
    expect((await thomas.json<ProjectSharing>(`/api/projects/${second.id}/sharing`)).viewerLevel).toBe("write");
    expect((await instance.admin.json<ProjectSharing>(`/api/projects/${first.id}/sharing`)).viewerLevel).toBe("write");
  });
});
