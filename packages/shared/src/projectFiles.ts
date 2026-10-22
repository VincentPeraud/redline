/** Project-level files read by every session of the project, written into each working copy. */
export const DESIGN_MD_PATH = "DESIGN.md";
/** Folder of the project's shared images and fonts, in the working copy and relative to every artboard. */
export const ASSETS_DIR = "assets";
/** Folder of the design system files inside a working copy. */
export const WORKING_COPY_DESIGN_SYSTEM_DIR = "design-system";

export interface ProjectAsset {
  /** Path relative to the asset folder, e.g. `logo.png` or `fonts/inter.woff2`. */
  name: string;
  /** SHA-256 of the content. */
  hash: string;
  size: number;
}

export interface DesignMdResponse {
  content: string;
}

export interface SaveDesignMdRequest {
  content: string;
}

/** What a working copy carries besides the page's own files. */
export interface ProjectContext {
  /** Current DESIGN.md text, empty if none was written yet. */
  designMd: string;
  /** Asset name -> content, base64. */
  assets: Record<string, string>;
  designSystem: { id: string; files: Record<string, string> };
}

/** True for working copy paths that belong to the project, not to the page. */
export function isProjectContextPath(path: string): boolean {
  return path === DESIGN_MD_PATH || path.startsWith(`${ASSETS_DIR}/`) || path.startsWith(`${WORKING_COPY_DESIGN_SYSTEM_DIR}/`);
}
