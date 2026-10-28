import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { connectToServer } from "../src/connection.js";
import { linkFolder, serverForFolder, type LinkChoice } from "../src/link.js";

const on = (serverUrl: string, token: string) => ({
  servers: [{ serverUrl, token }],
  chooseServer: async () => {
    throw new Error("should not ask for a server");
  },
});

describe("linking a folder to a project", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  let token: string;
  beforeEach(async () => {
    token = ((await (await server.get("/api/agent-token")).json()) as { token: string }).token;
  });

  const folder = () => mkdtempSync(join(tmpdir(), "redline-folder-"));
  const projects = async () => (await (await server.get("/api/projects")).json()) as Project[];
  const never = async (): Promise<LinkChoice> => {
    throw new Error("should not ask");
  };

  it("creates a project when the user chooses to, and records the link in the folder", async () => {
    const dir = folder();
    const { projectIds } = await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Acme" }) });
    expect(await projects()).toMatchObject([{ id: projectIds[0], title: "Acme" }]);
    expect(JSON.parse(readFileSync(join(dir, ".redline", "project.json"), "utf8"))).toEqual({ serverUrl: server.url, projectIds });
  });

  it("offers the existing projects and links the one picked without creating another", async () => {
    const existing = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    let offered: Project[] = [];
    const { projectIds } = await linkFolder({
      folder: folder(),
      ...on(server.url, token),
      choose: async (list) => {
        offered = list;
        return { existing: existing.id };
      },
    });
    expect(offered.map((p) => p.title)).toEqual(["Acme"]);
    expect(projectIds).toEqual([existing.id]);
    expect(await projects()).toHaveLength(1);
  });

  it("does not ask again for a folder that is already linked", async () => {
    const dir = folder();
    const { projectIds: first } = await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Acme" }) });
    expect((await linkFolder({ folder: dir, ...on(server.url, token), choose: never })).projectIds).toEqual(first);
  });

  it("offers to add a project to a linked folder, which then serves both", async () => {
    const dir = folder();
    const studio = (await (await server.post("/api/projects", { title: "Reel studio" })).json()) as Project;
    await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Sueurs froides" }) });
    const offers: { linked: string[]; others: string[] }[] = [];
    const linked = await linkFolder({
      folder: dir,
      ...on(server.url, token),
      choose: never,
      chooseMore: async (linked, others) => {
        offers.push({ linked: linked.map((p) => p.title), others: others.map((p) => p.title) });
        return offers.length === 1 ? { existing: studio.id } : undefined;
      },
    });
    expect(offers).toEqual([
      { linked: ["Sueurs froides"], others: ["Reel studio"] },
      { linked: ["Sueurs froides", "Reel studio"], others: [] },
    ]);
    expect(linked.projects.map((p) => p.title)).toEqual(["Sueurs froides", "Reel studio"]);
    expect(JSON.parse(readFileSync(join(dir, ".redline", "project.json"), "utf8")).projectIds).toEqual(linked.projectIds);
  });

  it("stops serving a project on request, but never the last one", async () => {
    const dir = folder();
    const studio = (await (await server.post("/api/projects", { title: "Reel studio" })).json()) as Project;
    const chills = (await (await server.post("/api/projects", { title: "Sueurs froides" })).json()) as Project;
    mkdirSync(join(dir, ".redline"));
    writeFileSync(join(dir, ".redline", "project.json"), JSON.stringify({ serverUrl: server.url, projectIds: [studio.id, chills.id, studio.id] }));
    const answers = [{ remove: studio.id }, { remove: chills.id }];
    const linked = await linkFolder({ folder: dir, ...on(server.url, token), choose: never, chooseMore: async () => answers.shift() });
    expect(linked.projectIds).toEqual([chills.id]);
  });

  it("does not offer a project another online agent serves", async () => {
    const dir = folder();
    const taken = (await (await server.post("/api/projects", { title: "Taken" })).json()) as Project;
    await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Mine" }) });
    const other = await connectToServer({ serverUrl: server.url, token, kind: "project", projectIds: [taken.id], machine: "iMac", folder: "/other" });
    let offered: string[] = [];
    await linkFolder({ folder: dir, ...on(server.url, token), choose: never, chooseMore: async (_, others) => ((offered = others.map((p) => p.title)), undefined) });
    expect(offered).toEqual([]);
    other.close();
    await other.closed;
  });

  it("does not offer to add a project right after linking an unlinked folder", async () => {
    const linked = await linkFolder({ folder: folder(), ...on(server.url, token), choose: async () => ({ create: "Acme" }), chooseMore: never });
    expect(linked.projects.map((p) => p.title)).toEqual(["Acme"]);
  });

  it("drops a linked project that no longer exists and keeps the others", async () => {
    const dir = folder();
    const kept = (await (await server.post("/api/projects", { title: "Kept" })).json()) as Project;
    mkdirSync(join(dir, ".redline"));
    writeFileSync(join(dir, ".redline", "project.json"), JSON.stringify({ serverUrl: server.url, projectIds: ["gone", kept.id] }));
    expect((await linkFolder({ folder: dir, ...on(server.url, token), choose: never })).projectIds).toEqual([kept.id]);
  });

  it("keeps an archived project in the link without serving it, and refuses a folder whose projects are all archived", async () => {
    const dir = folder();
    const live = (await (await server.post("/api/projects", { title: "Live" })).json()) as Project;
    const old = (await (await server.post("/api/projects", { title: "Old" })).json()) as Project;
    await server.post(`/api/projects/${old.id}/archive`, {});
    mkdirSync(join(dir, ".redline"));
    writeFileSync(join(dir, ".redline", "project.json"), JSON.stringify({ serverUrl: server.url, projectIds: [live.id, old.id] }));
    expect((await linkFolder({ folder: dir, ...on(server.url, token), choose: never })).projectIds).toEqual([live.id]);
    expect(JSON.parse(readFileSync(join(dir, ".redline", "project.json"), "utf8")).projectIds).toEqual([live.id, old.id]);

    const archivedOnly = folder();
    mkdirSync(join(archivedOnly, ".redline"));
    writeFileSync(join(archivedOnly, ".redline", "project.json"), JSON.stringify({ serverUrl: server.url, projectIds: [old.id] }));
    await expect(linkFolder({ folder: archivedOnly, ...on(server.url, token), choose: never })).rejects.toThrow(/"Old" is archived/);
  });

  it("asks again when the linked project no longer exists on this server", async () => {
    const dir = folder();
    await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Acme" }) });
    const other = await startTestServer();
    try {
      const otherToken = ((await (await other.get("/api/agent-token")).json()) as { token: string }).token;
      const { projectIds } = await linkFolder({ folder: dir, ...on(other.url, otherToken), choose: async () => ({ create: "Fresh" }) });
      expect(projectIds).toHaveLength(1);
    } finally {
      await other.stop();
    }
  });

  it("goes through the agents' token-guarded API: a wrong token links nothing", async () => {
    const dir = folder();
    await expect(linkFolder({ folder: dir, ...on(server.url, "abt_wrong"), choose: async () => ({ create: "Acme" }) })).rejects.toThrow(/token/i);
    expect(existsSync(join(dir, ".redline", "project.json"))).toBe(false);
    expect(await projects()).toEqual([]);
  });

  it("adds .redline/ to .gitignore, keeping existing content and never duplicating the entry", async () => {
    const dir = folder();
    writeFileSync(join(dir, ".gitignore"), "node_modules");
    const choose = async (): Promise<LinkChoice> => ({ create: "Acme" });
    await linkFolder({ folder: dir, ...on(server.url, token), choose });
    await linkFolder({ folder: dir, ...on(server.url, token), choose: never });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.redline/\n");
  });

  it("creates .gitignore when missing, and leaves an existing .redline entry alone", async () => {
    const fresh = folder();
    await linkFolder({ folder: fresh, ...on(server.url, token), choose: async () => ({ create: "A" }) });
    expect(readFileSync(join(fresh, ".gitignore"), "utf8")).toBe(".redline/\n");

    const ignored = folder();
    writeFileSync(join(ignored, ".gitignore"), "/.redline\n");
    await linkFolder({ folder: ignored, ...on(server.url, token), choose: async () => ({ create: "B" }) });
    expect(readFileSync(join(ignored, ".gitignore"), "utf8")).toBe("/.redline\n");
    expect(existsSync(join(ignored, ".redline", "project.json"))).toBe(true);
  });

  it("a linked agent connects as the project's agent, and a second folder for the same project is refused", async () => {
    const dir = folder();
    const { projectIds } = await linkFolder({ folder: dir, ...on(server.url, token), choose: async () => ({ create: "Acme" }) });
    const base = { serverUrl: server.url, token, kind: "project" as const, projectIds };
    const first = await connectToServer({ ...base, machine: "MacBook", folder: dir });
    expect(((await projects())[0].agent)?.machine).toBe("MacBook");
    await expect(connectToServer({ ...base, machine: "iMac", folder: "/other" })).rejects.toThrow(/MacBook/);
    first.close();
    await first.closed;
  });
  it("completes an old link that has no server, using the only server", async () => {
    const dir = folder();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    mkdirSync(join(dir, ".redline"));
    writeFileSync(join(dir, ".redline", "project.json"), JSON.stringify({ projectId: project.id }));
    const linked = await linkFolder({ folder: dir, ...on(server.url, token), choose: never });
    expect(linked.projectIds).toEqual([project.id]);
    expect(JSON.parse(readFileSync(join(dir, ".redline", "project.json"), "utf8"))).toEqual({ serverUrl: server.url, projectIds: [project.id] });
  });

  it("with several servers, asks for the server first, then the project, and remembers both", async () => {
    const other = await startTestServer();
    try {
      const otherToken = ((await (await other.get("/api/agent-token")).json()) as { token: string }).token;
      const servers = [
        { serverUrl: server.url, token },
        { serverUrl: other.url, token: otherToken },
      ];
      const dir = folder();
      const asked: string[] = [];
      const linked = await linkFolder({
        folder: dir,
        servers,
        chooseServer: async (list) => {
          asked.push("server");
          return list[1];
        },
        choose: async () => {
          asked.push("project");
          return { create: "Elsewhere" };
        },
      });
      expect(asked).toEqual(["server", "project"]);
      expect(linked.server.serverUrl).toBe(other.url);
      expect(await projects()).toEqual([]);
      const again = await linkFolder({ folder: dir, servers, chooseServer: never as never, choose: never });
      expect(again).toEqual(linked);
    } finally {
      await other.stop();
    }
  });
});

describe("the server `redline mcp` talks to from a folder", () => {
  const a = { serverUrl: "https://a.example.fr", token: "a" };
  const b = { serverUrl: "https://b.example.fr", token: "b" };
  const linked = (link: object) => {
    const dir = mkdtempSync(join(tmpdir(), "redline-folder-"));
    mkdirSync(join(dir, ".redline"));
    writeFileSync(join(dir, ".redline", "project.json"), JSON.stringify(link));
    return dir;
  };

  it("is the folder's own server", () => {
    expect(serverForFolder(linked({ serverUrl: "https://b.example.fr", projectId: "p" }), [a, b])).toBe(b);
  });

  it("is the only server for a folder that is not linked, and for an old link", () => {
    expect(serverForFolder(mkdtempSync(join(tmpdir(), "redline-folder-")), [a])).toBe(a);
    expect(serverForFolder(linked({ projectId: "p" }), [a])).toBe(a);
  });

  it("is ambiguous for an unlinked folder when several servers are set up", () => {
    expect(() => serverForFolder(mkdtempSync(join(tmpdir(), "redline-folder-")), [a, b])).toThrow(/--server/);
  });
});
