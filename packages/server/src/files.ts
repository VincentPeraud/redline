import { MANIFEST_PATH, VERSION_ORIGINS, parseManifest, type CreateVersionRequest } from "@redline/shared";

/** Error message when the files carry a manifest that does not parse, else null. */
export function manifestError(files: Record<string, string>): string | null {
  const text = files[MANIFEST_PATH];
  if (text === undefined) return null;
  try {
    parseManifest(text);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Error message when a request to record a version is invalid, else null. */
export function versionRequestError(body: Partial<CreateVersionRequest> | undefined): string | null {
  const { files, message, origin } = body ?? {};
  if (!files || typeof files !== "object") return "files are required";
  if (Object.entries(files).some(([path, content]) => !isSafePath(path) || typeof content !== "string")) return "invalid files";
  const invalidManifest = manifestError(files);
  if (invalidManifest) return invalidManifest;
  if (typeof message !== "string" || message.trim() === "") return "message is required";
  if (!(VERSION_ORIGINS as readonly string[]).includes(origin as string)) return "invalid origin";
  return null;
}

export function isSafePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.split("/").includes("..");
}
