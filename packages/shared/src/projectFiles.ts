/** Project-level files read by every session of the project, written into each working copy. */
export const DESIGN_MD_PATH = "DESIGN.md";
/** The project style's tokens: a project-level file next to DESIGN.md, at the root of the working copy. */
export const PROJECT_STYLE_PATH = "tokens.css";
/** Folder of the project's shared images and fonts, in the working copy and relative to every artboard. */
export const ASSETS_DIR = "assets";
/** Largest project asset (image, font) the server accepts, from the web UI or from an agent. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
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

/** Who saved a DESIGN.md version: a thread or conversation run (Claude), the user's own Claude Code (terminal mode), or the user in the editor. Versions from before origins existed are "user". */
export type DesignMdOrigin = "thread" | "conversation" | "terminal" | "user";

export interface DesignMdAuthor {
  origin: DesignMdOrigin;
  /** Thread or conversation id (first thread of a batch). */
  originId?: string;
  /** Its title when the version was saved. */
  originLabel?: string;
}

/** One saved state of DESIGN.md. */
export interface DesignMdVersion extends DesignMdAuthor {
  id: string;
  content: string;
  createdAt: string;
}

/**
 * One rule of DESIGN.md: every non-blank line (list item, heading or paragraph line), compared trimmed. `line` is
 * 1-based in the current text. A rule comes from the oldest version since which a line with that text has been
 * present in every version up to the current one; editing a line makes it a new rule. When a text appears several
 * times, the k-th occurrence is matched to the k-th occurrence of earlier versions.
 */
export interface DesignMdRule extends DesignMdAuthor {
  line: number;
  text: string;
  versionId: string;
  createdAt: string;
}

/** `GET /api/projects/:id/design-md/info`. `lastModified` is null while DESIGN.md was never saved. */
export interface DesignMdInfo {
  versionCount: number;
  lastModified: (DesignMdAuthor & { versionId: string; createdAt: string }) | null;
  rules: DesignMdRule[];
}

export interface SaveDesignMdRequest {
  content: string;
}

/** Path on the artboard origin serving a project's style tokens, live. */
export function projectStyleUrlPath(projectId: string): string {
  return `/project-styles/${encodeURIComponent(projectId)}/${PROJECT_STYLE_PATH}`;
}

/** What a working copy carries besides the page's own files. */
export interface ProjectContext {
  /** Current DESIGN.md text, empty if none was written yet. */
  designMd: string;
  /** Asset name -> content, base64. */
  assets: Record<string, string>;
  /** Project style `tokens.css` (empty when the project only follows its design system); absent for a design system's own project. */
  projectStyle?: string;
  designSystem: { id: string; files: Record<string, string> };
}

/** True for working copy paths that belong to the project, not to the page. */
export function isProjectContextPath(path: string): boolean {
  return path === DESIGN_MD_PATH || path.startsWith(`${ASSETS_DIR}/`) || path.startsWith(`${WORKING_COPY_DESIGN_SYSTEM_DIR}/`);
}
