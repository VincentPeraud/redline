import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AGENT_API_PREFIX,
  AGENT_ENDPOINT,
  PROTOCOL_VERSION,
  type AgentTokenResponse,
  type ArtboardVersion,
  type ConversationDetail,
  type DeletedArtboard,
  type DesignMdInfo,
  type Page,
  type PageVersionSummary,
  type Project,
  type Thread,
  type WorkItem,
} from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { admitSsoPeople } from "./sso-people.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const MANIFEST = JSON.stringify({
  artboards: [
    { file: "home.html", x: 0, y: 0, width: 300, height: 200 },
    { file: "about.html", x: 400, y: 0, width: 300, height: 200 },
  ],
  tweaks: [{ id: "accent", type: "color", label: "Accent", default: "#e5484d" }],
});
const FILES = { "manifest.json": MANIFEST, "home.html": "<h1>Home</h1>", "about.html": "<h1>About</h1>" };
const ONLY_HOME = JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0, width: 300, height: 200 }] });

const ariane = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };
const vincent = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "vperaud", "remote-name": "Vincent Peraud", "remote-email": "vincent@example.com" };

describe("signed history, DESIGN.md, pages and deleted artboards", () => {
  let dataDir: string;
  let server: RunningServer;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-signed-history-"));
    server = await startServer({
      dataDir,
      port: 0,
      artboardPort: 0,
      host: "127.0.0.1",
      firstAdminEmail: "vincent@example.com",
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
    return res.json() as Promise<T>;
  };
  const get = async <T>(path: string): Promise<T> => (await send("GET", path, vincent)).json() as Promise<T>;

  async function createPage(headers: Record<string, string> = ariane): Promise<Page> {
    const project = await post<Project>("/api/projects", headers, { title: "Acme" });
    return post<Page>(`/api/projects/${project.id}/pages`, headers, { title: "Home", files: FILES });
  }
  const versions = (page: Page) => get<PageVersionSummary[]>(`/api/pages/${page.id}/versions`);

  it("signs a page and its creation version with the person who created it", async () => {
    const page = await createPage(ariane);
    expect(page.createdByPerson).toMatchObject({ id: "amartin", name: "Ariane Martin" });
    const [creation] = await versions(page);
    expect(creation).toMatchObject({ origin: "creation", person: { id: "amartin" } });
  });

  it("signs tweaks, manual versions and restorations with the person who made them", async () => {
    const page = await createPage(ariane);
    await post(`/api/pages/${page.id}/tweaks`, vincent, { id: "accent", value: "#0f766e" });
    await post(`/api/pages/${page.id}/versions`, ariane, { files: { ...FILES, "home.html": "<h1>Edited</h1>" }, message: "By hand", origin: "user" });
    const [creation] = (await versions(page)).slice(-1);
    await post(`/api/pages/${page.id}/versions/${creation.id}/restore`, vincent, {});
    const byOrigin = Object.fromEntries((await versions(page)).map((v) => [v.origin, v.person?.id]));
    expect(byOrigin).toEqual({ tweak: "vperaud", user: "amartin", restore: "vperaud", creation: "amartin" });
  });

  it("signs the artboard history and the artboards a person deleted or put back", async () => {
    const page = await createPage(ariane);
    const files = { "manifest.json": ONLY_HOME, "home.html": "<h1>Home</h1>" };
    await post(`/api/pages/${page.id}/versions`, vincent, { files, message: "Removed About", origin: "user" });

    const [gone] = await get<DeletedArtboard[]>(`/api/pages/${page.id}/deleted-artboards`);
    expect(gone).toMatchObject({ file: "about.html", deletedBy: "user", person: { id: "vperaud" } });

    const restored = await post<{ version: PageVersionSummary }>(`/api/pages/${page.id}/artboards/restore`, vincent, { file: "about.html", versionId: gone.lastVersionId });
    expect(restored.version.person?.id).toBe("vperaud");
    const history = await get<ArtboardVersion[]>(`/api/pages/${page.id}/artboard-versions?file=about.html`);
    expect(history.map((v) => v.person?.id)).toEqual(["vperaud", "amartin"]);
  });

  it("signs DESIGN.md versions and rules with the person who saved them", async () => {
    const page = await createPage(ariane);
    const url = `/api/projects/${page.projectId}/design-md`;
    expect((await send("PUT", url, ariane, { content: "- Buttons are round" })).status).toBe(200);
    expect((await send("PUT", url, vincent, { content: "- Buttons are round\n- Titles are bold" })).status).toBe(200);
    const info = await get<DesignMdInfo>(`${url}/info`);
    expect(info.lastModified?.person?.id).toBe("vperaud");
    expect(info.rules.map((r) => [r.text, r.person?.id])).toEqual([
      ["- Buttons are round", "amartin"],
      ["- Titles are bold", "vperaud"],
    ]);
  });

  describe("Claude runs and terminal publishes", () => {
    async function connectAgent(projectId: string): Promise<{ work: (index?: number) => Promise<WorkItem>; done: (workId: string) => void; close: () => void }> {
      const { token } = await get<AgentTokenResponse>("/api/agent-token");
      const socket = new WebSocket(server.url.replace(/^http/, "ws") + AGENT_ENDPOINT, { headers: { [PROXY_SECRET_HEADER]: MACHINE } });
      const items: WorkItem[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as { type: string; item?: WorkItem };
        if (message.type === "work" && message.item) items.push(message.item);
      });
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      socket.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "m", folder: "/f", kind: "project", projectId }));
      return {
        work: async (index = 0) => {
          for (let i = 0; i < 100 && items.length <= index; i++) await new Promise((resolve) => setTimeout(resolve, 20));
          expect(items).toHaveLength(index + 1);
          return items[index];
        },
        done: (workId) => socket.send(JSON.stringify({ type: "work-done", workId })),
        close: () => socket.close(),
      };
    }
    const agentCall = async <T>(path: string, body: unknown): Promise<T> => {
      const { token } = await get<AgentTokenResponse>("/api/agent-token");
      const res = await fetch(server.url + AGENT_API_PREFIX + path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [PROXY_SECRET_HEADER]: MACHINE },
        body: JSON.stringify(body),
      });
      expect(res.status).toBeLessThan(300);
      return res.json() as Promise<T>;
    };

    it("signs what a thread run publishes with the person who asked, deletions and DESIGN.md included", async () => {
      const page = await createPage(vincent);
      const agent = await connectAgent(page.projectId);
      const thread = await post<Thread>(`/api/pages/${page.id}/threads`, ariane, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body: "Drop the about page" });
      const item = await agent.work();
      const version = await agentCall<PageVersionSummary>(`/pages/${page.id}/versions`, {
        files: { "manifest.json": ONLY_HOME, "home.html": "<h1>Home</h1>" },
        message: "Dropped About",
        origin: "thread",
        baseVersionId: page.version.id,
        workId: item.id,
        confirmRemovals: true,
        designMd: { content: "- Keep pages short", base: "" },
      });
      expect(version.person?.id).toBe("amartin");
      const [gone] = await get<DeletedArtboard[]>(`/api/pages/${page.id}/deleted-artboards`);
      expect(gone).toMatchObject({ file: "about.html", deletedBy: "claude", originId: thread.id, person: { id: "amartin" } });
      const info = await get<DesignMdInfo>(`/api/projects/${page.projectId}/design-md/info`);
      expect(info.lastModified).toMatchObject({ origin: "thread", person: { id: "amartin" } });
      expect(info.rules[0].person?.id).toBe("amartin");

      const sibling = await agentCall<Page>(`/pages/${page.id}/siblings`, { title: "Pricing", workId: item.id });
      expect(sibling).toMatchObject({ createdBy: "claude", createdByPerson: { id: "amartin" } });
      agent.close();
    });

    const publish = (page: Page, item: WorkItem, origin: "thread" | "conversation", baseVersionId = page.version.id) =>
      agentCall<PageVersionSummary>(`/pages/${page.id}/versions`, {
        files: { ...FILES, "home.html": `<h1>${item.id}</h1>` },
        message: "Change",
        origin,
        baseVersionId,
        workId: item.id,
      });

    it("signs a run with the person whose message started it, even when someone replies while it runs", async () => {
      const page = await createPage(vincent);
      const agent = await connectAgent(page.projectId);
      const thread = await post<Thread>(`/api/pages/${page.id}/threads`, ariane, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body: "Make it bigger" });
      const first = await agent.work();
      await post(`/api/threads/${thread.id}/messages`, vincent, { body: "Also bolder" });
      const firstVersion = await publish(page, first, "thread");
      expect(firstVersion.person?.id).toBe("amartin");

      agent.done(first.id);
      const second = await agent.work(1);
      expect((await publish(page, second, "thread", firstVersion.id)).person?.id).toBe("vperaud");
      agent.close();
    });

    it("signs a conversation run with the person whose message started it", async () => {
      const page = await createPage(vincent);
      const agent = await connectAgent(page.projectId);
      const conversation = await post<ConversationDetail>(`/api/pages/${page.id}/conversations`, ariane, { title: "Error pages" });
      await post(`/api/conversations/${conversation.id}/messages`, ariane, { body: "Create the error pages" });
      const first = await agent.work();
      await post(`/api/conversations/${conversation.id}/messages`, vincent, { body: "Add a denied page" });
      expect((await publish(page, first, "conversation")).person?.id).toBe("amartin");
      agent.close();
    });

    it("records no person for a terminal publish", async () => {
      const page = await createPage(vincent);
      const version = await agentCall<PageVersionSummary>(`/pages/${page.id}/versions`, {
        files: { ...FILES, "home.html": "<h1>From the terminal</h1>" },
        message: "Terminal change",
        origin: "terminal",
        baseVersionId: page.version.id,
        designMd: { content: "- From the terminal", base: "" },
      });
      expect(version.person).toBeUndefined();
      const info = await get<DesignMdInfo>(`/api/projects/${page.projectId}/design-md/info`);
      expect(info.lastModified).toMatchObject({ origin: "terminal" });
      expect(info.lastModified?.person).toBeUndefined();
      const sibling = await agentCall<Page>(`/pages/${page.id}/siblings`, { title: "Pricing" });
      expect(sibling.createdByPerson).toBeUndefined();
    });
  });
});
