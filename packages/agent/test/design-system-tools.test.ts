import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CORE_TOKENS, type AgentTokenResponse, type DesignSystemSummary, type Project } from "@redline/shared";
import { ServerApi } from "../src/server-api.js";
import { createTerminalMcpServer } from "../src/terminal-mcp.js";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

let seam: Seam2 | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await seam?.stop();
  seam = undefined;
  client = undefined;
});

async function connectTerminal(folder: string): Promise<(name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>> {
  const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const server = createTerminalMcpServer({ api: new ServerApi(seam!.server.url, token), folder });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "terminal-claude", version: "0.0.0" });
  await client.connect(clientSide);
  return async (name, args) => {
    const result = await client!.callTool({ name, arguments: args });
    return { text: ((result.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n"), isError: result.isError === true };
  };
}

const designSystems = async () => (await (await seam!.server.get("/api/design-systems")).json()) as DesignSystemSummary[];
const projectOf = async (id: string) => ((await (await seam!.server.get("/api/projects")).json()) as Project[]).find((p) => p.id === id)!;

describe("terminal design system tools", () => {
  it("lists the design systems with their pages", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await seam.server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111;`).join("\n")}\n}\n`, "index.html": "<!doctype html><html><head></head><body></body></html>" } });
    const { text } = await call("list_design_systems", {});
    const listed = await designSystems();
    expect(listed).toHaveLength(1);
    expect(text).toContain(`id ${listed[0].id}`);
    expect(text).toContain(listed[0].title);
    expect(text).toContain(`page ${listed[0].pageId}`);
    expect(text).not.toContain("neutral");
  });

  it("creates a design system, answers with its page id, and the page can be checked out and published", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    const created = await call("create_design_system", { title: "Lumora" });
    expect(created.isError).toBe(false);
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;
    expect(created.text).toContain(`id ${ds.id}`);
    expect(created.text).toContain(`page ${ds.pageId}`);

    const checkout = await call("checkout_page", { pageId: ds.pageId });
    expect(checkout.text).toContain("Lumora");
    const copy = join(seam.folder, ".redline", ds.pageId);
    expect(existsSync(join(copy, ".design-system"))).toBe(false);
    const tokens = readFileSync(join(copy, "tokens.css"), "utf8");
    expect(tokens).toContain("--color-primary");
    writeFileSync(join(copy, "tokens.css"), tokens.replace(/(--color-primary:\s*)[^;]+/, "$1#ff6600"));
    writeFileSync(join(copy, "DESIGN.md"), "# Lumora rules\n");
    const published = await call("publish_page", { message: "Brand colour" });
    expect(published.text).toMatch(/Published version/);
    const served = ((await (await seam.server.get(`/api/design-systems/${ds.id}/tokens`)).json()) as { content: string }).content;
    expect(served).toContain("#ff6600");
    for (const token of CORE_TOKENS) expect(served).toContain(token);
  });

  it("refuses an empty title when creating a design system", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    expect((await call("create_design_system", { title: "  " })).isError).toBe(true);
  });

  it("sets a project's design system, then back to none", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await call("create_design_system", { title: "Lumora" });
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;
    const projectId = seam.project.id;

    const set = await call("set_project_design_system", { projectId, designSystem: ds.id });
    expect(set.isError).toBe(false);
    expect((await projectOf(projectId)).designSystem).toBe(ds.id);
    expect((await designSystems()).find((d) => d.id === ds.id)!.usedBy.map((p) => p.id)).toContain(projectId);

    const none = await call("set_project_design_system", { projectId, designSystem: null });
    expect(none.isError).toBe(false);
    expect((await projectOf(projectId)).designSystem).toBeNull();
  });

  it("switches the pages of the project with it, so they render with the new design system", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await call("create_design_system", { title: "Lumora" });
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;
    const page = await seam.createPage({ "index.html": "<p>x</p>", "manifest.json": JSON.stringify({ artboards: [{ file: "index.html" }] }) });

    await call("set_project_design_system", { projectId: seam.project.id, designSystem: ds.id });
    expect(JSON.parse(await seam.readFile(page.id, "manifest.json")).designSystem).toBe(ds.id);

    await call("set_project_design_system", { projectId: seam.project.id, designSystem: null });
    expect(JSON.parse(await seam.readFile(page.id, "manifest.json")).designSystem).toBeUndefined();
  });

  it("leaving a shared design system for none keeps its values, with or without startFrom, and the tool never mentions startFrom", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await call("create_design_system", { title: "Lumora" });
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;
    const radius = async () => {
      const detail = (await (await seam!.server.get(`/api/projects/${seam!.project.id}/design-system`)).json()) as { tokens: { name: string; value: string }[] };
      return detail.tokens.find((t) => t.name === "--radius")?.value;
    };
    await call("set_project_design_system", { projectId: seam.project.id, designSystem: ds.id });
    const shared = await radius();
    await call("set_project_design_system", { projectId: seam.project.id, designSystem: null });
    expect(await radius()).toBe(shared);
    await call("set_project_design_system", { projectId: seam.project.id, designSystem: ds.id });
    expect((await call("set_project_design_system", { projectId: seam.project.id, designSystem: null, startFrom: "neutral" })).isError).toBe(false);
    expect(await radius()).toBe(shared);
    const tool = (await client!.listTools()).tools.find((t) => t.name === "set_project_design_system")!;
    expect(JSON.stringify(tool)).not.toContain("startFrom");
  });

  it("refuses an unknown design system or project", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    expect((await call("set_project_design_system", { projectId: seam.project.id, designSystem: "nope" })).isError).toBe(true);
    expect((await call("set_project_design_system", { projectId: "nope", designSystem: null })).isError).toBe(true);
  });
});

describe("terminal project tools", () => {
  it("renames a project and a design system, with their links", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await call("create_design_system", { title: "Lumora" });
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;

    const project = await call("rename_project", { projectId: seam.project.id, title: "Radio HAIDF v2" });
    expect(project.isError).toBe(false);
    expect(project.text).toContain(`#/projects/${seam.project.id}`);
    expect((await projectOf(seam.project.id)).title).toBe("Radio HAIDF v2");

    const renamed = await call("rename_project", { projectId: ds.id, title: "Lumora v2" });
    expect(renamed.text).toContain(`#/design-systems/${ds.id}`);
    expect((await designSystems()).find((d) => d.id === ds.id)!.title).toBe("Lumora v2");

    expect((await call("rename_project", { projectId: "nope", title: "X" })).isError).toBe(true);
  });

  it("archives a project, and explains why a followed design system is refused", async () => {
    seam = await startSeam2(new FakeEngine([]));
    const call = await connectTerminal(seam.folder);
    await call("create_design_system", { title: "Lumora" });
    const ds = (await designSystems()).find((d) => d.title === "Lumora")!;
    const follower = (await (await seam.server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as Project;

    const followed = await call("archive_project", { projectId: ds.id });
    expect(followed.isError).toBe(true);
    expect(followed.text).toContain("Halloween");

    const archived = await call("archive_project", { projectId: follower.id });
    expect(archived.isError).toBe(false);
    expect(await projectOf(follower.id)).toBeUndefined();
    expect((await call("rename_project", { projectId: follower.id, title: "Back" })).text).toMatch(/archived/);
  });
});
