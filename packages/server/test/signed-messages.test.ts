import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Conversation, ConversationDetail, Page, Project, Thread, ThreadReply } from "@redline/shared";
import { PROXY_SECRET_HEADER } from "../src/proxy-secrets.js";
import { startServer, type RunningServer } from "../src/start.js";
import { admitSsoPeople } from "./sso-people.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
const FILES = { "home.html": "<h1>Home</h1>" };

const ariane = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };
const vincent = { [PROXY_SECRET_HEADER]: HUMAN, "remote-user": "vperaud", "remote-name": "Vincent Peraud", "remote-email": "vincent@example.com" };

describe("signed thread and conversation messages", () => {
  let dataDir: string;
  let server: RunningServer;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-signed-"));
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
  const post = async <T>(path: string, headers: Record<string, string>, body: unknown): Promise<T> => (await send("POST", path, headers, body)).json() as Promise<T>;
  const get = async <T>(path: string): Promise<T> => (await send("GET", path, vincent)).json() as Promise<T>;

  async function createPage(): Promise<Page> {
    const project = await post<Project>("/api/projects", vincent, { title: "Acme" });
    return post<Page>(`/api/projects/${project.id}/pages`, vincent, { title: "Home", files: FILES });
  }
  const comment = (page: Page, headers: Record<string, string>, body: string, held = false) =>
    post<Thread>(`/api/pages/${page.id}/threads`, headers, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body, held });

  it("returns the author of a thread's comment and of each reply, nothing for Claude's answers", async () => {
    const page = await createPage();
    const thread = await comment(page, ariane, "Make the button bigger");
    expect(thread.person).toMatchObject({ id: "amartin", name: "Ariane Martin", initials: "AM" });
    await post<ThreadReply>(`/api/threads/${thread.id}/messages`, vincent, { body: "Keep the outline on hover" });
    const [stored] = await get<Thread[]>(`/api/pages/${page.id}/threads`);
    expect(stored.person?.id).toBe("amartin");
    expect(stored.replies.map((r) => r.person?.id)).toEqual(["vperaud"]);
  });

  it("returns the author of a held comment", async () => {
    const page = await createPage();
    await comment(page, ariane, "Shorten the title", true);
    const held = await get<Thread[]>(`/api/pages/${page.id}/held`);
    expect(held).toHaveLength(1);
    expect(held[0].person).toMatchObject({ id: "amartin", name: "Ariane Martin" });
  });

  it("returns who started a conversation and who wrote each of its messages", async () => {
    const page = await createPage();
    const conversation = await post<ConversationDetail>(`/api/pages/${page.id}/conversations`, ariane, { title: "Error pages" });
    expect(conversation.startedBy).toMatchObject({ id: "amartin" });
    await post(`/api/conversations/${conversation.id}/messages`, ariane, { body: "Create the error pages" });
    await post(`/api/conversations/${conversation.id}/messages`, vincent, { body: "Add a denied page" });
    const detail = await get<ConversationDetail>(`/api/conversations/${conversation.id}`);
    expect(detail.messages.map((m) => m.person?.id)).toEqual(["amartin", "vperaud"]);
    const [listed] = await get<Conversation[]>(`/api/pages/${page.id}/conversations`);
    expect(listed.startedBy?.id).toBe("amartin");
  });

  it("shows the authors in the Sessions panel", async () => {
    const page = await createPage();
    const thread = await comment(page, ariane, "Make the button bigger");
    const detail = await get<{ messages: { person?: { id: string } }[] }>(`/api/sessions/${thread.id}`);
    expect(detail.messages.map((m) => m.person?.id)).toEqual(["amartin"]);
  });
});
