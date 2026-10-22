import type { Store } from "./store.js";

export type MergeResult =
  | { files: Record<string, string>; merged: boolean }
  | { error: string; conflict: boolean };

/**
 * What an agent publishes is the whole working copy it checked out from `baseVersionId`. Only what the session changed
 * relative to that base is applied, on top of the page's current version, so a tweak, a restore or another session's
 * version made meanwhile is never reverted. A file changed on both sides (differently) is a conflict: nothing is published.
 */
export function mergeOntoCurrent(store: Store, pageId: string, files: Record<string, string>, baseVersionId: string): MergeResult {
  const current = store.readPageFiles(pageId);
  if (!current) return { error: "page not found", conflict: false };
  if (current.versionId === baseVersionId) return { files, merged: false };
  const base = store.readVersionFiles(pageId, baseVersionId);
  if (!base) return { error: "unknown baseVersionId", conflict: false };

  const merged: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(files), ...Object.keys(current.files)])) {
    const mine = files[path];
    const before = base[path];
    const theirs = current.files[path];
    const result = mine === before || theirs === mine ? theirs : theirs === before ? mine : conflict(path);
    if (result !== undefined) merged[path] = result;
  }
  if (conflicts.length > 0) {
    return {
      error: `The page changed since it was checked out; conflicting files: ${conflicts.join(", ")}. Check the page out again and redo the change.`,
      conflict: true,
    };
  }
  return { files: merged, merged: true };

  function conflict(path: string): undefined {
    conflicts.push(path);
    return undefined;
  }
}
