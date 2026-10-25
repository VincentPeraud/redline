import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ASSETS_DIR,
  DESIGN_MD_PATH,
  MAX_ASSET_BYTES,
  PROJECT_STYLE_PATH,
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
  const write = (path: string, content: string | Buffer, mode?: number) => {
    const target = pathInside(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, mode === undefined ? undefined : { mode });
  };
  for (const [path, content] of Object.entries(checkout.files)) write(path, content);
  // Project context for the session to read; never published back (see `readWorkingCopy`).
  const { designMd, assets, designSystem, projectStyle } = checkout.project;
  write(DESIGN_MD_PATH, designMd);
  if (projectStyle !== undefined) write(PROJECT_STYLE_PATH, projectStyle);
  for (const [name, base64] of Object.entries(assets)) write(`${ASSETS_DIR}/${name}`, Buffer.from(base64, "base64"));
  // The design system's current diffusion is for reading: read-only files (a publish touching them is refused anyway).
  for (const [path, content] of Object.entries(designSystem?.files ?? {})) write(`${WORKING_COPY_DESIGN_SYSTEM_DIR}/${path}`, content, 0o444);
  mkdirSync(dir, { recursive: true });
  ensureGitignored(folder);
  return dir;
}

/**
 * Every page file of the working copy (DESIGN.md, assets and design system files excluded), as path -> UTF-8 content
 * (paths use `/`). With `hasProjectStyle`, the root `tokens.css` is the project style, not a page file.
 */
export function readWorkingCopy(dir: string, hasProjectStyle = false): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // Regular files only: a symlink would publish whatever it points to.
      else if (entry.isFile()) {
        const path = relative(dir, full).split("\\").join("/");
        if (!isProjectContextPath(path) && !(hasProjectStyle && path === PROJECT_STYLE_PATH)) files[path] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Files of `.design-system/` that the session added or changed (path as in the working copy). They are never part of a
 * page, so the caller publishes them with the page files only to have the server refuse them.
 */
export function readDesignSystemEdits(dir: string, base: Record<string, string> = {}): Record<string, string> {
  const root = join(dir, WORKING_COPY_DESIGN_SYSTEM_DIR);
  const edits: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const path = relative(root, full).split("\\").join("/");
        const content = readFileSync(full, "utf8");
        if (base[path] !== content) edits[`${WORKING_COPY_DESIGN_SYSTEM_DIR}/${path}`] = content;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return edits;
}

/**
 * Assets under `assets/` of the working copy that are new or differ from `base` (name -> base64, as checked out).
 * Deleted assets are not reported: assets are shared by every page of the project, a working copy never removes one.
 * Throws on an asset the server would refuse (unsafe name, over `MAX_ASSET_BYTES`).
 */
export function readChangedAssets(dir: string, base: Record<string, string>): Record<string, Buffer> {
  const root = join(dir, ASSETS_DIR);
  const changed: Record<string, Buffer> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Hidden files (.DS_Store and the like) are not assets.
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // Regular files only: a symlink would upload whatever it points to.
      else if (entry.isFile()) {
        const name = relative(root, full).split("\\").join("/");
        if (!isSafePath(name)) throw new Error(`${ASSETS_DIR}/${name} is not a valid asset name (no ":", "\\" or empty, "." and ".." segments).`);
        // Checked before reading: the run fails before any upload, without loading a huge file.
        const size = statSync(full).size;
        if (size > MAX_ASSET_BYTES) {
          throw new Error(`${ASSETS_DIR}/${name} is ${(size / 1024 / 1024).toFixed(1)} MB; assets are limited to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
        }
        const bytes = readFileSync(full);
        if (bytes.toString("base64") !== base[name]) changed[name] = bytes;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return changed;
}

/** The session's DESIGN.md, or undefined when it deleted the file (that is not a change). */
export function readDesignMd(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, DESIGN_MD_PATH), "utf8");
  } catch {
    return undefined;
  }
}

/** The session's project style, or undefined when it deleted the file (that is not a change). */
export function readProjectStyle(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, PROJECT_STYLE_PATH), "utf8");
  } catch {
    return undefined;
  }
}

export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}
