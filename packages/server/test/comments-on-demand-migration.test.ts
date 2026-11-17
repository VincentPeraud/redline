import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Page, Project, QueueEntry, Thread } from "@redline/shared";
import { startServer, type RunningServer } from "../src/start.js";

const FILES = { "home.html": "<h1>Home</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };
const TARGET = { kind: "artboard", artboard: "home.html" };

let dataDir: string;
let server: RunningServer | undefined;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "redline-migration-"));
});
afterEach(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const start = async () => (server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "none" }));
const post = async <T>(path: string, body: unknown) => (await (await fetch(server!.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as T;
const get = async <T>(path: string) => (await (await fetch(server!.url + path)).json()) as T;

const queuedItem = (pageId: string, threadId: string, resume: boolean) => ({
  id: `work-${threadId}`,
  kind: "thread",
  pageId,
  threads: [{ threadId, number: 1, artboard: "home.html", selector: "", xPct: 0, yPct: 0, body: "x" }],
  message: "x",
  sessionId: `session-${threadId}`,
  resume,
});

it("turns each state of the old hold model into the new one", async () => {
  // A database as the previous version left it: threads and pages carry the hold columns, the queue has `for_terminal`.
  await start();
  const project = await post<Project>("/api/projects", { title: "Acme" });
  const page = await post<Page>(`/api/projects/${project.id}/pages`, { title: "Accueil", files: FILES });
  const comment = async (body: string) => post<Thread>(`/api/pages/${page.id}/threads`, { target: TARGET, body });
  const [pickedUnanswered, pickedAnswered, agentOwned, waitingForTerminal, waitingForOfflineAgent, resumeQueued] = [
    await comment("Picked, unanswered"),
    await comment("Picked, answered"),
    await comment("Agent owned"),
    await comment("Waiting for the terminal"),
    await comment("Waiting for an offline agent"),
    await comment("Resume queued"),
  ];
  await server!.close();

  const db = new Database(join(dataDir, "redline.db"));
  db.exec("ALTER TABLE pages ADD COLUMN held_by TEXT; ALTER TABLE pages ADD COLUMN held_at TEXT; ALTER TABLE threads ADD COLUMN terminal_session_id TEXT; ALTER TABLE threads ADD COLUMN terminal_pick_run TEXT; ALTER TABLE work_queue ADD COLUMN for_terminal INTEGER");
  db.prepare("UPDATE pages SET held_by = 'old-session', held_at = ? WHERE id = ?").run(new Date().toISOString(), page.id);
  db.prepare("UPDATE threads SET terminal_session_id = 'old-session', terminal_pick_run = 'run-1' WHERE id = ?").run(pickedUnanswered.id);
  db.prepare("UPDATE threads SET terminal_session_id = 'old-session' WHERE id = ?").run(pickedAnswered.id);
  db.prepare("INSERT INTO thread_replies (id, thread_id, author, body, created_at) VALUES ('r1', ?, 'claude', 'Done', ?)").run(pickedAnswered.id, new Date().toISOString());
  db.prepare("INSERT INTO thread_replies (id, thread_id, author, body, created_at) VALUES ('r2', ?, 'user', 'Bigger', ?)").run(pickedAnswered.id, new Date(Date.now() + 1000).toISOString());
  db.prepare("UPDATE threads SET session_id = 'agent-session', agent_id = 'agent-1' WHERE id = ?").run(agentOwned.id);
  db.prepare("UPDATE threads SET session_id = 'agent-session-2', agent_id = 'agent-1' WHERE id = ?").run(resumeQueued.id);
  const queue = db.prepare("INSERT INTO work_queue (id, position, state, project_id, item, attempts, for_terminal) VALUES (?, ?, 'queued', ?, ?, 0, ?)");
  queue.run("q1", 0, project.id, JSON.stringify(queuedItem(page.id, waitingForTerminal.id, false)), 1);
  queue.run("q2", 1, project.id, JSON.stringify(queuedItem(page.id, waitingForOfflineAgent.id, false)), 0);
  queue.run("q3", 2, project.id, JSON.stringify(queuedItem(page.id, resumeQueued.id, true)), 0);
  db.close();

  await start();

  expect((await get<Page>(`/api/pages/${page.id}`)).commentMode).toBe("conversation");
  const threads = new Map((await get<Thread[]>(`/api/pages/${page.id}/threads`)).map((t) => [t.id, t]));
  for (const thread of [pickedUnanswered, pickedAnswered, waitingForTerminal, waitingForOfflineAgent]) expect(threads.get(thread.id), thread.title).toMatchObject({ toTake: true });
  expect(threads.get(agentOwned.id)).not.toHaveProperty("toTake");
  expect(threads.get(resumeQueued.id)).not.toHaveProperty("toTake");
  expect((await get<QueueEntry[]>(`/api/pages/${page.id}/queue`)).map((entry) => entry.threadIds)).toEqual([[resumeQueued.id]]);

  // The hold columns are gone: a second start finds nothing to migrate.
  await server!.close();
  await start();
  expect(((await get<Thread[]>(`/api/pages/${page.id}/threads`)).filter((t) => t.toTake)).length).toBe(4);
});
