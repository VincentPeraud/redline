import { readFileSync } from "node:fs";

/** Hash of the build this CLI was packed from; "dev" when running from the sources. */
export function buildHash(): string {
  try {
    return readFileSync(new URL("../build-hash.txt", import.meta.url), "utf8").trim();
  } catch {
    return "dev";
  }
}
