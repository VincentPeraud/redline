import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, CommentMode, Project, QueueEntry, Thread } from "@redline/shared";
import { AccountsInstance, type SignedIn } from "../../server/test/accounts-harness.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
let instance: AccountsInstance | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  await instance?.close();
  seam = undefined;
  instance = undefined;
});

const linkFolder = (projectIds: string[]): string => {
  const folder = mkdtempSync(join(tmpdir(), "redline-conversation-"));
  mkdirSync(join(folder, ".redline"), { recursive: true });
  writeFileSync(join(folder, ".redline", "project.json"), JSON.stringify({ projectIds }));
  return folder;
};

const idleEngine = () => new FakeEngine([{ type: "result", summary: "Done" }]);
const threadOf = async (pageId: string, id: string) => ((await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[]).find((t) => t.id === id)!;
const queueOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/queue`)).json()) as QueueEntry[];

/** A terminal of the single account of `seam`, in a folder linked to the seam's project (or to none). */
async function terminalOf(machine: string, options: { folder?: string; linked?: boolean } = {}): Promise<Terminal> {
  const { linked = true } = options;
  return openTerminal({ ...seam!, folder: linked ? linkFolder([seam!.project.id]) : seam!.folder }, stops, machine, { folder: options.folder });
}

async function conversationSeam(engine = idleEngine()) {
  seam = await startSeam2(engine);
  const partager = await seam.createPage(PAGE_FILES, "Partager", "conversation");
  const visiteur = await seam.createPage(PAGE_FILES, "Vue visiteur", "conversation");
  return { engine, partager, visiteur };
}

describe("pending_comments without a page lists and takes nothing", () => {
  it("lists, page by page with thread ids, what waits in the linked projects, and every thread stays to take", async () => {
    const { partager, visiteur } = await conversationSeam();
    const first = await seam!.pinThread(partager.id, "home.html", "Title is hard coded");
    const second = await seam!.pinThread(partager.id, "home.html", "Close button too small");
    const third = await seam!.pinThread(visiteur.id, "home.html", "Missing hint");
    const terminal = await terminalOf("MacBook-Pro");

    const answer = await terminal.call("pending_comments", {});

    expect(answer).toMatch(/nothing was taken/i);
    expect(answer).toContain("Partager");
    expect(answer).toContain("Vue visiteur");
    for (const thread of [first, second, third]) expect(answer).toContain(thread.id);
    expect(answer).toMatch(/call pending_comments again with a pageId/);
    for (const [pageId, thread] of [[partager.id, first], [partager.id, second], [visiteur.id, third]] as const) {
      expect(await threadOf(pageId, thread.id)).toMatchObject({ toTake: true });
    }
  });

  it("says there is nothing to take, with the page count, when nothing waits (scenario vide)", async () => {
    await conversationSeam();
    const terminal = await terminalOf("MacBook-Pro");

    expect(await terminal.call("pending_comments", {})).toMatch(/No comment to take on the 2 pages of the project "Acme"/);
  });

  it("tells a folder linked to no project to give a page or to run redline link", async () => {
    await conversationSeam();
    const terminal = await terminalOf("MacBook-Pro", { linked: false });

    expect(await terminal.call("pending_comments", {})).toMatch(/pageId.*redline link/s);
  });

  it("lists the threads the account took from another folder apart (scenario ailleurs) and the ones taken here", async () => {
    const { partager } = await conversationSeam();
    const far = await seam!.pinThread(partager.id, "home.html", "Far thread");
    const near = await seam!.pinThread(partager.id, "home.html", "Near thread");
    const away = await terminalOf("Studio", { folder: "/Users/ana/crm" });
    await away.call("pending_comments", { threadIds: [far.id] });
    const here = await terminalOf("MacBook-Pro", { folder: "/Users/ana/redline" });
    await here.call("pending_comments", { threadIds: [near.id] });

    const answer = await here.call("pending_comments", {});

    expect(answer).toMatch(/Taken by your account from another folder \(1\):\s+- thread id [^\n]*\n?[^\n]*/);
    expect(answer).toContain(`thread id ${far.id}`);
    expect(answer).toContain("~/crm");
    expect(answer).toMatch(/Already taken by your account, from this folder \(1\)/);
    expect(answer).toContain(`thread id ${near.id}`);
  });
});

describe("pending_comments takes the threads it is given", () => {
  it("takes exactly those thread ids and leaves the others to take", async () => {
    const { partager } = await conversationSeam();
    const wanted = await seam!.pinThread(partager.id, "home.html", "Wanted");
    const other = await seam!.pinThread(partager.id, "home.html", "Other");
    const terminal = await terminalOf("MacBook-Pro", { folder: "/Users/ana/crm" });

    const answer = await terminal.call("pending_comments", { threadIds: [wanted.id] });

    expect(answer).toContain(`thread id: ${wanted.id}`);
    expect(answer).toContain("Wanted");
    expect(answer).not.toContain(other.id);
    expect(await threadOf(partager.id, wanted.id)).toMatchObject({ take: { folder: "~/crm", machine: "MacBook-Pro" } });
    expect(await threadOf(partager.id, other.id)).toMatchObject({ toTake: true });
  });

  it("refuses a thread that does not exist or is resolved, with the reason", async () => {
    const { partager } = await conversationSeam();
    const done = await seam!.pinThread(partager.id, "home.html", "Done already");
    await seam!.server.post(`/api/threads/${done.id}/resolve`, {});
    const terminal = await terminalOf("MacBook-Pro");

    const answer = await terminal.call("pending_comments", { threadIds: [done.id, "no-such-thread"] });

    expect(answer).toMatch(new RegExp(`Not taken: thread id ${done.id}: this thread is not open`));
    expect(answer).toMatch(/Not taken: thread id no-such-thread: thread not found/);
  });

  it("marks a message written in a taken, unanswered thread as new since the take", async () => {
    const { partager } = await conversationSeam();
    const thread = await seam!.pinThread(partager.id, "home.html", "Make it blue");
    const terminal = await terminalOf("MacBook-Pro");
    await terminal.call("pending_comments", { pageId: partager.id });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Actually, green" });

    const answer = await terminal.call("pending_comments", { pageId: partager.id });

    expect(answer).toContain("New since your take:");
    expect(answer).toContain("Actually, green");
    expect(await threadOf(partager.id, thread.id)).toMatchObject({ take: { folder: expect.any(String) } });
  });
});

describe("a thread waiting for an offline agent", () => {
  async function waitingThread() {
    seam = await startSeam2(idleEngine());
    const page = await seam.createPage(PAGE_FILES, "Partager", "agent");
    seam.agent.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const thread = await seam.pinThread(page.id, "home.html", "Wait for me");
    const deadline = Date.now() + 5_000;
    while ((await queueOf(page.id)).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return { page, thread };
  }

  it("is listed apart and taken by the page, leaving the queue", async () => {
    const { page, thread } = await waitingThread();
    const terminal = await terminalOf("MacBook-Pro");

    expect(await terminal.call("pending_comments", {})).toMatch(/Waiting for an offline agent, not started/);
    const answer = await terminal.call("pending_comments", { pageId: page.id });

    expect(answer).toContain("was waiting for an offline agent");
    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(await queueOf(page.id)).toEqual([]);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ take: { machine: "MacBook-Pro" } });
  });
});

describe("a thread an agent runs", () => {
  it("refuses a takeover while the run goes on", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    seam = await startSeam2(new FakeEngine(async () => (await gate, [{ type: "result" as const, summary: "Done" }])));
    const page = await seam.createPage(PAGE_FILES, "Partager", "agent");
    const thread = await seam.pinThread(page.id, "home.html", "Agent is on it");
    const terminal = await terminalOf("MacBook-Pro");

    const refused = await terminal.call("pending_comments", { threadIds: [thread.id], takeOver: true });

    expect(refused).toMatch(/an agent is running this thread/);
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("take");
    release();
    await seam.waitForWorkEnd(1);
  });

  it("can be taken over once the run ended, only on request", async () => {
    seam = await startSeam2(idleEngine());
    const page = await seam.createPage(PAGE_FILES, "Partager", "agent");
    const thread = await seam.pinThread(page.id, "home.html", "Agent did it");
    await seam.waitForWorkEnd(1);
    await seam.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "conversation" });
    const terminal = await terminalOf("MacBook-Pro");

    expect(await terminal.call("pending_comments", { threadIds: [thread.id] })).toMatch(/takeOver: true/);
    const answer = await terminal.call("pending_comments", { threadIds: [thread.id], takeOver: true });

    expect(answer).toContain("taken over");
    expect(await threadOf(page.id, thread.id)).toMatchObject({ take: { takenOver: {} }, traces: [{ kind: "taken-over" }] });
  });
});

describe("release_comments", () => {
  it("lets go of a page's threads: they are to take again, and follow Agent mode when the page switched", async () => {
    const { engine, partager } = await conversationSeam();
    const thread = await seam!.pinThread(partager.id, "home.html", "Make it blue");
    const terminal = await terminalOf("MacBook-Pro");
    await terminal.call("pending_comments", { pageId: partager.id });

    expect(await terminal.call("release_comments", { pageId: partager.id })).toMatch(/Released 1 thread/);

    expect(await threadOf(partager.id, thread.id)).toMatchObject({ toTake: true });
    await terminal.call("pending_comments", { pageId: partager.id });
    await seam!.server.post(`/api/pages/${partager.id}/comment-mode`, { mode: "agent" });
    await terminal.call("release_comments", { threadIds: [thread.id] });
    await seam!.waitForWorkEnd(1);
    expect(engine.runs).toHaveLength(1);
  });

  it("asks which threads when none is given, and reports a thread the account does not hold", async () => {
    const { partager } = await conversationSeam();
    const thread = await seam!.pinThread(partager.id, "home.html", "Nobody's");
    const terminal = await terminalOf("MacBook-Pro");

    expect(await terminal.call("release_comments", {})).toMatch(/pageId or threadIds/);
    expect(await terminal.call("release_comments", { threadIds: [thread.id] })).toMatch(/Nothing released/);
    expect(await terminal.call("release_comments", { threadIds: [thread.id] })).toContain(`thread id ${thread.id} is not taken by your account`);
  });
});

describe("the reminder line ends the answers of the pages this conversation published or checked out", () => {
  it("counts the threads to take on a page the conversation published, and only then", async () => {
    const { partager, visiteur } = await conversationSeam();
    await seam!.pinThread(partager.id, "home.html", "One");
    await seam!.pinThread(partager.id, "home.html", "Two");
    await seam!.pinThread(visiteur.id, "home.html", "Elsewhere");
    const coding = await terminalOf("MacBook-Pro");
    expect(await coding.call("list_projects", {})).not.toContain("commentaire");

    const published = await coding.publish(partager.id, "Update");

    expect(published).toContain("Redline : 2 commentaires à prendre sur « Partager » : appelle pending_comments si la personne le demande");
    expect(published).not.toContain("Vue visiteur");
  });

  it("survives a resume: a new process of the same account and folder knows the pages the first published", async () => {
    const { partager } = await conversationSeam();
    const first = await terminalOf("MacBook-Pro", { folder: "/Users/ana/crm" });
    await first.call("checkout_page", { pageId: partager.id });
    await first.quit();
    await seam!.pinThread(partager.id, "home.html", "New while away");
    const folder = linkFolder([seam!.project.id]);
    const resumed = await openTerminal({ ...seam!, folder }, stops, "MacBook-Pro", { folder: "/Users/ana/crm" });

    expect(await resumed.call("list_projects", {})).toContain("1 commentaire à prendre sur « Partager »");
  });

  it("is absent from a conversation that touched no page, and from another folder", async () => {
    const { partager } = await conversationSeam();
    await seam!.pinThread(partager.id, "home.html", "Waiting");
    const coding = await terminalOf("MacBook-Pro", { folder: "/Users/ana/crm" });
    await coding.call("checkout_page", { pageId: partager.id });
    const untouched = await terminalOf("MacBook-Pro", { folder: "/Users/ana/other" });

    expect(await untouched.call("list_projects", {})).not.toContain("commentaire");
  });

  it("counts relaunches of the account's takes from this folder", async () => {
    const { partager } = await conversationSeam();
    const thread = await seam!.pinThread(partager.id, "home.html", "Make it blue");
    const terminal = await terminalOf("MacBook-Pro", { folder: "/Users/ana/crm" });
    await terminal.call("checkout_page", { pageId: partager.id });
    await terminal.call("pending_comments", { pageId: partager.id });
    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done" });
    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });

    expect(await terminal.call("list_projects", {})).toContain("1 commentaire à prendre sur « Partager »");
  });

  it("names three pages at most, then the others", async () => {
    seam = await startSeam2(idleEngine());
    const terminal = await terminalOf("MacBook-Pro");
    for (const title of ["A", "B", "C", "D", "E"]) {
      const page = await seam.createPage(PAGE_FILES, title, "conversation");
      await seam.pinThread(page.id, "home.html", `On ${title}`);
      await terminal.call("checkout_page", { pageId: page.id });
    }

    const answer = await terminal.call("list_projects", {});

    expect(answer).toMatch(/« A » \(1\), « B » \(1\), « C » \(1\) et 2 autres/);
    expect(answer).not.toContain("« D »");
  });
});

describe("with several accounts", () => {
  const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;

  async function accounts() {
    instance = await new AccountsInstance().start();
    const { admin, people } = instance;
    const project = (await instance.createProject(admin)) as Project;
    for (const person of [people.ariane, people.thomas]) await admin.send("PUT", `/api/projects/${project.id}/members/${person.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.marc.id}`, { level: "comment" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const threads: Thread[] = [];
    for (const body of ["First", "Second"]) threads.push((await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread);
    const terminalFor = async (who: SignedIn, machine: string, folder: string) =>
      openTerminal({ folder: linkFolder([project.id]), server: { url: instance!.server.url } as Seam2["server"] }, stops, machine, { token: await tokenOf(who), folder });
    return { project, pageId, threads, terminalFor };
  }

  it("lists another account's takes apart with who, where and the thread id, and does not take them (scenario conflit)", async () => {
    const { pageId, threads, terminalFor } = await accounts();
    const ariane = await terminalFor(instance!.ariane, "Studio", "/Users/ana/crm");
    await ariane.call("pending_comments", { threadIds: [threads[0].id] });
    const thomas = await terminalFor(instance!.thomas, "Air", "/Users/tom/site");

    const answer = await thomas.call("pending_comments", { pageId });

    expect(answer).toContain(`thread id: ${threads[1].id}`);
    expect(answer).toMatch(/Taken by another account \(1\)/);
    expect(answer).toContain(threads[0].id);
    expect(answer).toContain("Ariane Martin");
    expect(answer).toContain("~/crm");
    expect(answer).toMatch(/Do not take them unless the person asks/);
    const stillHers = (await instance!.admin.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === threads[0].id)!;
    expect(stillHers.take?.person?.name).toBe("Ariane Martin");
  });

  it("refuses to take another account's thread without takeOver, then takes it over with the trace (scenario reprise)", async () => {
    const { pageId, threads, terminalFor } = await accounts();
    const ariane = await terminalFor(instance!.ariane, "Studio", "/Users/ana/crm");
    await ariane.call("pending_comments", { threadIds: [threads[0].id] });
    const thomas = await terminalFor(instance!.thomas, "Air", "/Users/tom/site");

    expect(await thomas.call("pending_comments", { threadIds: [threads[0].id] })).toMatch(/taken by Ariane Martin.*takeOver: true/);
    const answer = await thomas.call("pending_comments", { threadIds: [threads[0].id], takeOver: true });

    expect(answer).toContain(`thread id: ${threads[0].id}`);
    expect(answer).toContain('taken over from "Ariane Martin"');
    const taken = (await instance!.admin.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === threads[0].id)!;
    expect(taken.take).toMatchObject({ person: { name: "Thomas Lefevre" }, takenOver: { from: { name: "Ariane Martin" } } });
    expect(taken.traces).toMatchObject([{ kind: "taken-over", taker: { name: "Ariane Martin" }, by: { name: "Thomas Lefevre" } }]);
    // The late answer of the first conversation is still added, says who took the thread over, and leaves the take to Thomas.
    expect(await ariane.call("reply_in_thread", { threadId: threads[0].id, text: "Late" })).toMatch(/^Reply posted\. Il n'est plus à toi : Thomas Lefevre l'a repris .+\. Sa conversation verra ta réponse\.$/);
    const after = (await instance!.admin.json<Thread[]>(`/api/pages/${pageId}/threads`)).find((t) => t.id === threads[0].id)!;
    expect(after).toMatchObject({ take: { person: { name: "Thomas Lefevre" } }, replies: [{ body: "Late", late: "taken-over" }] });
  });

  it("refuses an account without Écriture, naming its right and the project (scenario droits), in every form", async () => {
    const { project, pageId, threads, terminalFor } = await accounts();
    const marc = await terminalFor(instance!.marc, "Air", "/Users/marc/site");

    for (const args of [{ pageId }, { threadIds: [threads[0].id] }, {}]) {
      const answer = await marc.call("pending_comments", args);
      expect(answer).toMatch(/Marc Petit/);
      expect(answer).toMatch(/Commentaire/);
      expect(answer).toMatch(/Écriture/);
    }
    expect(await marc.call("pending_comments", { pageId })).toContain(JSON.stringify("Acme"));
    const unchanged = await instance!.admin.json<Thread[]>(`/api/pages/${pageId}/threads`);
    expect(unchanged.every((t) => !t.take)).toBe(true);
    void project;
  });
});

describe("comment modes of the pages do not change what a list shows", () => {
  it("lists the threads of a page in Agent mode as owned by the agent: nothing to take", async () => {
    seam = await startSeam2(idleEngine());
    const mode: CommentMode = "agent";
    const page = await seam.createPage(PAGE_FILES, "Partager", mode);
    await seam.pinThread(page.id, "home.html", "Agent's");
    await seam.waitForWorkEnd(1);
    const terminal = await terminalOf("MacBook-Pro");

    expect(await terminal.call("pending_comments", {})).toMatch(/No comment to take/);
  });
});
