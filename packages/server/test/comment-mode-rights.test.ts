import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "@redline/shared";
import { AccountsInstance } from "./accounts-harness.js";

describe("who switches the comment mode of a page", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  async function setup() {
    const { admin, people } = instance;
    const project = await instance.createProject(admin);
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "comment" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.marc.id}`, { level: "read" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    return pageId;
  }

  it("lets an admin and a member with Écriture switch it",async () => {
    const pageId = await setup();

    expect((await instance.ariane.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" })).status).toBe(200);
    expect(await instance.admin.json<Page>(`/api/pages/${pageId}`)).toMatchObject({ commentMode: "agent" });
    expect((await instance.admin.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "conversation" })).status).toBe(200);
  });

  it("refuses a member with Commentaire or Lecture", async () => {
    const pageId = await setup();

    expect((await instance.thomas.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" })).status).toBe(403);
    expect((await instance.marc.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" })).status).toBe(403);
    expect(await instance.admin.json<Page>(`/api/pages/${pageId}`)).toMatchObject({ commentMode: "conversation" });
  });
});
