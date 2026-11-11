import { describe, expect, it } from "vitest";
import { ensureGlobalCommand, launchedThroughNpx } from "../src/global-command.js";

const SERVER = "https://redline.lumora.com";

function world(installedVersion?: string) {
  const installs: string[] = [];
  return { installs, deps: { installedVersion: async () => installedVersion, install: async (url: string) => void installs.push(url) } };
}

describe("the global redline command, from the panel's npx command", () => {
  it("installs it from the server when it is missing", async () => {
    const { deps, installs } = world();
    expect(await ensureGlobalCommand(SERVER, "0.3.0", deps)).toBe("installed");
    expect(installs).toEqual([`${SERVER}/cli/redline-cli.tgz`]);
  });

  it("replaces an older one, and leaves an equal or newer one alone", async () => {
    const older = world("0.2.0");
    expect(await ensureGlobalCommand(SERVER, "0.3.0", older.deps)).toBe("updated");
    expect(older.installs).toHaveLength(1);
    for (const version of ["0.3.0", "0.4.1"]) {
      const current = world(version);
      expect(await ensureGlobalCommand(SERVER, "0.3.0", current.deps)).toBe("current");
      expect(current.installs).toEqual([]);
    }
  });

  it("recognises a run started by npx, and not one typed against the global command", () => {
    expect(launchedThroughNpx({ npm_command: "exec" }, "/usr/local/lib/node_modules/redline-cli")).toBe(true);
    expect(launchedThroughNpx({}, "/home/me/.npm/_npx/1a2b/node_modules/redline-cli")).toBe(true);
    expect(launchedThroughNpx({}, "/usr/local/lib/node_modules/redline-cli")).toBe(false);
    expect(launchedThroughNpx({ npm_command: "run-script" }, "/usr/local/lib/node_modules/redline-cli")).toBe(false);
  });
});
