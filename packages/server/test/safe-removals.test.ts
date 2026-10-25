import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111111;`).join("\n")}\n${extra}}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const usingToken = (name: string) => `<!doctype html><html><body><p style="color: var(${name}, red)">Hi</p></body></html>`;

describe("safe removals on a design system publish", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let dsPage: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss("  --brand: #ff0000;\n  --old-brand: var(--brand); /* deprecated: renamed to --brand */\n"),
        "manifest.json": manifestOf(["components/post-cta.html"]),
        "components/post-cta.html": component(".cta{color:red}"),
      },
    })).json()) as DesignSystem;
    dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  });
  afterEach(async () => {
    await server.stop();
  });

  const createProject = async (designSystem?: string) => (await (await server.post("/api/projects", { title: "Halloween", designSystem })).json()) as Project;
  const createPage = async (project: Project, files: Record<string, string>, title = "Stories") =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title, files })).json()) as Page;
  const publishDs = (files: Record<string, string>, extra: object = {}) =>
    server.post(`/api/pages/${dsPage.id}/versions`, { files, message: "Edit", origin: "thread", ...extra });
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;

  it("refuses removing a token a page still uses, naming the page, unless confirmed", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": usingToken("--brand") });

    const refused = await publishDs({ "tokens.css": tokensCss() });
    expect(refused.status).toBe(400);
    const message = await error(refused);
    expect(message).toContain("--brand");
    expect(message).toContain('"Stories"');
    expect(message).toContain('"Halloween"');

    const accepted = await publishDs({ "tokens.css": tokensCss() }, { confirmRemovals: true });
    expect(accepted.status).toBe(201);
    expect(await (await fetch(`${server.artboardOrigin}/design-systems/${ds.id}/tokens.css`)).text()).not.toContain("--brand:");
  });

  it("removes a token no page uses, and ignores projects of another design system", async () => {
    const other = await createProject();
    await createPage(other, { "a.html": usingToken("--brand") });
    const unrelated = await createProject(ds.id);
    await createPage(unrelated, { "a.html": "<p>none</p>" });
    expect((await publishDs({ "tokens.css": tokensCss() })).status).toBe(201);
  });

  it("counts a reference in the project style, naming the project", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": "<p>none</p>" });
    await fetch(`${server.url}/api/projects/${project.id}/project-style`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: ":root { --accent: var(--brand); }\n" }),
    });
    const refused = await publishDs({ "tokens.css": tokensCss() });
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain('project style of "Halloween"');
  });

  it("does not take a longer token name for a use of the removed one", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": usingToken("--brand-dark") });
    expect((await publishDs({ "tokens.css": tokensCss() })).status).toBe(201);
  });

  it("keeps a deprecated alias working, and removes it only once nothing uses it", async () => {
    const project = await createProject(ds.id);
    const page = await createPage(project, { "a.html": usingToken("--old-brand") });
    const withoutAlias = tokensCss("  --brand: #ff0000;\n");

    const refused = await publishDs({ "tokens.css": withoutAlias });
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain("--old-brand");

    await server.post(`/api/pages/${page.id}/versions`, { files: { "a.html": usingToken("--brand") }, message: "Use the new name", origin: "thread" });
    expect((await publishDs({ "tokens.css": withoutAlias })).status).toBe(201);
  });

  it("refuses removing a component whose classes a page still uses, unless confirmed", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": '<button class="btn cta">Go</button>' });
    const files = { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) };

    const refused = await publishDs(files);
    expect(refused.status).toBe(400);
    const message = await error(refused);
    expect(message).toContain('component "post-cta"');
    expect(message).toContain('"Stories"');

    expect((await publishDs(files, { confirmRemovals: true })).status).toBe(201);
  });

  it("removes a component nobody uses", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": '<button class="other">Go</button>' });
    expect((await publishDs({ "manifest.json": manifestOf([]) })).status).toBe(201);
  });

  it("applies the same rule to the design system tokens published by an agent session", async () => {
    const project = await createProject(ds.id);
    await createPage(project, { "a.html": usingToken("--brand") });
    const checkout = (await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${dsPage.id}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout;
    const publish = (extra: object) =>
      fetch(`${server.url}${AGENT_API_PREFIX}/pages/${dsPage.id}/versions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          files: checkout.files,
          message: "m",
          origin: "thread",
          baseVersionId: checkout.versionId,
          projectStyle: { content: tokensCss(), base: checkout.project.projectStyle },
          ...extra,
        }),
      });
    const refused = await publish({});
    expect(refused.status).toBe(400);
    expect(await error(refused)).toContain("--brand");
    expect((await publish({ confirmRemovals: true })).status).toBe(201);
  });
});
