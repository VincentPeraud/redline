import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { legacyGateRefuses } from "../src/migrate.js";

describe("the legacy gate", () => {
  it("lets setup through when npx launches it, and only then", () => {
    expect(legacyGateRefuses("setup", { throughNpx: true })).toBe(false);
    expect(legacyGateRefuses("setup", { throughNpx: false })).toBe(true);
    expect(legacyGateRefuses("link", { throughNpx: true })).toBe(true);
    expect(legacyGateRefuses("migrate", { throughNpx: false })).toBe(false);
  });
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../../../scripts/tsconfig.json", import.meta.url));

/** Runs the CLI entry point on a computer that still has the old single login. */
async function runOnOldComputer(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  const configDir = mkdtempSync(join(tmpdir(), "redline-old-computer-"));
  writeFileSync(join(configDir, "login.json"), JSON.stringify([{ serverUrl: "https://redline.example.com", token: "abt_old" }]));
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig, REDLINE_CONFIG_DIR: configDir, npm_command: "", ...env } });
    return { code: 0, stderr: "" };
  } catch (error) {
    const { code, stderr } = error as { code: number; stderr: string };
    return { code, stderr };
  }
}

describe("redline setup on a computer with the old installation", () => {
  it("stops on migrate when typed against the global command", async () => {
    const { code, stderr } = await runOnOldComputer(["setup", "https://other.example.com", "--token", "abt_new"], {});
    expect(code).toBe(1);
    expect(stderr).toContain("Run redline migrate first");
  });

  it("goes past the gate when typed by hand for the address still in the old login", async () => {
    const { stderr } = await runOnOldComputer(["setup", "redline.example.com", "--token", "abt_new"], {});
    expect(stderr).not.toContain("Run redline migrate first");
  });

  it("goes past the gate when npx launched it (here it stops later, on a refused address)", async () => {
    const { stderr } = await runOnOldComputer(["setup", "http://example.com", "--token", "abt_new"], { npm_command: "exec" });
    expect(stderr).not.toContain("Run redline migrate first");
    expect(stderr).toContain("http:// is only allowed");
  });
});
