import type { AgentWorkMessage, Effort, ModelChoice, ThreadContext, ThreadReply, WorkItem } from "./work.js";

export * from "./work.js";
export * from "./sessions.js";
export * from "./home.js";

export const PROTOCOL_VERSION = 1;

/**
 * True for a relative, forward-slash path that stays inside a page: no empty, `.` or `..` segment, no backslash,
 * colon (drive letters, streams) or NUL. One implementation for the server and for agents writing to disk.
 */
export function isSafePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\\:\0]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `UUID` v1-v8 as produced by `randomUUID()`; page ids are used to build folder names on agents. */
export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export interface Project {
  id: string;
  title: string;
  /** Brief that becomes the first message of the project's first conversation. */
  instructions: string;
  /** Design system id, or null for the neutral default. */
  designSystem: string | null;
  /** The project agent serving it, once an agent has linked the project. */
  agent?: { id: string; machine: string; folder: string; status: AgentStatus };
  /** Effective takeover: whether the global agent may run the project's work, in new sessions, while its project agent is offline (`globalTakeoverOverride ?? Settings.globalTakeover`). */
  globalTakeover: boolean;
  /** The project's own choice; null follows the global setting. */
  globalTakeoverOverride: boolean | null;
  /** The online agent that would run the project's work now (`GET /api/projects...`); absent when none can. */
  servedBy?: { id: string; machine: string; folder: string; kind: AgentKind; takeover: boolean };
}

/** `PATCH /api/projects/:id`: any field may be sent alone. */
export interface UpdateProjectRequest {
  /** Rename the project (trimmed, 1 to `MAX_TITLE_LENGTH` characters). */
  title?: string;
  /** true / false overrides the global takeover setting for this project, null goes back to following it. */
  globalTakeoverOverride?: boolean | null;
}

/** `PATCH /api/pages/:id`: rename the page. */
export interface UpdatePageRequest {
  title: string;
}

/** Longest project or page name accepted. */
export const MAX_TITLE_LENGTH = 120;

/** Instance-wide settings, `GET|PATCH /api/settings`. */
export interface Settings {
  /** Whether the global agent takes over a project's work while its project agent is offline, unless the project overrides it. */
  globalTakeover: boolean;
}

export interface CreateProjectRequest {
  title: string;
  instructions?: string;
  designSystem?: string | null;
}

/** "creation": the first version of a page (new page, design system, page created by Claude); "terminal": a publish from the user's own Claude Code. */
export type VersionOrigin = "creation" | "thread" | "conversation" | "terminal" | "tweak" | "restore";

export const VERSION_ORIGINS: readonly VersionOrigin[] = ["creation", "thread", "conversation", "terminal", "tweak", "restore"];

export interface PageVersionSummary {
  id: string;
  message: string;
  origin: VersionOrigin;
  /** Thread or conversation that produced the version (first thread of a batch); absent for other origins and for versions recorded before this field. */
  originId?: string;
  /** Title of that thread or conversation, as it was when the version was recorded. */
  originLabel?: string;
  createdAt: string;
  /** Only in the answer to an agent's publish: the page had moved since `baseVersionId` and the changes were merged onto its current version. */
  merged?: boolean;
}

export interface CreateVersionRequest {
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
  message: string;
  origin: VersionOrigin;
  /**
   * `POST /agent-api/pages/:id/versions` only (required there): the version the files were checked out from. The server
   * records what changed relative to it on top of the page's current version, and answers 409 when the same file changed on both sides.
   */
  baseVersionId?: string;
  /** `/agent-api` only: the work item publishing; the server derives the version's origin id and label (thread or conversation title) from it. */
  workId?: string;
  /**
   * `/agent-api` only: the DESIGN.md of the working copy, sent when the session changed it. `base` is the DESIGN.md the
   * working copy started from; the server answers 409 when DESIGN.md changed meanwhile (nothing is published).
   */
  designMd?: { content: string; base: string };
}

// Per-artboard history (decision 3 of 2026-10-22). Storage is the page versions; these are derived views.

/** One state of one artboard file: a page version in which that file's content changed. */
export interface ArtboardVersion {
  /** The page version that introduced this content; pass it to the preview path and to restore. */
  versionId: string;
  /** Claude's run summary / terminal message; fixed texts "Artboard créé", "Version du … restaurée", "Remis depuis les artboards supprimés". */
  title: string;
  origin: VersionOrigin;
  originId?: string;
  originLabel?: string;
  createdAt: string;
  /** The content the page shows now. At most one entry per artboard is current. */
  current: boolean;
}

/** `GET /api/pages/:pageId/artboard-versions?file=<artboard file>` -> ArtboardVersion[], newest first (tweaks excluded). */
export const artboardVersionsPath = (pageId: string, file: string) => `/api/pages/${pageId}/artboard-versions?file=${encodeURIComponent(file)}`;

/** Path on the ARTBOARD origin that serves any file of a page as it was in a version (read-only preview, same sandbox as live artboards). */
export const versionPreviewPath = (pageId: string, versionId: string, file: string) => `/page-versions/${pageId}/${versionId}/${file}`;

/** An artboard that is no longer on the page, with what is needed to list it and to put it back. */
export interface DeletedArtboard {
  file: string;
  title?: string;
  /** Who removed it: sessions (threads, conversations, terminal) = "claude", undoing an action = "user". */
  deletedBy: "claude" | "user";
  origin: VersionOrigin;
  originId?: string;
  originLabel?: string;
  deletedAt: string;
  /** Last page version that still had it: preview it with `versionPreviewPath` for the thumbnail, and pass it to restore to put it back. */
  lastVersionId: string;
  width: number;
  height: number;
}

/** Body of `POST /api/pages/:pageId/artboards/restore`. */
export interface RestoreArtboardRequest {
  file: string;
  /** Put `file` back as it was in this page version (file content, and its manifest entry when it is not on the page now). Absent in that version = the artboard is removed. */
  versionId: string;
  /** IANA time zone used to write the date in the version message ("Version du 21 octobre à 14:32 restaurée"); default: the server's. */
  timeZone?: string;
}

export interface RestoreArtboardResponse {
  version: PageVersionSummary;
  /** To undo: POST the same request with `versionId = previousVersionId`. */
  previousVersionId: string;
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
  /** Who made the page: a session through `create_page`, or the user. Pages from before this field are "user". */
  createdBy: PageCreator;
  version: PageVersion;
  /** Only on `GET /api/pages/:pageId`. */
  viewSettings?: PageViewSettings;
}

export type PageCreator = "claude" | "user";

/** A page a run created through `create_page`, shown as a link card under the answer. */
export interface CreatedPage {
  pageId: string;
  name: string;
  artboardCount: number;
}

export interface CreatePageRequest {
  title: string;
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
}

export interface ServerConfig {
  artboardOrigin: string;
}

/** `held`: a finished comment kept back ("Plus tard") until "Tout envoyer"; not yet sent to any session. */
export type ThreadStatus = "held" | "open" | "resolved";

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
  /** Short readable name of the commented element (role + visible text), computed by the artboard bridge; null on old threads. */
  elementName: string | null;
  /** Rendering of a responsive artboard the thread was pinned in; absent on other artboards. */
  rendering?: ThreadRendering;
  /** First line of the comment, kept visible when the thread is resolved. */
  title: string;
  body: string;
  status: ThreadStatus;
  /** Claude's answers, oldest first. */
  replies: ThreadReply[];
  /** Context of the thread's session after the last reply; absent before the first usage or after "Nouvelle session". */
  context?: ThreadContext;
  /** "summarizing" while the old session writes its summary; "ready" once the next reply starts a new session. */
  newSession?: "summarizing" | "ready";
}

export interface CreateThreadRequest extends ModelChoice {
  artboard: string;
  selector: string;
  xPct: number;
  yPct: number;
  body: string;
  /** Short name of the thread; defaults to the first line of the body. */
  title?: string;
  /** "Plus tard": store the comment without sending it. */
  held?: boolean;
  /** Readable name of the element, e.g. `bouton « Continuer »`; at most `MAX_ELEMENT_NAME_LENGTH` characters. */
  elementName?: string;
  /** Rendering of a responsive artboard the comment was pinned in. */
  rendering?: ThreadRendering;
}

export const MAX_ELEMENT_NAME_LENGTH = 200;

/** `PATCH /api/threads/:id`: edits a held comment. */
export interface UpdateThreadRequest {
  body: string;
}

/** `POST /api/pages/:pageId/send-held`: sends the held comments of that page as one message. Model and effort apply to it. */
export interface SendHeldRequest extends ModelChoice {
}

export interface SendHeldResponse {
  /** Held comments sent (0 when the page had none). */
  threads: number;
}

// Page manifest (ticket 19). Contract shared by the canvas, play mode, tweaks, design systems and MCP tools.

/** Path of the manifest inside a page's files. */
export const MANIFEST_PATH = "manifest.json";

/** Largest JSON request the server reads: a published version carries every file of the page (images and fonts go to the project assets instead). */
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;

export const DEFAULT_ARTBOARD_WIDTH = 800;
export const DEFAULT_ARTBOARD_HEIGHT = 500;
/** Horizontal gap between artboards laid out automatically. */
export const ARTBOARD_GAP = 80;

/** How play mode presents an artboard. `none` = the design as is. */
export type ArtboardDevice = "phone" | "tablet" | "desktop" | "paper" | "none";
export const ARTBOARD_DEVICES: readonly ArtboardDevice[] = ["phone", "tablet", "desktop", "paper", "none"];
/** Column grid drawn over an artboard when the viewer shows guides (canvas pixels). */
export interface ArtboardGuides {
  columns: number;
  gutter: number;
  margin: number;
  /** Height of the baseline grid; no baseline lines when absent. */
  baseline?: number;
}

/** Formats a responsive artboard can be rendered at. */
export type ResponsiveFormat = "desktop" | "tablet-landscape" | "tablet" | "mobile";
export const RESPONSIVE_FORMATS: Record<ResponsiveFormat, { label: string; width: number; height: number }> = {
  desktop: { label: "Desktop", width: 1440, height: 900 },
  "tablet-landscape": { label: "Tablette paysage", width: 1024, height: 768 },
  tablet: { label: "Tablette", width: 768, height: 1024 },
  mobile: { label: "Mobile", width: 390, height: 844 },
};
/** One rendering of a responsive artboard: its format and the viewport it is laid out in. */
export interface ArtboardRendering {
  format: ResponsiveFormat;
  width: number;
  /** Viewport height; the canvas shows the real height of the page once the bridge reported it. */
  height: number;
}
/** The rendering a thread is pinned in: its format and viewport width (what `renderingKey` / `renderingLabel` need). */
export type ThreadRendering = Pick<ArtboardRendering, "format" | "width">;
/** Identity of a rendering within its artboard. */
export const renderingKey = (rendering: Pick<ArtboardRendering, "format" | "width">) => `${rendering.format}-${rendering.width}`;
/** "Desktop · 1440" */
export const renderingLabel = (rendering: Pick<ArtboardRendering, "format" | "width">) => `${RESPONSIVE_FORMATS[rendering.format].label} · ${rendering.width}`;
/**
 * How a viewer sees a page, kept on the server per page: not part of a version, never sent to a session.
 * `hiddenFormats`: formats hidden in every responsive frame. `renderingOverrides[artboard file][renderingKey]`:
 * a frame's own choice (true = shown) for one rendering, which wins over the format's.
 */
export interface PageViewSettings {
  hiddenFormats: ResponsiveFormat[];
  renderingOverrides: Record<string, Record<string, boolean>>;
}
export const EMPTY_VIEW_SETTINGS: PageViewSettings = { hiddenFormats: [], renderingOverrides: {} };

/** Padding of a responsive frame, and gap between its renderings (canvas pixels). */
export const RESPONSIVE_SPACING = 96;

export interface ManifestArtboard {
  /** Path of the HTML file; also the artboard's identity (threads reference it). */
  file: string;
  title?: string;
  /** Size and position on the canvas, in canvas pixels. */
  width: number;
  height: number;
  x: number;
  y: number;
  /** Declared presentation in play mode; absent = inferred from the size. */
  device?: ArtboardDevice;
  /** Text shown in the address bar of the `desktop` presentation; never invented. */
  url?: string;
  /** `fill`: in play mode the artboard fills the whole window (ignored on a phone); the canvas keeps the declared size. */
  expand?: "fill";
  guides?: ArtboardGuides;
  /** One HTML file rendered at several widths, side by side in one frame; `device` is ignored. `width`/`height` then describe the frame with the declared heights. */
  responsive?: ArtboardRendering[];
}

export const DEFAULT_TITLE_WIDTH = 1200;

/** Big group title above a row of artboards. */
export interface ManifestTitleElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "title";
  text: string;
  subtitle?: string;
  /** Maximum width in canvas pixels. */
  width: number;
  x: number;
  y: number;
}

/** Palette shared by sticky notes, text notes, shapes and arrows. The web package maps each name to its shades. */
export const PALETTE_COLORS = ["yellow", "orange", "pink", "green", "blue", "purple", "gray"] as const;
export type PaletteColor = (typeof PALETTE_COLORS)[number];

export const NOTE_SIZES = ["s", "m", "l"] as const;
export type NoteSize = (typeof NOTE_SIZES)[number];

export const DEFAULT_TEXT_WIDTH = 360;
export const DEFAULT_STICKY_WIDTH = 240;

/** Prose with a fixed width; `color` tints the text. Limited markdown. */
export interface ManifestTextElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "text";
  text: string;
  width: number;
  size: NoteSize;
  color?: PaletteColor;
  x: number;
  y: number;
}

/** Coloured paper for an open question or a reminder; `color` fills the background. Limited markdown. */
export interface ManifestStickyElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "sticky";
  text: string;
  width: number;
  size: NoteSize;
  color: PaletteColor;
  x: number;
  y: number;
}

export const SHAPE_KINDS = ["rect", "ellipse"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export const SHAPE_STYLES = ["outline", "fill"] as const;
export type ShapeStyle = (typeof SHAPE_STYLES)[number];

/** Frame around a group of variants or one detail, drawn under the artboards. `fill` is a light 15 % fill. */
export interface ManifestShapeElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "shape";
  shape: ShapeKind;
  style: ShapeStyle;
  color: PaletteColor;
  label?: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export const DEFAULT_IMAGE_WIDTH = 400;

/** Image from the project assets (screenshot, reference), shown with its file name as caption. */
export interface ManifestImageElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "image";
  /** `assets/…` path of the project; never an external URL. */
  src: string;
  /** Width in canvas pixels; the height follows the image ratio. */
  width: number;
  x: number;
  y: number;
}

export const LINK_CARD_WIDTH = 640;
export const LINK_CARD_HEIGHT = 112;

/** Link card (640x112) to another Redline page; opens in the same tab. */
export interface ManifestPageLinkElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "link";
  page: string;
  x: number;
  y: number;
}

/** Link card (640x112) to an external URL, with the title Claude gives it; opens in a new tab. */
export interface ManifestUrlLinkElement {
  /** Target for arrows; unique across artboard files and element ids. */
  id?: string;
  kind: "link";
  url: string;
  title: string;
  x: number;
  y: number;
}

export type ManifestLinkElement = ManifestPageLinkElement | ManifestUrlLinkElement;

export const ARROW_LINES = ["solid", "dashed"] as const;
export type ArrowLine = (typeof ARROW_LINES)[number];

/** End of an arrow: an artboard `file`, an element `id`, or a free canvas point. */
export type ArrowEnd = string | { x: number; y: number };

/** Arrow between two elements, drawn on their nearest edges. Has no id and cannot be a target. */
export interface ManifestArrowElement {
  kind: "arrow";
  from: ArrowEnd;
  to: ArrowEnd;
  label?: string;
  color: PaletteColor;
  line: ArrowLine;
}

/** Decoration drawn on the canvas, written by Claude. Add a kind here and a parser in ELEMENT_PARSERS. */
export type ManifestElement = ManifestTitleElement | ManifestTextElement | ManifestStickyElement | ManifestShapeElement | ManifestImageElement | ManifestLinkElement | ManifestArrowElement;
export type ManifestElementKind = ManifestElement["kind"];

/** Play mode: clicking `selector` in artboard `from` goes to artboard `to`. */
export interface ManifestLink {
  from: string;
  selector: string;
  to: string;
}

export type TweakType = "color" | "choice" | "toggle" | "range" | "count" | "text";

/** How a `choice` tweak is drawn: segmented buttons (default), a dropdown, or live thumbnails of the artboard. */
export type TweakDisplay = "buttons" | "dropdown" | "previews";
export const TWEAK_DISPLAYS: readonly TweakDisplay[] = ["buttons", "dropdown", "previews"];

/** What a tweak touches. The tweaks panel lists them in this order; a tweak without a scope counts as "page". */
export type TweakScope = "element" | "artboard" | "page";
export const TWEAK_SCOPES: readonly TweakScope[] = ["element", "artboard", "page"];

/** Declaration only; chosen values live in the page's tweaks file, never in the manifest. */
export interface ManifestTweak {
  id: string;
  type: TweakType;
  label: string;
  default?: string | number | boolean;
  /** `choice`: the choices. `color`: suggested colours. `text`: suggested phrasings. */
  options?: string[];
  /** `range` and `count` only. */
  min?: number;
  max?: number;
  /** `range` and `count`: shown after the value ("px", "cartes"). */
  unit?: string;
  /** `choice` only. */
  display?: TweakDisplay;
  /** `color` only: also offer a free colour picker next to the suggested `options`. */
  allowCustom?: boolean;
  scope?: TweakScope;
  /** Artboard file the tweak is shown on; page-level tweaks without it go on the first artboard. */
  artboard?: string;
}

export interface Manifest {
  title?: string;
  /** Id of the design system the page uses. */
  designSystem?: string;
  artboards: ManifestArtboard[];
  /** Ordered: drawn in list order. */
  elements: ManifestElement[];
  links: ManifestLink[];
  tweaks: ManifestTweak[];
}

const TWEAK_TYPES: readonly TweakType[] = ["color", "choice", "toggle", "range", "count", "text"];
const TWEAK_TYPE_ALIASES: Record<string, TweakType> = { boolean: "toggle", int: "count" };

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

function oneOf<T extends string>(item: Record<string, unknown>, key: string, name: string, allowed: readonly T[]): T | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${name}.${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function arrowEnd(item: Record<string, unknown>, key: string, name: string): ArrowEnd {
  const value = item[key];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { x, y } = value as Record<string, unknown>;
    if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) return { x, y };
  }
  return fail(`${name}.${key} must be an element id or an {x, y} point`);
}

const ELEMENT_PARSERS: { [K in ManifestElementKind]: (item: Record<string, unknown>, name: string) => Extract<ManifestElement, { kind: K }> } = {
  title(item, name) {
    const title: ManifestTitleElement = {
      kind: "title",
      text: str(item, "text", name),
      width: num(item, "width", name, DEFAULT_TITLE_WIDTH, true),
      x: num(item, "x", name, 0),
      y: num(item, "y", name, 0),
    };
    if (typeof item.subtitle === "string" && item.subtitle !== "") title.subtitle = item.subtitle;
    return title;
  },
  text(item, name) {
    const note: ManifestTextElement = {
      kind: "text",
      text: str(item, "text", name),
      width: num(item, "width", name, DEFAULT_TEXT_WIDTH, true),
      size: oneOf(item, "size", name, NOTE_SIZES) ?? "m",
      x: num(item, "x", name, 0),
      y: num(item, "y", name, 0),
    };
    const color = oneOf(item, "color", name, PALETTE_COLORS);
    if (color) note.color = color;
    return note;
  },
  sticky(item, name) {
    return {
      kind: "sticky",
      text: str(item, "text", name),
      width: num(item, "width", name, DEFAULT_STICKY_WIDTH, true),
      size: oneOf(item, "size", name, NOTE_SIZES) ?? "m",
      color: oneOf(item, "color", name, PALETTE_COLORS) ?? "yellow",
      x: num(item, "x", name, 0),
      y: num(item, "y", name, 0),
    };
  },
  shape(item, name) {
    const shape = oneOf(item, "shape", name, SHAPE_KINDS);
    if (!shape) fail(`${name}.shape must be one of ${SHAPE_KINDS.join(", ")}`);
    if (item.width === undefined) fail(`${name}.width must be a positive number`);
    if (item.height === undefined) fail(`${name}.height must be a positive number`);
    const element: ManifestShapeElement = {
      kind: "shape",
      shape,
      style: oneOf(item, "style", name, SHAPE_STYLES) ?? "outline",
      color: oneOf(item, "color", name, PALETTE_COLORS) ?? "gray",
      width: num(item, "width", name, 0, true),
      height: num(item, "height", name, 0, true),
      x: num(item, "x", name, 0),
      y: num(item, "y", name, 0),
    };
    if (typeof item.label === "string" && item.label !== "") element.label = item.label;
    return element;
  },
  image(item, name) {
    const src = str(item, "src", name);
    if (!src.startsWith("assets/") || src === "assets/" || src.split("/").some((part) => part === ".." || part === ".")) {
      fail(`${name}.src must be a path inside the project assets, like assets/screenshot.png`);
    }
    return {
      kind: "image",
      src,
      width: num(item, "width", name, DEFAULT_IMAGE_WIDTH, true),
      x: num(item, "x", name, 0),
      y: num(item, "y", name, 0),
    };
  },
  link(item, name) {
    const x = num(item, "x", name, 0);
    const y = num(item, "y", name, 0);
    if (item.page !== undefined) {
      if (item.url !== undefined) fail(`${name}.page and ${name}.url cannot be used together`);
      return { kind: "link", page: str(item, "page", name), x, y };
    }
    if (item.url === undefined) fail(`${name}.page must be a non-empty string (or ${name}.url with ${name}.title)`);
    const url = str(item, "url", name);
    if (!/^https?:\/\/[^\s/]+/i.test(url)) fail(`${name}.url must be an http(s) address`);
    return { kind: "link", url, title: str(item, "title", name), x, y };
  },
  arrow(item, name) {
    const arrow: ManifestArrowElement = {
      kind: "arrow",
      from: arrowEnd(item, "from", name),
      to: arrowEnd(item, "to", name),
      color: oneOf(item, "color", name, PALETTE_COLORS) ?? "gray",
      line: oneOf(item, "line", name, ARROW_LINES) ?? "solid",
    };
    if (typeof item.label === "string" && item.label !== "") arrow.label = item.label;
    return arrow;
  },
};

function parseElement(item: Record<string, unknown>, name: string): ManifestElement {
  const kind = item.kind === undefined ? "title" : item.kind;
  if (typeof kind !== "string" || !Object.hasOwn(ELEMENT_PARSERS, kind)) {
    fail(`${name}.kind must be one of ${Object.keys(ELEMENT_PARSERS).join(", ")}`);
  }
  const element = ELEMENT_PARSERS[kind as ManifestElementKind](item, name);
  if (element.kind !== "arrow" && item.id !== undefined) element.id = str(item, "id", name);
  return element;
}

/** Ids are unique across artboard files and element ids; an arrow can only name one of them. */
function checkElementIds(artboards: ManifestArtboard[], elements: ManifestElement[], elementsName: string): void {
  const known = new Set(artboards.map((artboard) => artboard.file));
  elements.forEach((element, i) => {
    if (element.kind === "arrow" || element.id === undefined) return;
    if (known.has(element.id)) fail(`${elementsName}[${i}].id "${element.id}" is already used by an artboard file or another element`);
    known.add(element.id);
  });
  elements.forEach((element, i) => {
    if (element.kind !== "arrow") return;
    for (const key of ["from", "to"] as const) {
      const end = element[key];
      if (typeof end === "string" && !known.has(end)) fail(`${elementsName}[${i}].${key} names "${end}", which is not an artboard file or an element id`);
    }
  });
}

function parseGuides(value: unknown, name: string): ArtboardGuides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  const item = value as Record<string, unknown>;
  const required = (key: string, integer = false, positive = false): number => {
    const n = item[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (positive && n === 0) || (integer && !Number.isInteger(n))) {
      fail(`${name}.${key} must be ${integer ? "a positive whole number" : positive ? "a positive number" : "a number of 0 or more"}`);
    }
    return n;
  };
  const guides: ArtboardGuides = { columns: required("columns", true, true), gutter: required("gutter"), margin: required("margin") };
  if (item.baseline !== undefined) guides.baseline = required("baseline", false, true);
  return guides;
}

const RESPONSIVE_FORMAT_NAMES = Object.keys(RESPONSIVE_FORMATS) as ResponsiveFormat[];

function parseRenderings(value: unknown, name: string): ArtboardRendering[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty list of formats (${RESPONSIVE_FORMAT_NAMES.join(", ")})`);
  const seen = new Set<string>();
  return (value as unknown[]).map((entry, i) => {
    const entryName = `${name}[${i}]`;
    let rendering: ArtboardRendering;
    if (typeof entry === "string") {
      if (!RESPONSIVE_FORMAT_NAMES.includes(entry as ResponsiveFormat)) fail(`${entryName} must be one of ${RESPONSIVE_FORMAT_NAMES.join(", ")}`);
      const { width, height } = RESPONSIVE_FORMATS[entry as ResponsiveFormat];
      rendering = { format: entry as ResponsiveFormat, width, height };
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      if (!RESPONSIVE_FORMAT_NAMES.includes(item.device as ResponsiveFormat)) fail(`${entryName}.device must be one of ${RESPONSIVE_FORMAT_NAMES.join(", ")}`);
      const size = (key: "width" | "height") => {
        const n = item[key];
        if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) fail(`${entryName}.${key} must be a positive number`);
        return n as number;
      };
      rendering = { format: item.device as ResponsiveFormat, width: size("width"), height: size("height") };
    } else {
      return fail(`${entryName} must be a format name or {device, width, height}`);
    }
    if (seen.has(renderingKey(rendering))) fail(`${entryName} repeats ${renderingLabel(rendering)}`);
    seen.add(renderingKey(rendering));
    return rendering;
  });
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
    if (item.responsive !== undefined) {
      const renderings = parseRenderings(item.responsive, `${name}.responsive`);
      artboard.responsive = renderings;
      artboard.width = renderings.reduce((sum, r) => sum + r.width, 0) + RESPONSIVE_SPACING * (renderings.length + 1);
      artboard.height = Math.max(...renderings.map((r) => r.height)) + RESPONSIVE_SPACING * 2;
    } else if (item.device !== undefined) {
      if (!ARTBOARD_DEVICES.includes(item.device as ArtboardDevice)) fail(`${name}.device must be one of ${ARTBOARD_DEVICES.join(", ")}`);
      artboard.device = item.device as ArtboardDevice;
    }
    if (typeof item.url === "string") artboard.url = item.url;
    if (item.expand !== undefined) {
      if (item.expand !== "fill") fail(`${name}.expand must be "fill"`);
      artboard.expand = "fill";
    }
    if (item.guides !== undefined) artboard.guides = parseGuides(item.guides, `${name}.guides`);
    nextX = artboard.x + artboard.width + ARTBOARD_GAP;
    return artboard;
  });

  if (root.notes !== undefined && root.elements !== undefined) fail("notes and elements cannot be used together; notes is replaced by elements");
  // Legacy `notes` are title elements.
  const elements =
    root.notes !== undefined
      ? list(root.notes, "notes").map((item, i) => parseElement({ ...item, kind: "title" }, `notes[${i}]`))
      : list(root.elements, "elements").map((item, i) => parseElement(item, `elements[${i}]`));

  checkElementIds(artboards, elements, root.notes !== undefined ? "notes" : "elements");

  const links = list(root.links, "links").map((item, i): ManifestLink => {
    const name = `links[${i}]`;
    return { from: str(item, "from", name), selector: str(item, "selector", name), to: str(item, "to", name) };
  });

  const tweaks = list(root.tweaks, "tweaks").map((item, i): ManifestTweak => {
    const name = `tweaks[${i}]`;
    const declared = str(item, "type", name);
    const type = TWEAK_TYPE_ALIASES[declared] ?? declared;
    if (!TWEAK_TYPES.includes(type as TweakType)) fail(`${name}.type must be one of ${[...TWEAK_TYPES, ...Object.keys(TWEAK_TYPE_ALIASES)].join(", ")}`);
    if (item.display !== undefined && !TWEAK_DISPLAYS.includes(item.display as TweakDisplay)) fail(`${name}.display must be one of ${TWEAK_DISPLAYS.join(", ")}`);
    if (item.scope !== undefined && !TWEAK_SCOPES.includes(item.scope as TweakScope)) fail(`${name}.scope must be one of ${TWEAK_SCOPES.join(", ")}`);
    return { ...(item as unknown as ManifestTweak), id: str(item, "id", name), type: type as TweakType, label: str(item, "label", name) };
  });

  const manifest: Manifest = { artboards, elements, links, tweaks };
  if (typeof root.title === "string") manifest.title = root.title;
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
export interface AgentHello extends ModelChoice {
  type: "hello";
  token: string;
  protocolVersion: number;
  machine: string;
  folder: string;
  kind: AgentKind;
  /** The project a project agent serves (the link recorded in its folder). */
  projectId?: string;
}

export type AgentToServerMessage = AgentHello | AgentWorkMessage;

/** Messages the server sends on the agent endpoint. */
export type ServerToAgentMessage =
  | { type: "welcome"; agentId: string }
  | { type: "work"; item: WorkItem }
  | { type: "error"; code: "unauthorized" | "incompatible_protocol" | "bad_hello" | "unknown_project" | "project_taken"; message: string };

export type AgentStatus = "online" | "offline";

export interface AgentInfo extends ModelChoice {
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

// Tweaks (ticket 22). Declarations are in the manifest; chosen values are in the tweaks file.

/** Path of the tweaks file inside a page's files: a flat JSON object of tweak id to chosen value. */
export const TWEAKS_PATH = "tweaks.json";

export type TweakValue = string | number | boolean;
export type TweakValues = Record<string, TweakValue>;

export const DEFAULT_TWEAK_MIN = 0;
export const DEFAULT_TWEAK_MAX = 100;

/** Body of `POST /api/pages/:id/tweaks`: sets one tweak value and records a version with origin "tweak". */
export interface SetTweakRequest {
  id: string;
  value: TweakValue;
}

export function parseTweaks(text: string): TweakValues {
  const fail = (message: string): never => {
    throw new Error(`Invalid ${TWEAKS_PATH}: ${message}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("must be a JSON object");
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      fail(`${id} must be a string, number or boolean`);
    }
  }
  return raw as TweakValues;
}

/** Error message when `value` does not fit the tweak's declaration, else null. */
export function tweakValueError(tweak: ManifestTweak, value: unknown): string | null {
  const min = tweak.min ?? DEFAULT_TWEAK_MIN;
  const max = tweak.max ?? DEFAULT_TWEAK_MAX;
  switch (tweak.type) {
    case "color":
      return typeof value === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) ? null : "value must be a color like #1a2b3c";
    case "choice":
      return typeof value === "string" && (tweak.options ?? []).includes(value) ? null : "value must be one of the options";
    case "toggle":
      return typeof value === "boolean" ? null : "value must be a boolean";
    case "range":
    case "count":
      if (typeof value !== "number" || !Number.isFinite(value)) return "value must be a number";
      if (tweak.type === "count" && !Number.isInteger(value)) return "value must be an integer";
      return value >= min && value <= max ? null : `value must be between ${min} and ${max}`;
    case "text":
      return typeof value === "string" ? null : "value must be a string";
  }
}

function typeDefault(tweak: ManifestTweak): TweakValue {
  switch (tweak.type) {
    case "color":
      return tweak.options?.[0] ?? "#000000";
    case "choice":
      return tweak.options?.[0] ?? "";
    case "toggle":
      return false;
    case "range":
    case "count":
      return tweak.min ?? DEFAULT_TWEAK_MIN;
    case "text":
      return "";
  }
}

/** Value of every declared tweak: stored value, else declared default, else the type's default. Undeclared or invalid stored values are ignored. */
export function resolveTweakValues(manifest: Manifest, stored: TweakValues): TweakValues {
  const values: TweakValues = {};
  for (const tweak of manifest.tweaks) {
    const candidates: unknown[] = [stored[tweak.id], tweak.default];
    values[tweak.id] =
      (candidates.find((v) => v !== undefined && tweakValueError(tweak, v) === null) as TweakValue | undefined) ?? typeDefault(tweak);
  }
  return values;
}

/** Files of a new page: a manifest naming its title, and no artboard (the session that fills the page adds them). */
export function starterPageFiles(title: string, designSystem?: string | null): Record<string, string> {
  const manifest = { title, ...(designSystem ? { designSystem } : {}), artboards: [] };
  return { [MANIFEST_PATH]: JSON.stringify(manifest, null, 2) };
}

export * from "./designSystem.js";
export * from "./projectFiles.js";
