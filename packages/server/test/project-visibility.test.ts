import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_PATH, type HomeOverview, type NoAccessResponse, type Project, type ProjectSharing, type ServerEvent } from "@redline/shared";
import { hashPassword } from "../src/accounts.js";
import { startServer, type RunningServer } from "../src/start.js";

const JSON_HEADERS = { "content-type": "application/json" };
const PASSWORD = "correct horse";
const FILES = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

describe("project visibility", () => {
  let dataDir: string;
  let server: RunningServer | undefined;
  let logs: string[];
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-visibility-"));
    logs = [];
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  interface Viewer {
    get: (path: string) => Promise<Response>;
    send: (method: string, path: string, body?: unknown) => Promise<Response>;
    json: <T>(path: string) => Promise<T>;
    cookie: string;
  }

  const signIn = async (url: string, email: string): Promise<Viewer> => {
    const response = await fetch(`${url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const send = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { cookie, send, get: (path) => send("GET", path), json: async <T,>(path: string) => (await send("GET", path)).json() as Promise<T> };
  };

  /** An instance with an admin (Vincent) and two members (Ariane, Thomas), each signed in. */
  const start = async () => {
    server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: (line) => logs.push(line) });
    const token = logs.find((l) => l.includes("/#/setup/"))!.split("/#/setup/")[1].trim();
    await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
    const db = new Database(join(dataDir, "redline.db"));
    const hash = await hashPassword(PASSWORD);
    for (const [name, email] of [["Ariane Martin", "ariane@example.com"], ["Thomas Lefevre", "thomas@example.com"]]) {
      db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(randomUUID(), name, email, new Date().toISOString(), hash);
    }
    db.close();
    return {
      url: server.url,
      admin: await signIn(server.url, "vincent@example.com"),
      ariane: await signIn(server.url, "ariane@example.com"),
      thomas: await signIn(server.url, "thomas@example.com"),
    };
  };

  const createProject = async (who: Viewer, body: object) => (await (await who.send("POST", "/api/projects", { title: "Acme", ...body })).json()) as Project;
  const createPage = async (who: Viewer, projectId: string) => ((await (await who.send("POST", `/api/projects/${projectId}/pages`, { title: "Home", files: FILES })).json()) as { id: string }).id;

  it("makes a new project Équipe by default, created by whoever made it, and shows it to every member", async () => {
    const { admin, ariane, thomas } = await start();
    const project = await createProject(ariane, {});
    expect(project.visibility).toBe("team");
    expect(project.createdBy?.name).toBe("Ariane Martin");
    for (const viewer of [admin, ariane, thomas]) {
      expect((await viewer.json<Project[]>("/api/projects")).map((p) => p.id)).toContain(project.id);
    }
  });

  it("hides a Privé project from the other members in every list and route, and shows it to its creator and the admins", async () => {
    const { admin, ariane, thomas } = await start();
    const project = await createProject(ariane, { visibility: "private" });
    expect(project.visibility).toBe("private");
    const pageId = await createPage(ariane, project.id);
    const threadId = ((await (await ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Hi" })).json()) as { id: string }).id;

    for (const viewer of [admin, ariane]) {
      expect((await viewer.json<Project[]>("/api/projects")).map((p) => p.id)).toContain(project.id);
      expect((await viewer.get(`/api/projects/${project.id}`)).status).toBe(200);
      expect((await viewer.json<HomeOverview>("/api/home")).projects.map((p) => p.id)).toContain(project.id);
    }
    expect((await thomas.json<Project[]>("/api/projects")).map((p) => p.id)).not.toContain(project.id);
    const home = await thomas.json<HomeOverview>("/api/home");
    expect(home.projects.map((p) => p.id)).not.toContain(project.id);
    expect(home.recentPages.map((r) => r.page.id)).not.toContain(pageId);
    for (const path of [`/api/projects/${project.id}`, `/api/projects/${project.id}/pages`, `/api/pages/${pageId}`, `/api/pages/${pageId}/threads`]) {
      expect((await thomas.get(path)).status, path).toBe(403);
    }
    expect((await thomas.send("POST", `/api/threads/${threadId}/resolve`, {})).status).toBe(403);
    expect((await thomas.send("POST", `/api/projects/${project.id}/pages`, { title: "Mine", files: FILES })).status).toBe(403);
    expect((await thomas.json<{ sessions?: unknown }>("/api/sessions")) as unknown[]).toEqual([]);
  });

  it("names the creator on the 403 of a Privé project", async () => {
    const { ariane, thomas } = await start();
    const project = await createProject(ariane, { visibility: "private" });
    const refused = await thomas.get(`/api/projects/${project.id}`);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as NoAccessResponse;
    expect(body.code).toBe("no-access");
    expect(body.creator?.name).toBe("Ariane Martin");
  });

  it("lets only the creator or an admin switch the visibility, and lists who loses access", async () => {
    const { admin, ariane, thomas } = await start();
    const project = await createProject(ariane, {});
    expect((await thomas.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" })).status).toBe(403);
    expect((await thomas.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).canChange).toBe(false);

    const sharing = await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`);
    expect(sharing).toMatchObject({ visibility: "team", canChange: true });
    expect(sharing.wouldLoseAccess.map((p) => p.name)).toEqual(["Thomas Lefevre"]);
    expect((await admin.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).wouldLoseAccess.map((p) => p.name)).toEqual(["Thomas Lefevre"]);

    const switched = await ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "private" });
    expect(((await switched.json()) as Project).visibility).toBe("private");
    expect((await thomas.get(`/api/projects/${project.id}`)).status).toBe(403);
    expect((await ariane.json<ProjectSharing>(`/api/projects/${project.id}/sharing`)).wouldLoseAccess).toEqual([]);

    expect((await admin.send("PATCH", `/api/projects/${project.id}`, { visibility: "team" })).status).toBe(200);
    expect((await thomas.get(`/api/projects/${project.id}`)).status).toBe(200);
    expect((await ariane.send("PATCH", `/api/projects/${project.id}`, { visibility: "nobody" })).status).toBe(400);
  });

  it("sends events of a Privé project only to who may see it", async () => {
    const { ariane, thomas } = await start();
    const project = await createProject(ariane, { visibility: "private" });
    const pageId = await createPage(ariane, project.id);
    const teamProject = await createProject(ariane, { title: "Open" });
    const teamPageId = await createPage(ariane, teamProject.id);

    const listen = async (viewer: Viewer) => {
      const events: ServerEvent[] = [];
      const controller = new AbortController();
      const response = await fetch(`${server!.url}/api/events`, { headers: { cookie: viewer.cookie }, signal: controller.signal });
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for await (const chunk of response.body!) {
            buffer += decoder.decode(chunk as Uint8Array);
            const lines = buffer.split("\n\n");
            buffer = lines.pop()!;
            for (const line of lines) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
          }
        } catch {
          // Aborted at the end of the test.
        }
      })();
      return { events, stop: () => controller.abort() };
    };
    const owner = await listen(ariane);
    const other = await listen(thomas);
    await ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Private remark" });
    await ariane.send("POST", `/api/pages/${teamPageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team remark" });
    await vi.waitFor(() => expect(other.events.some((e) => "pageId" in e && e.pageId === teamPageId)).toBe(true));
    expect(owner.events.some((e) => "pageId" in e && e.pageId === pageId)).toBe(true);
    expect(other.events.some((e) => "pageId" in e && e.pageId === pageId)).toBe(false);
    owner.stop();
    other.stop();
  });
});
