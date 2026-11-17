import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, ChangeReview, Project, Thread } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "../../server/test/accounts-harness.js";
import type { Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

let instance: AccountsInstance | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await instance?.close();
  instance = undefined;
});

const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;

async function setup() {
  instance = await new AccountsInstance().start();
  const { admin, people } = instance;
  const project = (await instance.createProject(admin)) as Project;
  for (const person of [people.ariane, people.thomas]) await admin.send("PUT", `/api/projects/${project.id}/members/${person.id}`, { level: "write" });
  const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
  const folder = mkdtempSync(join(tmpdir(), "redline-review-"));
  mkdirSync(join(folder, ".redline"), { recursive: true });
  writeFileSync(join(folder, ".redline", "project.json"), JSON.stringify({ projectIds: [project.id] }));
  const terminalFor = async (who: SignedIn, machine: string, workFolder: string) =>
    openTerminal({ folder, server: { url: instance!.server.url } as Seam2["server"] }, stops, machine, { token: await tokenOf(who), folder: workFolder });
  const arianeTerminal = await terminalFor(instance.ariane, "Studio", "/Users/ana/crm");
  const answer = await arianeTerminal.call("request_review", { steps: [{ pageId, artboard: "home.html", changed: "Changed", lookAt: "Look", question: "Fine?" }] });
  const reviewId = idOf(answer);
  const review = await admin.json<ChangeReview>(`/api/change-reviews/${reviewId}`);
  await admin.send("PUT", `/api/change-reviews/${reviewId}/steps/${review.steps[0]!.id}/remark`, { text: "Too dense" });
  await admin.send("POST", `/api/change-reviews/${reviewId}/finish`);
  const threadsOf = () => admin.json<Thread[]>(`/api/pages/${pageId}/threads`);
  return { reviewId, pageId, terminalFor, threadsOf };
}

describe("a review belongs to the account that requested it", () => {
  it("is fetched by a new process of the requester's account, which takes the remark threads", async () => {
    const { terminalFor, threadsOf } = await setup();
    const resumed = await terminalFor(instance!.ariane, "Studio", "/Users/ana/crm");

    const answer = await resumed.call("review_feedback", {});

    expect(answer).toMatch(/Retours \(1 sur 1 étape\)/);
    const [thread] = await threadsOf();
    expect(thread!.take).toMatchObject({ person: { name: "Ariane Martin" }, folder: "~/crm" });
    expect(answer).toContain(`fil ${thread!.id}`);
  });

  it("lists another account's finished review as requested by them and fetches nothing", async () => {
    const { reviewId, terminalFor, threadsOf } = await setup();
    const thomas = await terminalFor(instance!.thomas, "Air", "/Users/tom/site");

    const answer = await thomas.call("review_feedback", {});

    expect(answer).toMatch(/demandée par "Ariane Martin"/);
    expect(answer).toContain(reviewId);
    expect(answer).toMatch(/takeOver: true/);
    expect(await threadsOf()).toEqual([]);
    expect((await instance!.admin.json<ChangeReview>(`/api/change-reviews/${reviewId}`)).state).toBe("finished");
  });

  it("refuses another account's review by id without takeOver, then fetches it with takeOver and leaves a trace", async () => {
    const { reviewId, terminalFor, threadsOf } = await setup();
    const thomas = await terminalFor(instance!.thomas, "Air", "/Users/tom/site");

    expect(await thomas.call("review_feedback", { reviewId })).toMatch(/requested by "Ariane Martin".*takeOver: true/s);
    expect(await threadsOf()).toEqual([]);
    const answer = await thomas.call("review_feedback", { reviewId, takeOver: true });

    expect(answer).toMatch(/Retours \(1 sur 1 étape\)/);
    const [thread] = await threadsOf();
    expect(thread!.take).toMatchObject({ person: { name: "Thomas Lefevre" }, takenOver: { from: { name: "Ariane Martin" } } });
    expect(await instance!.admin.json<ChangeReview>(`/api/change-reviews/${reviewId}`)).toMatchObject({ state: "fetched", fetchedBy: { name: "Thomas Lefevre" } });
  });

  it("lets any member with Écriture fetch the review of a deactivated requester, without takeOver", async () => {
    const { reviewId, terminalFor, threadsOf } = await setup();
    await instance!.admin.send("POST", `/api/accounts/${instance!.people.ariane.id}/deactivate`, {});
    const thomas = await terminalFor(instance!.thomas, "Air", "/Users/tom/site");

    const answer = await thomas.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Retours \(1 sur 1 étape\)/);
    const [thread] = await threadsOf();
    expect(thread!.take).toMatchObject({ person: { name: "Thomas Lefevre" } });
  });

  it("is not affected by the comment mode of its page", async () => {
    const { pageId, terminalFor, threadsOf } = await setup();
    await instance!.admin.send("POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" });
    const resumed = await terminalFor(instance!.ariane, "Studio", "/Users/ana/crm");

    await resumed.call("review_feedback", {});

    const [thread] = await threadsOf();
    expect(thread!.take).toMatchObject({ person: { name: "Ariane Martin" } });
  });
});
