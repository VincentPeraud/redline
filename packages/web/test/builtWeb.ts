import { cpSync } from "node:fs";
import { inject } from "vitest";

/** Copies the web app built once for the run (`support/build-web-once.ts`) into `dir`, which the journey owns and may remove. */
export function copyBuiltWeb(dir: string): void {
  cpSync(inject("builtWebDir"), dir, { recursive: true });
}
