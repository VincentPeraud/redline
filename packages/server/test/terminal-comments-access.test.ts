import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type Page, type Project, type TerminalCommentsPage } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { admitSsoPeople } from "./sso-people.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const SESSION = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
const FILES = { "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0, width: 300, height: 200 }] }), "home.html": "<h1>Home</h1>" };
const sso = (id: string, name: string) => ({ [PROXY_SECRET_HEADER]: HUMAN, "remote-user": id, "remote-name": name, "remote-email": `${id}@example.com` });
const vincent = sso("vperaud", "Vincent Peraud");
const ariane = sso("amartin", "Ariane Martin");
const thomas = sso("tlefevre", "Thomas Lefevre");

let dataDir: string;
let server: RunningServer;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "redline-terminal-comments-"));
  server = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    firstAdminEmail: "vperaud@example.com",
    proxySecrets: { human: HUMAN, machine: MACHINE },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
  });
  await admitSsoPeople(server.url, [vincent, ariane, thomas]);
});
afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const human = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(server.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = async (who: Record<string, string>, method: string, path: string, body?: unknown) => {
  const { token } = (await (await human("GET", "/api/agent-token", who)).json()) as AgentTokenResponse;
  return fetch(server.url + AGENT_API_PREFIX + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [PROXY_SECRET_HEADER]: MACHINE }, body: body === undefined ? undefined : JSON.stringify(body) });
};

it("lists the waiting comments of the projects the token's account can read, and no others", async () => {
  const project = (await (await human("POST", "/api/projects", ariane, { title: "Acme", visibility: "private" })).json()) as Project;
  const page = (await (await human("POST", `/api/projects/${project.id}/pages`, ariane, { title: "Home", files: FILES })).json()) as Page;
  await agent(ariane, "POST", `/terminal-sessions/${SESSION}/heartbeat`, { folder: "/work", machine: "mac" });
  const published = await agent(ariane, "POST", `/pages/${page.id}/versions`, { files: { ...FILES, "home.html": "<h1>Terminal</h1>" }, message: "Terminal", origin: "terminal", baseVersionId: page.version.id, terminalSessionId: SESSION });
  expect(published.status).toBeLessThan(300);
  await human("POST", `/api/pages/${page.id}/threads`, ariane, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body: "Bigger" });

  const asOwner = (await (await agent(ariane, "GET", "/terminal-comments")).json()) as TerminalCommentsPage[];
  expect(asOwner.map((p) => p.pageId)).toEqual([page.id]);

  const asOutsider = (await (await agent(thomas, "GET", "/terminal-comments")).json()) as TerminalCommentsPage[];
  expect(asOutsider).toEqual([]);
});
