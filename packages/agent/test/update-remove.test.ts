import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findInstallation, listInstallations } from "../src/installations.js";
import { removeInstallation, removeReport, updateInstallation, updateReport, type UpdateResult } from "../src/installation-update.js";
import { recordSession } from "../src/mcp-sessions.js";
import { addInstallation, fakeWorld, tempDir } from "./support/installations.js";

const LUMORA = "https://redline.lumora.com";

function lumora({ version = "0.2.0", server = { version: "0.2.1", buildHash: "h-new", hostProtocol: 2 } }: { version?: string; server?: object } = {}) {
  const world = fakeWorld();
  const configDir = tempDir();
  addInstallation(configDir, { name: "Lumora", serverUrl: LUMORA, version, hostProtocol: 2 });
  world.servers.set(LUMORA, { instanceName: "Lumora", ...server });
  const update = (wanted = "lumora") => updateInstallation({ configDir, wanted, deps: world.deps });
  const remove = (wanted = "lumora") => removeInstallation({ configDir, wanted, deps: world.deps, home: "/home/me" });
  return { world, configDir, update, remove };
}

describe("redline update", () => {
  it("installs the server's build into the installation, by name or by address, and restarts its agents", async () => {
    const { world, configDir, update } = lumora();
    world.agents.push({ installation: "lumora", name: "agora", running: true }, { installation: "lumora", name: "old", running: false }, { installation: "local", name: "other", running: true });

    const result = await update(LUMORA);

    expect(result).toMatchObject({ outcome: "updated", from: "0.2.0", to: "0.2.1", restarted: ["agora"], globalCommand: "kept" });
    expect(findInstallation(configDir, "lumora")).toMatchObject({ version: "0.2.1", buildHash: "h-new", token: "abt_t" });
    expect(world.updated).toEqual(["lumora"]);
    expect(listInstallations(configDir)).toHaveLength(1);
    expect(existsSync(join(configDir, "instances", "lumora", ".npm-old"))).toBe(false);
  });

  it("says there is nothing newer, and restarts nothing", async () => {
    const { world, update } = lumora({ version: "0.2.1", server: { version: "0.2.1", buildHash: "h-lumora", hostProtocol: 2 } });
    const result = await update();
    expect(result.outcome).toBe("current");
    expect(world.installs).toEqual([]);
    expect(world.updated).toEqual([]);
  });

  it("refuses a server too old for the command, naming both versions, and installs nothing", async () => {
    const { world, update } = lumora({ server: { version: "0.1.0", hostProtocol: 0 } });
    await expect(update()).rejects.toThrow("Lumora's server still runs v0.1.0, too old for this redline command (v0.3.0, accepts v0.2.0 and later).\n  Its agents stay refused until the server is upgraded.");
    expect(world.installs).toEqual([]);
  });

  it("keeps the installation as it was when the install fails", async () => {
    const { world, configDir, update } = lumora();
    world.failInstall = "ENOSPC";
    await expect(update()).rejects.toThrow("ENOSPC");
    expect(findInstallation(configDir, "lumora")).toMatchObject({ version: "0.2.0" });
    expect(world.updated).toEqual([]);
  });

  it("refuses an installation that is not set up", async () => {
    const { update } = lumora();
    await expect(update("brightco")).rejects.toThrow("brightco is not set up");
  });

  it("refreshes the global command only from a newer build, never downgrades it", async () => {
    const newer = lumora({ server: { version: "0.4.0", buildHash: "h-new", hostProtocol: 2 } });
    expect(await newer.update()).toMatchObject({ globalCommand: "updated" });
    expect(newer.world.globalInstalls).toEqual([LUMORA]);

    const older = lumora();
    expect(await older.update()).toMatchObject({ globalCommand: "kept" });
    expect(older.world.globalInstalls).toEqual([]);
  });

  const result = (more: Partial<UpdateResult> = {}): UpdateResult => ({ outcome: "updated", name: "Lumora", address: "redline.lumora.com", from: "0.2.0", to: "0.2.1", restarted: ["agora", "lumora-site"], globalCommand: "kept", commandVersion: "0.3.0", ...more });

  it("reports with the texts of update.html", () => {
    expect(updateReport(result())).toEqual([
      "Lumora: v0.2.0 → v0.2.1 (redline.lumora.com)",
      "✓ Installed. Agents restarted, each after its run: agora, lumora-site.",
      "  The redline command stays v0.3.0 (it only follows a newer build).",
      "  Claude Code sessions on Lumora: type /mcp and reconnect redline.",
    ]);
    expect(updateReport(result({ restarted: [], globalCommand: "updated", to: "0.4.0" }))).toEqual([
      "Lumora: v0.2.0 → v0.4.0 (redline.lumora.com)",
      "✓ Installed. No agent of Lumora is running.",
      "  The redline command was updated to v0.4.0 (this build is newer).",
      "  Claude Code sessions on Lumora: type /mcp and reconnect redline.",
    ]);
    expect(updateReport(result({ outcome: "current", to: "0.2.0" }))).toEqual(["✓ Lumora is up to date (v0.2.0, redline.lumora.com): nothing newer on the server."]);
  });
});

describe("redline remove", () => {
  it("removes the installation and its stopped agents, and leaves folder links alone", async () => {
    const { world, configDir, remove } = lumora();
    world.agents.push({ installation: "lumora", name: "old", running: false }, { installation: "local", name: "other", running: true });
    const result = await remove();
    expect(result.removedAgents).toEqual(["old"]);
    expect(listInstallations(configDir)).toEqual([]);
    expect(world.agents.map((agent) => agent.name)).toEqual(["other"]);
    expect(removeReport(result, { home: "/home/me" })).toEqual([
      `✓ Removed Lumora (${join(configDir, "instances", "lumora")}) and its stopped agents.`,
      "  Folders linked to it now say how to install it again.",
    ]);
  });

  it("refuses while an agent runs, naming it", async () => {
    const { world, configDir, remove } = lumora();
    world.agents.push({ installation: "lumora", name: "lumora-site", running: true });
    await expect(remove()).rejects.toThrow("An agent of Lumora is running (lumora-site). Stop it first: redline, then x.");
    expect(listInstallations(configDir)).toHaveLength(1);
  });

  it("refuses while a Claude Code session of it runs, naming its folder, and accepts once the session is gone", async () => {
    const { configDir, remove } = lumora();
    const installation = findInstallation(configDir, "lumora")!;
    const done = recordSession(installation.dir, "/home/me/Sites/agora");
    await expect(remove()).rejects.toThrow("A Claude Code session of Lumora is running (~/Sites/agora). Close it, then run redline remove lumora again.");
    done();
    await remove();
    expect(listInstallations(configDir)).toEqual([]);
  });

  it("ignores a session whose process is gone", async () => {
    const { configDir, remove } = lumora();
    const installation = findInstallation(configDir, "lumora")!;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(installation.dir, "sessions"));
    writeFileSync(join(installation.dir, "sessions", "999999999.json"), JSON.stringify({ pid: 999999999, folder: "/x" }));
    await remove();
    expect(listInstallations(configDir)).toEqual([]);
  });
});
