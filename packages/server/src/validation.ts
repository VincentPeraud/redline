import {
  DESIGN_SYSTEM_TOKENS_PATH,
  EFFORTS,
  MANIFEST_PATH,
  TWEAKS_PATH,
  VERSION_ORIGINS,
  isSafePath,
  missingCoreTokens,
  parseManifest,
  parseTweaks,
  type CreateVersionRequest,
  type Effort,
  type ModelChoice,
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

/** The validated choice of a request body (call after `modelChoiceError`). */
export function modelChoiceOf({ model, effort }: { model?: unknown; effort?: unknown }): ModelChoice {
  return { model: model as string | undefined, effort: effort as Effort | undefined };
}

/** Error message when `files` is not a path -> text map with safe relative paths, else null. */
export function filesError(files: unknown): string | null {
  if (!files || typeof files !== "object") return "files are required";
  const invalid = Object.entries(files).some(([path, content]) => !isSafePath(path) || typeof content !== "string");
  return invalid ? "invalid files" : null;
}

/** Error message when the files carry a manifest or tweaks file that does not parse, else null. */
export function manifestError(files: Record<string, string>): string | null {
  try {
    if (files[MANIFEST_PATH] !== undefined) parseManifest(files[MANIFEST_PATH]);
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
export function pageFilesError(files: unknown): string | null {
  return filesError(files) ?? manifestError(files as Record<string, string>);
}

/**
 * Error message when a request to record a version is invalid, else null. The one check behind `/api` and `/agent-api`.
 * `designSystemPage`: the page is a design system's, whose tokens must stay complete.
 */
export function versionRequestError(body: Partial<CreateVersionRequest> | undefined, designSystemPage: boolean): string | null {
  const { files, message, origin } = body ?? {};
  const invalidFiles = pageFilesError(files);
  if (invalidFiles) return invalidFiles;
  if (designSystemPage) {
    const invalidDesignSystem = designSystemError(files!);
    if (invalidDesignSystem) return invalidDesignSystem;
  }
  if (!requiredString(message)) return "message is required";
  if (!(VERSION_ORIGINS as readonly string[]).includes(origin as string)) return "invalid origin";
  return null;
}
