import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AgentCheckout } from "@redline/shared";
import { ensureGitignored } from "./link.js";

/** Location of a page's working copy inside the agent's folder: `.redline/<pageId>/`. */
export function workingCopyDir(folder: string, pageId: string): string {
  return join(folder, ".redline", pageId);
}

/** Writes a fresh copy of the page's files (any earlier copy is removed) and keeps `.redline/` out of git. */
export function writeWorkingCopy(folder: string, pageId: string, checkout: AgentCheckout): string {
  const dir = workingCopyDir(folder, pageId);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(checkout.files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(dir, { recursive: true });
  ensureGitignored(folder);
  return dir;
}

/** Every file of the working copy, as path -> UTF-8 content (paths use `/`). */
export function readWorkingCopy(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(dir, full).split("\\").join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}
