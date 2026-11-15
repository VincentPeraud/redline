import { readFileSync } from "node:fs";

/** Hash of the build this CLI was packed from; "dev" when running from the sources. */
export function buildHash(): string {
  try {
    return readFileSync(new URL("../build-hash.txt", import.meta.url), "utf8").trim();
  } catch {
    return "dev";
  }
}

/** Version of this CLI: `package.json` sits one folder above `dist/` (and above `src/`). */
export function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "dev";
  }
}
