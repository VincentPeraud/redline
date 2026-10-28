import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCli, installPrefix } from "../src/install-cli.js";

describe("CLI install command", () => {
  const originalPath = process.env.PATH;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-install-"));
    writeFileSync(join(dir, "npm"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\n`);
    chmodSync(join(dir, "npm"), 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it.skipIf(process.platform === "win32")("passes the URL to npm as one plain argument, never through a shell", async () => {
    const url = `https://x.com/redline-cli.tgz;touch ${join(dir, "pwned")}`.replace(" ", "${IFS}");
    await installCli(`npm i -g ${url}`);
    expect(readFileSync(join(dir, "args"), "utf8").split("\n")).toEqual(["i", "-g", url, ""]);
    expect(() => readFileSync(join(dir, "pwned"))).toThrow();
  });

  it.skipIf(process.platform === "win32")("installs under the prefix the running CLI lives in, even with spaces in its path", async () => {
    await installCli("npm i -g https://x.com/redline-cli.tgz", "/Users/Jo Doe/.volta/tools/image/packages/redline-cli");
    expect(readFileSync(join(dir, "args"), "utf8").split("\n")).toEqual(["i", "-g", "https://x.com/redline-cli.tgz", "--prefix", "/Users/Jo Doe/.volta/tools/image/packages/redline-cli", ""]);
  });
});

describe("the npm prefix of the running CLI", () => {
  it.skipIf(process.platform === "win32")("is the folder above lib/node_modules, as Volta and plain npm lay it out", () => {
    expect(installPrefix("/Users/jo/.volta/tools/image/packages/redline-cli/lib/node_modules/redline-cli/")).toBe("/Users/jo/.volta/tools/image/packages/redline-cli");
    expect(installPrefix("/usr/local/lib/node_modules/redline-cli")).toBe("/usr/local");
  });

  it("is undefined when the CLI runs from the sources", () => {
    expect(installPrefix("/Users/jo/redline/packages/agent/")).toBeUndefined();
  });
});
