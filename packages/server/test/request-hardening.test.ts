import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("state-changing requests to /api", () => {
  let server: TestServer;
  let project: Project;
  beforeEach(async () => {
    server = await startTestServer();
    project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  });
  afterEach(async () => {
    await server.stop();
  });

  const post = (path: string, init: { origin?: string; contentType?: string; body?: string; headers?: Record<string, string> } = {}) =>
    fetch(server.url + path, {
      method: "POST",
      headers: {
        ...(init.contentType === undefined ? {} : { "content-type": init.contentType }),
        ...(init.origin === undefined ? {} : { origin: init.origin }),
        ...init.headers,
      },
      body: init.body,
    });

  it("refuses a request that comes from another origin", async () => {
    const res = await post("/api/agent-token/regenerate", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const sandboxed = await post("/api/agent-token/regenerate", { origin: "null" });
    expect(sandboxed.status).toBe(403);
  });

  it("accepts the UI's own origin, and requests without an origin (the agents, scripts)", async () => {
    expect((await post("/api/agent-token/regenerate", { origin: server.url })).status).toBe(200);
    expect((await post("/api/agent-token/regenerate")).status).toBe(200);
  });

  it("follows the host the proxy forwards", async () => {
    const res = await post("/api/agent-token/regenerate", {
      origin: "https://redline.example.fr",
      headers: { "x-forwarded-host": "redline.example.fr" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not JSON, even without an origin", async () => {
    const res = await post("/api/projects", { contentType: "text/plain", body: JSON.stringify({ title: "Sneaky" }) });
    expect(res.status).toBe(415);
    expect(((await (await server.get("/api/projects")).json()) as Project[]).map((p) => p.title)).toEqual(["Acme"]);
  });

  it("applies to PUT, PATCH and DELETE too", async () => {
    const put = await fetch(`${server.url}/api/projects/${project.id}/design-md`, {
      method: "PUT",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(put.status).toBe(403);
    const patch = await fetch(`${server.url}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ globalTakeoverOverride: true }),
    });
    expect(patch.status).toBe(415);
  });

  it("lets the raw asset upload through with its own content type, but still checks the origin", async () => {
    const asset = (origin?: string) =>
      fetch(`${server.url}/api/projects/${project.id}/assets/logo.png`, {
        method: "PUT",
        headers: { "content-type": "image/png", ...(origin ? { origin } : {}) },
        body: Buffer.from([1, 2, 3]),
      });
    expect((await asset(server.url)).status).toBe(201);
    expect((await asset("https://evil.example")).status).toBe(403);
  });

  it("does not touch reads", async () => {
    const res = await fetch(server.url + "/api/projects", { headers: { origin: "https://elsewhere.example" } });
    expect(res.status).toBe(200);
  });
});

describe("responses of the web server", () => {
  let server: TestServer;
  let page: Page;
  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    page = (await (
      await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<script>alert(1)</script>" } })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  it("serve stored files as downloads that browsers do not sniff or render", async () => {
    const res = await server.get(`/api/pages/${page.id}/files/home.html`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("cannot be framed by another site", async () => {
    const res = await server.get("/api/config");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});

describe("the agent API", () => {
  let server: TestServer;
  let token: string;
  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  });
  afterEach(async () => {
    await server.stop();
  });

  const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(server.url + AGENT_API_PREFIX + path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token ?? token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  it("lists and creates projects for `redline init`, behind the agents' token", async () => {
    expect((await call("/projects", { token: "abt_wrong" })).status).toBe(401);
    expect((await fetch(server.url + AGENT_API_PREFIX + "/projects")).status).toBe(401);

    const created = await call("/projects", { method: "POST", body: { title: "Acme" } });
    expect(created.status).toBe(201);
    const project = (await created.json()) as Project;
    expect(project.title).toBe("Acme");
    expect(((await (await call("/projects")).json()) as Project[]).map((p) => p.id)).toEqual([project.id]);
    expect((await call("/projects", { method: "POST", body: { title: " " } })).status).toBe(400);
  });

  it("refuses a model name that is not a plain model name", async () => {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (
      await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Hi</h1>" } })
    ).json()) as Page;
    const thread = (await (
      await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 1, yPct: 2, body: "Hi?" })
    ).json()) as { id: string };

    for (const model of ["opus --dangerously-skip-permissions", "a b", "$(id)", ""]) {
      expect((await server.post(`/api/threads/${thread.id}/messages`, { body: "x", model })).status).toBe(400);
      expect((await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 1, yPct: 2, body: "x", model })).status).toBe(400);
      expect((await server.post(`/api/pages/${page.id}/send-held`, { model })).status).toBe(400);
    }
    for (const model of ["opus", "claude-opus-4-1", "sonnet[1m]", "us.anthropic.claude_x"]) {
      expect((await server.post(`/api/threads/${thread.id}/messages`, { body: "x", model })).status).toBe(201);
    }
  });
});
