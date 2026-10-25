import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type AgentTokenResponse, type ConversationDetail, type DesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startAgent } from "../src/agent.js";
import type { AgentConnection } from "../src/connection.js";
import { FakeEngine, type FakeAction } from "./support/fake-engine.js";

const tokens = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;

let server: TestServer | undefined;
let agent: AgentConnection | undefined;
let folder: string | undefined;
afterEach(async () => {
  agent?.close();
  await server?.stop();
  if (folder) rmSync(folder, { recursive: true, force: true });
  server = agent = folder = undefined;
});

/** A design system, a global agent running `script`, and one conversation answered on the design system's page (or on a project page). */
async function answeredConversation(script: FakeAction[], onProjectPage = false): Promise<{ ds: DesignSystem; detail: ConversationDetail }> {
  server = await startTestServer();
  const engine = new FakeEngine(script);
  folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  agent = await startAgent({ serverUrl: server.url, token, machine: "test-machine", folder, kind: "global", engine });
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokens("#111111"), "manifest.json": JSON.stringify({ artboards: [] }) } })).json()) as DesignSystem;
  let pageId = ds.pageId;
  if (onProjectPage) {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }) } })).json()) as { id: string };
    pageId = page.id;
  }
  const conversation = (await (await server.post(`/api/pages/${pageId}/conversations`, {})).json()) as ConversationDetail;
  await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Do it" });
  await engine.finished(1);
  const edits = script.some((action) => "edit" in action);
  await expect
    .poll(async () => ((await (await server!.get(`/api/pages/${pageId}/versions`)).json()) as unknown[]).length, { timeout: 8000 })
    .toBeGreaterThanOrEqual(edits ? 2 : 1);
  await expect.poll(async () => ((await (await server!.get(`/api/conversations/${conversation.id}`)).json()) as ConversationDetail).messages.length).toBe(2);
  return { ds, detail: (await (await server.get(`/api/conversations/${conversation.id}`)).json()) as ConversationDetail };
}

describe("the answer that changed a design system", () => {
  it("names the design system on Claude's answer when its run published a version of a design system page", async () => {
    const { ds, detail } = await answeredConversation([{ edit: { path: "tokens.css", content: tokens("#222222") } }, { type: "result", summary: "Changed the primary colour" }]);
    expect(detail.messages.map((m) => [m.author, m.designSystemId])).toEqual([
      ["user", undefined],
      ["claude", ds.id],
    ]);
  });

  it("does not when the run changed nothing", async () => {
    const { detail } = await answeredConversation([{ type: "result", summary: "Nothing to change" }]);
    expect(detail.messages.map((m) => m.designSystemId)).toEqual([undefined, undefined]);
  });

  it("does not on the page of a project", async () => {
    const { detail } = await answeredConversation([{ edit: { path: "home.html", content: "<h1>New</h1>" } }, { type: "result", summary: "Edited" }], true);
    expect(detail.messages.map((m) => m.designSystemId)).toEqual([undefined, undefined]);
  });
});
