import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentCheckout, type AgentTokenResponse, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let token: string;
let source: Page;
let target: Page;
let stranger: Page;

const html = "<h1>Hi</h1>";
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file) => ({ file })) });
const linkManifest = (link: object) => JSON.stringify({ artboards: [{ file: "home.html" }], links: [{ from: "home.html", selector: "#go", ...link }] });

beforeEach(async () => {
  server = await startTestServer();
  token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const other = (await (await server.post("/api/projects", { title: "Other" })).json()) as { id: string };
  const create = async (projectId: string, title: string, files: Record<string, string>) =>
    (await (await server.post(`/api/projects/${projectId}/pages`, { title, files })).json()) as Page;
  source = await create(project.id, "Flow", { "home.html": html, "manifest.json": manifestOf(["home.html"]) });
  target = await create(project.id, "Checkout", { "panier.html": html, "ancien.html": html, "manifest.json": manifestOf(["panier.html", "ancien.html"]) });
  stranger = await create(other.id, "Elsewhere", { "x.html": html, "manifest.json": manifestOf(["x.html"]) });
});
afterEach(async () => {
  await server.stop();
});

const viaApi = (files: Record<string, string>) => server.post(`/api/pages/${source.id}/versions`, { files, message: "m", origin: "thread" });

async function viaAgentApi(files: Record<string, string>) {
  const headers = { authorization: `Bearer ${token}` };
  const checkout = (await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${source.id}/files`, { headers })).json()) as AgentCheckout;
  return fetch(`${server.url}${AGENT_API_PREFIX}/pages/${source.id}/versions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ files, message: "m", origin: "thread", baseVersionId: checkout.versionId }),
  });
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

for (const [name, publish] of Object.entries({ "/api": viaApi, "/agent-api": viaAgentApi })) {
  const files = (link: object) => ({ "home.html": html, "manifest.json": linkManifest(link) });

  it(`${name}: accepts a play link to an artboard of another page of the project`, async () => {
    expect((await publish(files({ page: target.id, to: "panier.html" }))).status).toBe(201);
  });

  it(`${name}: refuses a play link to a page that is unknown or of another project, naming the entry`, async () => {
    for (const page of ["nope", stranger.id]) {
      const refused = await publish(files({ page, to: "x.html" }));
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toBe(`links[0] aims at page ${page}, which is not a page of this project`);
    }
  });

  it(`${name}: refuses a play link to an artboard missing from the target page, naming the entry`, async () => {
    const refused = await publish(files({ page: target.id, to: "nope.html" }));
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toBe(`links[0] aims at artboard "nope.html", which is not an artboard of page ${target.id}`);
  });

  it(`${name}: a target removed later does not fail an unrelated publish`, async () => {
    expect((await publish(files({ page: target.id, to: "ancien.html" }))).status).toBe(201);
    await server.post(`/api/pages/${target.id}/versions`, { files: { "panier.html": html, "manifest.json": manifestOf(["panier.html"]) }, message: "m", origin: "thread" });
    const unrelated = await publish({ "home.html": "<h1>Changed</h1>", "manifest.json": linkManifest({ page: target.id, to: "ancien.html" }) });
    expect(unrelated.status).toBe(201);
  });
}

it("keeps today's behaviour for a link without page", async () => {
  const res = await viaApi({ "home.html": html, "manifest.json": linkManifest({ to: "nope.html" }) });
  expect(res.status).toBe(201);
});
