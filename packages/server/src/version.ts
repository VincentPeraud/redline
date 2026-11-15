import { readFileSync } from "node:fs";

/** The server's version, read from its package.json (one level above both `src` and `dist`). */
export function serverVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}
