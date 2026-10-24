import type { ServerApi } from "./server-api.js";
import { readChangedAssets } from "./working-copy.js";

/**
 * Uploads the assets the working copy added or changed (see `readChangedAssets`, which refuses an invalid one before
 * the first upload) to the page's project. Returns the uploaded names and the new base to compare against.
 */
export async function uploadChangedAssets(
  api: ServerApi,
  pageId: string,
  dir: string,
  base: Record<string, string>,
): Promise<{ uploaded: string[]; assets: Record<string, string> }> {
  const changed = readChangedAssets(dir, base);
  const assets = { ...base };
  for (const [name, bytes] of Object.entries(changed)) {
    await api.uploadAsset(pageId, name, bytes);
    assets[name] = bytes.toString("base64");
  }
  return { uploaded: Object.keys(changed), assets };
}
