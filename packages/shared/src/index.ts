export const PROTOCOL_VERSION = 1;

export type PageType = "prototype" | "comparison";

export interface Project {
  id: string;
  title: string;
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
