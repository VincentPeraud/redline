import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { instanceLine } from "../src/installations.js";
import { liveSessions } from "../src/mcp-sessions.js";
import { launchMcp, type McpHandOver } from "../src/mcp-launcher.js";
import { addInstallation, fakeWorld, folderWithLink, tempDir } from "./support/installations.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "claude", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content).map((c) => c.text).join("\n");

/** The launcher on a computer with three instances; the hand-over is recorded instead of serving stdio. */
function computer() {
  const configDir = tempDir();
  const world = fakeWorld();
  world.servers.set("https://redline.localhost", { instanceName: "Local", version: "0.3.0" });
  world.servers.set("https://redline.lumora.com", { instanceName: "Lumora", version: "0.2.0" });
  addInstallation(configDir, { name: "Local", serverUrl: "https://redline.localhost", version: "0.3.0" });
  addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0" });
  addInstallation(configDir, { name: "Brightco", serverUrl: "https://redline.brightco.fr", version: "0.1.0" });
  const handedOver: McpHandOver[] = [];
  const launch = (folder: string, handOver: (to: McpHandOver) => Promise<unknown> = async (to) => void handedOver.push(to)) =>
    launchMcp({ configDir, folder, home: "/home/me", fetchInstance: world.deps.fetchInstance, handOver });
  return { configDir, world, handedOver, launch };
}

describe("the MCP launcher", () => {
  it("records the session of the installation while it is served, and forgets it afterwards", async () => {
    const { configDir, launch } = computer();
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] });
    const lumora = join(configDir, "instances", "lumora");
    let during: unknown;
    await launch(folder, async () => void (during = liveSessions(lumora)));
    expect(during).toEqual([{ pid: process.pid, folder }]);
    expect(liveSessions(lumora)).toEqual([]);
    expect(liveSessions(join(configDir, "instances", "local"))).toEqual([]);
  });

  it("serves only setup_needed in a folder linked to nothing when several instances are installed", async () => {
    const { launch, handedOver } = computer();
    const folder = join("/home/me", "Downloads");
    const server = await launch(folder);
    const claude = await connect(server!);
    expect((await claude.listTools()).tools.map((tool) => tool.name)).toEqual(["setup_needed"]);
    expect(text(await claude.callTool({ name: "setup_needed", arguments: {} }))).toBe(
      [
        "This folder (~/Downloads) is linked to no Redline instance, and this computer has three:",
        "Brightco (redline.brightco.fr), Local (redline.localhost), Lumora (redline.lumora.com).",
        "Ask the user which one, to run `redline link <instance>` in this folder, then /mcp and reconnect redline.",
      ].join("\n"),
    );
    expect(handedOver).toEqual([]);
  });

  it("names the missing address when the folder is linked to one that is not installed here", async () => {
    const { launch } = computer();
    const claude = await connect((await launch(folderWithLink({ serverUrl: "https://redline.tda.fr", projectIds: ["p"] })))!);
    expect(text(await claude.callTool({ name: "setup_needed", arguments: {} }))).toBe(
      [
        "This folder's link file (.redline/project.json) names redline.tda.fr, which is not installed on this computer.",
        "That address comes from the folder, not from the user's setup: check it with the user before installing anything.",
        "Tell the user to run `redline setup https://redline.tda.fr` (or `redline link <instance>` for another one),",
        "then /mcp and reconnect redline.",
      ].join("\n"),
    );
  });

  it("hands over to the linked installation's own MCP entry point, with its login, folder and instance line", async () => {
    const { launch, handedOver } = computer();
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p"] });
    expect(await launch(folder)).toBeUndefined();
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]).toMatchObject({ folder, serverUrl: "https://redline.lumora.com", token: "abt_t", instance: { name: "Lumora", address: "redline.lumora.com", version: "0.2.0" } });
    expect(handedOver[0].entry).toMatch(/instances[\\/]lumora[\\/]npm[\\/].*installation-mcp\.js$/);
  });

  it("follows the server's instance name unless the name was chosen", async () => {
    const { launch, handedOver, world, configDir } = computer();
    world.servers.set("https://redline.lumora.com", { instanceName: "Lumora Group", version: "0.2.0" });
    await launch(folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] }));
    expect(handedOver[0].instance.name).toBe("Lumora Group");
    addInstallation(configDir, { name: "Mine", serverUrl: "https://redline.mine.fr", nameChosen: true });
    world.servers.set("https://redline.mine.fr", { instanceName: "Theirs", version: "0.2.0" });
    await launch(folderWithLink({ serverUrl: "https://redline.mine.fr", projectIds: [] }));
    expect(handedOver[1].instance.name).toBe("Mine");
  });

  it("keeps the stored name when the server cannot be asked", async () => {
    const { launch, handedOver, world } = computer();
    world.servers.delete("https://redline.lumora.com");
    await launch(folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] }));
    expect(handedOver[0].instance.name).toBe("Lumora");
  });

  it("works as before on a computer with a single instance, with no link", async () => {
    const configDir = tempDir();
    addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com" });
    const handedOver: McpHandOver[] = [];
    await launchMcp({ configDir, folder: tempDir(), home: "/home/me", fetchInstance: async () => ({}), handOver: async (to) => void handedOver.push(to) });
    expect(handedOver[0]).toMatchObject({ serverUrl: "https://redline.lumora.com" });
  });

  it("serves a setup message naming the update when the installation has no hand-over entry point", async () => {
    const { launch } = computer();
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] });
    const claude = await connect((await launch(folder, async (to) => Promise.reject(Object.assign(new Error(`Cannot find module '${to.entry}' imported from /x`), { code: "ERR_MODULE_NOT_FOUND" }))))!);
    expect(text(await claude.callTool({ name: "setup_needed", arguments: {} }))).toContain("redline update https://redline.lumora.com");
  });

  it("names the installation and the real error when its MCP fails for another reason, without asking for an update", async () => {
    const { launch } = computer();
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] });
    const claude = await connect((await launch(folder, async () => Promise.reject(new Error("EACCES: permission denied"))))!);
    const message = text(await claude.callTool({ name: "setup_needed", arguments: {} }));
    expect(message).toContain("Lumora");
    expect(message).toContain("EACCES: permission denied");
    expect(message).not.toContain("redline update");
  });

  it("passes its own config directory to the installation's MCP", async () => {
    const { launch, handedOver, configDir } = computer();
    await launch(folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: [] }));
    expect(handedOver[0].configDir).toBe(configDir);
  });

  it("says no instance is set up on a computer with none", async () => {
    const claude = await connect(
      (await launchMcp({ configDir: tempDir(), folder: tempDir(), home: "/home/me", fetchInstance: async () => ({}), handOver: async () => undefined }))!,
    );
    expect(text(await claude.callTool({ name: "setup_needed", arguments: {} }))).toContain("redline setup <address>");
  });
});

describe("the instance line", () => {
  it("names the instance, its address and the installed version", () => {
    expect(instanceLine({ name: "Lumora", address: "redline.lumora.com", version: "0.2.0" })).toBe("Instance: Lumora (redline.lumora.com, v0.2.0)");
  });
});

