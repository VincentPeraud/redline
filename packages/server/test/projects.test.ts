import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("projects over the server HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("creates a project with title, instructions and design system and reads it back", async () => {
    const res = await server.post("/api/projects", {
      title: "Acme",
      instructions: "A calm, editorial look",
      designSystem: "neutral",
    });
    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    expect(project).toMatchObject({ title: "Acme", instructions: "A calm, editorial look", designSystem: "neutral" });

    const read = await server.get(`/api/projects/${project.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(project);
    expect(await (await server.get("/api/projects")).json()).toMatchObject([project]);
  });

  it("defaults to no instructions and no design system", async () => {
    const project = (await (await server.post("/api/projects", { title: "Bare" })).json()) as Project;
    expect(project.instructions).toBe("");
    expect(project.designSystem).toBeNull();
  });

  it("rejects invalid instructions or design system, and unknown projects", async () => {
    expect((await server.post("/api/projects", { title: "X", instructions: 3 })).status).toBe(400);
    expect((await server.post("/api/projects", { title: "X", designSystem: 3 })).status).toBe(400);
    expect((await server.get("/api/projects/nope")).status).toBe(404);
  });
});
