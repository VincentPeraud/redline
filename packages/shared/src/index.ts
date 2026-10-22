export const PROTOCOL_VERSION = 1;

export type PageType = "prototype" | "comparison";

export interface Project {
  id: string;
  title: string;
  /** Brief that becomes the first message of the project's first conversation. */
  instructions: string;
  /** Design system id, or null for the neutral default. */
  designSystem: string | null;
  /** The project agent serving it, once an agent has linked the project. */
  agent?: { id: string; machine: string; folder: string; status: AgentStatus };
}

export interface CreateProjectRequest {
  title: string;
  instructions?: string;
  designSystem?: string | null;
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

// Page manifest (ticket 19). Contract shared by the canvas, play mode, tweaks, design systems and MCP tools.

/** Path of the manifest inside a page's files. */
export const MANIFEST_PATH = "manifest.json";

export const DEFAULT_ARTBOARD_WIDTH = 800;
export const DEFAULT_ARTBOARD_HEIGHT = 500;
/** Horizontal gap between artboards laid out automatically. */
export const ARTBOARD_GAP = 80;

export interface ManifestArtboard {
  /** Path of the HTML file; also the artboard's identity (threads reference it). */
  file: string;
  title?: string;
  /** Size and position on the canvas, in canvas pixels. */
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ManifestNote {
  text: string;
  x: number;
  y: number;
}

/** Play mode: clicking `selector` in artboard `from` goes to artboard `to`. */
export interface ManifestLink {
  from: string;
  selector: string;
  to: string;
}

export type TweakType = "color" | "choice" | "toggle" | "range" | "count" | "text";

/** Declaration only; chosen values live in the page's tweaks file, never in the manifest. */
export interface ManifestTweak {
  id: string;
  type: TweakType;
  label: string;
  default?: string | number | boolean;
  /** `choice` only. */
  options?: string[];
  /** `range` and `count` only. */
  min?: number;
  max?: number;
}

export interface Manifest {
  title?: string;
  type?: PageType;
  /** Id of the design system the page uses. */
  designSystem?: string;
  artboards: ManifestArtboard[];
  notes: ManifestNote[];
  links: ManifestLink[];
  tweaks: ManifestTweak[];
}

const TWEAK_TYPES: readonly TweakType[] = ["color", "choice", "toggle", "range", "count", "text"];

function fail(message: string): never {
  throw new Error(`Invalid ${MANIFEST_PATH}: ${message}`);
}

function list(value: unknown, name: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${name} must be a list`);
  value.forEach((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) fail(`${name}[${i}] must be an object`);
  });
  return value as Record<string, unknown>[];
}

function str(item: Record<string, unknown>, key: string, name: string): string {
  const value = item[key];
  if (typeof value !== "string" || value === "") fail(`${name}.${key} must be a non-empty string`);
  return value;
}

function num(item: Record<string, unknown>, key: string, name: string, fallback: number, positive = false): number {
  const value = item[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    fail(`${name}.${key} must be ${positive ? "a positive number" : "a number"}`);
  }
  return value;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("must be a JSON object");
  const root = raw as Record<string, unknown>;

  let nextX = 0;
  const artboards = list(root.artboards, "artboards").map((item, i): ManifestArtboard => {
    const name = `artboards[${i}]`;
    const width = num(item, "width", name, DEFAULT_ARTBOARD_WIDTH, true);
    const artboard: ManifestArtboard = {
      file: str(item, "file", name),
      width,
      height: num(item, "height", name, DEFAULT_ARTBOARD_HEIGHT, true),
      x: num(item, "x", name, nextX),
      y: num(item, "y", name, 0),
    };
    if (typeof item.title === "string") artboard.title = item.title;
    nextX = artboard.x + width + ARTBOARD_GAP;
    return artboard;
  });

  const notes = list(root.notes, "notes").map((item, i): ManifestNote => {
    const name = `notes[${i}]`;
    return { text: str(item, "text", name), x: num(item, "x", name, 0), y: num(item, "y", name, 0) };
  });

  const links = list(root.links, "links").map((item, i): ManifestLink => {
    const name = `links[${i}]`;
    return { from: str(item, "from", name), selector: str(item, "selector", name), to: str(item, "to", name) };
  });

  const tweaks = list(root.tweaks, "tweaks").map((item, i): ManifestTweak => {
    const name = `tweaks[${i}]`;
    const type = str(item, "type", name);
    if (!TWEAK_TYPES.includes(type as TweakType)) fail(`${name}.type must be one of ${TWEAK_TYPES.join(", ")}`);
    return { ...(item as unknown as ManifestTweak), id: str(item, "id", name), type: type as TweakType, label: str(item, "label", name) };
  });

  const manifest: Manifest = { artboards, notes, links, tweaks };
  if (typeof root.title === "string") manifest.title = root.title;
  if (root.type === "prototype" || root.type === "comparison") manifest.type = root.type;
  if (typeof root.designSystem === "string") manifest.designSystem = root.designSystem;
  return manifest;
}

/** Layout used when a page has no manifest: every HTML file, side by side at the default size. */
export function defaultManifest(paths: string[]): Manifest {
  const files = paths.filter((path) => path.endsWith(".html"));
  return parseManifest(JSON.stringify({ artboards: files.map((file) => ({ file })) }));
}

/** WebSocket path of the agent endpoint (outside the reverse proxy's protection; guarded by the token). */
export const AGENT_ENDPOINT = "/agent";

/** Command printed to users whose agent is too old for the server. */
export const AGENT_UPDATE_COMMAND = "npm i -g redline-cli@latest";

/** WebSocket close codes sent by the server on the agent endpoint. */
export const AgentCloseCode = {
  /** Wrong token, or token regenerated while connected. */
  Unauthorized: 4401,
  /** The agent's protocol version is not the server's. */
  IncompatibleProtocol: 4426,
  /** Malformed first message. */
  BadHello: 4400,
  /** The hello names a project that does not exist. */
  UnknownProject: 4404,
  /** Another project agent already serves the project. */
  ProjectTaken: 4409,
} as const;

export type AgentKind = "project" | "global";

/** First message an agent sends after the socket opens. */
export interface AgentHello {
  type: "hello";
  token: string;
  protocolVersion: number;
  machine: string;
  folder: string;
  kind: AgentKind;
  /** The project a project agent serves (the link recorded in its folder). */
  projectId?: string;
}

export type AgentToServerMessage = AgentHello;

/** Messages the server sends on the agent endpoint. */
export type ServerToAgentMessage =
  | { type: "welcome"; agentId: string }
  | { type: "error"; code: "unauthorized" | "incompatible_protocol" | "bad_hello" | "unknown_project" | "project_taken"; message: string };

export type AgentStatus = "online" | "offline";

export interface AgentInfo {
  id: string;
  machine: string;
  folder: string;
  kind: AgentKind;
  status: AgentStatus;
  /** ISO timestamp of the last connection or disconnection. */
  lastSeenAt: string;
}

export interface AgentTokenResponse {
  token: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function starterArtboard(title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; }</style>
  </head>
  <body>
    <h1>${title}</h1>
  </body>
</html>
`;
}

/** Files of a new page: a manifest plus one artboard (prototype) or two variants (comparison). */
export function starterPageFiles(title: string, type: PageType, designSystem?: string | null): Record<string, string> {
  const artboards = type === "comparison" ? ["variant-a.html", "variant-b.html"] : ["screen-1.html"];
  const manifest = { title, type, ...(designSystem ? { designSystem } : {}), artboards: artboards.map((file) => ({ file })) };
  const files: Record<string, string> = { [MANIFEST_PATH]: JSON.stringify(manifest, null, 2) };
  for (const file of artboards) files[file] = starterArtboard(escapeHtml(title));
  return files;
}

export * from "./designSystem.js";
