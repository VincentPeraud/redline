import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ASSETS_DIR,
  DESIGN_MD_PATH,
  WORKING_COPY_DESIGN_SYSTEM_DIR,
  isProjectContextPath,
  isSafePath,
  isUuid,
  type AgentCheckout,
} from "@redline/shared";
import { ensureGitignored } from "./link.js";

/** Location of a page's working copy inside the agent's folder: `.redline/<pageId>/`. */
export function workingCopyDir(folder: string, pageId: string): string {
  if (!isUuid(pageId)) throw new Error(`Invalid page id: ${pageId}`);
  return join(folder, ".redline", pageId);
}

/** Absolute path of `path` inside `dir`; refuses anything that is not a safe relative path or would leave `dir`. */
export function pathInside(dir: string, path: string): string {
  const target = resolve(dir, path);
  if (!isSafePath(path) || !target.startsWith(resolve(dir) + sep)) throw new Error(`Unsafe path: ${path}`);
  return target;
}

/** Writes a fresh copy of the page's files (any earlier copy is removed) and keeps `.redline/` out of git. */
export function writeWorkingCopy(folder: string, pageId: string, checkout: AgentCheckout): string {
  const dir = workingCopyDir(folder, pageId);
  rmSync(dir, { recursive: true, force: true });
  const write = (path: string, content: string | Buffer) => {
    const target = pathInside(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const [path, content] of Object.entries(checkout.files)) write(path, content);
  // Project context for the session to read; never published back (see `readWorkingCopy`).
  const { designMd, assets, designSystem } = checkout.project;
  write(DESIGN_MD_PATH, designMd);
  for (const [name, base64] of Object.entries(assets)) write(`${ASSETS_DIR}/${name}`, Buffer.from(base64, "base64"));
  for (const [path, content] of Object.entries(designSystem.files)) write(`${WORKING_COPY_DESIGN_SYSTEM_DIR}/${path}`, content);
  mkdirSync(dir, { recursive: true });
  ensureGitignored(folder);
  return dir;
}

/** Every page file of the working copy (DESIGN.md, assets and design system files excluded), as path -> UTF-8 content (paths use `/`). */
export function readWorkingCopy(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const path = relative(dir, full).split("\\").join("/");
        if (!isProjectContextPath(path)) files[path] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return files;
}

export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}
