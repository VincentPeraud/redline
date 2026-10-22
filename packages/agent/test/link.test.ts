import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { connectToServer } from "../src/connection.js";
import { linkFolder, type LinkChoice } from "../src/link.js";

describe("linking a folder to a project", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const folder = () => mkdtempSync(join(tmpdir(), "redline-folder-"));
  const projects = async () => (await (await server.get("/api/projects")).json()) as Project[];
  const never = async (): Promise<LinkChoice> => {
    throw new Error("should not ask");
  };

  it("creates a project when the user chooses to, and records the link in the folder", async () => {
    const dir = folder();
    const projectId = await linkFolder({ folder: dir, serverUrl: server.url, choose: async () => ({ create: "Acme" }) });
    expect(await projects()).toMatchObject([{ id: projectId, title: "Acme" }]);
    expect(JSON.parse(readFileSync(join(dir, ".redline", "project.json"), "utf8"))).toEqual({ projectId });
  });

  it("offers the existing projects and links the one picked without creating another", async () => {
    const existing = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    let offered: Project[] = [];
    const projectId = await linkFolder({
      folder: folder(),
      serverUrl: server.url,
      choose: async (list) => {
        offered = list;
        return { existing: existing.id };
      },
    });
    expect(offered.map((p) => p.title)).toEqual(["Acme"]);
    expect(projectId).toBe(existing.id);
    expect(await projects()).toHaveLength(1);
  });

  it("does not ask again for a folder that is already linked", async () => {
    const dir = folder();
    const first = await linkFolder({ folder: dir, serverUrl: server.url, choose: async () => ({ create: "Acme" }) });
    expect(await linkFolder({ folder: dir, serverUrl: server.url, choose: never })).toBe(first);
  });

  it("asks again when the linked project no longer exists on this server", async () => {
    const dir = folder();
    await linkFolder({ folder: dir, serverUrl: server.url, choose: async () => ({ create: "Acme" }) });
    const other = await startTestServer();
    try {
      const id = await linkFolder({ folder: dir, serverUrl: other.url, choose: async () => ({ create: "Fresh" }) });
      expect(id).toBeTruthy();
    } finally {
      await other.stop();
    }
  });

  it("adds .redline/ to .gitignore, keeping existing content and never duplicating the entry", async () => {
    const dir = folder();
    writeFileSync(join(dir, ".gitignore"), "node_modules");
    const choose = async (): Promise<LinkChoice> => ({ create: "Acme" });
    await linkFolder({ folder: dir, serverUrl: server.url, choose });
    await linkFolder({ folder: dir, serverUrl: server.url, choose: never });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.redline/\n");
  });

  it("creates .gitignore when missing, and leaves an existing .redline entry alone", async () => {
    const fresh = folder();
    await linkFolder({ folder: fresh, serverUrl: server.url, choose: async () => ({ create: "A" }) });
    expect(readFileSync(join(fresh, ".gitignore"), "utf8")).toBe(".redline/\n");

    const ignored = folder();
    writeFileSync(join(ignored, ".gitignore"), "/.redline\n");
    await linkFolder({ folder: ignored, serverUrl: server.url, choose: async () => ({ create: "B" }) });
    expect(readFileSync(join(ignored, ".gitignore"), "utf8")).toBe("/.redline\n");
    expect(existsSync(join(ignored, ".redline", "project.json"))).toBe(true);
  });

  it("a linked agent connects as the project's agent, and a second folder for the same project is refused", async () => {
    const dir = folder();
    const projectId = await linkFolder({ folder: dir, serverUrl: server.url, choose: async () => ({ create: "Acme" }) });
    const token = ((await (await server.get("/api/agent-token")).json()) as { token: string }).token;
    const base = { serverUrl: server.url, token, kind: "project" as const, projectId };
    const first = await connectToServer({ ...base, machine: "MacBook", folder: dir });
    expect(((await projects())[0].agent)?.machine).toBe("MacBook");
    await expect(connectToServer({ ...base, machine: "iMac", folder: "/other" })).rejects.toThrow(/MacBook/);
    first.close();
    await first.closed;
  });
});
