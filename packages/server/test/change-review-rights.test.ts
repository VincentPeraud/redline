import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessLevel, AgentTokenResponse, ChangeReview } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "./accounts-harness.js";

describe("review of changes: rights", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  /** Ariane declares a review (through her agent token) on a project where Thomas has `level`. */
  async function declared(level: AccessLevel) {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(ariane, project.id);
    await ariane.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level });
    const token = ((await ariane.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
    const declare = (bearer: string) =>
      fetch(`${instance.server.url}/agent-api/terminal-sessions/${randomUUID()}/reviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ folder: "/work/site", steps: [{ pageId, artboard: "home.html", changed: "c", lookAt: "l", question: "q" }] }),
      });
    const created = await declare(token);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    return { id, thomas: thomas as SignedIn, token, declare };
  }

  it("shows the review to a member with Écriture and refuses a member with Commentaire or Lecture", async () => {
    for (const level of ["comment", "read"] as const) {
      const { id, thomas } = await declared(level);
      expect((await thomas.get(`/api/change-reviews/${id}`)).status, level).toBe(403);
      const step = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!;
      expect((await thomas.send("PUT", `/api/change-reviews/${id}/steps/${step.id}/ok`)).status, level).toBe(403);
      expect((await thomas.send("POST", `/api/change-reviews/${id}/finish`)).status, level).toBe(403);
    }
    const { id, thomas } = await declared("write");
    expect((await thomas.get(`/api/change-reviews/${id}`)).status).toBe(200);
  });

  it("lets a member see another member's remark, but not delete it; writing a remark only touches one's own", async () => {
    const { id, thomas } = await declared("write");
    const { ariane } = instance;
    const stepId = (await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.id;
    await ariane.send("PUT", `/api/change-reviews/${id}/steps/${stepId}/remark`, { text: "Ariane's remark" });

    const seenByThomas = (await thomas.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.answers;
    expect(seenByThomas).toMatchObject([{ kind: "remark", text: "Ariane's remark", mine: false, person: { id: instance.people.ariane.id } }]);
    expect((await thomas.send("DELETE", `/api/change-reviews/${id}/remarks/${seenByThomas[0]!.id}`)).status).toBe(403);

    await thomas.send("PUT", `/api/change-reviews/${id}/steps/${stepId}/remark`, { text: "Thomas' remark" });
    const answers = (await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.answers;
    expect(answers.map((a) => [a.text, a.mine])).toEqual([["Ariane's remark", true], ["Thomas' remark", false]]);
  });

  it("refuses a remark from a member without Écriture", async () => {
    const { id, thomas } = await declared("comment");
    const stepId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.id;
    expect((await thomas.send("PUT", `/api/change-reviews/${id}/steps/${stepId}/remark`, { text: "Hi" })).status).toBe(403);
  });

  it("refuses a declaration by an agent whose account has no Écriture on the project", async () => {
    const { thomas, declare } = await declared("read");
    const thomasToken = ((await thomas.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
    expect((await declare(thomasToken)).status).toBe(403);
  });
});
