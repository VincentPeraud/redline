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
const cardManifest = (file: string) =>
  JSON.stringify({ artboards: [{ file: "home.html" }], elements: [{ kind: "link", id: "carte", page: target.id, file, x: 0, y: 400 }] });

beforeEach(async () => {
  server = await startTestServer();
  token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const create = async (title: string, files: Record<string, string>) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title, files })).json()) as Page;
  source = await create("Flow", { "home.html": html, "manifest.json": manifestOf(["home.html"]) });
  const other = (await (await server.post("/api/projects", { title: "Other" })).json()) as { id: string };
  stranger = (await (await server.post(`/api/projects/${other.id}/pages`, { title: "Elsewhere", files: { "x.html": html, "manifest.json": manifestOf(["x.html"]) } })).json()) as Page;
  target = await create("Checkout", { "panier.html": html, "ancien.html": html, "manifest.json": manifestOf(["panier.html", "ancien.html"]) });
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

const pageCardManifest = (card: object) => JSON.stringify({ artboards: [{ file: "home.html" }], elements: [{ kind: "link", id: "carte", x: 0, y: 400, ...card }] });

const publishers = { "/api": viaApi, "/agent-api": viaAgentApi };

for (const [name, publish] of Object.entries(publishers)) {
  it(`${name}: accepts a card aimed at an artboard of the target page and refuses an unknown one, naming the entry`, async () => {
    const files = (file: string) => ({ "home.html": html, "manifest.json": cardManifest(file) });
    expect((await publish(files("panier.html"))).status).toBe(201);

    const refused = await publish(files("nope.html"));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(`elements[0] (link) aims at artboard "nope.html", which is not an artboard of page ${target.id}`);
  });

  it(`${name}: a target artboard removed later does not fail an unrelated publish`, async () => {
    expect((await publish({ "home.html": html, "manifest.json": cardManifest("ancien.html") })).status).toBe(201);
    await server.post(`/api/pages/${target.id}/versions`, { files: { "panier.html": html, "manifest.json": manifestOf(["panier.html"]) }, message: "m", origin: "thread" });

    const unrelated = await publish({ "home.html": "<h1>Changed</h1>", "manifest.json": cardManifest("ancien.html") });
    expect(unrelated.status).toBe(201);
  });

  it(`${name}: refuses a card aimed at a page that is unknown or of another project, with or without file`, async () => {
    for (const card of [(page: string) => ({ page }), (page: string) => ({ page, file: "x.html" })]) {
      for (const page of ["nope", stranger.id]) {
        const refused = await publish({ "home.html": html, "manifest.json": pageCardManifest(card(page)) });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toBe(`elements[0] (link) aims at page ${page}, which is not a page of this project`);
      }
    }
  });

  it(`${name}: accepts a card aimed at a page of the project without file`, async () => {
    expect((await publish({ "home.html": html, "manifest.json": pageCardManifest({ page: target.id }) })).status).toBe(201);
  });
}
