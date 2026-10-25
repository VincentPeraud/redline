import {
  DESIGN_SYSTEM_TOKENS_PATH,
  EFFORTS,
  MANIFEST_PATH,
  MAX_TITLE_LENGTH,
  RESPONSIVE_FORMATS,
  TWEAKS_PATH,
  VERSION_ORIGINS,
  isSafePath,
  missingCoreTokens,
  parseManifest,
  publishManifestError,
  parseTweaks,
  type CreateVersionRequest,
  type Effort,
  type MessageContext,
  MAX_ELEMENT_NAME_LENGTH,
  type CreateElementThreadRequest,
  CANVAS_ELEMENT_KIND_LABELS,
  type ModelChoice,
  type PageViewSettings,
} from "@redline/shared";

/** True for a string with something in it; the guard form of "field is required". */
export function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Model names reach `claude --model`: letters, digits, `.`, `_`, `-` and brackets only (`opus`, `claude-opus-4-1`, `sonnet[1m]`). */
const MODEL_PATTERN = /^[\w.\-[\]]+$/;

/** Error message when a model/effort pair of a request is invalid, else null. Both are optional. */
export function modelChoiceError({ model, effort }: { model?: unknown; effort?: unknown }): string | null {
  if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) return "invalid model";
  if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort)) return "invalid effort";
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isPct = (value: unknown) => typeof value === "number" && value >= 0 && value <= 100;

/**
 * Error message when a thread target is malformed, else null. One validator for both uses of a target:
 * `request` is what a client sends to create a thread (an artboard or a canvas element by id; the server fills the rest),
 * `chip` is a full `ThreadTarget` as stored and as pointed at by a conversation message.
 */
export function threadTargetError(target: unknown, use: "request" | "chip"): string | null {
  if (!isObject(target)) return "invalid target";
  if (target.kind === "artboard") return typeof target.artboard === "string" && isSafePath(target.artboard) ? null : "invalid artboard";
  if (target.kind === "canvas-element") {
    if (!requiredString(target.elementId)) return "element id is required";
    if (use === "request") return null;
    const kindOk = typeof target.elementKind === "string" && Object.hasOwn(CANVAS_ELEMENT_KIND_LABELS, target.elementKind);
    return kindOk && (target.elementSummary === undefined || typeof target.elementSummary === "string") ? null : "invalid target";
  }
  if (use === "chip" && target.kind === "element") {
    const valid =
      requiredString(target.artboard) &&
      requiredString(target.selector) &&
      (target.elementName === null || typeof target.elementName === "string") &&
      typeof target.xPct === "number" &&
      typeof target.yPct === "number";
    if (!valid) return "invalid target";
    const invalidRendering = target.rendering === undefined ? null : threadRenderingError(target.rendering);
    return invalidRendering ?? (target.cell === undefined ? null : threadCellError(target.cell));
  }
  return "invalid target";
}

/** Error message when the body of `POST /api/pages/:pageId/threads` is malformed (shape only; the page's artboards and elements are checked by the route), else null. */
export function createThreadRequestError(request: unknown): string | null {
  const pin = (request ?? {}) as Partial<CreateElementThreadRequest> & { target?: unknown };
  if (!requiredString(pin.body)) return "body is required";
  if (pin.target !== undefined) {
    const invalidTarget = threadTargetError(pin.target, "request");
    if (invalidTarget) return invalidTarget;
  } else {
    if (typeof pin.selector !== "string" || pin.selector === "") return "selector is required";
    if (typeof pin.artboard !== "string" || !isSafePath(pin.artboard)) return "invalid artboard";
    if (!isPct(pin.xPct) || !isPct(pin.yPct)) return "position must be a percentage";
  }
  if (pin.title !== undefined && !requiredString(pin.title)) return "title must be a non-empty string";
  if (pin.held !== undefined && typeof pin.held !== "boolean") return "held must be a boolean";
  if (pin.elementName !== undefined && (typeof pin.elementName !== "string" || pin.elementName.length > MAX_ELEMENT_NAME_LENGTH)) {
    return `elementName must be a string of at most ${MAX_ELEMENT_NAME_LENGTH} characters`;
  }
  if (pin.rendering !== undefined) {
    const invalidRendering = threadRenderingError(pin.rendering);
    if (invalidRendering) return invalidRendering;
  }
  if (pin.cell !== undefined) {
    const invalidCell = threadCellError(pin.cell);
    if (invalidCell) return invalidCell;
  }
  return modelChoiceError(pin);
}

/** True for the visible artboards, tweaks and chips of a message context (what Claude is told about). */
export function isMessageContext(value: unknown): value is MessageContext {
  if (!isObject(value) || !Array.isArray(value.visibleArtboards) || !Array.isArray(value.tweaks)) return false;
  const artboardsOk = value.visibleArtboards.every((a) => isObject(a) && requiredString(a.file) && (a.rendering === undefined || threadRenderingError(a.rendering) === null));
  const targetsOk = value.targets === undefined || (Array.isArray(value.targets) && value.targets.every((t) => threadTargetError(t, "chip") === null));
  return artboardsOk && targetsOk && value.tweaks.every((t) => isObject(t) && typeof t.label === "string" && typeof t.value === "string");
}

/** The choice without its absent fields, so it can be spread over a work item without erasing what the item has. */
export function definedChoice({ model, effort }: ModelChoice): ModelChoice {
  return { ...(model !== undefined && { model }), ...(effort !== undefined && { effort }) };
}

/** The validated choice of a request body (call after `modelChoiceError`). */
export function modelChoiceOf({ model, effort }: { model?: unknown; effort?: unknown }): ModelChoice {
  return definedChoice({ model: model as string | undefined, effort: effort as Effort | undefined });
}

/** Error message when `files` is not a path -> text map with safe relative paths, else null. */
/** Error message when a project or page name is not a non-empty string of at most `MAX_TITLE_LENGTH` characters once trimmed, else null. */
export function titleError(title: unknown): string | null {
  if (!requiredString(title)) return "title is required";
  return title.trim().length > MAX_TITLE_LENGTH ? `title must be at most ${MAX_TITLE_LENGTH} characters` : null;
}

export function filesError(files: unknown): string | null {
  if (!files || typeof files !== "object") return "files are required";
  const invalid = Object.entries(files).some(([path, content]) => !isSafePath(path) || typeof content !== "string");
  return invalid ? "invalid files" : null;
}

/**
 * Error message when the files carry a manifest or tweaks file that does not parse, else null.
 * `requireElementIds`: a publish by Claude, whose manifest elements must all carry an id.
 */
export function manifestError(files: Record<string, string>, requireElementIds = false): string | null {
  try {
    if (files[MANIFEST_PATH] !== undefined) {
      const invalid = requireElementIds ? publishManifestError(files[MANIFEST_PATH]) : (parseManifest(files[MANIFEST_PATH]), null);
      if (invalid) return invalid;
    }
    if (files[TWEAKS_PATH] !== undefined) parseTweaks(files[TWEAKS_PATH]);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Error message when a design system's `tokens.css` misses a core token, else null. */
export function tokensError(css: string): string | null {
  const missing = missingCoreTokens(css);
  return missing.length === 0 ? null : `Missing core tokens: ${missing.join(", ")}`;
}

/** Error message when the files of a new design system miss `tokens.css` or a core token, else null. */
export function designSystemError(files: Record<string, string>): string | null {
  const css = files[DESIGN_SYSTEM_TOKENS_PATH];
  return css === undefined ? `${DESIGN_SYSTEM_TOKENS_PATH} is required` : tokensError(css);
}

/** Error message when the files of a new page are invalid, else null. */
export function pageFilesError(files: unknown, requireElementIds = false): string | null {
  return filesError(files) ?? manifestError(files as Record<string, string>, requireElementIds);
}

/**
 * Error message when a request to record a version is invalid, else null. The one check behind `/api` and `/agent-api`.
 * `designSystemPage`: the page is one of a design system's; a `tokens.css` it publishes goes to the design system and must stay complete.
 */
export function versionRequestError(body: Partial<CreateVersionRequest> | undefined, designSystemPage: boolean, requireElementIds = false): string | null {
  const { files, message, origin } = body ?? {};
  const invalidFiles = pageFilesError(files, requireElementIds);
  if (invalidFiles) return invalidFiles;
  const tokens = files![DESIGN_SYSTEM_TOKENS_PATH];
  if (designSystemPage && tokens !== undefined) {
    const invalidTokens = tokensError(tokens);
    if (invalidTokens) return invalidTokens;
  }
  if (!requiredString(message)) return "message is required";
  if (!(VERSION_ORIGINS as readonly string[]).includes(origin as string)) return "invalid origin";
  return null;
}

/** Error message when a request body is not valid page view settings, else null. */
export function viewSettingsError(body: unknown): string | null {
  const { hiddenFormats, renderingOverrides } = (body ?? {}) as Partial<Record<keyof PageViewSettings, unknown>>;
  if (!Array.isArray(hiddenFormats) || !hiddenFormats.every((format) => typeof format === "string" && Object.hasOwn(RESPONSIVE_FORMATS, format))) {
    return "hiddenFormats must be a list of responsive formats";
  }
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(renderingOverrides)) return "renderingOverrides must be an object";
  const valid = Object.values(renderingOverrides).every((byKey) => isRecord(byKey) && Object.values(byKey).every((shown) => typeof shown === "boolean"));
  return valid ? null : "renderingOverrides must map artboard files to rendering keys to booleans";
}

/** Error message when a thread's rendering (format and viewport width) is malformed, else null. */
export function threadRenderingError(rendering: unknown): string | null {
  const { format, width } = (rendering ?? {}) as { format?: unknown; width?: unknown };
  const valid = typeof format === "string" && Object.hasOwn(RESPONSIVE_FORMATS, format) && typeof width === "number" && Number.isFinite(width) && width > 0;
  return valid ? null : "rendering must be { format: a responsive format, width: a positive number }";
}

/** Error message when a thread's tweak grid cell (tweak id to value) is malformed, else null. */
export function threadCellError(cell: unknown): string | null {
  const valid =
    isObject(cell) &&
    !Array.isArray(cell) &&
    Object.keys(cell).length > 0 &&
    Object.values(cell).every((v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)));
  return valid ? null : "cell must map tweak ids to a string, number or boolean";
}
