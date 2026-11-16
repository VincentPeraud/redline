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
    const declare = async (bearer: string) => {
      const sessionId = randomUUID();
      await fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ folder: "/work/site", machine: "Mac" }),
      });
      return fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/reviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ folder: "/work/site", steps: [{ pageId, artboard: "home.html", changed: "c", lookAt: "l", question: "q" }] }),
      });
    };
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

  it("numbers pins across members, shows another member's pin read-only, and lets only its author change or delete it", async () => {
    const { id, thomas } = await declared("write");
    const { ariane } = instance;
    const stepId = (await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.id;
    const target = { selector: "h1", xPct: 10, yPct: 10 };
    await ariane.send("POST", `/api/change-reviews/${id}/steps/${stepId}/pins`, { text: "Ariane's pin", target });
    await thomas.send("POST", `/api/change-reviews/${id}/steps/${stepId}/pins`, { text: "Thomas' pin", target });

    const seenByThomas = (await thomas.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.pins;
    expect(seenByThomas.map((pin) => [pin.number, pin.text, pin.mine])).toEqual([[1, "Ariane's pin", false], [2, "Thomas' pin", true]]);
    expect(seenByThomas[0]).toMatchObject({ person: { id: instance.people.ariane.id } });
    expect((await thomas.send("PUT", `/api/change-reviews/${id}/pins/${seenByThomas[0]!.id}`, { text: "Hijacked" })).status).toBe(403);
    expect((await thomas.send("DELETE", `/api/change-reviews/${id}/pins/${seenByThomas[0]!.id}`)).status).toBe(403);
    expect((await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.pins.map((pin) => pin.text)).toEqual(["Ariane's pin", "Thomas' pin"]);
  });

  it("refuses a pin from a member without Écriture", async () => {
    const { id, thomas } = await declared("comment");
    const stepId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.id;
    expect((await thomas.send("POST", `/api/change-reviews/${id}/steps/${stepId}/pins`, { text: "Hi", target: { selector: "h1", xPct: 1, yPct: 1 } })).status).toBe(403);
  });

  it("refuses a remark from a member without Écriture", async () => {
    const { id, thomas } = await declared("comment");
    const stepId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.id;
    expect((await thomas.send("PUT", `/api/change-reviews/${id}/steps/${stepId}/remark`, { text: "Hi" })).status).toBe(403);
  });

  it("lists a page's review banners to a member with Écriture only", async () => {
    for (const level of ["comment", "read"] as const) {
      const { id, thomas } = await declared(level);
      const pageId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.pageId;
      expect((await thomas.get(`/api/pages/${pageId}/change-reviews`)).status, level).toBe(403);
    }
    const { id, thomas } = await declared("write");
    const pageId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).steps[0]!.pageId;
    const response = await thomas.get(`/api/pages/${pageId}/change-reviews`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string; viewerIsRequester: boolean }[]).map((banner) => [banner.id, banner.viewerIsRequester])).toContainEqual([id, false]);
  });

  it("refuses a declaration by an agent whose account has no Écriture on the project", async () => {
    const { thomas, declare } = await declared("read");
    const thomasToken = ((await thomas.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
    expect((await declare(thomasToken)).status).toBe(403);
  });

  /** A fetch by `bearer` from a terminal session of its own (by review id, or through the projects when none). */
  async function fetchAs(bearer: string, body: object) {
    const sessionId = randomUUID();
    await fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ folder: "/work/other", machine: "Other" }),
    });
    return fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/review-feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets another member's conversation fetch a finished review with Écriture, by id or through the project, and refuses Commentaire and Lecture", async () => {
    for (const level of ["comment", "read"] as const) {
      const { id, thomas } = await declared(level);
      await instance.ariane.send("POST", `/api/change-reviews/${id}/finish`);
      const projectId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).projectId;
      const thomasToken = ((await thomas.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
      expect((await fetchAs(thomasToken, { reviewId: id })).status, level).toBe(403);
      expect((await fetchAs(thomasToken, { projectIds: [projectId] })).status, level).toBe(403);
      expect((await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).state, level).toBe("finished");
    }
    const { id, thomas } = await declared("write");
    await instance.ariane.send("POST", `/api/change-reviews/${id}/finish`);
    const projectId = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).projectId;
    const thomasToken = ((await thomas.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;

    const fetched = await fetchAs(thomasToken, { projectIds: [projectId] });

    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ status: "finished" });
    expect(await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).toMatchObject({ state: "fetched" });
  });

  it("refuses a link visitor, even with an Écriture link, on every review route", async () => {
    const { id } = await declared("write");
    const view = await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`);
    const { pageId, id: stepId } = view.steps[0]!;
    const response = await instance.ariane.send("POST", `/api/pages/${pageId}/links`, { kind: "personal", name: "Alix", level: "write" });
    const { token } = (await response.json()) as { token: string };
    const visit = (method: string, path: string) => fetch(`${instance.server.url}/s/${token}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });

    expect((await visit("GET", `/api/change-reviews/${id}`)).status).toBe(403);
    expect((await visit("GET", `/api/pages/${pageId}/change-reviews`)).status).toBe(403);
    expect((await visit("PUT", `/api/change-reviews/${id}/steps/${stepId}/ok`)).status).toBe(403);
    expect((await visit("POST", `/api/change-reviews/${id}/finish`)).status).toBe(403);
  });

  it("deletes a project's reviews with it, and refuses a fetch through the id of a project that is gone", async () => {
    const { id, thomas } = await declared("write");
    const { ariane } = instance;
    const view = await ariane.json<ChangeReview>(`/api/change-reviews/${id}`);
    await ariane.send("POST", `/api/change-reviews/${id}/finish`);
    await ariane.send("POST", `/api/projects/${view.projectId}/archive`);
    expect((await ariane.send("DELETE", `/api/projects/${view.projectId}`, { title: "Acme" })).status).toBe(204);

    expect((await ariane.get(`/api/change-reviews/${id}`)).status).toBe(404);
    const thomasToken = ((await thomas.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
    expect((await fetchAs(thomasToken, { projectIds: [view.projectId] })).status).toBe(403);
  });
});

describe("review of changes: presence, reopening, filing", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  async function declared() {
    const { ariane, thomas, people } = instance;
    const project = await instance.createProject(ariane);
    const pageId = await instance.createPage(ariane, project.id);
    await ariane.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "write" });
    const token = ((await ariane.json<AgentTokenResponse>("/api/agent-token")) as AgentTokenResponse).token;
    const sessionId = randomUUID();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
    const created = await fetch(`${instance.server.url}/agent-api/terminal-sessions/${sessionId}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folder: "/work/site", steps: [{ pageId, artboard: "home.html", changed: "c", lookAt: "l", question: "q" }] }),
    });
    const { id } = (await created.json()) as { id: string };
    return { id, ariane: ariane as SignedIn, thomas: thomas as SignedIn };
  }

  it("shows another member who is on a screen of the review, with their step, and never the viewer", async () => {
    const { id, ariane, thomas } = await declared();
    await thomas.send("POST", `/api/change-reviews/${id}/presence`, { step: 1 });

    const seenByAriane = await ariane.json<ChangeReview>(`/api/change-reviews/${id}`);
    const seenByThomas = await thomas.json<ChangeReview>(`/api/change-reviews/${id}`);

    expect(seenByAriane.present).toMatchObject([{ person: { id: instance.people.thomas.id }, step: 1 }]);
    expect(seenByThomas.present).toEqual([]);
  });

  it("forgets a member who left the review", async () => {
    const { id, ariane, thomas } = await declared();
    await thomas.send("POST", `/api/change-reviews/${id}/presence`, { step: 1 });
    await thomas.send("DELETE", `/api/change-reviews/${id}/presence`);

    expect((await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).present).toEqual([]);
  });

  it("refuses presence from a member without Écriture", async () => {
    const { id } = await declared();
    const project = (await instance.ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).projectId;
    await instance.ariane.send("PUT", `/api/projects/${project}/members/${instance.people.thomas.id}`, { level: "comment" });

    expect((await instance.thomas.send("POST", `/api/change-reviews/${id}/presence`, { step: 1 })).status).toBe(403);
  });

  it("lets any member with Écriture reopen and file, signing the filing", async () => {
    const { id, ariane, thomas } = await declared();
    await ariane.send("POST", `/api/change-reviews/${id}/finish`);

    expect((await thomas.send("POST", `/api/change-reviews/${id}/reopen`)).status).toBe(200);
    await ariane.send("POST", `/api/change-reviews/${id}/finish`);
    expect((await thomas.send("POST", `/api/change-reviews/${id}/file`)).status).toBe(200);

    expect(await ariane.json<ChangeReview>(`/api/change-reviews/${id}`)).toMatchObject({ state: "filed", filedBy: { id: instance.people.thomas.id }, viewerIsRequester: true });
  });
});
