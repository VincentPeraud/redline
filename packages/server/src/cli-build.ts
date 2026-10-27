import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLI_TARBALL_PATH = "/cli/redline-cli.tgz";

/** The CLI tarball the image carries and the hash of the build it was packed from. */
export interface CliBuild {
  tarballPath: string;
  hash: string;
}

/** Reads `redline-cli.tgz` and `build-hash.txt` from the folder; undefined when the image carries no CLI (development). */
export function loadCliBuild(dir: string | undefined): CliBuild | undefined {
  if (!dir) return undefined;
  const tarballPath = join(dir, "redline-cli.tgz");
  const hashPath = join(dir, "build-hash.txt");
  if (!existsSync(tarballPath) || !existsSync(hashPath)) return undefined;
  return { tarballPath, hash: readFileSync(hashPath, "utf8").trim() };
}
