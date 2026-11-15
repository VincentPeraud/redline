import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { GlobalSetupContext } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    builtWebDir: string;
  }
}

/**
 * Vitest global setup: builds the web app once for the whole run, instead of once per journey file
 * (96 identical builds of ~3.5 s each). Journeys copy it with `copyBuiltWeb`.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const dir = mkdtempSync(join(tmpdir(), "redline-web-shared-"));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  await build({ root, logLevel: "silent", build: { outDir: dir, emptyOutDir: true } });
  provide("builtWebDir", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
