import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript build script
import { packCli } from "../build/pack-cli.mjs";

describe("CLI package", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "redline-pack-"));
    mkdirSync(join(work, "agent", "dist"), { recursive: true });
    mkdirSync(join(work, "shared", "dist"), { recursive: true });
    writeFileSync(join(work, "agent", "package.json"), JSON.stringify({ name: "redline-cli", version: "0.0.0", type: "module", bin: { redline: "dist/cli.js" }, dependencies: { "@redline/shared": "*", zod: "^4.0.0" }, scripts: { build: "tsc" } }));
    writeFileSync(join(work, "agent", "dist", "cli.js"), "console.log('cli');\n");
    writeFileSync(join(work, "shared", "package.json"), JSON.stringify({ name: "@redline/shared", version: "0.0.0", private: true, type: "module", main: "dist/index.js" }));
    writeFileSync(join(work, "shared", "dist", "index.js"), "export const x = 1;\n");
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const pack = (name: string) => {
    const outDir = join(work, name);
    mkdirSync(outDir);
    return { outDir, hash: packCli({ agentDir: join(work, "agent"), sharedDir: join(work, "shared"), outDir }) as string };
  };

  it("gives the same hash to two builds of the same code, and another one when a file changes", () => {
    const first = pack("one").hash;
    expect(pack("two").hash).toBe(first);
    writeFileSync(join(work, "shared", "dist", "index.js"), "export const x = 2;\n");
    expect(pack("three").hash).not.toBe(first);
    writeFileSync(join(work, "shared", "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(work, "agent", "dist", "cli.js"), "console.log('changed');\n");
    expect(pack("four").hash).not.toBe(first);
  });

  it("puts the hash in the tarball, next to the bundled shared package", () => {
    const { outDir, hash } = pack("one");
    const tarball = join(outDir, "redline-cli.tgz");
    expect(execFileSync("tar", ["-xzOf", tarball, "package/build-hash.txt"], { encoding: "utf8" })).toBe(hash);
    expect(readFileSync(join(outDir, "build-hash.txt"), "utf8")).toBe(hash);
    const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(files).toContain("package/node_modules/@redline/shared/dist/index.js");
    expect(files).toContain("package/dist/cli.js");
  });
});
