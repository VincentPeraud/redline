import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import { AGENT_API_PREFIX, AGENT_ENDPOINT, PROTOCOL_VERSION, type AgentTokenResponse, type Page, type PageVersionSummary, type Project, type Thread, type WorkItem } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { admitSsoPeople } from "./sso-people.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const FILES = { "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0, width: 300, height: 200 }] }), "home.html": "<h1>Home</h1>" };
const sso = (id: string, name: string) => ({ [PROXY_SECRET_HEADER]: HUMAN, "remote-user": id, "remote-name": name, "remote-email": `${id}@example.com` });
const ariane = sso("amartin", "Ariane Martin");
const vincent = sso("vperaud", "Vincent Peraud");

let dataDir: string;
let server: RunningServer;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "redline-hand-over-"));
  server = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    firstAdminEmail: "vperaud@example.com",
    proxySecrets: { human: HUMAN, machine: MACHINE },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
  });
  await admitSsoPeople(server.url, [vincent, ariane]);
});
afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(server.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = async <T>(path: string, headers: Record<string, string>, body: unknown): Promise<T> => {
  const res = await send("POST", path, headers, body);
  expect(res.status).toBeLessThan(300);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};
const agentCall = async <T>(path: string, body: unknown): Promise<T> => {
  const { token } = (await (await send("GET", "/api/agent-token", vincent)).json()) as AgentTokenResponse;
  const res = await fetch(server.url + AGENT_API_PREFIX + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [PROXY_SECRET_HEADER]: MACHINE },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

async function connectAgent(projectId: string): Promise<{ work: () => Promise<WorkItem>; close: () => void }> {
  const { token } = (await (await send("GET", "/api/agent-token", vincent)).json()) as AgentTokenResponse;
  const socket = new WebSocket(server.url.replace(/^http/, "ws") + AGENT_ENDPOINT, { headers: { [PROXY_SECRET_HEADER]: MACHINE } });
  const items: WorkItem[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as { type: string; item?: WorkItem };
    if (message.type === "work" && message.item) items.push(message.item);
  });
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  socket.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "m", folder: "/f", kind: "project", projectId }));
  return {
    work: async () => {
      for (let i = 0; i < 100 && items.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(items).toHaveLength(1);
      return items[0];
    },
    close: () => socket.close(),
  };
}

async function heldPage(): Promise<{ page: Page; thread: Thread; baseVersionId: string }> {
  const project = await post<Project>("/api/projects", ariane, { title: "Acme" });
  const page = await post<Page>(`/api/projects/${project.id}/pages`, ariane, { title: "Home", files: FILES });
  await agentCall("/terminal-sessions/7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10/heartbeat", { folder: "/work", machine: "mac" });
  const published = await agentCall<PageVersionSummary>(`/pages/${page.id}/versions`, { files: { ...FILES, "home.html": "<h1>Terminal</h1>" }, message: "Terminal", origin: "terminal", baseVersionId: page.version.id, terminalSessionId: "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10" });
  const thread = await post<Thread>(`/api/pages/${page.id}/threads`, ariane, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body: "Bigger" });
  return { page, thread, baseVersionId: published.id };
}

const publishFrom = (page: Page, item: WorkItem, baseVersionId: string) =>
  agentCall<PageVersionSummary>(`/pages/${page.id}/versions`, { files: { ...FILES, "home.html": "<h1>Bigger</h1>" }, message: "Change", origin: "thread", workId: item.id, baseVersionId });

it("signs the run of a handed-over thread with the person who clicked", async () => {
  const { page, thread, baseVersionId } = await heldPage();
  const agent = await connectAgent(page.projectId);
  await post(`/api/threads/${thread.id}/hand-over`, vincent, {});
  const item = await agent.work();
  expect((await publishFrom(page, item, baseVersionId)).person?.id).toBe("vperaud");
  agent.close();
});

it("signs the run of a released page with the person who clicked", async () => {
  const { page, baseVersionId } = await heldPage();
  const agent = await connectAgent(page.projectId);
  await post(`/api/pages/${page.id}/terminal-release`, vincent, {});
  const item = await agent.work();
  expect((await publishFrom(page, item, baseVersionId)).person?.id).toBe("vperaud");
  agent.close();
});
