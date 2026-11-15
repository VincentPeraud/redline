import { describe, expect, it } from "vitest";
import { ensureGlobalCommand, globalCommandPlace, launchedThroughNpx } from "../src/global-command.js";

const SERVER = "https://redline.lumora.com";

const OWN = { version: "0.3.0", buildHash: "b3" };

function world(installed?: { version: string; buildHash?: string }) {
  const installs: string[] = [];
  return { installs, deps: { installed: async () => installed, install: async (url: string) => void installs.push(url) } };
}

describe("the global redline command, from the panel's npx command", () => {
  it("installs it from the server when it is missing", async () => {
    const { deps, installs } = world();
    expect(await ensureGlobalCommand(SERVER, OWN, deps)).toBe("installed");
    expect(installs).toEqual([`${SERVER}/cli/redline-cli.tgz`]);
  });

  it("replaces an older one, and leaves an equal or newer one alone", async () => {
    const older = world({ version: "0.2.0", buildHash: "b2" });
    expect(await ensureGlobalCommand(SERVER, OWN, older.deps)).toBe("updated");
    expect(older.installs).toHaveLength(1);
    for (const installed of [{ version: "0.3.0", buildHash: "b3" }, { version: "0.4.1", buildHash: "b4" }]) {
      const current = world(installed);
      expect(await ensureGlobalCommand(SERVER, OWN, current.deps)).toBe("current");
      expect(current.installs).toEqual([]);
    }
  });

  it("replaces another build of the same version, unless this one runs from the sources", async () => {
    const otherBuild = world({ version: "0.3.0", buildHash: "old" });
    expect(await ensureGlobalCommand(SERVER, OWN, otherBuild.deps)).toBe("updated");
    expect(otherBuild.installs).toHaveLength(1);
    const fromSources = world({ version: "0.3.0", buildHash: "old" });
    expect(await ensureGlobalCommand(SERVER, { version: "0.3.0", buildHash: "dev" }, fromSources.deps)).toBe("current");
    const noHash = world({ version: "0.3.0" });
    expect(await ensureGlobalCommand(SERVER, OWN, noHash.deps)).toBe("updated");
  });

  it("installs through Volta when Volta runs the commands, so that its redline shim serves the new build", () => {
    const volta = globalCommandPlace({ VOLTA_HOME: "/Users/me/.volta" }, (path) => path === "/Users/me/.volta/bin/npm", "darwin");
    expect(volta).toEqual({ npm: "/Users/me/.volta/bin/npm", packageDir: "/Users/me/.volta/tools/image/packages/redline-cli/lib/node_modules/redline-cli" });
    expect(globalCommandPlace({}, () => true, "darwin")).toEqual({ npm: "npm" });
    expect(globalCommandPlace({ VOLTA_HOME: "/Users/me/.volta" }, () => false, "darwin")).toEqual({ npm: "npm" });
  });

  it("recognises a run started by npx, and not one typed against the global command", () => {
    expect(launchedThroughNpx({ npm_command: "exec" }, "/usr/local/lib/node_modules/redline-cli")).toBe(true);
    expect(launchedThroughNpx({}, "/home/me/.npm/_npx/1a2b/node_modules/redline-cli")).toBe(true);
    expect(launchedThroughNpx({}, "/usr/local/lib/node_modules/redline-cli")).toBe(false);
    expect(launchedThroughNpx({ npm_command: "run-script" }, "/usr/local/lib/node_modules/redline-cli")).toBe(false);
  });
});
