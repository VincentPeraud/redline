import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type DesignSystemDetail } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

describe("who sees the design system draft", () => {
  let server: TestServer;
  let token: string;
  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  });
  afterEach(async () => {
    await server.stop();
  });

  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const designSystem = async () => (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss } })).json()) as DesignSystem;
  const project = async (ds: DesignSystem, title: string) => ((await (await server.post("/api/projects", { title, designSystem: ds.id })).json()) as { id: string }).id;
  const detail = async (ds: DesignSystem) => (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
  const checkout = async (ds: DesignSystem) =>
    ((await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${ds.pageId}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout).project;

  it("flags on the design system overview the projects that follow the draft", async () => {
    const ds = await designSystem();
    const app = await project(ds, "App");
    await project(ds, "Site");
    expect((await detail(ds)).usedBy.map((user) => user.followsDraft)).toEqual([false, false]);
    await put(`/api/projects/${app}/design-system`, { followsDraft: true });
    expect((await detail(ds)).usedBy.map((user) => [user.title, user.followsDraft])).toEqual([["App", true], ["Site", false]]);
  });

  it("tells a design system session which projects see its draft right away", async () => {
    const ds = await designSystem();
    const app = await project(ds, "App");
    await project(ds, "Site");
    expect((await checkout(ds)).editsDesignSystem?.followedBy).toEqual([]);
    await put(`/api/projects/${app}/design-system`, { followsDraft: true });
    expect((await checkout(ds)).editsDesignSystem?.followedBy).toEqual([{ id: app, title: "App" }]);
  });
});
