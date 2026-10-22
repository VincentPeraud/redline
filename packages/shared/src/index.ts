export const PROTOCOL_VERSION = 1;

export type PageType = "prototype" | "comparison";

export interface Project {
  id: string;
  title: string;
}

export type VersionOrigin = "thread" | "conversation" | "terminal" | "tweak" | "restore";

export const VERSION_ORIGINS: readonly VersionOrigin[] = ["thread", "conversation", "terminal", "tweak", "restore"];

export interface PageVersionSummary {
  id: string;
  message: string;
  origin: VersionOrigin;
  createdAt: string;
}

export interface CreateVersionRequest {
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
  message: string;
  origin: VersionOrigin;
}

export interface PageVersion {
  id: string;
  /** Maps each file path of the page to the content hash of its blob. */
  files: Record<string, string>;
}

export interface Page {
  id: string;
  projectId: string;
  title: string;
  type: PageType;
  version: PageVersion;
}

export interface CreatePageRequest {
  title: string;
  type: PageType;
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
}

export interface ServerConfig {
  artboardOrigin: string;
}

export type ThreadStatus = "open" | "resolved";

export interface Thread {
  id: string;
  pageId: string;
  /** Per-page number shown on the pin and in the thread list; never reused. */
  number: number;
  /** Path of the artboard file the thread is pinned on. */
  artboard: string;
  /** CSS selector of the pinned element; may stop matching after edits. */
  selector: string;
  /** Fallback position, in percent of the artboard document size. */
  xPct: number;
  yPct: number;
  /** First line of the comment, kept visible when the thread is resolved. */
  title: string;
  body: string;
  status: ThreadStatus;
}

export interface CreateThreadRequest {
  artboard: string;
  selector: string;
  xPct: number;
  yPct: number;
  body: string;
}
