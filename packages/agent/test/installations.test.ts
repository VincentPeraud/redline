import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fallbackName, findInstallation, hasLegacyLayout, installationId, listInstallations, setupInstallation, type SetupResult } from "../src/installations.js";
import { saveLogin } from "../src/login.js";
import { fakeWorld, readJson, tempDir } from "./support/installations.js";

const LUMORA = "https://redline.lumora.com";

function setup(world = fakeWorld(), configDir = tempDir()) {
  const run = (options: { serverUrl?: string; token?: string; name?: string; askName?: (suggested?: string) => Promise<string> } = {}): Promise<SetupResult> =>
    setupInstallation({ configDir, serverUrl: options.serverUrl ?? LUMORA, token: options.token ?? "abt_one", name: options.name, askName: options.askName, deps: world.deps });
  return { world, configDir, run };
}

describe("installation names", () => {
  it("derives the id from the name: lower case, no accents, dashes", () => {
    expect(installationId("Lumora Préprod")).toBe("lumora-preprod");
    expect(installationId("  Green pix! ")).toBe("green-pix");
  });

  it("names a nameless server from the first label of its address, skipping a leading redline", () => {
    expect(fallbackName("https://redline.lumora.com")).toBe("lumora");
    expect(fallbackName("https://lumora-staging.fr")).toBe("lumora-staging");
    expect(fallbackName("https://redline.localhost")).toBe("localhost");
    expect(fallbackName("http://localhost:3000")).toBe("localhost");
  });
});

describe("redline setup, a new instance", () => {
  it("names the installation after the server, installs its build under its own folder and stores a private login", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0", buildHash: "h1" });
    const result = await run();
    expect(result).toMatchObject({ created: true, mcp: "registered", tooOld: false });
    expect(result.installation).toMatchObject({ id: "lumora", name: "Lumora", serverUrl: LUMORA, token: "abt_one", version: "0.2.0", buildHash: "h1" });
    expect(result.installation.dir).toBe(join(configDir, "instances", "lumora"));
    expect(world.installs).toEqual([{ serverUrl: LUMORA, prefix: expect.stringMatching(/instances[\\/]\.lumora-[^\\/]+[\\/]npm$/) }]);
    expect(statSync(join(result.installation.dir, "login.json")).mode & 0o777).toBe(0o600);
    expect(readJson(join(result.installation.dir, "login.json"))).toMatchObject({ serverUrl: LUMORA, token: "abt_one", name: "Lumora" });
    expect(listInstallations(configDir).map((installation) => installation.id)).toEqual(["lumora"]);
    expect(readdirSync(join(configDir, "instances"))).toEqual(["lumora"]);
  });

  it("lets --name win over the server's name, and keeps it", async () => {
    const { world, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    const { installation } = await run({ name: "Lumora Préprod" });
    expect(installation).toMatchObject({ id: "lumora-preprod", name: "Lumora Préprod", nameChosen: true });
  });

  it("falls back to the address when the server has no name", async () => {
    const { world, run } = setup();
    world.servers.set(LUMORA, { version: "0.2.0" });
    expect((await run()).installation).toMatchObject({ id: "lumora", name: "lumora", nameChosen: false });
  });

  it("asks for a name when the address gives localhost, and keeps the answer", async () => {
    const { world, run } = setup();
    world.servers.set("https://redline.localhost", { version: "0.2.0" });
    const asked: (string | undefined)[] = [];
    const result = await run({ serverUrl: "https://redline.localhost", askName: async (suggested) => (asked.push(suggested), "Local") });
    expect(asked).toEqual(["localhost"]);
    expect(result.installation).toMatchObject({ id: "local", name: "Local", nameChosen: true });
  });

  it("refuses a name already used by another address, with the --name hint, and saves nothing", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.servers.set("https://redline.lumora-staging.fr", { instanceName: "Lumora", version: "0.2.0" });
    await run();
    await expect(run({ serverUrl: "https://redline.lumora-staging.fr" })).rejects.toThrow(
      'The name "Lumora" (lumora) is already used by https://redline.lumora.com.\n  Pick another one: redline setup https://redline.lumora-staging.fr --name <name>',
    );
    expect(readdirSync(join(configDir, "instances"))).toEqual(["lumora"]);
    expect(world.installs).toHaveLength(1);
  });

  it("counts two names giving the same id as the same name", async () => {
    const { world, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora Préprod", version: "0.2.0" });
    world.servers.set("https://b.example.fr", { version: "0.2.0" });
    await run();
    await expect(run({ serverUrl: "https://b.example.fr", name: "lumora preprod" })).rejects.toThrow(/already used by https:\/\/redline\.lumora\.com/);
  });

  it("saves nothing and says why when the build cannot be installed", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.failInstall = "https://redline.lumora.com/cli/redline-cli.tgz answered 502";
    await expect(run()).rejects.toThrow("Could not install Lumora's build: https://redline.lumora.com/cli/redline-cli.tgz answered 502.\n  Nothing was saved. Check that the server is up, then run the command again.");
    expect(existsSync(join(configDir, "instances")) ? readdirSync(join(configDir, "instances")) : []).toEqual([]);
    expect(world.mcp.registrations).toBe(0);
  });

  it("saves nothing when the server refuses the token", async () => {
    const { configDir, run } = setup();
    await expect(run({ token: "abt_wrong" })).rejects.toThrow(/Cannot use https:\/\/redline\.lumora\.com with this token/);
    expect(existsSync(join(configDir, "instances"))).toBe(false);
  });

  it("requires a token", async () => {
    await expect(setup().run({ token: "  " })).rejects.toThrow("A token is required.");
  });

  it("refuses http:// outside this computer, before any call", async () => {
    const { world, run } = setup();
    await expect(run({ serverUrl: "http://redline.lumora.com" })).rejects.toThrow("http:// is only allowed for this computer (localhost, *.localhost, 127.0.0.1).\n  Use https://redline.lumora.com.");
    expect(world.installs).toEqual([]);
  });

  it("refuses while the old single login is still there, before migrate", async () => {
    const { world, configDir, run } = setup();
    saveLogin({ configDir, serverUrl: "https://old.example.fr", token: "abt_old" });
    expect(hasLegacyLayout(configDir)).toBe(true);
    await expect(run()).rejects.toThrow("This computer still has the old Redline installation (one login for every server).\n  Run redline migrate first: it moves each server to its own installation.");
    expect(world.installs).toEqual([]);
  });
});

describe("redline setup and Claude Code", () => {
  it("registers the MCP on the first setup and reports it already registered on later ones", async () => {
    const { world, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.servers.set("https://redline.brightco.fr", { instanceName: "Brightco", version: "0.2.0" });
    expect((await run()).mcp).toBe("registered");
    expect((await run({ serverUrl: "https://redline.brightco.fr" })).mcp).toBe("already");
  });

  it("keeps the installation when Claude Code is missing, and says so", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    world.mcp.status = "claude-missing";
    expect((await run()).mcp).toBe("claude-missing");
    expect(listInstallations(configDir)).toHaveLength(1);
  });
});

describe("redline setup, an instance too old for the command", () => {
  it("installs it and reports it too old", async () => {
    const { world, configDir, run } = setup();
    world.servers.set("https://redline.brightco.fr", { instanceName: "Brightco", version: "0.1.0" });
    const result = await run({ serverUrl: "https://redline.brightco.fr" });
    expect(result.tooOld).toBe(true);
    expect(listInstallations(configDir)[0]).toMatchObject({ id: "brightco", version: "0.1.0" });
  });

  it("reads the version from the installed build when the server does not tell it", async () => {
    const { world, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora" });
    world.deps.install = async (_url, prefix) => {
      const { writeInstalledBuild } = await import("./support/installations.js");
      writeInstalledBuild(prefix, { version: "0.1.0" });
    };
    expect(await run()).toMatchObject({ tooOld: true, installation: { version: "0.1.0" } });
  });
});

describe("redline setup, the same address again", () => {
  it("replaces the token, keeps the name and the build, and restarts the agents the old token had stopped", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0", buildHash: "h1" });
    await run({ name: "Mine" });
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.9.0", buildHash: "h2" });
    world.restarted = ["agora"];
    const result = await run({ token: "abt_two", serverUrl: `${LUMORA}/` });
    expect(result).toMatchObject({ created: false, restarted: ["agora"] });
    expect(result.installation).toMatchObject({ id: "mine", name: "Mine", token: "abt_two", version: "0.2.0", buildHash: "h1" });
    expect(readJson(join(configDir, "instances", "mine", "login.json"))).toMatchObject({ token: "abt_two", name: "Mine" });
    expect(world.installs).toHaveLength(1);
  });

  it("does not touch the stored token when the new one is refused", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora", version: "0.2.0" });
    await run();
    world.servers.delete(LUMORA);
    await expect(run({ token: "abt_bad" })).rejects.toThrow(/with this token/);
    expect(findInstallation(configDir, "lumora")?.token).toBe("abt_one");
  });
});

describe("finding installations", () => {
  it("finds one by id, name or address, and ignores half-made folders", async () => {
    const { world, configDir, run } = setup();
    world.servers.set(LUMORA, { instanceName: "Lumora Préprod", version: "0.2.0" });
    await run();
    writeFileSync(join(configDir, "instances", "stray"), "not a folder");
    expect(findInstallation(configDir, "lumora-preprod")?.serverUrl).toBe(LUMORA);
    expect(findInstallation(configDir, "lumora préprod")?.serverUrl).toBe(LUMORA);
    expect(findInstallation(configDir, `${LUMORA}/`)?.id).toBe("lumora-preprod");
    expect(findInstallation(configDir, "other")).toBeUndefined();
    expect(hasLegacyLayout(configDir)).toBe(false);
  });
});
