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
  type ThreadTarget,
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

const isThreadTarget = (value: unknown): value is ThreadTarget => {
  if (!isObject(value)) return false;
  if (value.kind === "artboard") return requiredString(value.artboard);
  if (value.kind === "canvas-element") return requiredString(value.elementId) && typeof value.elementKind === "string" && value.elementKind in CANVAS_ELEMENT_KIND_LABELS && (value.elementSummary === undefined || typeof value.elementSummary === "string");
  return (
    value.kind === "element" &&
    requiredString(value.artboard) &&
    requiredString(value.selector) &&
    (value.elementName === null || typeof value.elementName === "string") &&
    typeof value.xPct === "number" &&
    typeof value.yPct === "number"
  );
};

/** True for the visible artboards, tweaks and chips of a message context (what Claude is told about). */
export function isMessageContext(value: unknown): value is MessageContext {
  if (!isObject(value) || !Array.isArray(value.visibleArtboards) || !Array.isArray(value.tweaks)) return false;
  const artboardsOk = value.visibleArtboards.every((a) => {
    if (!isObject(a) || !requiredString(a.file)) return false;
    if (a.rendering === undefined) return true;
    const r = a.rendering;
    return isObject(r) && typeof r.format === "string" && r.format in RESPONSIVE_FORMATS && typeof r.width === "number";
  });
  const targetsOk = value.targets === undefined || (Array.isArray(value.targets) && value.targets.every(isThreadTarget));
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

/** Error message when a design system's files miss `tokens.css` or a core token, else null. */
export function designSystemError(files: Record<string, string>): string | null {
  const css = files[DESIGN_SYSTEM_TOKENS_PATH];
  if (css === undefined) return `${DESIGN_SYSTEM_TOKENS_PATH} is required`;
  const missing = missingCoreTokens(css);
  return missing.length === 0 ? null : `Missing core tokens: ${missing.join(", ")}`;
}

/** Error message when the files of a new page are invalid, else null. */
export function pageFilesError(files: unknown, requireElementIds = false): string | null {
  return filesError(files) ?? manifestError(files as Record<string, string>, requireElementIds);
}

/**
 * Error message when a request to record a version is invalid, else null. The one check behind `/api` and `/agent-api`.
 * `designSystemPage`: the page is a design system's, whose tokens must stay complete.
 */
export function versionRequestError(body: Partial<CreateVersionRequest> | undefined, designSystemPage: boolean, requireElementIds = false): string | null {
  const { files, message, origin } = body ?? {};
  const invalidFiles = pageFilesError(files, requireElementIds);
  if (invalidFiles) return invalidFiles;
  if (designSystemPage) {
    const invalidDesignSystem = designSystemError(files!);
    if (invalidDesignSystem) return invalidDesignSystem;
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
