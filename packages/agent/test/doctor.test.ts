import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseInstallation, doctorReport, gatherDoctor, type DoctorDeps, type McpRegistration } from "../src/doctor.js";
import { addInstallation, fakeWorld, folderWithLink, tempDir } from "./support/installations.js";

const HOME = "/home/vince";

function setup(overrides: Partial<DoctorDeps> = {}) {
  const world = fakeWorld();
  const configDir = tempDir();
  const deps: DoctorDeps = {
    ...world.deps,
    async mcp(): Promise<McpRegistration> {
      return { status: "registered" };
    },
    async host() {
      return { running: true, agents: 4 };
    },
    async projectNames() {
      return ["Agora"];
    },
    ...overrides,
  };
  return { world, configDir, deps };
}

const report = async (configDir: string, folder: string, deps: DoctorDeps, home = HOME) => doctorReport(await gatherDoctor({ configDir, folder, deps }), { home });

describe("diagnosing one installation (also the left pane of the Instances tab)", () => {
  const context = { commandVersion: "0.3.0", hostProtocol: 2 };
  const installation = { id: "lumora", name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0", buildHash: "aaaaaaaaaa", hostProtocol: 1 };
  const diagnose = (info: object | undefined, failure?: "token-refused" | "unreachable", own: object = {}) =>
    diagnoseInstallation({ installation: { ...installation, ...own } as never, info, failure }, context);

  it("is up to date when the server runs the same build", () => {
    expect(diagnose({ version: "0.2.0", buildHash: "aaaaaaaaaa", hostProtocol: 2 })).toEqual({ state: "up-to-date", severity: "ok", status: "v0.2.0 · up to date · token OK" });
  });

  it("offers an update when the server runs a newer version", () => {
    expect(diagnose({ version: "0.2.1", hostProtocol: 2 })).toEqual({
      state: "update-available",
      severity: "warning",
      status: "v0.2.0 installed, the server runs v0.2.1",
      fix: { before: "", command: "redline update lumora" },
    });
  });

  it("tells two builds of the same version apart by their short hash", () => {
    const { status, state } = diagnose({ version: "0.2.0", buildHash: "bbbbbbbbbbbb", hostProtocol: 2 });
    expect(state).toBe("update-available");
    expect(status).toBe("v0.2.0 (aaaaaaa) installed, the server runs v0.2.0 (bbbbbbb)");
  });

  it("is too old when the command does not accept its protocol, and says what the server must do", () => {
    expect(diagnose({ version: "0.1.0" }, undefined, { version: "0.1.0", hostProtocol: undefined, name: "Brightco", id: "brightco" })).toEqual({
      state: "too-old",
      severity: "problem",
      status: "v0.1.0, too old for this command (accepts v0.2.0 and later)",
      fix: { before: "the server runs v0.1.0: it must be upgraded, then ", command: "redline update brightco" },
    });
  });

  it("is only an update away when the server already runs an accepted build", () => {
    expect(diagnose({ version: "0.3.0", hostProtocol: 2 }, undefined, { hostProtocol: undefined }).fix).toEqual({ before: "", command: "redline update lumora" });
  });

  it("names a refused token and where to get another", () => {
    expect(diagnose(undefined, "token-refused")).toEqual({
      state: "token-refused",
      severity: "problem",
      status: "token refused (regenerated, or account deactivated)",
      fix: { before: "copy your token from Lumora's Agents page (Lancer un agent), then ", command: "redline setup https://redline.lumora.com" },
    });
  });

  it("names an unreachable server", () => {
    expect(diagnose(undefined, "unreachable")).toEqual({
      state: "unreachable",
      severity: "problem",
      status: "cannot reach the server",
      fix: { before: "check the address, or ", command: "redline remove lumora" },
    });
  });
});

describe("redline doctor", () => {
  it("reports every state of doctor.html as text", async () => {
    const { world, configDir, deps } = setup({
      async fetchInstance(serverUrl, token) {
        if (serverUrl === "http://redline-tests.local") throw new Error("cannot reach it (ENOTFOUND)");
        return world.deps.fetchInstance(serverUrl, token);
      },
    });
    addInstallation(configDir, { name: "Local", serverUrl: "http://redline.localhost", version: "0.3.0" });
    addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com", version: "0.2.0" });
    addInstallation(configDir, { name: "Brightco", serverUrl: "https://redline.brightco.fr", version: "0.1.0", hostProtocol: null });
    addInstallation(configDir, { name: "Tests", serverUrl: "http://redline-tests.local", version: "0.2.0" });
    mkdirSync(join(configDir, "instances", "old-test"), { recursive: true });
    world.servers.set("http://redline.localhost", { version: "0.3.0", buildHash: "h-local", hostProtocol: 2 });
    world.servers.set("https://redline.lumora.com", { version: "0.2.1", hostProtocol: 2 });
    world.servers.set("https://redline.brightco.fr", { version: "0.1.0" });
    const folder = folderWithLink({ serverUrl: "https://redline.lumora.com", projectIds: ["p1"] });

    expect((await report(configDir, folder, deps)).lines.join("\n").replaceAll(folder, "~/claude-projects/agora")).toBe(
      [
        "redline command v0.3.0 · agent host v0.3.0, running (4 agents)",
        "✓ Claude Code: the redline MCP is registered for every session.",
        "",
        "INSTANCES",
        "✗ Brightco  redline.brightco.fr    v0.1.0, too old for this command (accepts v0.2.0 and later)",
        "                                   → the server runs v0.1.0: it must be upgraded, then redline update brightco",
        "✓ Local     redline.localhost      v0.3.0 · up to date · token OK",
        "! Lumora    redline.lumora.com     v0.2.0 installed, the server runs v0.2.1",
        "                                   → redline update lumora",
        "✗ Tests     redline-tests.local    cannot reach the server",
        "                                   → check the address, or redline remove tests",
        "○ old-test  instances/old-test     skipped: not an installation (no login, no build)",
        "",
        "THIS FOLDER",
        "✓ ~/claude-projects/agora → Agora on Lumora",
        "",
        "2 problems, 1 warning.",
      ].join("\n"),
    );
  });

  it("counts the problems and warnings", async () => {
    const { configDir, deps } = setup();
    expect((await report(configDir, tempDir(), deps)).problems).toBe(0);
  });

  it("says a refused token and the Lumora remedy", async () => {
    const { configDir, deps } = setup();
    addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com" });
    const { lines } = await report(configDir, tempDir(), deps);
    expect(lines).toContain("✗ Lumora  redline.lumora.com    token refused (regenerated, or account deactivated)");
    expect(lines).toContain("                                → copy your token from Lumora's Agents page (Lancer un agent), then redline setup https://redline.lumora.com");
  });

  it("prints the old installation line, and nothing else, before migrate", async () => {
    const { configDir, deps } = setup();
    writeFileSync(join(configDir, "login.json"), JSON.stringify([{ serverUrl: "https://a.example", token: "t" }, { serverUrl: "https://b.example", token: "t" }]));
    const { lines, problems } = await report(configDir, tempDir(), deps, configDir.slice(0, configDir.lastIndexOf("/")));
    expect(lines).toEqual([`✗ Old installation: one login for 2 servers (~${configDir.slice(configDir.lastIndexOf("/"))}/login.json).`, "  → redline migrate (every other command refuses until then)"]);
    expect(problems).toBe(1);
  });

  describe("this folder", () => {
    it("is linked to an address not installed here", async () => {
      const { configDir, deps } = setup();
      addInstallation(configDir, { name: "Local", serverUrl: "http://redline.localhost" });
      const folder = folderWithLink({ serverUrl: "https://redline.tda.fr", projectIds: [] });
      const { lines, problems } = await report(configDir, folder, deps);
      expect(lines).toContain(`✗ ${folder} → redline.tda.fr, not installed on this computer`);
      expect(lines).toContain("  → redline setup https://redline.tda.fr, or redline link <instance>");
      expect(problems).toBeGreaterThanOrEqual(1);
    });

    it("is linked to nothing", async () => {
      const { configDir, deps } = setup();
      addInstallation(configDir, { name: "Local", serverUrl: "http://redline.localhost" });
      addInstallation(configDir, { name: "Lumora", serverUrl: "https://redline.lumora.com" });
      const folder = tempDir();
      const { lines } = await report(configDir, folder, deps);
      expect(lines).toContain(`○ ${folder} is linked to no instance: Claude Code sessions here do not see Redline`);
      expect(lines).toContain("  → redline link");
    });

    it("uses the only installation without a link", async () => {
      const { configDir, deps } = setup();
      addInstallation(configDir, { name: "Local", serverUrl: "http://redline.localhost" });
      const folder = tempDir();
      expect((await report(configDir, folder, deps)).lines).toContain(`✓ ${folder} uses Local, the only installation (no link needed)`);
    });
  });

  describe("Claude Code", () => {
    it("runs another command", async () => {
      const { configDir, deps } = setup({ mcp: async () => ({ status: "other", command: "npx redline-cli mcp" }) });
      const { lines, problems } = await report(configDir, tempDir(), deps);
      expect(lines.slice(1, 3)).toEqual(["✗ Claude Code: the redline MCP runs another command (npx redline-cli mcp).", "  → redline setup <address> of any installed instance registers it again"]);
      expect(problems).toBeGreaterThanOrEqual(1);
    });

    it("is not installed", async () => {
      const { configDir, deps } = setup({ mcp: async () => ({ status: "claude-missing" }) });
      expect((await report(configDir, tempDir(), deps)).lines[1]).toBe("✗ Claude Code is not installed: the redline MCP cannot be registered.");
    });

    it("has no redline MCP", async () => {
      const { configDir, deps } = setup({ mcp: async () => ({ status: "absent" }) });
      expect((await report(configDir, tempDir(), deps)).lines[1]).toBe("✗ Claude Code: the redline MCP is not registered.");
    });
  });

  it("says when no host runs", async () => {
    const { configDir, deps } = setup({ host: async () => ({ running: false }) });
    expect((await report(configDir, tempDir(), deps)).lines[0]).toBe("redline command v0.3.0 · agent host not running");
  });

  it("paints like the mock-ups when a terminal asks for colour", async () => {
    const { configDir, deps } = setup();
    addInstallation(configDir, { name: "Local", serverUrl: "http://redline.localhost" });
    const state = await gatherDoctor({ configDir, folder: tempDir(), deps });
    expect(doctorReport(state, { home: HOME, color: true }).lines.join("\n")).toContain("\u001b[38;2;74;222;128m✓ \u001b[0m");
  });
});
