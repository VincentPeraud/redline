// Packs the CLI into one installable tarball (`@redline/shared` bundled in) and writes the build hash next to it.
// Usage: node packages/agent/build/pack-cli.mjs <outDir>   (run after `npm run build`)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const TARBALL_NAME = "redline-cli.tgz";
export const HASH_FILE = "build-hash.txt";

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/** Hash of the sorted relative paths and contents of every file under `dir`. */
export function hashBuiltFiles(dir) {
  const hash = createHash("sha256");
  for (const path of filesUnder(dir)) {
    hash.update(`${path}\0`).update(readFileSync(join(dir, path))).update("\0");
  }
  return hash.digest("hex");
}

/** Stages the built CLI and its bundled shared package, then packs them. Returns the build hash. */
export function packCli({ agentDir, sharedDir, outDir }) {
  const stage = join(outDir, "stage");
  const root = join(stage, "package");
  rmSync(stage, { recursive: true, force: true });
  cpSync(join(agentDir, "dist"), join(root, "dist"), { recursive: true });
  const bundled = join(root, "node_modules", "@redline", "shared");
  cpSync(join(sharedDir, "dist"), join(bundled, "dist"), { recursive: true });
  const shared = JSON.parse(readFileSync(join(sharedDir, "package.json"), "utf8"));
  writeFileSync(
    join(bundled, "package.json"),
    JSON.stringify({ name: shared.name, version: shared.version, type: shared.type, main: shared.main, types: shared.types }, null, 2),
  );

  const hash = hashBuiltFiles(root);
  writeFileSync(join(root, HASH_FILE), hash);

  const manifest = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
  delete manifest.scripts;
  manifest.files = ["dist", HASH_FILE];
  manifest.bundleDependencies = ["@redline/shared"];
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));

  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", outDir], { cwd: root, encoding: "utf8" }).trim();
  renameSync(join(outDir, packed), join(outDir, TARBALL_NAME));
  writeFileSync(join(outDir, HASH_FILE), hash);
  rmSync(stage, { recursive: true, force: true });
  return hash;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const outDir = process.argv[2];
  mkdirSync(outDir, { recursive: true });
  console.log(packCli({ agentDir: join(packages, "agent"), sharedDir: join(packages, "shared"), outDir }));
}
